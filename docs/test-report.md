# 测试报告

日期：2026-10-24。所有结果来自本机实际执行，未使用 mock 或伪造输出；被跳过的测试在
第 6 节逐条列出。

## 1. 环境

| 项目 | 值 |
| --- | --- |
| 操作系统 | Windows 11 Pro for Workstations，10.0.26300 x86_64 |
| 运行身份 | 非管理员，Medium 完整性 |
| Rust | stable，edition 2024，`cargo 1.98` |
| 覆盖率工具 | `cargo-llvm-cov 0.9.1`（Rust）/ Vitest 5 + V8（TypeScript） |
| Node.js / pnpm | Node 24.22.1，pnpm 12.15.0（经 corepack） |
| Chrome | 156.0.8078.48（本机安装，供集成测试使用） |
| Electron | 45（`apps/desktop`） |

能力探测（`virealm-runtime probe`）结果：

| 能力 | 状态 | 依据 |
| --- | --- | --- |
| Job Object | `supported` | 创建作业、设置 `KILL_ON_JOB_CLOSE` 并回读 |
| AppContainer | `supported` | 创建挂起 AppContainer 进程、附能力 SID、终止 |
| AppContainer ACL | `supported` | 为临时 AppContainer SID 写入并回读目录 ACE |
| 受限令牌 | `supported` | 创建 Low 完整性受限令牌与挂起进程 |
| 进程缓解策略 | `supported` | `GetProcessMitigationPolicy` 可调用 |
| ETW | `not_verified` | 本构建未实现 ETW 观察 |

## 2. 质量门禁（全量实跑）

### 2.1 全仓 `pnpm check`（`rust` → `contracts` → `adapter` → `desktop`）

| 命令 | 结果 |
| --- | --- |
| `cargo fmt --all --check` | 通过 |
| `cargo clippy --workspace --all-targets -- -D warnings` | 通过，0 警告 |
| `cargo test --workspace` | 通过：110 个测试执行，109 通过，1 忽略 |
| `contracts:check-generated` | 通过（生成文件与 Schema 一致） |
| `contracts:lint` / `format:check` / `typecheck` | 通过 |
| `contracts:test` | 通过：80 个测试 |
| `contracts:build` | 通过 |
| `runtime-client:lint` / `format:check` / `typecheck` | 通过 |
| `runtime-client:test` | 通过：24 个测试 |
| `runtime-client:build` | 通过 |
| `adapter:lint` / `format:check` / `typecheck` / `build` | 通过 |
| `adapter:test` | 通过：236 个测试 |
| `desktop:lint` / `format:check` / `typecheck` / `build` | 通过 |
| `desktop:test` | 通过：240 个测试（11 个文件） |

门禁的**顺序**也是门禁的一部分：类型感知的 ESLint 规则通过兄弟包构建出的
`dist/*.d.ts` 解析类型，因此每个包的 lint 之前必须先构建它的依赖
（`contracts` → `runtime-client` → `browser-adapter`）。这一点曾被本机上遗留的
`dist/` 掩盖，CI 上暴露为 319 条 "type that could not be resolved" 错误；现在
根 `check` 脚本按依赖拓扑排列，CI 的每个作业也显式构建依赖包，并且已在**删除
全部 `dist/` 之后**实跑验证通过。

### 2.2 需要真实环境的门禁（单独执行）

| 命令 | 结果 |
| --- | --- |
| `adapter:test:integration` | 通过：11 个测试（真实 Chrome + 真实运行时） |
| `desktop:test:integration` | 通过：4 个测试（2 个服务层真实 Chrome + 2 个 Electron E2E） |
| `desktop:package`（electron-builder） | 通过，产出 `release/win-unpacked/Virealm.exe`，已实际启动验证 |

### 2.3 覆盖率

| 包 | 语句 | 分支 | 函数 | 行 |
| --- | --- | --- | --- | --- |
| `@virealm/contracts` | 99.04% | 94.52% | 100% | 99.02% |
| `@virealm/runtime-client` | 95.05% | 94.02% | 93.33% | 95.05% |
| `@virealm/browser-adapter` | 97.34% | 90.49% | 95.26% | 97.94% |
| `@virealm/desktop` | 96.20% | 93.99% | 94.88% | 96.45% |

桌面端核心逻辑（服务、持久化、IPC 校验）均在 90% 以上，核心覆盖率要求（≥90%）达标。

## 3. 测试覆盖内容

### 3.1 阶段一：Process Runtime（Rust）

**单元测试（82，`crates/process-runtime/src`）**

- 策略：模式与文件/网络策略组合、`killOnClose` 必须开启、零限制拒绝、空程序目录拒绝。
- 请求校验：绝对路径、存在性、文件/目录类型、程序目录路径边界、宽泛目录拒绝、
  数据目录与额外根目录、环境标识长度/控制字符、参数与环境变量的 NUL/`=`/大小写重复。
- 命令行：MSVC 转义（空格、引号、反斜杠、空参数）。
- 环境块：继承、覆盖、大小写不敏感、`TEMP`/`TMP` 重定向、NUL 终止。
- 进程：PID + 创建时间身份、状态与退出码、诊断事件。
- 能力与错误：四态语义、序列化形状、错误分类、错误码唯一性。

**公共 API 测试（12，`tests/smoke.rs`）**

版本常量、能力报告四态与序列化、相对/缺失/越界可执行文件、空程序目录、模式与
策略不匹配、重复环境变量、NUL 参数，以及 AppContainer 启动不静默降级。

**Windows 集成测试（9 通过，1 忽略，`tests/windows_launch.rs`）**

| 测试 | 验证内容 |
| --- | --- |
| `managed_launch_passes_arguments_environment_and_working_directory` | 含空格与非 ASCII 的程序路径、参数数组、环境变量、工作目录、退出码 |
| `missing_executable_fails_before_process_creation` | 未创建进程即返回结构化错误 |
| `terminate_kills_the_whole_tree_and_is_idempotent` | 子进程随进程树终止；重复 `terminate` 安全 |
| `active_process_limit_is_enforced_by_the_job` | Job `maxProcesses=1` 实际阻止子进程 |
| `process_memory_limit_is_enforced_by_the_job` | Job 内存上限实际阻止大块分配 |
| `restricted_mode_applies_a_restricted_low_integrity_token` | 子进程令牌为 Low 完整性、无启用特权 |
| `app_container_enforces_file_and_network_policy` | 数据目录可读写；目录外读/写被拒绝（Win32 5）；loopback 连接被拒绝 |
| `app_container_network_allow_grants_network_capabilities` | 允许网络时能力 SID 生效并通过回验 |
| `status_survives_a_sleeping_process_and_reports_exit_code` | 运行中状态、身份与退出码 |
| `chrome_launches_in_managed_mode`（**忽略**） | 需要本机 Chrome；未使用 `--no-sandbox` |

**线格式测试（6，`tests/wire_format.rs`）**

能力报告字段 camelCase、四态取值；`ProcessState` 标签与字段；`ProcessStatus`
往返；错误包含 `code`/`operation`/`windowsError`；诊断事件稳定形状。

### 3.2 阶段二：Browser Adapter

**单元测试（235，11 个文件）**

| 文件 | 数量 | 覆盖内容 |
| --- | --- | --- |
| `environment-service.test.ts` | 93 | 启动/停止编排、状态机、热更新与需重启配置、验证报告、持久化、`STATUS_BREAKPOINT` 归类 |
| `config-applier.test.ts` | 22 | 时区、语言、视口、请求头的 CDP 下发与回读验证 |
| `launch-options.test.ts` | 23 | Chrome 参数构造、保留开关拒绝、独立 `--user-data-dir` |
| `validation.test.ts` | 22 | 环境草稿与运行配置的运行时校验 |
| `devtools-endpoint.test.ts` | 14 | CDP 端点解析、回环地址校验、`ws://` 构造 |
| `discovery.test.ts` | 13 | Chrome 探测顺序、版本读取、缺失时的错误 |
| `profile.test.ts` | 14 | Profile 目录隔离、符号链接/联接点拒绝 |
| `process-runtime-client.test.ts` | 11 | 运行时协议调用与错误映射、复用调用方持有的 client |
| `urls.test.ts` | 10 | URL 归一化与拒绝规则 |
| `runtime-state-store.test.ts` | 8 | 运行时状态持久化、损坏恢复 |
| `browser-adapter.test.ts` | 5 | 对外 API 形状 |

**集成测试（11，`tests/integration/browser-adapter.integration.test.ts`，真实 Chrome）**

| 测试 | 验证内容 |
| --- | --- |
| `has a built runtime and a local Chrome` | 前置条件：运行时可执行文件与本机 Chrome 存在 |
| `discovers the installed Chrome with a real version` | 探测到真实版本号 156.0.8078.48 |
| `launches Chrome through the runtime and verifies timezone, locale, viewport and headers` | 经运行时启动真实 Chrome；时区/语言/视口/请求头四项**均已验证** |
| `opens, navigates and closes targets over the real CDP connection` | 真实 CDP 打开、导航、关闭标签页 |
| `disconnects and reconnects CDP without stopping Chrome` | CDP 断开与重连不终止 Chrome |
| `persists cookies and localStorage across a stop and relaunch` | 停止再启动后 Cookie 与 localStorage 保留 |
| `isolates two environments and keeps B running when A stops` | 两个环境互不干扰，停止 A 不影响 B |
| `reports an externally terminated browser without deleting its profile` | 外部终止后如实上报，**不**删除 Profile |
| `force-stops the whole Chrome process tree and keeps the profile` | 强制停止整棵进程树，Profile 保留 |
| `never downgrades an isolation policy the runtime does not support` | 能力不足时明确失败，不静默降级 |
| `explains that Chromium cannot start inside a restricted token` | **真实**受限令牌下启动 Chrome：进程在启动阶段中止，适配器归类为 `unsupported_isolation` 并带上 `isolation`、`exitCode` 与 `reason`。用例不锁定某一个中止码（它随 Chromium 构建而变），但要求退出码确实被观测并返回 |

### 3.2b Runtime Client（`packages/runtime-client`）

**单元测试（24，1 个文件）**

| 文件 | 数量 | 覆盖内容 |
| --- | --- | --- |
| `client.test.ts` | 24 | 命名管道协议 v2 的请求/响应、错误映射、超时与并发调用 |

这一包的测试此前**不在**根 `check` 脚本里；现已纳入门禁。

### 3.3 阶段三：Desktop

**单元测试（235，10 个文件）+ 安全测试（5，1 个文件）**

| 文件 | 数量 | 覆盖内容 |
| --- | --- | --- |
| `validation.test.ts` | 75 | 环境 id / 草稿 / 配置的运行时校验、错误字段定位 |
| `environment-service.test.ts` | 66 | CRUD、启动停止编排、状态聚合、需重启标记、验证结果缓存与失效、浏览器不兼容隔离模式的拒绝 |
| `environment-store.test.ts` | 22 | 原子写入、版本号、损坏文件备份、写入失败保留旧数据 |
| `ipc.test.ts` | 15 | 15 条通道的请求校验、错误信封、鉴权 |
| `errors.test.ts` | 14 | 结构化错误到 UI 消息的映射 |
| `settings-store.test.ts` | 14 | 设置持久化、向后兼容、只读旧版本 |
| `profile-cleanup.test.ts` | 11 | 只清理 `<dataRoot>/environments/<id>/chrome-data`，拒绝符号链接/越界路径 |
| `logging.test.ts` | 9 | 日志过滤与脱敏 |
| `probe-server.test.ts` | 4 | Accept-Language 回环探测服务 |
| `isolation.test.ts` | 5 | 共享的隔离模式兼容性规则与文案 |
| `security.test.ts` | 5 | 安全测试（见下） |

**安全测试（5，`tests/security/security.test.ts`）**

| 测试 | 验证内容 |
| --- | --- |
| `exposes exactly one fixed API and no generic privileged bridge` | 渲染进程只有固定的 15 个方法，没有通用 `invoke` 桥 |
| `keeps IPC channels namespaced, unique and allowlisted` | 通道全部 `virealm:` 命名空间、唯一、白名单 |
| `rejects privilege-shaped fields instead of ignoring them` | 出现越权字段时**拒绝**而不是静默忽略 |
| `delegates unsafe Chrome switches to the adapter's reserved list` | 危险开关交由适配层保留名单处理 |
| `never leaves debugger paths or credentials in log text` | 日志不含调试端口、Cookie、令牌 |

**集成测试（2，`tests/integration/desktop-chrome.test.ts`，真实 Chrome）**

| 测试 | 验证内容 |
| --- | --- |
| `has a Windows runtime binary and a local Chrome` | 前置条件检查 |
| `manages two simultaneous isolated environments end to end` | 两个环境同时运行（不同 PID、不同数据目录）、CDP 已连接、Chrome 版本已上报、四项配置已验证；热更新时区即时生效并重新验证；需重启的配置被标记为 `pendingRestart`；优雅停止与强制停止均确认进程退出；新建的 store/service 从磁盘恢复元数据并显示 `stopped` |

**Electron 端到端测试（2，`tests/electron/app.e2e.test.ts`）**

| 测试 | 验证内容 |
| --- | --- |
| `renders a hardened renderer and creates an environment through the UI` | 渲染进程无 `require`/`process`；preload 恰好 15 个方法；非法 IPC 返回 `{ok:false,error:{code:"invalid_request",message:"环境 id 无效。"}}`；通过界面创建环境成功 |
| `restores persisted metadata after a full restart` | 完全重启应用后环境列表仍在 |

### 3.4 打包产物验证（`desktop:package`）

`release/win-unpacked/Virealm.exe` 实际启动并逐项核对：

- 窗口正常渲染，标题为「环境」，无控制台报错。
- 渲染进程暴露的 API 与开发构建一致，仍是 15 个方法。
- 内置运行时从 `resources/runtime/virealm-runtime.exe` 解析成功，运行时守护进程启动并
  上报三种隔离能力均为 `supported`。
- 探测到本机 Chrome 156.0.8078.48。
- 用户数据目录为 `%APPDATA%\Virealm`（`productName` 生效）。

打包过程中发现并修复了一个真实缺陷：Electron 的沙箱渲染进程要求安装目录对
`ALL APPLICATION PACKAGES`（`*S-1-15-2-1`）可读可执行，否则以 `FATAL` 拒绝启动。
修复方式是新增打包后钩子 `apps/desktop/scripts/after-pack.mjs` 授予该只读权限，
而不是关闭沙箱。

本次修复后的打包与启动复核：`electron-builder` 再次产出 `Virealm.exe`，
`resources/runtime/virealm-runtime.exe` 就位，after-pack 钩子输出
`granted *S-1-15-2-1 read/execute`；实际启动打包产物，窗口正常渲染、侧栏与
环境列表正常显示本机已保存的环境（见 `docs/screenshots/30-packaged-app.png`）。

**未完成的复核**：`electron-builder` 无法写入默认输出目录 `apps/desktop/release`，
因为上一次失败留下的 `release/win-unpacked.tmp/resources/default_app.asar` 被外部
进程持续占用（删除与重命名均报 `EBUSY` / `Permission denied`，Restart Manager
报告存在一个无法枚举的持有者，疑似扫描器）。本次改用
`--config.directories.output=release-verify` 完成打包与启动验证，
**`release/win-unpacked` 这次没有重新生成**。该目录清理需要结束持有该文件的
外部进程，本次会话没有执行这一步。

## 4. Rust 覆盖率（阶段 1 实测，阶段 2/3 未改动 Rust 代码）

`cargo llvm-cov --workspace --summary-only` 的结果（行覆盖）：

| 模块 | 行覆盖 | 说明 |
| --- | --- | --- |
| `launch.rs` | 90.44% | 请求规范化与路径边界 |
| `policy/mod.rs` | 93.04% | 纯策略校验 |
| `error.rs` | 100% | 错误分类 |
| `capabilities/mod.rs` | 100% | 四态与报告结构 |
| `diagnostics/mod.rs` | 100% | 诊断事件 |
| `platform/windows/command_line.rs` | 100% | 参数转义 |
| `platform/windows/environment.rs` | 98.29% | 环境块 |
| `platform/windows/path.rs` | 93.10% | 路径边界与宽泛目录 |
| `platform/windows/token.rs` | 87.82% | 令牌查询与受限令牌 |
| `platform/windows/acl.rs` | 87.50% | ACL 授予与回读 |
| `platform/windows/app_container.rs` | 85.33% | Profile 与安全能力 |
| `platform/windows/process.rs` | 80.08% | 进程创建与验证分支 |
| `platform/windows/job_object.rs` | 73.19% | 失败分支覆盖较少 |
| `platform/windows/capability.rs` | 64.53% | 仅走通本机可用路径 |
| CLI `virealm-runtime.rs` | 0% | 未纳入自动化测试 |
| 总计 | 76.99% | 含 CLI 与未触发的平台失败分支 |

纯逻辑层（策略、校验、转义、环境块、错误、诊断）均达到 90% 以上；平台层未覆盖
的主要是失败分支与当前机器上不可触发的状态。

## 5. 已验证（本机真实执行）

- 三种隔离模式的启动、状态查询与终止行为；Job Object 生命周期、进程数与内存限制、
  进程树终止。
- AppContainer 的文件访问边界与网络 deny 的实际效果；受限令牌的 Low 完整性与特权清除。
- 真实 Chrome 经 Process Runtime 启动；时区、语言、视口、请求头四项配置在真实浏览器
  中**回读验证**通过。
- **Chrome 在受限令牌下启动会以 `STATUS_BREAKPOINT` 中止**：真实运行时 + 真实 Chrome
  实测，适配器归类为 `unsupported_isolation`；桌面端在保存与启动前直接拒绝该模式。
- 两个环境同时运行、互不干扰；停止其中一个不影响另一个。
- 桌面端完整生命周期：创建 → 启动 → 热更新 → 需重启标记 → 停止 → 元数据恢复。
- Electron 渲染进程加固、IPC 白名单与错误信封；重启后列表恢复。
- 打包产物真实启动、运行时解析、能力上报与 Chrome 探测。

## 6. 未执行的测试与已知盲区

以下内容**没有**被执行或验证，不应被假定存在：

### 6.1 被显式忽略的测试

| 测试 | 原因 |
| --- | --- |
| `crates/process-runtime/tests/windows_launch.rs::chrome_launches_in_managed_mode` | 需要本机 Chrome；该测试被 `#[ignore]` 标记，未在本报告中执行 |

### 6.2 CI 的执行情况

`.github/workflows/ci.yml` 已在本仓库（`unfallenwill/virealm`）上**实际执行**，
分四个作业：`Process Runtime (Windows)`、`Contracts (Node)`、
`Browser Adapter (Windows, real Chrome)`、`Desktop (Windows, Electron + real Chrome)`。

前几次运行暴露了两个真实缺陷，都已修复：

| 运行发现的问题 | 原因 | 处理 |
| --- | --- | --- |
| 三个 Node 作业在 `actions/setup-node` 处失败（`Unable to locate executable file: pnpm`） | `cache: pnpm` 需要先能调用 pnpm，而 `corepack enable` 排在 setup-node 之后 | 改用 `pnpm/action-setup` 先安装 pnpm，并设置 `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` |
| `adapter:lint` / `desktop:lint` 报 319 条 "type that could not be resolved" | 类型感知的 ESLint 规则要读兄弟包构建出的 `dist/*.d.ts`，而新克隆的仓库没有 `dist/` | 根 `check` 按依赖拓扑排序并在 lint 前构建依赖；CI 作业同样显式构建 |
| 受限令牌集成测试在 CI 上失败 | 适配层原先只把 `0x80000003` 判为 `unsupported_isolation`，而 CI 运行器的 Chromium 构建中止码不同 | 改为按隔离模式判定，`exitCode` 随错误返回；用例不再锁定单一魔数 |

CI 运行器是 GitHub 的 `windows-latest` / `ubuntu-latest`，其上安装的 Chrome 与
本机版本不同、运行账户与本机也不同，因此 CI 结果不能替代本机结论：受限令牌
与 AppContainer 下 Chromium 的中止码在 CI 上被实测为与本机不同，这本身就是
「该结论只对特定 Chrome 版本成立」的直接证据。

`Contracts (Node)`、`Process Runtime (Windows)` 与
`Desktop (Windows, Electron + real Chrome)` 三个作业已在 CI 上通过；其中桌面作业
跑的是真实 Chrome + 真实运行时 + Electron 端到端。
`Browser Adapter (Windows, real Chrome)` 作业曾在上表第三行的问题上失败，修复后
复跑的结果见本节末尾的补充记录。CI 仍**不能**覆盖本报告第 6.1 节列出的内容。

### 6.3 未验证的行为

- 未在 Windows 10 早期构建、Windows Server、ARM64、管理员/高完整性会话中验证。
- **未**在受限令牌与 AppContainer 模式下跑通桌面端的完整环境生命周期——该路径
  **不可能**跑通：Chromium 在这两种模式下无法启动（退出码 `0x80000003`）。适配器
  与桌面端的行为由单元测试与一个真实受限令牌的集成测试覆盖，而不是由完整生命
  周期测试覆盖。
- Chromium 无法在受限令牌下运行这一结论只对 Chrome 156.0.8078.48 成立，未验证
  其它浏览器（Edge、Firefox）与其它版本。
- ETW 观察未实现，状态为 `not_verified`。
- 未构造 PID 复用场景；未测试多环境并发启动、同进程多实例、宿主崩溃后的孤儿清理。
- 网络策略只验证了 loopback TCP；DNS、UDP、外网访问未逐一验证。
- 非 UTF-8 / 非法 UTF-16 参数未做专门测试。
- CLI（`virealm-runtime`）没有自动化测试，覆盖率 0%。
- 平台层失败分支覆盖不足（`capability.rs` 64.53% 行覆盖），因为本机所有能力都可用。
- 桌面集成测试使用 `--headless=new` 启动 Chrome，未验证有头窗口与多显示器表现。
- Electron 端到端测试只覆盖创建环境与重启恢复；**没有**在 Electron 内点击「启动」
  按钮做真实 Chrome 的端到端验证（该路径由服务层集成测试覆盖）。
- 界面没有像素级回归基线；`docs/screenshots/` 是人工视觉检查的结果。

## 7. 环境噪声

本机 Defender 实时扫描偶尔会锁住刚生成的测试可执行文件，使链接阶段出现
`LNK1104: cannot open file ...exe`。该错误与代码无关，重试即可通过；本报告中的
通过结果是在重试后得到的。测试代码中不存在为绕过该问题而放宽安全策略的逻辑。

打包时曾出现 `EPERM rename win-unpacked.tmp -> win-unpacked`：原因是上一次失败运行
留下的目录仍被占用。解决方式是清理陈旧输出目录后重试，没有绕过文件锁。

本次修复后的复核中，`apps/desktop/release/win-unpacked.tmp/resources/default_app.asar`
仍被外部进程持续占用（删除与重命名都失败），导致 `electron-builder` 无法写入默认
输出目录；改用 `--config.directories.output=release-verify` 完成打包与启动验证。
清理该陈旧目录需要先结束持有文件的外部进程，本次没有执行。
