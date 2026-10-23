# @virealm/browser-adapter

把 Virealm Process Runtime 与真实 Chrome 连起来的浏览器环境适配层。它为每个
环境分配独立的持久化 Profile，通过 CDP 应用并**读取回来验证**时区、语言、
视口等页面级配置，并对上层暴露稳定的 TypeScript API。

本包不创建操作系统进程，也不直接调用 Win32 API：

```
BrowserAdapter
  → ProcessRuntimeClient (TypeScript)
  → Windows named pipe (newline-delimited JSON, protocol v2)
  → virealm-runtime serve (Rust)
  → Chrome (Job Object / 受限令牌 / AppContainer)
```

`RuntimeHost` 只用于 demo 与集成测试启动 runtime daemon 本身；它从不启动浏览器。

## 构建

```bash
cargo build -p virealm-process-runtime --bin virealm-runtime
corepack pnpm install
corepack pnpm --filter @virealm/browser-adapter build
```

## 公共 API

```ts
import { BrowserAdapter } from "@virealm/browser-adapter";

const adapter = new BrowserAdapter({
  dataRoot: "C:\\Users\\me\\AppData\\Local\\Virealm",
  // 省略 runtime 时连接默认管道；也可注入已有 RuntimePort 或 runtimePipePath。
});
```

| 方法 | 说明 |
| --- | --- |
| `discoverBrowsers(executablePath?)` | 在标准安装位置或指定路径发现 Chrome，返回真实安装路径与版本 |
| `validateEnvironment(input)` | 启动前校验；返回全部问题（不抛异常） |
| `launchEnvironment(input)` | 校验 → 预留 Profile → 经 runtime 启动 → 等待端点 → CDP 连接 → 应用配置 |
| `stopEnvironment(id, { mode })` | `graceful` 先 `Browser.close` 再升级终止；`force` 直接终止进程树 |
| `getEnvironmentStatus(id)` | 以 runtime 为权威对账后的真实状态 |
| `connectEnvironment(input)` / `disconnectEnvironment(id)` | 断开 CDP 不等于退出 Chrome；重连复用同一进程与 Profile |
| `applyEnvironmentConfig(id, input?)` / `verifyEnvironmentConfig(id, input?, options?)` | 应用 / 应用后读取验证 |
| `listPages(id)` / `openPage(id, url)` / `navigatePage(id, pageId, url)` / `closePage(id, pageId)` | 受控目标管理 |
| `close()` | 断开本适配器持有的 CDP 连接与 runtime 客户端；不删除 Profile |

状态为 `stopped | starting | running | stopping | failed`。配置字段结果为
`applied | verified | unsupported | failed | not_verified`，并带 `requested`、
`observed`、`reason`、`capability`，不存在布尔捷径。

## 配置示例

```ts
const config = {
  id: "work-us",                 // 稳定 id；只有它参与目录命名
  name: "Work US",
  browser: {
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    version: "156.0.8078.48",    // 声明版本，启动后与 CDP 报告核对
  },
  timezone: "America/Los_Angeles",
  locale: "en-GB",
  viewport: { width: 1366, height: 768 },
  // geolocation: { latitude: 1.3521, longitude: 103.8198, accuracy: 20 },
  runtimePolicy: { isolation: "managed" },
  persistence: { mode: "persistent" },
  launch: {
    initialUrls: ["about:blank"],
    additionalArguments: ["--headless=new"], // 安全相关开关会被拒绝
  },
} as const;

const result = await adapter.launchEnvironment(config);
const verified = await adapter.verifyEnvironmentConfig("work-us");
```

`dataRoot` 下的布局固定为：

```
<dataRoot>/environments/<id>/chrome-data   # --user-data-dir，持久化
<dataRoot>/runtime-state.json              # adapter 的对账记录，不是环境注册表
```

## 启动行为

- Chrome argv 始终是数组，不经过 shell 拼接。
- 每次启动使用 `--remote-debugging-port=0` + `--remote-debugging-address=127.0.0.1`，
  端口由 Chrome 分配，从 `DevToolsActivePort` 读取；不存在固定调试端口。
- Profile 必须位于 `dataRoot` 内，且不能是 Chrome 默认 Profile。
- `--no-sandbox`、`--disable-web-security`、`--user-data-dir`、`--lang` 等保留开关
  由配置注入时会被拒绝；适配器不会为了兼容性降低安全等级。
- runtime 能力不满足声明的隔离策略时直接失败（`unsupported_isolation`），不降级。
- 启动失败会终止已创建的 Chrome，但不会删除 Profile。

### Chromium 与受限令牌 / AppContainer

适配器不限制 `runtimePolicy.isolation` 的取值——运行时管理的其它程序可以使用
`restricted` 与 `app_container`。但 **Chrome 不能在这两种模式下运行**：Chromium
的浏览器进程要为自己创建沙箱，运行在运行时已经限制过的令牌里时这一步会失败，
进程在启动阶段中止，不写入任何 Profile。

适配器会识别这一情形并把它翻译成 `unsupported_isolation`，而不是把它当成
「浏览器意外退出」：

```jsonc
{
  "code": "unsupported_isolation",
  "message": "Chrome aborted during startup with STATUS_BREAKPOINT (2147483651): ...",
  "details": { "isolation": "restricted", "exitCode": 2147483651, "reason": "status_breakpoint" }
}
```

判定依据是**隔离模式**，不是某一个中止码：`reason` 为 `status_breakpoint` 表示
确实是 `0x80000003`，否则为 `early_exit_under_restricted_isolation`。中止码随
Chromium 构建而变（同一台机器上的 Chrome 156.0.8078.48 报 `0x80000003`，CI 运行
器上的另一个构建报别的值），只认一个魔数会让同一种不兼容在别的机器上重新变成
笼统错误。实际观察到的 `exitCode` 始终随错误一起返回。

`managed` 模式不受影响，Chrome 正常启动。适配器**不会**用 `--no-sandbox` 之类
的手段绕过这个限制——那等于放弃隔离本身。详见
`docs/known-limitations.md` §1.1。

## 配置验证的含义

| 字段 | 应用方式 | 验证读取 |
| --- | --- | --- |
| `timezone` | `Emulation.setTimezoneOverride` | `Intl.DateTimeFormat().resolvedOptions().timeZone` |
| `locale` | `Emulation.setLocaleOverride` + 启动 `--lang` | `navigator.language` / `navigator.languages` |
| `acceptLanguage` | `Network.setUserAgentOverride` | 请求受控本地探针，读取 HTTP 头 |
| `viewport` | `--window-size` + `Emulation.setDeviceMetricsOverride` | `window.innerWidth/innerHeight` |
| `deviceScaleFactor` | 同上，仅当显式声明 | `window.devicePixelRatio` |
| `geolocation` | `Browser.grantPermissions` + `Emulation.setGeolocationOverride` | `navigator.geolocation.getCurrentPosition` |

这是**页面级模拟**：不会修改 Windows 时区，也不会改变出口 IP。`screen.width`
仍是宿主显示器尺寸；报告会如实给出 `observed`，不会把声明值当作已生效值。

新标签页/弹窗创建时会自动重放同一套配置；无法应用的字段以 `unsupported` /
`failed` / `not_verified` 明确报告。

## 测试

```bash
# 单元测试 + 覆盖率（核心逻辑阈值 90%）
corepack pnpm --filter @virealm/browser-adapter test

# 真实 Chrome + 真实 Rust runtime 集成测试（Windows）
cargo build -p virealm-process-runtime --bin virealm-runtime
corepack pnpm --filter @virealm/browser-adapter test:integration

# 非 UI 公共 API 演示
corepack pnpm --filter @virealm/browser-adapter demo
```

集成测试使用独立命名管道和自己的 runtime daemon，只访问本地受控 HTTP 页面，
不依赖真实账号或外部站点。它覆盖：发现、经 runtime 启动、独立 Profile、CDP
连接、时区/语言/视口/Accept-Language 验证、目标创建与导航、断开重连、优雅与
强制停止、进程树清理、异常退出、重启后 Cookie/localStorage 持久化、双环境隔离
以及安全参数检查。

缺少 Chrome 或未构建 runtime 时，集成测试会明确失败并提示原因，而不是静默跳过。

## Demo

`pnpm demo` 会：

1. 发现本机 Chrome；
2. 启动专用 runtime daemon；
3. 启动两个环境（`Asia/Singapore`/`en-US` 与 `America/Los_Angeles`/`en-GB`）；
4. 在本地受控页面验证时区、语言、视口与 `Accept-Language`；
5. 打印两个环境的 Profile、端口与验证结果；
6. 优雅停止并确认调试端点关闭、Profile 保留。

可用参数：`--runtime <path>`、`--chrome <path>`、`--data-root <path>`。

## 已知限制

- `managed` 是 Job Object 生命周期约束，不是沙箱；真正的文件/网络隔离依赖
  `restricted` 或 `app_container`（由 runtime 能力决定）。
- 时区、语言、视口、地理位置都是 CDP 模拟，不是操作系统级设置；页面之外
  （下载管理、浏览器 UI 等）不在覆盖范围内。
- `screen.width/height` 反映宿主显示器，不是模拟视口。
- 语言覆盖启动语言、JS locale、`navigator.language` 与 `Accept-Language`；
  Chrome 内部其他本地化表面未逐一验证。
- 地理位置需要权限授予；拒绝或超时会报告 `failed` / `not_verified`，且不改变
  真实网络定位。
- 本阶段不自动下载 Chrome for Testing，也不管理账号或桌面 UI。
- 适配器实例重启后通过持久记录与 runtime 对账恢复状态；它不删除 Profile，
  也不接管不属于自己的进程。

## 上层集成建议

- **Desktop / Environment Manager**：把 `BrowserEnvironmentConfig` 作为声明
  保存到自己的注册表；用 `getEnvironmentStatus` 展示真实状态，用验证报告展示
  哪些配置真正生效。
- **Session Gateway / AI Agent**：只调用 `openPage`/`navigatePage`/`closePage`
  与状态 API，不接触 argv、CDP 或 Playwright 类型。
- 启动前先 `validateEnvironment`；把 `BrowserAdapterError.code` 映射为 UI 文案，
  不要解析错误消息。
- 需要 runtime 生命周期时由宿主负责启动 `virealm-runtime serve`；本包不会
  自动拉起生产 daemon。
