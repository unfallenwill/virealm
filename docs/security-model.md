# 安全模型

## 1. 信任边界

```
┌─────────────────────────────────────────────┐
│ Renderer (React)                            │  不可信输入来源
│ 无 Node.js、无文件系统、无命令执行           │
└──────────────────┬──────────────────────────┘
                   │ 语义化 IPC（白名单）
┌──────────────────▼──────────────────────────┐
│ Electron Main / Environment Service         │  可信宿主
│ 校验配置、协调生命周期                       │
└──────────────────┬──────────────────────────┘
                   │ Browser Adapter（浏览器配置）
┌──────────────────▼──────────────────────────┐
│ Process Runtime                             │  安全边界
│ 策略校验；Windows: 令牌/AppContainer/Job     │
│ macOS: POSIX 进程组与身份校验                │
└──────────────────┬──────────────────────────┘
                   │ 受约束的进程创建
┌──────────────────▼──────────────────────────┐
│ Chrome 进程树                                │  被隔离对象
└─────────────────────────────────────────────┘
```

## 2. 不可妥协的规则

1. **Renderer 不接触操作系统。** 不暴露 `ipcRenderer` 原语，不提供通用
   `invoke(channel, ...)`；preload 只暴露固定的环境操作集合。
2. **所有进程创建都经过 Process Runtime。** Browser Adapter 负责准备参数，
   但不拥有启动进程的能力。任何绕过运行时的 `spawn` 都是缺陷。
3. **能力未验证不等于能力可用。** 只有 `supported` 可以作为满足策略的依据；
   `unavailable` 与 `not_verified` 都必须让依赖该能力的策略失败。
4. **不自动降级。** 请求 AppContainer 但系统不可用时返回
   `capability_unavailable`，由用户显式选择是否改用其他策略。
5. **路径不由 `PATH` 解析。** 可执行文件必须是绝对路径，且必须位于调用方显式
   允许的程序目录内；比较按路径边界进行，不允许前缀伪装。
6. **隔离在进程恢复执行前完成。** Windows 使用挂起创建，先加入 Job Object、
   应用令牌 / AppContainer、设置 ACL，再从子进程读回证据。macOS 在创建进程时
   即通过 `process_group(0)` 进入独立进程组，随后用 `getpgid` 与
   `proc_pidinfo` 回验；两种平台都在验证失败时终止进程，不存在「先跑起来再补
   隔离」的窗口。
7. **不使用 shell 中间层。** 参数以数组传入 `CreateProcessW`（Windows）或
   `posix_spawn`（macOS），不经过 `cmd.exe`、PowerShell 或 shell 命令字符串。
8. **不通过关闭安全机制来「通过」。** 不关闭 Defender、不修改全局安全策略、
   不使用 `--no-sandbox`，也不为了测试扩大 ACL 授权范围。

## 3. 隔离原语与实际边界

| 原语 | 强制内容 | 不强制的内容 | 失败时 |
| --- | --- | --- | --- |
| Job Object | 进程树生命周期、进程数/内存限制、随句柄关闭而终止 | 文件、网络、注册表 | 返回 `platform_failure` |
| 受限令牌 | `DISABLE_MAX_PRIVILEGE` + Low 完整性 | 按路径限制文件、限制网络 | 返回 `unsupported` / `platform_failure` |
| AppContainer | 文件系统默认拒绝 + 显式目录 ACL、网络能力 SID | 精确的域名/端口级网络策略 | 返回 `capability_unavailable` 或 `platform_failure` |
| POSIX 进程组（macOS） | 整组信号终止、关闭时杀组、进程身份校验 | 文件、网络、资源上限 | 返回 `platform_failure`（`errno`） |
| 独立 `user-data-dir` | 浏览器配置与数据隔离 | 进程级隔离 | 拒绝启动，禁止回退到共享目录 |

必须区分各模式的强度：

- `managed` 只提供生命周期与资源约束。它**不是沙箱**：子进程持有调用方令牌
  （Windows）或与调用方相同的 UID（macOS），可以访问调用方可访问的一切。
- `restricted` 降低权限与完整性级别，使进程难以写入中完整性位置；它**不**按
  路径限制文件，也**不**限制网络。策略要求路径或网络隔离时会被拒绝，而不是
  假装满足。仅 Windows。
- `app_container` 是唯一声称文件/网络隔离的模式。文件访问只来自数据目录、
  数据目录下的 `Temp` 与显式 `additionalRoots`；网络在 `deny` 时不附加
  `internetClient` 等能力 SID，并在启动后回读令牌验证。仅 Windows。
- macOS 的 `managed` 是进程组：子进程可以自己调用 `setsid` 或双 fork 离开
  进程组，因此它是生命周期包含，不是强制边界。运行时不做文件或网络限制，
  也不拦截这种逃逸。

**这三种模式中的更强模式都不能承载 Chrome。** Windows 上 Chromium 的浏览器
进程要为自己创建沙箱，运行在运行时已经限制过的令牌里时这一步会失败，进程以
`STATUS_BREAKPOINT`（`0x80000003`）或其它构建相关中止码退出；macOS 上这两种
模式根本没有实现。因此对 Chrome 环境，实际可用的隔离路径只有 `managed`——
即生命周期约束，加上浏览器层的配置覆盖（时区、语言、视口）。这不是操作系统级
的指纹隔离，桌面界面不这样宣称。详见 `docs/known-limitations.md` §1.1 与 §1.2。

时区、语言、视口等浏览器配置属于 Browser Adapter，通过 CDP 应用并**验证**。
它们是功能性配置，不是安全边界；不能用来替代进程隔离。

## 4. 文件与网络策略（仅 Windows）

macOS 的 `managed` 不提供文件或网络限制：子进程继承用户权限，运行时配置中的
`fileAccess` 必须是 `inherited`、`networkAccess` 必须是 `allow`；其它组合会被
拒绝。以下规则只适用于 Windows 的 `app_container`：

- 数据目录必须已存在；AppContainer 只授予该目录和数据目录下 `Temp` 的访问。
- 额外根目录必须显式列出，不能是卷根、`%USERPROFILE%`、`%LOCALAPPDATA%`、
  `%PROGRAMFILES%`、`%ProgramData%` 等宽泛目录。
- 不允许把整个用户目录或整个磁盘开放给受限进程；这既是策略校验，也有测试覆盖。
- `networkAccess: deny` 只对 `app_container` 有效，回验要求子进程令牌中不存在
  网络能力 SID。

## 5. 主要威胁与对策

| 威胁 | 对策 |
| --- | --- |
| 配置注入：环境名/参数中夹带额外命令行开关 | 参数以数组传递，按 MSVC 规则转义；不经过 shell；Adapter 校验允许的开关 |
| 路径劫持：通过相对路径、`PATH` 或前缀伪装启动错误二进制 | 强制绝对路径 + `canonicalize` + 程序目录路径边界比较 |
| 环境变量注入：覆盖系统关键变量 | 显式覆盖集合；校验名称/值不含 NUL、名称不含 `=`、大小写不敏感去重 |
| 数据目录复用：两个环境共享 Cookie / 缓存 | 每个环境一个独立目录；目录不存在时拒绝启动 |
| 退出残留：UI 崩溃后浏览器继续运行 | Windows：Job Object `killOnClose`；macOS：正常退出执行 `killpg(SIGKILL)` 并回收 leader |
| 进程组逃逸（macOS） | 不声称阻止；文档与界面都说明 `managed` 不是沙箱，子进程可 `setsid` |
| 进程组 ID 复用（macOS） | 用 `waitid(WNOWAIT)` 观察退出但不回收，直到终止或关闭时才回收 leader，避免 `killpg` 命中被复用的 PGID |
| 本地端点被其它用户连接 | macOS socket 权限 `0600`，接受连接后校验 `LOCAL_PEERCRED` 的 UID 与当前用户一致；Windows 暂无管道 ACL |
| 部分启动：Chrome 已启动但配置验证失败 | 失败路径终止进程树并释放句柄，再向上报错 |
| 隔离未生效却被当作生效 | 启动后回读 Job 成员关系、AppContainer 标志、Low 完整性、能力 SID；macOS 回读 `getpgid` 与进程启动时间；失败即终止 |
| 诊断信息泄露 | 诊断只记录稳定代码与必要上下文；不记录令牌、Cookie、完整环境变量值 |

## 6. 尚未解决

- 运行时命名管道缺少 ACL 与调用方身份校验：桌面端只在自己创建的、名称随机的
  管道上通信，但没有做调用方鉴权。macOS 的 Unix socket 有 `0600` 与同 UID
  校验，两端不对称。
- macOS 没有内核级的「关闭即杀」：进程组依赖运行时进程执行清理。运行时被
  `SIGKILL` 时，内核不会代为终止整组，Chrome 可能残留（Windows 的 Job Object
  由内核保证）。桌面正常退出会显式终止环境。
- macOS 的进程组可以被 `setsid` 或双 fork 逃逸；这不是可修复的实现缺口，而是
  `managed` 层级的定义。
- Windows NSIS 安装器未签名，SmartScreen 可能拦截。安装器在 `customInstall`
  中为 `$INSTDIR` 递归授予 `ALL APPLICATION PACKAGES` 读/执行权限；这是
  Electron 沙箱渲染进程读取应用目录的必要条件，范围仅限安装目录，不包含
  用户数据。
- macOS DMG 与其中的 `.app` 未签名、未公证，跨机分发会被 Gatekeeper 拦截；
  只验证了本机 Apple silicon。
- ETW 目前标记为 `not_verified`，尚未作为运行时诊断来源。
- Chrome 二进制来源校验（签名、版本、更新通道）。
- AppContainer Profile 按环境复用，但删除只在显式调用时发生；桌面端的「删除
  数据」只清理浏览器 Profile 目录，不回收 AppContainer Profile 与其 ACL 条目。
- 桌面端的 JSON 元数据文件没有加密与文件级 ACL 加固，依赖用户目录的默认权限。
- 没有对渲染进程内容做 CSP 之外的额外来源校验（例如外链与图片请求的出网
  白名单）。
- 桌面端保存与启动环境时拒绝 `restricted` 与 `app_container`，因此 Chrome 环境
  实际上没有可用的文件/网络级隔离，只剩生命周期约束（Windows 为 Job Object，
  macOS 为进程组）；这是 Chromium 与平台能力的限制，不是可以靠实现补齐的缺口。

已解决或已实现的边界（不再列为风险）：

- 环境配置的持久化位置与内容：桌面端只保存名称、浏览器路径、时区、语言、视口、
  隔离模式与启动参数，不保存 Cookie、密码或令牌。
- 运行时以独立进程提供本地端点接口（协议 2）：Windows 命名管道、macOS Unix
  socket；桌面端通过 `RuntimeController` 管理它的启动、探测、重启与自己的
  socket 清理。
