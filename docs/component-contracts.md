# 组件契约与边界

## 1. 契约来源

`packages/contracts` 是跨组件数据结构的唯一来源：

- `packages/contracts/schemas/*.json`：JSON Schema（Draft 2020-12），手写，
  是协议的唯一事实来源。
- `packages/contracts/src/generated/*.ts`：由 Schema 生成的 TypeScript 类型、
  打包后的 Schema 与枚举常量。**禁止手工修改**；用 `pnpm generate` 重新生成。
- `packages/contracts/src/protocol/` 与 `src/validators/`：手写的常量、错误
  构造、身份工具与运行时校验器。
- `packages/contracts/fixtures/`：valid/invalid 消息样例，供 TS 与后续 Rust
  契约测试共同使用。

Rust 侧对应类型位于 `crates/process-runtime/src/`。两侧不共享代码，只保证
序列化后的形状一致；`tests/generated.test.ts` 会比对协议版本与错误码集合。
任何形状变化必须同时更新 Schema、生成物、Rust 类型、fixtures 与本文档。

## 2. 边界：数据协议，不是传输层

Contracts 定义的是**消息内容**，不是消息如何到达：

- 不创建命名管道、Unix socket 或 Electron IPC 通道，不处理连接、重连、鉴权与
  帧边界。
- 不启动 Chrome/CDP，不创建进程，不调用平台 API。
- 不实现生命周期、权限或隔离策略；这些由 `crates/process-runtime` 裁决。
- 不规定 Desktop 与 Browser Adapter 的内部架构。

传输层必须在发送前校验请求、接收后校验响应。本包的校验用于尽早发现错误，
**不能替代运行时检查**：路径存在性、允许根目录、目录宽泛程度、令牌与能力
约束等只有运行时才能判断。

## 3. 命名与编码约定

| 项目 | 约定 | 示例 |
| --- | --- | --- |
| 对象字段 | camelCase | `workingDirectory`、`memoryLimitBytes` |
| 枚举值 | snake_case | `app_container`、`policy_violation` |
| 路径 | 绝对路径（Windows 盘符/UNC 或 POSIX `/`）；禁止通过 `PATH` 解析可执行文件 | `C:\\Program Files\\Virealm\\virealm-child.exe`、`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` |
| 时间 | Unix 毫秒整数 | `1768435200000` |
| 进程身份 | `<pid>:<creationTime100ns>` | `4242:134129088000000000` |
| FILETIME | 十进制字符串（u64） | `"134129088000000000"` |
| 空值 | 省略可选字段，不发送 `null` | — |

字段使用 camelCase 是 Rust 侧 `#[serde(rename_all = "camelCase")]` 的明确选择。
枚举值保留 snake_case，避免跨语言连字符转换规则。Windows 原生字符串在 Rust
侧使用 `OsString` / `PathBuf`，不假设 UTF-8；JSON 契约是有损边界，仅覆盖宿主
实际传递的文本字段。

`creationTime100ns` 必须用字符串：当前 FILETIME 值约为 `1.3e17`，超过
JavaScript 安全整数范围。`startedAtUnixMs` 必须精确等于
`floor(creationTime100ns / 10000) - 11644473600000`，校验器会验证两者一致。

## 4. 协议版本

`PROTOCOL_VERSION` 是整数，当前为 `2`，与 Rust 常量一致。

- 每条请求、响应、事件都携带 `protocolVersion`。
- 版本精确匹配；不协商、不降级、不猜测。
- 版本不匹配返回 `unsupported_protocol_version`，并在
  `details.supportedProtocolVersion` 中给出实现版本。
- 增加可选字段、新方法或新错误码可在同版本内演进；删除字段、改名、收紧约束、
  改变语义或必填性必须提升版本。
- 所有消息拒绝未知字段（`additionalProperties: false`）。安全相关字段不会被
  静默忽略；旧实现会整体拒绝携带新字段的消息。

`CONTRACT_VERSION`（Rust 常量，当前 `0.3.0`）描述 crate 公共 API 版本，与线
协议版本相互独立。macOS 支持以可选字段的形式增量加入，因此协议版本保持 `2`。

## 5. 消息与错误模型

请求使用统一信封：`protocolVersion`、`requestId`、`method`，可选 `params`。
成功响应回传 `requestId` 与 `method`，并携带 `ok: true` 与 `result`。错误响应
携带 `ok: false` 与 `error`。

```json
{
  "protocolVersion": 2,
  "requestId": "req_abc123",
  "method": "process.getStatus",
  "ok": false,
  "error": {
    "code": "platform_failure",
    "message": "CreateProcessW failed",
    "retryable": false,
    "details": { "operation": "CreateProcessW", "windowsError": 5 }
  }
}
```

| code | 含义 | 宿主处理 |
| --- | --- | --- |
| `invalid_request` | 请求结构或基本不变量不合法 | 修正请求；通常是调用方 bug |
| `unsupported_protocol_version` | 版本不受支持 | 升级/降级实现，不要重试原消息 |
| `unknown_method` | 方法不在协议内 | 修正调用方；检查版本 |
| `policy_violation` | 请求合法但被安全策略拒绝 | 展示策略原因，**不得**自动降级 |
| `capability_unavailable` | 平台原语缺失或当前会话不可用 | 展示能力缺口，建议调整环境 |
| `platform_failure` | Windows 调用失败 | 展示诊断；仅在确认无副作用后重试 |
| `process_not_found` | 进程实例不存在 | 刷新状态；不要复用旧身份 |
| `unsupported` | 契约存在但实现不支持 | 开发期信号，不向用户承诺 |
| `internal` | 运行时内部不变量被破坏 | 记录诊断并上报 |

`retryable` 表示“重复完全相同的请求不会新增副作用”，不表示“下一次很可能
成功”。失败的启动可能已经创建进程，重试前应先查询状态。

`details` 受错误码限制：`operation` 与 `windowsError` / `errno` 仅用于
`platform_failure`，其中 `operation` 必填，且 `windowsError`（Windows）与
`errno`（macOS）必须恰好出现一个；`method` 仅用于 `unknown_method`；
`supportedProtocolVersion` 仅用于 `unsupported_protocol_version`。错误消息与
details 不得包含堆栈、路径、令牌、Cookie 或凭据。

## 6. 能力状态

每个能力项给出四种状态之一：

| 状态 | 含义 |
| --- | --- |
| `supported` | 运行时实际调用并验证成功 |
| `unsupported` | 当前 Windows 版本 / 构建缺少该原语 |
| `unavailable` | 原语存在，但当前会话无法使用（例如权限不足） |
| `not_verified` | 尚未验证，不能视为可用 |

探测结论来自实际 API 调用，不来自版本号推断。Windows 报告覆盖 Job Object、
AppContainer、AppContainer ACL、受限令牌、进程缓解策略与 ETW。macOS 报告保留
这六个键并统一报 `unsupported`，另提供可选的 `processGroup`、`unixSocket`、
`processIdentity` 与 `resourceLimits`（按进程组演练结果判定）；两个资源上限在
macOS 上为 `unavailable`。消费方不得把 `not_verified` 或 `unavailable` 当作
可用。

## 7. 启动请求与状态

`LaunchParams` 包含环境标识、绝对可执行文件路径、独立参数数组、可选工作目录、
显式环境变量覆盖、数据目录与策略。`LaunchPolicy` 包含隔离模式、允许的程序
目录、文件访问策略、网络策略与容器限制。模式与策略联合校验：

- `managed` / `restricted`：文件策略为 `inherited`，网络为 `allow`。
- `app_container`：文件策略为 `restricted`，网络可为 `allow` / `deny`。
- `killOnClose` 必须为 `true`；进程数与内存上限若存在必须大于 0。

`ProcessStatus` 包含：

- `processInstanceId`：`<pid>:<creationTime100ns>`。PID 会被复用，单独 PID
  不构成身份。
- `pid`、`creationTime100ns`、`startedAtUnixMs`：身份与时间信息。
- `state`：`starting` / `running { pid }` / `exited { exitCode }`。
- `applied`：启动后从进程/作业回读的隔离证据，而不是请求的副本。
- `diagnostics`（可选）：运行时当前持有的诊断条目。

`managed` 只是生命周期约束，不是沙箱：Windows 为 Job Object，macOS 为 POSIX
进程组（`applied` 额外带可选的 `processGroupAttached` / `processGroupId` /
`killOnCloseArmed`）。`restricted` 增加低完整性受限令牌；`app_container` 增加
AppContainer 与显式文件能力（两者仅 Windows）。调用方展示隔离程度时应以
`applied` 为准。

事件目前只定义 `process.exited`，且**运行时尚未实现推送通道**。在该能力真正
实现前，不得声称支持事件。

## 8. 不变量

Process Runtime 在触达操作系统前必须拒绝以下请求（TS 校验器与 Schema 覆盖
其中可在数据层判断的部分，运行时才是权威）：

- 环境标识为空、超过 128 字节或包含控制字符。
- 可执行文件路径为空、不是绝对路径、不存在或不是文件。
- 允许的程序目录为空、不是绝对路径、不存在或不是目录。
- 可执行文件不在任一允许目录之内（按路径边界比较，防止
  `C:\Program Files Evil`；macOS 比较区分大小写）。
- 参数包含 NUL。
- 环境变量名为空、包含 `=` 或 NUL，或值包含 NUL。
- 环境变量名仅大小写不同地重复。
- 工作目录为空、不是绝对路径、不存在或不是目录。
- 数据目录为空、不是绝对路径、不存在、不是目录，或过于宽泛（卷根、用户主目录
  等；macOS 另外拒绝 `/`、`/Users`、`/Applications`、`/Library`、`/System`、
  `/private`、`/var`、`/tmp`、`/Volumes` 与 `$HOME` 本身，但允许其子目录）。
- 额外访问根目录过于宽泛，或与数据目录重复。
- `killOnClose` 为 `false`。
- `maxProcesses` 或 `memoryLimitBytes` 为 0。
- 模式与策略不匹配。

这些规则在 `crates/process-runtime/src/launch.rs` 与 `src/policy/mod.rs` 中实现，
并有对应测试。

## 9. 各组件职责

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| `packages/contracts` | 消息形状、生成类型、运行时校验、fixtures | 传输、进程创建、策略裁决 |
| Desktop（Electron） | 传输实现、请求/响应校验、UI 文案、进程身份缓存 | 修改协议形状、绕过运行时策略 |
| Browser Adapter | 把浏览器侧调用映射为协议消息、校验响应、暴露能力缺口 | 直接调用平台 API、伪造能力 |
| `crates/process-runtime` | 实际能力探测、创建进程、隔离与策略执行、权威校验 | 选择传输方式、定义 UI |

Browser Adapter 不需要依赖进程创建细节；它应检查 `CapabilityReport`，在能力
不足时明确失败或降级到调用方指定的替代方案，而不是假设 `not_verified` 可用。

## 10. 变更流程

1. 修改 `packages/contracts/schemas/` 中的定义。
2. 运行 `pnpm --filter @virealm/contracts generate`，提交生成物。
3. 修改 `process-runtime` 对应类型，保持序列化形状一致。
4. 更新 fixtures、测试、`docs/protocol.md` 与本文档。
5. 运行 `check-generated`、`lint`、`typecheck`、`test`、`build`，以及 Rust
   侧门禁。
6. 若为破坏性变更，提升 `PROTOCOL_VERSION` 并同步 Rust 常量。
