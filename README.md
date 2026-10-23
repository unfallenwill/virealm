# Virealm

为 Windows 提供隔离浏览环境的桌面应用：每个环境拥有独立的浏览器数据目录、
受约束的进程树，以及可验证的时区、语言与视口配置。

## 当前状态

第一阶段（`process-runtime` 的 Windows 实现）已完成并在本机 Windows 11 x86_64
上通过集成测试：

- 能力探测直接调用 Windows API 验证 Job Object、AppContainer、ACL、受限令牌与
  进程缓解策略，区分 `supported` / `unsupported` / `unavailable` / `not_verified`。
- 三种隔离模式：`managed`（普通进程 + Job Object，**不是**沙箱）、`restricted`
  （受限令牌 + 低完整性）、`app_container`（文件与网络策略可强制执行）。
- 挂起创建 → 应用隔离 → 回读验证 → 恢复执行；验证失败会终止进程并返回结构化错误，
  不存在静默降级。
- Job Object 生命周期、进程数/内存限制、进程树终止；进程身份使用 PID + 创建时间。
- 最小 CLI（`virealm-runtime probe|run|serve`）用于从外部调用公共 API；
  `serve` 在命名管道上提供版本化 IPC，供 TypeScript 客户端启动与管理进程。

详细结果与未验证项见 [docs/test-report.md](docs/test-report.md) 与
[docs/known-limitations.md](docs/known-limitations.md)。

第二阶段（`browser-adapter`）已完成：它在 Process Runtime 之上启动真实 Chrome，
为每个环境分配独立、持久化的 Profile，通过 CDP 应用并验证时区、语言、视口与
`Accept-Language`，并提供环境生命周期、目标管理与明确的验证报告。它从不自行
`spawn` 浏览器进程，也不使用固定调试端口。使用方式、配置语义与已知限制见
[packages/browser-adapter/README.md](packages/browser-adapter/README.md)。

第三阶段（`desktop`）已完成：Electron + React + TypeScript 桌面应用，提供环境
列表、创建 / 编辑 / 删除、启动 / 停止、真实状态、验证结果、诊断与恢复路径，
并在重启后恢复环境元数据。渲染进程没有 Node 能力，所有浏览器操作都经由
Browser Adapter。使用说明见 [apps/desktop/README.md](apps/desktop/README.md)。

## 结构

```
virealm/
├── apps/
│   └── desktop/                  # 第三阶段（已实现）：Electron + React 环境管理 UI
├── packages/
│   ├── contracts/                # 协议 Schema、生成类型与运行时校验器
│   ├── runtime-client/           # runtime 管道客户端与 daemon 启动辅助
│   └── browser-adapter/          # 第二阶段（已实现）：Chrome 启动、Profile、CDP
├── crates/
│   └── process-runtime/          # 第一阶段（已实现）
├── docs/
│   ├── architecture.md
│   ├── component-contracts.md
│   ├── security-model.md
│   ├── development.md
│   ├── test-report.md
│   ├── known-limitations.md
│   └── screenshots/              # 界面检查截图
├── scripts/
├── Cargo.toml                    # Rust workspace
├── package.json                  # 根脚本
└── pnpm-workspace.yaml
```

带阶段标注的目录在其阶段开始前不会创建，避免堆积空模块。当前实际存在的有
根配置、`crates/process-runtime`、`packages/contracts`、`packages/runtime-client`、
`packages/browser-adapter`、`apps/desktop` 与 `docs`。

## 组成

| 组件 | 语言 | 职责 |
| --- | --- | --- |
| Virealm Desktop | TypeScript | 环境管理 UI 与用户操作入口 |
| Virealm Process Runtime | Rust | 能力探测、受约束的进程启动与生命周期管理 |
| Browser Adapter | TypeScript | Chrome 启动参数、独立数据目录、CDP 配置与验证 |
| Contracts | TypeScript + JSON Schema | 跨组件数据契约 |

调用关系与边界见 [docs/architecture.md](docs/architecture.md)，
安全规则见 [docs/security-model.md](docs/security-model.md)。

## 快速开始

```bash
cargo test --workspace
```

检查本机是否具备各项隔离原语：

```bash
cargo run -p virealm-process-runtime --bin virealm-runtime -- probe
```

```bash
corepack pnpm install
corepack pnpm contracts:typecheck
```

浏览器适配层的单元测试、真实 Chrome 集成测试与演示：

```bash
corepack pnpm adapter:test
cargo build -p virealm-process-runtime --bin virealm-runtime
corepack pnpm adapter:test:integration
corepack pnpm adapter:demo
```

桌面应用的开发、构建、测试与打包：

```bash
corepack pnpm desktop:dev
corepack pnpm desktop:typecheck
corepack pnpm desktop:test
corepack pnpm desktop:build
cargo build --release -p virealm-process-runtime --bin virealm-runtime
corepack pnpm desktop:test:integration
corepack pnpm desktop:package
```

完整命令与阶段计划见 [docs/development.md](docs/development.md)。

## 设计原则

- 每个环境一个独立浏览器数据目录，不共享 Cookie、缓存或配置。
- 进程隔离由 Process Runtime 统一执行，浏览器适配层不得绕过。
- 能力探测区分 supported / unsupported / unavailable / not_verified；
  `not_verified` 不等于可用。
- 策略不可满足时拒绝启动，不静默降级。
- `managed` 模式只提供生命周期与资源约束，不声称文件或网络隔离。
- 不为「看起来模块化」拆分项目；职责边界真实出现时才拆分。
