# Virealm 进程协议

本文描述 `@virealm/contracts` 定义的线协议。字段形状以
`packages/contracts/schemas/` 为准；本文解释语义与规则，不替代 Schema。

- Schema：JSON Schema Draft 2020-12
- 当前版本：`2`
- 编码：JSON 对象；字段 camelCase，枚举值 snake_case
- 未知字段：所有对象均为 `additionalProperties: false`，出现未知字段即拒绝

## 1. 边界

Contracts 是**数据协议**，不是传输层：

- 不定义 Named Pipe 名称、帧格式、连接生命周期或鉴权。
- 不定义 Chrome/CDP 启动方式，也不定义 Electron IPC 通道。
- 不创建进程、不调用 Windows API、不决定隔离策略。
- 传输层负责把完整的 JSON 消息送达；协议只规定消息内容。

任何调用方（Desktop、Browser Adapter、测试工具）在发送前都应校验请求，在
接收后都应校验响应。运行时的策略检查仍然是权威，客户端的校验不能替代它。

## 2. 标识符

| 标识符 | 格式 | 语义 |
| --- | --- | --- |
| `protocolVersion` | 整数，当前固定为 `2` | 每条请求、响应、事件都携带 |
| `requestId` | `req_[A-Za-z0-9_-]{1,64}` | 调用方生成，响应原样回传 |
| `eventId` | `evt_[A-Za-z0-9_-]{1,64}` | 每条事件唯一 |
| `environmentId` | 1–128 字符，无控制字符 | 不透明环境标识，由创建方生成 |
| `processInstanceId` | `<pid>:<creationTime100ns>` | 进程的持久身份 |

`pid` 会被 Windows 复用，因此**单独的 PID 不是身份**。所有引用进程的请求都
使用 `processInstanceId`；状态中的 `pid` 只用于诊断与人工排查。

`creationTime100ns` 是 Windows FILETIME 的十进制字符串。真实值约为 `1.3e17`，
超过 JavaScript 的 `Number.MAX_SAFE_INTEGER`，因此绝不能用 JSON 数字传输。
`startedAtUnixMs` 必须由它精确推导：

```
startedAtUnixMs = floor(creationTime100ns / 10000) - 11644473600000
```

## 3. 请求

统一信封：

```json
{
  "protocolVersion": 2,
  "requestId": "req_abc123",
  "method": "process.getStatus",
  "params": { "processInstanceId": "4242:134129088000000000" }
}
```

`runtime.getCapabilities` 没有 `params`。其余方法必须携带 `params`，且
`method` 与 `params` 的形状必须匹配；两者是联合校验的。

| 方法 | `params` | 成功结果 | Rust 对应 |
| --- | --- | --- | --- |
| `runtime.getCapabilities` | 无 | `CapabilityReport` | `probe_capabilities` |
| `process.launch` | `LaunchParams` | `ProcessStatus` | `launch` |
| `process.getStatus` | `ProcessReference` | `ProcessStatus` | `ManagedProcess::status` |
| `process.terminate` | `ProcessReference` | `ProcessStatus` | `ManagedProcess::terminate` |
| `process.getDiagnostics` | `ProcessReference` | `ProcessDiagnosticsResult` | `ManagedProcess::diagnostics` |

`ProcessReference` 只包含 `processInstanceId`。

### 3.1 启动参数

```json
{
  "environmentId": "env-demo-01",
  "executable": "C:\\Program Files\\Virealm\\virealm-child.exe",
  "arguments": ["--profile", "C:\\Users\\demo\\AppData\\Local\\Virealm\\env-demo-01"],
  "workingDirectory": "C:\\Program Files\\Virealm",
  "environmentOverrides": { "VIREALM_ENV": "env-demo-01" },
  "dataDirectory": "C:\\Users\\demo\\AppData\\Local\\Virealm\\env-demo-01",
  "policy": {
    "isolation": "managed",
    "allowedProgramRoots": ["C:\\Program Files\\Virealm"],
    "fileAccess": { "kind": "inherited" },
    "networkAccess": "allow",
    "containment": { "killOnClose": true, "maxProcesses": 8 }
  }
}
```

字段语义：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `environmentId` | 是 | 1–128 字符，无控制字符 |
| `executable` | 是 | 绝对 Windows 路径（盘符或 UNC），不使用 `PATH` 解析 |
| `arguments` | 是 | 独立参数数组，调用方不做字符串拼接；每个参数不含 NUL |
| `workingDirectory` | 否 | 绝对路径 |
| `environmentOverrides` | 否 | 覆盖继承环境；名称不含 `=`/NUL，值不含 NUL；大小写折叠后不得重复 |
| `dataDirectory` | 是 | 该环境的私有数据目录，绝对路径 |
| `policy` | 是 | 与隔离模式联合校验 |

策略与模式必须一致：

- `managed` / `restricted`：`fileAccess.kind = "inherited"`，
  `networkAccess = "allow"`。
- `app_container`：`fileAccess.kind = "restricted"`，其中
  `dataDirectory` 是数据目录的访问级别（`read_only` / `read_write`），
  `additionalRoots` 列出额外路径及其访问级别；`networkAccess` 可为
  `allow` 或 `deny`。
- `containment.killOnClose` 必须为 `true`；`maxProcesses`、
  `memoryLimitBytes` 若存在必须大于 0；`allowedProgramRoots` 至少 1 项。
- 每个模式的 `allowedProgramRoots` 最多 32 项，`additionalRoots` 最多 32 项，
  `environmentOverrides` 最多 256 项，`arguments` 最多 1024 项。

Schema 只能检查结构与明显边界。路径是否存在、是否在允许根目录内、目录是否
过于宽泛（例如卷根或用户主目录）等判断由运行时完成，见
`crates/process-runtime/src/launch.rs` 与 `src/policy/mod.rs`。

## 4. 响应

成功响应重复 `method`，调用方无需根据请求猜测结果类型：

```json
{
  "protocolVersion": 2,
  "requestId": "req_abc123",
  "method": "process.getStatus",
  "ok": true,
  "result": { "...": "ProcessStatus" }
}
```

| `method` | `result` |
| --- | --- |
| `runtime.getCapabilities` | `CapabilityReport` |
| `process.launch` | `ProcessStatus` |
| `process.getStatus` | `ProcessStatus` |
| `process.terminate` | `ProcessStatus` |
| `process.getDiagnostics` | `ProcessDiagnosticsResult` |

错误响应：

```json
{
  "protocolVersion": 2,
  "requestId": "req_abc123",
  "method": "process.getStatus",
  "ok": false,
  "error": {
    "code": "process_not_found",
    "message": "no managed process with this instance id",
    "retryable": true
  }
}
```

`requestId` 在能关联到请求时回传；`unsupported_protocol_version` 或无法解析
信封时可以省略。`method` 只在方法可识别时回传。

## 5. 错误模型

`ContractError`：

| 字段 | 必填 | 语义 |
| --- | --- | --- |
| `code` | 是 | 稳定分类，客户端据此分支 |
| `message` | 是 | 1–2048 字符的简短诊断，不是最终 UI 文案，不含堆栈 |
| `retryable` | 是 | 重试完全相同的请求是否安全 |
| `details` | 否 | 结构化诊断，受错误码限制 |

`retryable` 表示“重复该请求不会新增副作用”，而不是“下一次很可能成功”。
运行时失败（`capability_unavailable`、`platform_failure`、`internal`）为
`false`，因为失败的启动可能已经创建了平台状态。

| code | 来源 | 含义 | `retryable` |
| --- | --- | --- | --- |
| `invalid_request` | 运行时 | 结构或基本不变量不合法 | `true` |
| `policy_violation` | 运行时 | 请求合法但被安全策略拒绝 | `true` |
| `capability_unavailable` | 运行时 | 平台原语缺失或当前会话不可用 | `false` |
| `platform_failure` | 运行时 | Windows API 调用失败 | `false` |
| `unsupported` | 运行时 | 契约存在但当前平台/实现不支持 | `true` |
| `internal` | 运行时 | 运行时内部不变量被破坏 | `false` |
| `unsupported_protocol_version` | 协议 | 版本不是本实现支持的整数 | `true` |
| `unknown_method` | 协议 | 方法名不在协议内 | `true` |
| `process_not_found` | 协议 | 引用的进程实例不存在 | `true` |

前三类协议级错误是 `ErrorCode` 的扩展；六个运行时错误码与 Rust
`virealm_process_runtime::ErrorCode` 的 snake_case 序列化值一一对应。
`tests/generated.test.ts` 会比对两侧集合。

`details` 只允许以下字段，且受错误码约束：

| 字段 | 允许的错误码 | 说明 |
| --- | --- | --- |
| `operation` | `platform_failure`（必填） | 失败的 Windows API 名称 |
| `windowsError` | `platform_failure`（必填） | 原始 Win32 错误码，仅诊断 |
| `method` | `unknown_method`（必填） | 可打印 ASCII 方法名，最长 128 |
| `supportedProtocolVersion` | `unsupported_protocol_version`（必填） | 实现支持的版本 |

错误消息与 details 不得包含堆栈、文件路径、令牌、Cookie 或凭据。UI 文案应由
宿主根据 `code` 与上下文生成。

## 6. 能力报告

```json
{
  "platform": {
    "os": "Windows 11 Pro for Workstations",
    "version": { "major": 10, "minor": 0, "build": 26300 },
    "architecture": "x86_64",
    "elevated": false,
    "integrityLevel": "medium"
  },
  "jobObject": { "state": "supported" },
  "appContainer": { "state": "unavailable", "detail": "profile creation denied" },
  "appContainerAcl": { "state": "not_verified" },
  "restrictedToken": { "state": "supported" },
  "processMitigation": { "state": "not_verified" },
  "etw": { "state": "unsupported", "detail": "no session provider" },
  "notes": []
}
```

每个能力项至少包含 `state`，可选 `detail`（1–1024 字符）：

| 状态 | 含义 |
| --- | --- |
| `supported` | 运行时实际调用并验证成功 |
| `unsupported` | 当前平台/构建缺少该原语 |
| `unavailable` | 原语存在，但当前会话或权限下不可用 |
| `not_verified` | 本构建未验证，**不能视为可用** |

状态只能来自实际探测，不能由 Windows 版本号推断。消费方不得把
`not_verified` 或 `unavailable` 当作可用；需要某能力时应显式降级或失败。

`PlatformInfo` 中的 `elevated` 指调用进程令牌是否提升，`integrityLevel` 为
`untrusted` / `low` / `medium` / `high` / `system` / `protected` / `unknown`。

## 7. 进程状态

```json
{
  "processInstanceId": "4242:134129088000000000",
  "pid": 4242,
  "creationTime100ns": "134129088000000000",
  "startedAtUnixMs": 1768435200000,
  "state": { "state": "running", "pid": 4242 },
  "applied": {
    "mode": "managed",
    "jobObjectAttached": true,
    "appContainerToken": false,
    "restrictedToken": false,
    "lowIntegrity": false,
    "fileAccessRestricted": false,
    "networkAccess": "allow",
    "networkCapabilitiesVerified": false
  },
  "diagnostics": []
}
```

`state` 是带标签的联合：

- `{ "state": "starting" }`
- `{ "state": "running", "pid": 4242 }`
- `{ "state": "exited", "exitCode": 0 }`

退出码只在 `exited` 状态下存在，缺失值不会被误读为成功。`running.pid` 必须
等于顶层的 `pid`。

`applied` 是从已创建进程与其 Job Object 回读的证据，不是请求策略的副本。
字段含义：

| 字段 | 含义 |
| --- | --- |
| `mode` | `managed` / `restricted` / `app_container` |
| `jobObjectAttached` | 进程已加入 Job Object |
| `appContainerToken` | 子进程令牌是 AppContainer 令牌 |
| `restrictedToken` | 子进程令牌是受限令牌 |
| `lowIntegrity` | 子进程为低完整性级别 |
| `fileAccessRestricted` | 文件访问由 AppContainer 能力限制 |
| `networkAccess` | `allow` / `deny` |
| `networkCapabilitiesVerified` | 子进程能力 SID 与网络策略一致 |

`managed` 只是 Job Object 生命周期约束，不是沙箱；调用方不应把它宣传为隔离。
`diagnostics` 可选，因为传输层可能通过 `process.getDiagnostics` 单独提供。
诊断条目包含 `timestampUnixMs`、`level`、`component`、`code`、`message` 与
可选 `context`（字符串键值，不得含敏感信息）。

## 8. 事件

当前只定义 `process.exited`：

```json
{
  "protocolVersion": 2,
  "eventId": "evt_exit_001",
  "event": "process.exited",
  "occurredAtUnixMs": 1768435200000,
  "environmentId": "env-demo-01",
  "processInstanceId": "4242:134129088000000000",
  "exitCode": 0
}
```

**实现状态：未接通。** Rust 运行时目前没有推送通道，也没有任何代码会发出该
事件。此契约用于未来适配层；在运行时或适配层真正实现之前，不得在能力报告或
UI 中声称支持事件推送。调用方可使用 `process.getStatus` 轮询作为当前手段。

## 9. 版本规则

- 每条消息必须携带 `protocolVersion`，且在本版本中必须精确等于 `2`。
  请求、响应与事件是顶层消息；`CapabilityReport`、`ProcessStatus`、
  `ContractError` 是响应载荷，版本由外层信封携带。
- 不做版本协商、范围匹配或向后兼容降级。收到其他版本时返回
  `unsupported_protocol_version`，并带 `details.supportedProtocolVersion`。
- 增加可选字段、增加新方法或新错误码：可以在同一版本内演进，但严格未知字段
  检查意味着旧实现会拒绝携带新字段的消息，因此跨版本混用时应先升级运行时。
- 删除字段、改名、收紧约束、改变语义、改变必填性、改变枚举含义：破坏性变更，
  必须提升 `PROTOCOL_VERSION`，并同步 Rust 常量。
- 未知的安全相关字段不会被忽略；它们会被整体拒绝。这是有意的失败模式。

## 10. 客户端处理建议

1. 发送前调用 `validateRequest`；校验失败时修正调用方，不要重试同一请求。
2. 接收后调用 `validateResponse`；失败说明对端违反协议，应记录并终止该次
   交互，而不是猜测字段。
3. 按 `code` 分支：策略拒绝不得静默降级为普通启动；能力缺失应展示具体缺口。
4. 只在 `retryable === true` 且操作本身幂等时重试；`process.launch` 失败后
   重试前应先用 `process.getStatus` 确认是否已创建实例。
5. 进程身份始终使用 `processInstanceId`，不要缓存并复用裸 PID。
