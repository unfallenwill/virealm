# 已知限制

本文件记录当前实现**没有**做到或**没有**验证的事情。它和测试报告一起使用：
未列在此处的能力不应被假定存在。

## 1. 隔离强度

- `managed` 不是沙箱。子进程使用调用方令牌，拥有调用方的文件、网络与注册表
  访问权限；Job Object 只约束生命周期与部分资源。
- `restricted` 只移除特权并降低到 Low 完整性。它不按路径限制文件，也不限制
  网络；`networkAccess: deny` 与 `fileAccess: restricted` 在该模式下会被拒绝。
- `app_container` 的文件隔离是**目录级 ACL**：授予数据目录、数据目录下的
  `Temp` 与显式额外根目录，其余路径依赖 AppContainer 默认拒绝。它不提供单文件
  白名单、不拦截已授权目录内的任意读写。
- `app_container` 的网络隔离是**能力级**的（是否附加 `internetClient` 等
  capability SID），不是域名、端口或协议级防火墙。`deny` 不附加网络能力，
  但没有实现按目标地址过滤。
- 桌面界面只把上述模式作为「隔离方式」列出，不声称浏览器层配置（时区、语言、
  视口）构成操作系统级的指纹隔离。

### 1.1 Chrome 不能在受限令牌 / AppContainer 下运行（已实测确认）

`restricted` 与 `app_container` 都**无法**承载 Chrome。这不是运行时实现缺失，
而是 Chromium 自身的约束：Chrome 的浏览器进程要为自己创建沙箱（Job Object +
受限令牌），当它已经运行在运行时预先限制过的令牌里时，这一步会失败并触发
Chromium 的 `CHECK` 中止，进程以 `STATUS_BREAKPOINT`（`0x80000003`）退出，
不写入任何 Profile 数据。

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
  但当被拉起的可执行文件是 Chromium 系浏览器并以 `STATUS_BREAKPOINT` 中止时，
  适配器会把它翻译成 `unsupported_isolation`，并带上 `isolation` 与 `exitCode`。
- 没有使用 `--no-sandbox` 之类的手段绕过：该做法是移除沙箱而不是让 Chromium
  在受限令牌下正常工作，等于放弃隔离本身，与项目的隔离目标相反。
- 真正可用的隔离路径是 `managed`（Job Object 生命周期与资源约束）加上浏览器层
  的配置覆盖（时区、语言、视口）。这两者都不是操作系统级的指纹隔离。


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

- 只在 Windows 11 26300 x86_64、非管理员、Medium 完整性下验证。
  未在 Windows 10 早期构建、Windows Server、ARM64 或高完整性/管理员会话中验证。
- 未在 Windows CI 上运行。`docs/test-report.md` 中的结果全部来自单台开发机；
  CI 工作流已写好（`.github/workflows/ci.yml`），但没有实际执行记录。
- Chrome 兼容性测试需要本机安装 Chrome；本机使用 Chrome 156.0.8078.48。
  Chrome 在 AppContainer 下运行所需的额外授权**已实测失败**：`ALL APPLICATION
  PACKAGES` 对 `C:\Program Files` 已经授予 RX 且子目录继承 GR/GE，额外授权是
  冗余的；真正的障碍是 Chromium 无法在受限令牌内启动自己的沙箱（见 §1.1）。
- 打包产物以 `dir` 目标产出，尚未生成安装器（NSIS/MSI）。安装目录需要
  `ALL APPLICATION PACKAGES` 只读权限，`apps/desktop/scripts/after-pack.mjs`
  会在打包后授予；若目标目录继承自带有 AppContainer 包 SID 的目录，缺少该
  授权会让沙箱渲染进程拒绝启动。
- AppContainer Profile 按环境标识复用；删除需要显式调用，尚未与环境删除流程
  集成。失败启动可能留下临时 Profile 或 ACL 条目（探测用临时 Profile 会删除）。
- AppContainer 进程只能执行容器可读取的二进制；程序目录不在数据目录内时，
  调用方需要把该目录加入 `additionalRoots`（只读），否则启动会失败。

## 4. 桌面应用的限制

- 打包版本固定使用系统提供的用户数据目录（`%APPDATA%\Virealm`），不接受
  `VIREALM_USER_DATA_DIR` 覆盖；该覆盖只对未打包的开发与测试构建生效。
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
- 错误中的 `windowsError` 是诊断信息，不保证跨 Windows 版本语义稳定。
- 环境元数据文件与设置文件在写入失败时保留旧内容，但两者之间没有事务：极端
  情况下可能存在「设置已更新、环境记录未更新」的不一致，需要用户再次保存。
