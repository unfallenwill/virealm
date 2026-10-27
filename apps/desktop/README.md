# Virealm Desktop

Windows 与 macOS 桌面应用：管理一组相互隔离的 Chrome 环境——每个环境有自己的
浏览器数据目录、受约束的进程树，以及可验证的时区 / 语言 / 视口配置。

桌面层**不实现**任何浏览器或进程能力：它只做配置管理、生命周期编排、持久化与
展示，Chrome 的启动与隔离全部交给
[Browser Adapter](../../packages/browser-adapter) 与
[Process Runtime](../../crates/process-runtime)。

## 1. 组成

```
src/
├── main/                     Electron 主进程（可信宿主）
│   ├── index.ts              窗口、CSP、单实例锁、启动与退出清理
│   ├── ipc.ts                IPC 处理器表：解析、授权、结构化错误
│   ├── errors.ts             DesktopError 与对外错误视图（脱敏）
│   ├── logging.ts            环形日志缓冲（写入即脱敏）
│   ├── persistence/          environments.json / settings.json（原子写入）
│   ├── runtime/              本地运行时守护进程与 Accept-Language 探针
│   └── services/             环境服务（业务规则）与受控的 Profile 清理
├── preload/index.ts          固定、显式的 15 个 API 方法
├── renderer/                 React 界面（无 Node、无文件系统、无命令执行）
└── shared/                   契约类型与运行时校验
```

分层约束：

- **Renderer 不得直接访问平台 API（Win32 / POSIX）、Node.js 文件系统或进程管理
  接口。** 它只能调用 preload 暴露的语义化方法。
- **Main 拥有全部编排**：初始化、IPC 校验与授权、业务服务、适配器调用、元数据
  持久化与退出清理。它不复制浏览器启动逻辑。
- **Desktop 不得绕过 Browser Adapter 启动 Chrome。** 运行时守护进程由 Main 拉起，
  但浏览器进程只能由适配层通过 Process Runtime 创建。

## 2. 命令

```bash
corepack pnpm --filter @virealm/desktop dev        # 开发模式（Vite + Electron）
corepack pnpm --filter @virealm/desktop build      # 构建 renderer / main / preload
corepack pnpm --filter @virealm/desktop start      # 以构建产物启动
corepack pnpm --filter @virealm/desktop lint       # ESLint
corepack pnpm --filter @virealm/desktop typecheck  # tsc（main + renderer）
corepack pnpm --filter @virealm/desktop test       # 单元 + 安全测试（带覆盖率）
corepack pnpm --filter @virealm/desktop test:integration  # 真实运行时 + Chrome + Electron E2E
corepack pnpm --filter @virealm/desktop package    # electron-builder，dir 目标
corepack pnpm --filter @virealm/desktop package:win  # Windows NSIS x64
corepack pnpm --filter @virealm/desktop package:mac  # macOS arm64 DMG
corepack pnpm --filter @virealm/desktop set-version 0.1.0
```

打包需要先构建发布版运行时：

```bash
cargo build --release -p virealm-process-runtime --bin virealm-runtime
```

`package` 使用 `dir` 目标，按平台放置运行时：

- Windows：`virealm-runtime.exe` 放进 `resources/runtime/`，产出
  `release/win-unpacked`；`scripts/after-pack.mjs` 校验其存在，并为安装目录授予
  `ALL APPLICATION PACKAGES` 只读权限——Electron 的沙箱渲染进程需要该授权，否则
  会拒绝启动。
- macOS：`virealm-runtime` 放进 `Virealm.app/Contents/Resources/runtime/`，产出
  `release/mac-arm64/Virealm.app`；`after-pack` 校验它是 Mach-O 且设置 `0755`。
  产物未签名、未公证，跨机分发会被 Gatekeeper 拦截。

安装器由显式目标构建：

- `package:win`：NSIS x64 一键安装器，按当前用户安装到
  `%LOCALAPPDATA%\Programs\Virealm`。NSIS 解包不保留 ACL，因此
  `build-resources/installer.nsh` 的 `customInstall` 会为 `$INSTDIR` 递归授予
  `ALL APPLICATION PACKAGES` 只读权限；授权失败时安装器以非零码中止。
- `package:mac`：arm64 DMG，内含 `Virealm.app`。

`set-version` 把版本写入本目录的 `package.json`，打包后的应用版本随之改变。
tag 触发的发布流水线、冒烟脚本与未签名限制见
[docs/release.md](../../docs/release.md)。

在 macOS 上打包还需要 `pnpm` 出现在 `PATH`（例如 `corepack enable pnpm`），否则
`electron-builder` 会以 `spawn pnpm ENOENT` 失败。

## 3. 数据与配置

| 文件 | 内容 |
| --- | --- |
| `%APPDATA%\Virealm\environments.json` | 环境元数据与期望配置（版本化，原子写入） |
| `%APPDATA%\Virealm\settings.json` | 界面设置（主题、默认浏览器） |
| `%APPDATA%\Virealm\data\environments\<id>\chrome-data` | 浏览器 Profile 目录 |

macOS 上同一布局位于 `~/Library/Application Support/Virealm/`（`environments.json`、
`settings.json`、`data/environments/<id>/chrome-data`）。

- 记录里**没有** Cookie、密码、访问令牌或任何凭据。
- 写入采用「临时文件 + fsync + rename」，失败时保留旧文件；内容损坏时备份原文件
  并降级为空列表；版本高于当前实现时只读打开，不做任何破坏性迁移。
- 列表状态**不**从数据库恢复。应用重启后重新查询运行时，运行中的环境才会显示
  为运行中。

## 4. 环境状态语义

| 状态 | 含义 |
| --- | --- |
| `stopped` | 运行时确认没有该环境的进程 |
| `starting` | 启动流程进行中 |
| `running` | 运行时确认进程存活 |
| `stopping` | 停止流程进行中 |
| `failed` | 上次启动或运行失败 |
| `unknown` | 运行时不可用，无法确认 |

界面区分「期望配置 / 已应用 / 已验证 / 不支持」四层信息：验证结果来自适配层对
CDP 的实测回读，隔离能力不支持时明确标注为不支持，不把浏览器层配置描述成完整
的操作系统指纹隔离。

### 隔离模式与 Chrome 的兼容性

Chrome 的浏览器进程要为自己创建沙箱（Job Object + 受限令牌），运行在运行时
已经预先限制过的令牌里时这一步会失败，进程在启动阶段中止（中止码随 Chromium
构建而变，本机 Chrome 156.0.8078.48 上是 `STATUS_BREAKPOINT` / `0x80000003`）。
因此桌面端在**保存与启动**环境时直接拒绝「受限令牌」与「AppContainer」两种模式，
给出可读原因而不是让用户在启动后看到笼统的运行时错误；界面里这两项被禁用并标注
「浏览器不兼容」。已被保存的旧配置仍可读取与编辑，只是不允许启动。

对 Chrome 实际可用的隔离路径是 `managed`——Windows 为「Job Object 管理」，即生命
周期与资源约束；macOS 为「进程组管理」，即 POSIX 进程组的生命周期约束。两者再
加上浏览器层的配置覆盖（时区、语言、视口）。**这不是操作系统级的指纹隔离。**
运行时管理的其它程序在 Windows 上仍可以使用受限令牌与 AppContainer。实测证据见
`docs/known-limitations.md` §1.1 与 §1.2。

macOS 没有 `restricted` 与 `app_container` 的实现：界面把这两项禁用并标注
「macOS 不支持」，保存与启动时给出可读原因；`maxProcesses` / `memoryLimitBytes`
在 macOS 上同样不可用，界面禁用这两个输入。已在 Windows 上保存了这两种模式的
旧记录仍能在 macOS 上打开与编辑，只是不允许启动。

## 5. 安全边界

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
- Preload 只暴露 15 个固定方法，不暴露通用 `invoke`；`ipcRenderer.on/send` 不出现
  在 preload 中。
- IPC 频道全部带 `virealm:` 前缀并在 Main 侧校验；每个请求在运行时做类型校验，
  拒绝未知字段。
- Main 校验 IPC 发起方（窗口来源与 frame）。
- 日志在写入时脱敏：Cookie、Authorization、访问令牌、密码与 CDP 调试路径。
- 删除数据时只允许操作 `<dataRoot>/environments/<id>/chrome-data`，拒绝软链接、
  联接点与非目录目标；删除前需要用户确认，运行中的环境必须先停止。
- 环境配置中的额外启动参数由适配层校验，禁止 `--no-sandbox`、
  `--disable-web-security`、`--user-data-dir` 等保留开关。

## 6. 已知限制

- Windows 只在 11 26300 x86_64、非管理员会话验证过；未在 Windows 10、Windows
  Server 或 ARM64 上验证。
- macOS 只在 27.0.1 arm64 上验证过；未在 Intel Mac、旧版 macOS 或 Rosetta 下
  验证。打包产物未签名、未公证。
- macOS 的进程组依赖运行时进程执行清理：运行时被 `SIGKILL` 时内核不会代为杀树，
  Chrome 可能残留；子进程也可以 `setsid` 离开进程组。窗口关闭即退出两个平台一致，
  这是对 macOS 常驻菜单栏约定的有意偏离，用于保证运行时与 Chrome 被清理。
- 打包版本固定使用系统提供的用户数据目录，不接受 `VIREALM_USER_DATA_DIR` 覆盖；
  未打包的开发与测试构建接受该覆盖，覆盖在**申请单实例锁之前**生效，因此开发实例
  与已安装实例可以同时运行、互不抢占。
- 没有账号、云同步、远程浏览器、计费与插件系统。
- 界面没有为每个环境生成随机品牌色；环境之间的差异通过名称、状态与配置体现。
- Chrome 环境没有可用的文件/网络级隔离：受限令牌与 AppContainer 都不能承载
  Chromium，macOS 也没有这两种模式；只剩 `managed` 生命周期约束与浏览器层配置覆盖。
- 结论只对 Chrome 156.0.8078.48 成立，未验证其它浏览器或其它版本。
