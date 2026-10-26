# virealm-process-runtime

Virealm 的 Rust 进程运行时。它只负责与操作系统边界相关的事情：

- 探测平台能力：Windows 为 Job Object、AppContainer、受限令牌、ACL、进程缓解；
  macOS 为 POSIX 进程组、Unix domain socket 与进程身份。
- 按策略启动进程，并在恢复执行前完成隔离配置与验证。
- 通过 Job Object（Windows）或进程组（macOS）管理进程树生命周期。
- 输出结构化状态、错误与诊断事件。

它**不**知道 Chrome、CDP、时区、语言或网页配置。这些属于 `browser-adapter`。

## 公共 API

```rust
use virealm_process_runtime::{
    probe_capabilities, validate_launch_spec, launch, LaunchSpec,
};

let report = probe_capabilities();
// report.job_object.state == CapabilityState::Supported
```

| 函数 | 作用 |
| --- | --- |
| `probe_capabilities()` | 真实调用平台 API（Win32 或 POSIX）验证各原语，返回四态报告 |
| `validate_launch_spec(&spec)` | 只在用户态校验请求与策略，不创建进程 |
| `launch(&spec)` | 校验、创建、应用并验证隔离，返回 `ManagedProcess` |
| `ManagedProcess::status()` | 返回 PID + 创建时间、状态与已验证的隔离 |
| `ManagedProcess::terminate()` | 终止进程树；重复调用返回是否仍有存活进程 |
| `ManagedProcess::diagnostics()` | 启动与生命周期中的结构化事件 |

Windows 上 `ManagedProcess` 持有 Job Object 与进程句柄；因为 Job 设置了
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，drop 时会终止仍存活的进程树。macOS 上它
持有子进程 PID 与创建时间，drop 时向进程组发 `SIGKILL` 并回收 leader——这是
运行时进程执行的清理，不是内核保证：运行时被 `SIGKILL` 时不会代为杀树。

## 隔离模式

| 模式 | 平台 | 实际执行的约束 |
| --- | --- | --- |
| `managed` | Windows / macOS | 普通进程 + Job Object（Windows）或 POSIX 进程组（macOS）。**不是沙箱**，继承调用方的文件与网络权限。 |
| `restricted` | 仅 Windows | 受限令牌（`DISABLE_MAX_PRIVILEGE`）+ Low 完整性。降低对中完整性位置的写入能力，但不按路径限制文件，也不限制网络。 |
| `app_container` | 仅 Windows | AppContainer 令牌 + 按目录的 ACL + 网络能力控制。唯一能够声称文件/网络隔离的模式。 |

请求与模式不匹配的策略会被拒绝（例如 `managed` + `networkDeny`），不会降级。
`app_container` 不可用时返回 `capability_unavailable`。

macOS **只实现** `managed`。`restricted` / `app_container` 与
`maxProcesses` / `memoryLimitBytes` 会在创建进程前以 `capability_unavailable`
被拒绝，不用 `RLIMIT` 近似。macOS 的进程组子进程可以 `setsid` 或双 fork 离开，
因此它是生命周期包含，不是强制边界。详见
[`docs/known-limitations.md`](../../docs/known-limitations.md) §1.2。

## AppContainer 的文件访问（仅 Windows）

- 数据目录（`dataDirectory`）按 `readOnly` / `readWrite` 授予。
- 额外根目录只能通过 `additionalRoots` 显式授予。
- 系统拒绝把整盘、用户主目录等宽泛根目录作为数据目录。
- 其余路径不授予访问，由 AppContainer 的默认拒绝生效。

## 命令行

CLI 用于从外部调用公共 API，不构成第二套策略实现。

```bash
cargo run -p virealm-process-runtime --bin virealm-runtime -- probe
```

```bash
cargo run -p virealm-process-runtime --bin virealm-runtime -- run \
  --environment-id demo --isolation app-container \
  --executable "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" \
  --program-root "C:\\Program Files\\Google\\Chrome\\Application" \
  --data-directory "C:\\Users\\me\\AppData\\Local\\Virealm\\demo" \
  --network deny --file-access read-write --timeout-ms 5000
```

macOS 上等价的 `managed` 调用：

```bash
cargo run -p virealm-process-runtime --bin virealm-runtime -- run \
  --environment-id demo --isolation managed \
  --executable "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --program-root "/Applications/Google Chrome.app" \
  --data-directory "$HOME/Library/Application Support/Virealm/demo" \
  --timeout-ms 5000
```

`serve --pipe <address>` 在两个平台上都使用同一参数名：Windows 是命名管道，macOS
是 Unix domain socket（默认 `$TMPDIR/virealm-runtime-v2.sock`，要求路径不超过
100 字节，权限 `0600`，并校验连接方与当前进程同 UID）。

## 分层

```
src/
├── capabilities/     四态能力探测
├── diagnostics/      结构化诊断事件（不输出敏感值）
├── policy/           平台无关的启动策略与校验
├── process/          进程身份、状态、句柄与生命周期
├── platform/         平台门面与平台后端
│   ├── windows/      Job Object / AppContainer / Token / 进程创建 / 命名管道
│   └── macos/        进程组 / proc_pidinfo 身份 / Unix socket
├── launch.rs         公共启动入口与请求规范化
└── error.rs          错误分类与序列化形式
```

平台后端保持为模块而不是独立 crate：它们共享请求校验、策略与线格式，拆成 crate
只会增加接口维护成本。

## 命令

```bash
cargo test -p virealm-process-runtime
cargo clippy -p virealm-process-runtime --all-targets -- -D warnings
```

Windows 集成测试需要当前用户能够创建 Job Object 与 AppContainer Profile；macOS
集成测试（`tests/macos_launch.rs`）覆盖进程组、身份校验、socket 权限与陈旧
socket 清理，需要当前用户能创建进程组与 Unix socket。测试结果与未覆盖项见仓库
根目录的 `docs/test-report.md`。
