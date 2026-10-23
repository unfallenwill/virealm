# @virealm/contracts

Virealm Process Runtime 与 TypeScript 调用方之间的**数据协议包**：JSON Schema
（Draft 2020-12）是唯一事实来源，TypeScript 类型由 Schema 生成，运行时校验器
负责在执行任何操作前拒绝不合法的消息。

当前线协议版本为 `2`，与 `crates/process-runtime` 中的 `PROTOCOL_VERSION` 一致。

## 1. 职责与非职责

本包负责：

- 定义请求、响应、事件、错误、能力报告与进程状态的数据形状。
- 由 Schema 生成 TypeScript 类型与常量，保证类型和 Schema 不会各自漂移。
- 对每个公开输入做运行时校验（不只是编译期类型），返回结构化问题列表。
- 提供稳定的错误码、进程身份与时间转换工具。
- 提供可被 Rust 契约测试复用的 JSON fixtures。

本包**不**负责，也不应包含：

- Named Pipe、WebSocket、HTTP 或 Electron IPC 的建立与生命周期。
- Chrome/CDP 启动、进程创建、Job Object、AppContainer、Windows API 调用。
- 权限模型、隔离策略的最终裁决；这些属于 `crates/process-runtime`。
- 重试、超时、重连等传输层行为。

Contracts 只描述“线上传什么”，传输方式由宿主决定。运行时才是策略与安全语义
的权威；本包的校验用于尽早失败，不替代运行时的检查。

## 2. 目录

```
schemas/                 JSON Schema 源文件
  common/                标识符、错误、能力、诊断
  process/               启动、隔离、状态、结果
  protocol/              方法、请求、响应、事件
  index.schema.json      打包入口（oneOf 全部消息）
src/
  generated/             由 Schema 生成，禁止手工修改
  protocol/              常量、错误构造、进程身份工具
  validators/            Ajv 2020 校验器与跨字段语义检查
  index.ts               公开导出
fixtures/                valid/ 与 invalid/ JSON 样例及 manifest.json
scripts/                 generate.mjs、check-generated.mjs、generate-lib.mjs
tests/                   Vitest 契约测试
```

## 3. 安装、构建与检查

在仓库根目录使用 pnpm workspace（`pnpm` 未全局安装时用 `corepack pnpm`）：

```bash
corepack pnpm install
corepack pnpm --filter @virealm/contracts build
```

包内脚本：

| 命令 | 作用 |
| --- | --- |
| `pnpm generate` | 由 `schemas/` 重新生成 `src/generated/` |
| `pnpm check-generated` | 重新生成并比较，生成物不一致时退出码为 1 |
| `pnpm lint` | ESLint（flat config，严格类型规则） |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Vitest + V8 覆盖率（核心校验分支阈值 90%） |
| `pnpm build` | 输出 `dist/`（JS + 声明 + sourcemap） |

根目录另有 `contracts:*` 与 `check` 脚本；CI 必须依次执行 `check-generated`、
`lint`、`typecheck`、`test`、`build`。

## 4. Schema 是唯一事实来源

`schemas/` 是手写文件，`src/generated/` 是生成物。

- 生成器先解析各文件之间的相对 `$ref`，把全部定义打包进一个文档
  （`index.schema.json` 为入口，`x-include` 用于引入没有消息直接引用的
  `MethodName`）。
- 打包结果同时产出三份文件：`protocol.ts`（类型）、`schemas.ts`（打包后的
  Schema 与 `$id`）、`constants.ts`（版本、方法、错误码、枚举数组）。
- 生成是确定性的：相同 Schema 必须产生逐字节相同的输出。
  `check-generated` 在 CI 中强制执行这一点。

**不要手工编辑 `src/generated/`**。需要改类型时改 Schema，然后运行
`pnpm generate` 并提交生成结果。

## 5. 运行时校验

所有公开输入都通过运行时校验。校验器使用 Ajv 2020 严格模式：
`allErrors: true`、不做类型强转、不填充默认值、不移除未知字段。

```ts
import { validateRequest, validateResponse } from "@virealm/contracts";

const request = {
  protocolVersion: 2,
  requestId: "req_launch_001",
  method: "process.launch",
  params: {
    environmentId: "env-demo-01",
    executable: "C:\\Program Files\\Virealm\\virealm-child.exe",
    arguments: [],
    dataDirectory: "C:\\Users\\demo\\AppData\\Local\\Virealm\\env-demo-01",
    policy: {
      isolation: "managed",
      allowedProgramRoots: ["C:\\Program Files\\Virealm"],
      fileAccess: { kind: "inherited" },
      networkAccess: "allow",
      containment: { killOnClose: true },
    },
  },
};

const result = validateRequest(request);
if (!result.ok) {
  // issues 是结构化数组；path 为 JSON Pointer，keyword 为 Schema 关键字
  // 或 "contractSemantics"。
  console.error(result.issues);
} else {
  // result.value 已通过校验，可直接编码发送。
  send(result.value);
}

const incoming: unknown = receive();
const parsed = validateResponse(incoming);
if (!parsed.ok) {
  throw new Error(`runtime violated the contract: ${JSON.stringify(parsed.issues)}`);
}
```

校验器覆盖的语义规则（Schema 无法单独表达的跨字段约束）：

- `Request`：`process.launch` 的环境变量名按 ASCII 大小写折叠后不得重复。
- `ProcessStatus`：`processInstanceId` 必须等于 `<pid>:<creationTime100ns>`；
  `startedAtUnixMs` 必须精确等于
  `floor(creationTime100ns / 10000) - 11644473600000`；`running` 状态的 PID
  必须与状态 PID 一致；`creationTime100ns` 不得超过 `u64` 上限。
- `ContractError`：`unsupported_protocol_version`、`unknown_method`、
  `platform_failure` 必须携带各自要求的 `details`；其他错误码不得携带这些
  字段；`unsupported_protocol_version` 与 `unknown_method` 的 `retryable`
  必须为 `true`。
- `Response`：成功响应中的进程状态同样执行上述状态语义检查；错误响应执行
  错误语义检查。

`validateRequest/Response/Event/CapabilityReport/ProcessStatus/Error` 对任意
`unknown` 输入都不会抛出异常。

## 6. Fixtures 与测试

`fixtures/manifest.json` 是唯一索引，`valid/` 中的每个文件必须通过对应校验器，
`invalid/` 中的每个文件必须失败并产生 `manifest.json` 声明的 `path` 与
`keyword`。新增样例时：

1. 放入 `fixtures/valid/` 或 `fixtures/invalid/`。
2. 在 `manifest.json` 中登记 `file` 与 `kind`；非法样例还要登记期望的
   `expect.path`、`expect.keyword`，必要时包含 `missingProperty` /
   `additionalProperty`。
3. 运行 `pnpm test`。测试会验证索引完整性与每个期望是否真的出现。

fixtures 保持稳定、可读，后续 Rust 契约测试可直接读取这些 JSON 文件。

## 7. 修改协议

1. 修改或新增 `schemas/` 中的定义，保持字段 camelCase、枚举值 snake_case。
2. 运行 `pnpm generate`，检查生成差异。
3. 同步 `crates/process-runtime` 的序列化形状；`tests/generated.test.ts` 会
   比对协议版本与错误码集合。
4. 更新 fixtures、测试、`docs/protocol.md` 与 `docs/component-contracts.md`。
5. 运行全部门禁。

### 兼容性判断

- 增加可选字段、增加新的错误码或新方法：向后兼容，仍需评估旧调用方是否会
  因严格未知字段检查而被拒绝。
- 删除字段、改名、收紧取值范围、改变字段含义、把可选字段改为必填、改变枚举
  语义：破坏性变更，必须提升 `PROTOCOL_VERSION`。
- 版本只在整数上精确匹配；没有协商、没有降级。未知版本返回
  `unsupported_protocol_version` 并附带 `details.supportedProtocolVersion`。
- 所有消息都禁止未知字段（`additionalProperties: false`）。安全相关字段不会
  被静默忽略；发送方必须先在协议中定义它。

## 8. Desktop 与 Browser Adapter 的最小用法

Desktop（Electron）与 Browser Adapter 只需依赖本包的数据类型与校验器，传输
层各自实现：

```ts
import {
  PROTOCOL_VERSION,
  validateResponse,
  unknownMethodError,
  type Request,
  type Response,
} from "@virealm/contracts";

const request: Request = {
  protocolVersion: PROTOCOL_VERSION,
  requestId: `req_${crypto.randomUUID()}`,
  method: "runtime.getCapabilities",
};

// Desktop: 通过自己的 Named Pipe / IPC 发送 JSON
// Browser Adapter: 通过宿主提供的桥接发送 JSON
const payload = JSON.stringify(request);
const reply: unknown = await transport.roundTrip(payload);

const parsed = validateResponse(reply);
if (!parsed.ok) {
  // 对端违反协议：不要猜测字段含义，也不要降级重试。
  throw new Error("invalid runtime response");
}
```

收到未知方法时，运行时侧应使用 `unknownMethodError(method)` 构造符合 Schema
的错误响应；收到不支持版本时使用 `unsupportedProtocolVersionError()`。

`process.exited` 事件契约已定义，但当前 Rust 运行时没有事件通道，也没有任何
实现会发出该消息。适配层若自行增加推送，必须显式标记这一能力，不能把
“契约存在”当作“运行时支持”。

## 9. 与 Rust 的映射

| 协议字段 | Rust 来源 | 注意 |
| --- | --- | --- |
| `protocolVersion` | `PROTOCOL_VERSION: u32` | 整数精确匹配 |
| `processInstanceId` | `ProcessId` | `<pid>:<creationTime100ns>`，PID 不是身份 |
| `creationTime100ns` | `u64` | 以十进制字符串编码，避免超过 JS 安全整数 |
| `startedAtUnixMs` | 由创建时间换算 | 必须与创建时间精确一致 |
| `applied` | `AppliedIsolation` | 从进程/作业回读的证据，不是请求副本 |
| `code` | `ErrorCode` | 六个运行时错误码 + 三个协议错误码 |
| `details.operation/windowsError` | `ErrorInfo.operation/windowsError` | 仅 `platform_failure` 允许 |

完整字段与消息样例见 [docs/protocol.md](../../docs/protocol.md)，组件边界见
[docs/component-contracts.md](../../docs/component-contracts.md)。
