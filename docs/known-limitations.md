# 已知限制

本文件记录当前实现**没有**做到或**没有**验证的事情。它和测试报告一起使用：
未列在此处的能力不应被假定存在。

## 1. 隔离强度

- `managed` 不是沙箱。Windows 上子进程使用调用方令牌，拥有调用方的文件、网络
  与注册表访问权限，Job Object 只约束生命周期与部分资源；macOS 上子进程使用
  当前 UID，进程组只约束生命周期（见 §1.2）。
- `restricted`（Windows）只移除特权并降低到 Low 完整性。它不按路径限制文件，
  也不限制网络；`networkAccess: deny` 与 `fileAccess: restricted` 在该模式下会
  被拒绝。
- `app_container`（Windows）的文件隔离是**目录级 ACL**：授予数据目录、数据
  目录下的 `Temp` 与显式额外根目录，其余路径依赖 AppContainer 默认拒绝。它不
  提供单文件白名单、不拦截已授权目录内的任意读写。
- `app_container` 的网络隔离是**能力级**的（是否附加 `internetClient` 等
  capability SID），不是域名、端口或协议级防火墙。`deny` 不附加网络能力，
  但没有实现按目标地址过滤。
- 桌面界面只把上述模式作为「隔离方式」列出，不声称浏览器层配置（时区、语言、
  视口）构成操作系统级的指纹隔离。

### 1.1 Chrome 不能在受限令牌 / AppContainer 下运行（已实测确认）

`restricted` 与 `app_container` 都**无法**承载 Chrome。这不是运行时实现缺失，
而是 Chromium 自身的约束：Chrome 的浏览器进程要为自己创建沙箱（Job Object +
受限令牌），当它已经运行在运行时预先限制过的令牌里时，这一步会失败并触发
Chromium 的 `CHECK` 中止，进程在启动阶段退出，不写入任何 Profile 数据。

**中止码随 Chromium 构建而变。** 本机 Chrome 156.0.8078.48 上是
`STATUS_BREAKPOINT`（`0x80000003`）；GitHub Actions 的 `windows-latest` 运行器上
装的 Chromium 换了一个构建，同一场景的中止码是 `0xffff7001`——按 Chromium 源码，
这是 Crashpad 的 `kCrashExitCodeNoDump`：崩溃处理器在一次启动期 FATAL 之后无法
写出 dump，于是用这个码结束进程，把底层异常掩盖了。因此适配层**不按某一个魔数
判定**——它按隔离模式判定：受限令牌 / AppContainer 下浏览器在启动阶段退出，就归类
为 `unsupported_isolation`，并把实际观察到的 `exitCode` 一并返回。

本机实测（Windows 11 26300 x86_64、非管理员、Chrome 156.0.8078.48）：

| 组合 | 结果 |
| --- | --- |
| `managed` + Chrome | 正常启动，CDP 可连接 |
| `restricted` + `cmd.exe` | 正常运行（对照组，证明令牌本身可用） |
| `restricted` + Chrome（有头 / 无头） | 退出码 `0x80000003`，无 Profile |
| `app_container` + Chrome | 同上；此外还会先在 Program Files 的额外 ACL 授权上失败 |

因此：

- 桌面应用在**保存与启动**环境时直接拒绝这两种模式，并给出可读原因
  （`unsupported_isolation`），而不是让用户在启动后才看到一个笼统的运行时错误。
- 浏览器适配器保留对这两种模式的支持——运行时管理的其它程序可以使用它们——
  但当被拉起的可执行文件是 Chromium 系浏览器并在启动阶段退出时，适配器会把它
  翻译成 `unsupported_isolation`，并带上 `isolation`、`exitCode` 与 `reason`
  （`status_breakpoint` 表示确实是 `0x80000003`，否则是
  `early_exit_under_restricted_isolation`）。
- 没有使用 `--no-sandbox` 之类的手段绕过：该做法是移除沙箱而不是让 Chromium
  在受限令牌下正常工作，等于放弃隔离本身，与项目的隔离目标相反。
- 真正可用的隔离路径是 `managed`（Job Object 生命周期与资源约束）加上浏览器层
  的配置覆盖（时区、语言、视口）。这两者都不是操作系统级的指纹隔离。

### 1.2 macOS：进程组不是沙箱（已实测）

macOS 的 `managed` 使用 POSIX 进程组：创建 Chrome 时通过 `process_group(0)`
进入独立进程组，`getpgid` 回验，`proc_pidinfo` 校验 PID + 启动时间身份；停止、
显式终止与运行时正常退出都会向整组发 `SIGKILL`。

它**不提供**：

- 文件系统或网络限制：Chrome 以当前用户身份运行，可访问用户可访问的一切。
- 按进程树聚合的进程数 / 内存上限：没有对应原语，配置了
  `maxProcesses` / `memoryLimitBytes` 的请求会以 `capability_unavailable`
  被拒绝，不用 `RLIMIT` 近似。
- 内核级 kill-on-close：进程组依赖运行时进程执行清理。运行时被 `SIGKILL` 时
  内核不会代为杀树，Chrome 可能残留；Windows 的 Job Object 有这一保证。
- 强制包含：子进程可以 `setsid` 或双 fork 离开进程组。`managed` 的定义就是
  生命周期包含，不是安全边界。
- `restricted` / `app_container`：这两个模式是 Windows 专属，macOS 运行时会
  在创建进程前以 `capability_unavailable` 拒绝，桌面端在保存/启动时给出可读
  原因。

实测观察（macOS 27.0.1 arm64、Chrome 155.0.8059.85）：Chrome 正常浏览器进程与
其大多数受管 helper 同组；Crashpad handler 可能加入用户已有 Chrome 的进程组
而不是新环境的进程组。因此「整组终止」覆盖浏览器主进程与 CDP 所需进程，但不
应描述成「保证每一个 Chromium 子进程都不会残留」。集成测试按
`--user-data-dir` 过滤残留进程，未发现环境自己的 Chrome 残留。

## 2. 未实现的能力

- ETW 观察与事件关联：探测状态为 `not_verified`，实现中未使用。
- 额外的进程缓解策略（ACG、CIG、字体/图像阻断等）：只读取当前策略，不主动设置。
- 可执行文件签名、发布者与版本校验。
- 宿主崩溃后的孤儿进程扫描；依赖 Job 的 `killOnClose` 在句柄关闭时终止。
- 进程监督、自动重启、退避与健康检查。
- 账号体系、云同步、远程浏览器、计费、插件市场与多租户。
- 自研指纹引擎、内核或系统调用级拦截。
- 每个环境的随机品牌色：界面刻意保持统一视觉，不为环境生成装饰性配色。

## 3. 平台与兼容性

- Windows 只在 11 26300 x86_64、非管理员、Medium 完整性下验证；未在 Windows 10
  早期构建、Windows Server、ARM64 或高完整性/管理员会话中验证。
- macOS 只在 27.0.1 arm64 上验证；未在 Intel Mac、旧版 macOS 或 Rosetta 下验证。
  代码不依赖具体版本号，但 `proc_pidinfo` 与 `LOCAL_PEERCRED` 的实测证据只来自
  这一台机器。
- Windows CI（`.github/workflows/ci.yml`）的实跑结果记录在
  `docs/test-report.md`；macOS job 与 macOS 打包 job 已加入工作流，其中打包 job
  暂时是非阻塞（`continue-on-error`），需要 CI 实跑后再转为门禁。
- Chrome 兼容性测试需要本机安装 Chrome；Windows 本机使用 Chrome 156.0.8078.48，
  macOS 本机使用 Chrome 155.0.8059.85。Chrome 在 AppContainer 下运行所需的额外
  授权**已实测失败**：`ALL APPLICATION PACKAGES` 对 `C:\Program Files` 已经
  授予 RX 且子目录继承 GR/GE，额外授权是冗余的；真正的障碍是 Chromium 无法在
  受限令牌内启动自己的沙箱（见 §1.1）。
- Windows 打包产物以 `dir` 目标产出，尚未生成安装器（NSIS/MSI）。安装目录需要
  `ALL APPLICATION PACKAGES` 只读权限，`apps/desktop/scripts/after-pack.mjs`
  会在打包后授予；若目标目录继承自带有 AppContainer 包 SID 的目录，缺少该
  授权会让沙箱渲染进程拒绝启动。
- macOS 打包产物同样以 `dir` 目标产出（`Virealm.app`，arm64），未签名、未公证。
  `after-pack` 只校验 Mach-O、设置可执行位并确认运行时被打进
  `Contents/Resources/runtime/`；跨机分发需要开发者签名与公证，不在当前范围。
  打包后的 `.app` 与已运行的同名应用共用单实例锁，无法同时启动两个实例。
- macOS 运行时默认地址 `$TMPDIR/virealm-runtime-v2.sock` 受 `sun_path` 104 字节
  限制（实现要求 ≤100 字节）；桌面端在 `$TMPDIR` 过长时回退到 `/tmp`。用户直接
  调用 `serve --pipe` 时，过长的路径会得到明确错误。
- AppContainer Profile 按环境标识复用；删除需要显式调用，尚未与环境删除流程
  集成。失败启动可能留下临时 Profile 或 ACL 条目（探测用临时 Profile 会删除）。
- AppContainer 进程只能执行容器可读取的二进制；程序目录不在数据目录内时，
  调用方需要把该目录加入 `additionalRoots`（只读），否则启动会失败。

## 4. 桌面应用的限制

- 打包版本固定使用系统提供的用户数据目录（Windows 为 `%APPDATA%\Virealm`，
  macOS 为 `~/Library/Application Support/Virealm`），不接受
  `VIREALM_USER_DATA_DIR` 覆盖；该覆盖只对未打包的开发与测试构建生效。
- macOS 与 Windows 都采用「关闭窗口即退出」：这样运行时与 Chrome 会被清理。
  这是对 macOS 常驻菜单栏约定的有意偏离。
- 桌面端只管理**本机**环境，不提供远程控制或多机编排。
- 环境元数据保存在单个 JSON 文件中，没有数据库；单文件规模下足够，但不适合
  大量环境。
- 界面不提供批量操作（批量启动 / 停止 / 删除）与定时任务。
- 诊断日志保存在内存环形缓冲中，进程退出后不保留，也没有导出日志文件的入口。
- 截图与视觉检查是人工完成的（`docs/screenshots/`），没有像素级回归基线。

## 5. 测试盲区

- 未构造 PID 复用场景；身份设计依赖 PID + 创建时间，但未做对抗性验证。
- Rust 侧未测试多环境并发启动、同进程多实例、宿主崩溃恢复。
- 未验证非 UTF-8 参数与非法 UTF-16；Rust API 使用 `OsString`，但 JSON 契约与
  CLI 参数要求 UTF-8。
- 网络策略只验证了 loopback TCP 连接；DNS、UDP、外网访问未逐一验证。
- CLI（`virealm-runtime`）没有自动化测试，覆盖率为 0%。
- 平台层失败分支覆盖不足：`capability.rs` 64.53% 行覆盖，主要因为本机所有
  能力都可用，`unsupported` / `unavailable` 路径未被触发。
- 桌面集成测试使用 `--headless=new` 的 Chrome 启动，未验证有头窗口与多显示器
  下的表现。
- Electron 端到端测试只覆盖创建环境与重启恢复；启动 / 停止真实 Chrome 的界面
  路径由服务层集成测试覆盖，未在 Electron 内点击「启动」按钮做端到端验证。
- macOS 未做进程组逃逸的对抗性测试（子进程主动 `setsid`），也未测试运行时被
  `SIGKILL` 后 Chrome 的残留行为；这两点按设计是已知缺口，不是待验证的「可能
  可用」能力。
- macOS 的 `LOCAL_PEERCRED` 只验证了同用户本地连接路径，未测试其它 UID 或
  沙箱内进程的连接尝试。
- 未在受限令牌与 AppContainer 模式下做过桌面端的完整环境生命周期验证——这已由
  §1.1 证明**不可能**：Chromium 在这两种模式下无法启动，该路径由适配器的
  `unsupported_isolation` 覆盖，而不是由桌面端的生命周期测试覆盖。
- 未验证 Chromium 在「运行时已限制 + Chromium 自带沙箱」之外的其他组合（例如
  旧版 Chrome、Chrome Canary、Edge、Firefox）在受限令牌下的表现；结论目前只对
  Chrome 156.0.8078.48 成立。

## 6. 契约与诊断

- JSON 是文本契约，无法无损表达任意 Windows 路径与环境变量；运行时的公共 API
  使用宽字符串，CLI 在 UTF-8 边界上转换。
- 诊断事件只保留稳定代码与必要上下文，不持久化，也不包含完整环境变量、令牌或
  浏览器凭据。
- 错误中的 `windowsError`（Windows）与 `errno`（macOS）是诊断信息，不保证跨
  系统版本语义稳定。`platform_failure` 必须带 `operation`，并恰好带其中一个
  平台错误码。
- 环境元数据文件与设置文件在写入失败时保留旧内容，但两者之间没有事务：极端
  情况下可能存在「设置已更新、环境记录未更新」的不一致，需要用户再次保存。
