# 开发指南

## 1. 前置要求

- Rust stable（`rust-toolchain.toml` 会安装 `rustfmt` 与 `clippy`）
- Windows 10/11 x86_64 或 macOS 27+ Apple silicon（运行对应平台的集成测试）
- 对应平台的真实 Chrome：Windows 的标准安装位置，或 macOS 的
  `/Applications/Google Chrome.app`
- Node.js >= 20
- pnpm：

```bash
corepack enable
corepack prepare pnpm@latest --activate
```

## 2. 常用命令

```bash
cargo fmt --all -- --check
```

```bash
cargo clippy --workspace --all-targets --all-features -- -D warnings
```

```bash
cargo test --workspace
```

```bash
cargo check --workspace
```

```bash
corepack pnpm install
corepack pnpm contracts:typecheck
```

根目录 `package.json` 的 `corepack pnpm check` 依次执行 Rust 格式检查、Clippy、
Rust 测试，以及契约与适配层的生成一致性、lint、格式、类型、测试与构建检查，
最后执行桌面应用的 lint、格式、类型、单元/安全测试与构建。集成测试（真实
Chrome 与真实 Electron）在 Windows 与 macOS 上分别运行；测试报告见
[test-report.md](test-report.md)。`VIREALM_REQUIRE_INTEGRATION=1` 会让浏览器
适配层的集成测试在缺少前置条件时失败而不是跳过（CI 使用该设置；桌面集成测试
同样识别它）。

桌面相关的根脚本：

```bash
corepack pnpm desktop:lint
corepack pnpm desktop:format:check
corepack pnpm desktop:typecheck
corepack pnpm desktop:test
corepack pnpm desktop:build
corepack pnpm desktop:test:integration
corepack pnpm desktop:package
```

`desktop:test:integration` 需要 Windows 或 macOS、已构建的 `virealm-runtime`
与本机 Chrome；缺少前置条件时该文件会整体跳过并在输出中说明原因，设置
`VIREALM_REQUIRE_INTEGRATION=1` 则改为失败。

`desktop:package` 需要先执行 `cargo build --release -p virealm-process-runtime
--bin virealm-runtime`。打包脚本按平台选择运行时文件名与资源目录：

- Windows：`target/release/virealm-runtime.exe` → `resources/runtime/`，产出
  `apps/desktop/release/win-unpacked`；
- macOS：`target/release/virealm-runtime` →
  `Virealm.app/Contents/Resources/runtime/`，产出
  `apps/desktop/release/mac-arm64/Virealm.app`，`after-pack` 会校验 Mach-O 并
  设置可执行位。

在 macOS 上，`electron-builder` 会直接调用名为 `pnpm` 的可执行文件来收集
 workspace 依赖；只用 `corepack pnpm` 而没有全局 `pnpm` 时，需要先让 `pnpm`
 出现在 `PATH`（例如 `corepack enable pnpm`），否则打包会以
 `spawn pnpm ENOENT` 失败。

若上一次失败的打包留下了 `release/win-unpacked.tmp`，且其中某个文件仍被外部
进程占用，`electron-builder` 会以 `EBUSY` 失败——此时换一个输出目录重跑即可
（`electron-builder --config.directories.output=<其它目录>`），不要用强制解锁或
跳过 after-pack 钩子的方式绕过。

## 3. 当前进度

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 第一阶段 | `process-runtime`：能力探测、进程启动、Windows 隔离原语；macOS POSIX 进程组与 Unix socket | 已实现；Windows 与 macOS 均通过本机测试，CI 双平台 job 已加入 |
| 第二阶段 | `contracts` + `browser-adapter`：Chrome 启动、独立数据目录、CDP 配置与验证 | 已实现；协议仍为 2（可选字段增量），两端均通过真实 Chrome 集成测试 |
| 第三阶段 | `desktop`：环境管理 UI、配置编辑、状态展示、诊断 | 已实现；单元/安全测试、真实 Chrome 集成测试与 Electron 端到端测试在 Windows 与 macOS 通过 |
| 第四阶段 | 端到端测试：隔离、浏览器配置、退出清理、错误恢复 | 部分并入第三阶段的桌面集成与 Electron 测试；尚未覆盖宿主崩溃后的孤儿进程扫描 |

能力探测返回四种状态，`not_verified` 表示尚未验证，不能被视为可用。当前在
Windows 11 26300 x86_64 与 macOS 27.0.1 arm64 上验证；Windows CI 已有实跑记录，
macOS job 已写入工作流但结果以 `docs/test-report.md` 的后续记录为准。

## 4. 目录增长规则

目标结构见根 `README.md`，但**不提前创建空目录或空模块**：

- `apps/desktop` 在第三阶段开始时创建。
- `packages/browser-adapter` 在第二阶段开始时创建。
- `tests/e2e` 与 `scripts/` 在出现第一个真实用例/脚本时创建。

新增目录时同步更新 README 中的结构说明。不要为了「看起来模块化」而拆分：
拆分应来自真实的职责边界或独立的变更节奏。

`docs/screenshots/` 存放界面检查截图，由 `apps/desktop/scripts/manual-walkthrough.mjs`
与 `manual-error-states.mjs` 生成：它们启动真实 Electron 应用、注入真实的错误
状态并截取界面，用于人工检查布局与状态呈现。

## 5. 编码约定

- Rust 使用 edition 2024，`cargo fmt` 默认风格，最大行宽 100。
- 公共 API 必须有文档注释；错误必须带稳定的 `ErrorCode`。
- TS 开启 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`。
- 跨边界字段 camelCase，枚举值 snake_case，详见
  [component-contracts.md](component-contracts.md)。
- `unsafe` 只用于平台调用边界（Win32、`libc`、`proc_pidinfo`），每处说明指针、
  所有权与生命周期前提。
- 不在预期内的运行时失败上使用 `unwrap()` / `expect()`；句柄使用 RAII 管理。
- 注释解释「为什么」，不复述代码。

## 6. 测试策略

- **单元测试**：策略校验、请求校验、路径边界、命令行转义、错误映射、能力状态。
  无需操作系统权限。
- **集成测试**（`crates/process-runtime/tests/`）：真实创建隔离原语，验证参数
  与环境传递、进程树终止、资源限制、文件与网络策略、状态身份。Windows 覆盖
  Job Object / AppContainer / 受限令牌；macOS 覆盖进程组、身份校验、socket
  权限与陈旧 socket 清理。按 `cfg` 分平台运行。
- **契约测试**：Rust 序列化结果与 TypeScript 类型/JSON Schema 的形状一致。
- **适配层集成测试**（`packages/browser-adapter/tests/`）：在真实 Chrome 上启动
  独立 Profile、应用并回读时区 / 语言 / 视口。
- **桌面测试**（`apps/desktop/tests/`）：
  - `unit/`：服务层、校验、持久化、IPC、错误与日志的单元测试；
  - `security/`：渲染进程不得拥有 Node 能力、非法 IPC 必须被拒绝、保留的
    Chrome 开关必须被拒绝、日志不得泄露凭据；
  - `integration/`：真实运行时 + 真实 Chrome 的两个并行环境、热更新与需要重启
    的配置、停止与元数据恢复；
  - `electron/`：启动真实 Electron 应用，验证渲染进程隔离、精确的 preload
    API、界面创建环境，以及重启后的元数据恢复。
- **视觉检查**：在两种桌面尺寸、深浅主题下对全部页面、抽屉与对话框截图并人工
  检查溢出、重叠与对齐（`docs/screenshots/`）。

需要真实 Chrome 的集成测试只在具备对应平台前置条件时运行；CI 设置
`VIREALM_REQUIRE_INTEGRATION=1`，让缺少前置条件变成失败而不是静默跳过。缺失
平台 API 的测试必须如实标记未验证，不得通过放宽安全策略来让测试通过。桌面测试
同样不得通过跳过用例、放宽 TypeScript 类型或关闭规则来通过门禁：前置条件缺失
时必须整体跳过该文件并说明原因。
