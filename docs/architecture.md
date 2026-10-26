# 架构

## 1. 目标

Virealm 为每个「环境」提供一套隔离的浏览上下文：独立的浏览器数据目录、受约束的
进程树，以及可验证的浏览器配置（时区、语言、视口等）。

设计上的核心约束只有一条：**每一层只做自己负责的事，跨层通过契约组合，而不是
通过共享实现细节。**

## 2. 组件与职责

| 组件 | 语言 | 负责 | 明确不负责 |
| --- | --- | --- | --- |
| `apps/desktop` | TypeScript / React | 环境管理 UI、配置编辑、状态与诊断展示 | 直接访问操作系统 API、直接执行命令、自行启动浏览器 |
| `packages/browser-adapter` | TypeScript | 定位 Chrome、构造启动参数、独立 `user-data-dir`、CDP 连接、浏览器配置与验证 | 决定进程隔离策略、绕过运行时直接创建进程 |
| `crates/process-runtime` | Rust | 能力探测、进程启动、Job Object、AppContainer / 受限令牌（Windows）、POSIX 进程组（macOS）、结构化诊断 | 任何 Chrome / CDP / 时区 / 语言知识 |
| `packages/contracts` | TypeScript + JSON Schema | 请求/响应/事件信封、启动参数、能力报告、进程状态与错误、协议版本、运行时校验器 | 传输实现、进程创建、隔离策略与任何一方的业务逻辑 |

## 3. 依赖方向

```
renderer (React)
    │  仅通过 preload 暴露的 IPC
    ▼
electron main / environment-service
    │
    ├──────────────▶ browser-adapter ──▶ process-runtime ──▶ Chrome
    │                      │                    │
    └──────────────────────┴────────────────────┘
                           │
                       contracts
```

规则：

- 依赖只能自上而下。`process-runtime` 不依赖浏览器适配层，也不感知 Electron。
- `contracts` 只包含 Schema、生成类型与数据校验器；不包含传输或进程创建实现。
- Renderer 不持有 Node.js 能力，也不获得任意命令执行权限；它只能发起语义化的
  环境操作。
- 浏览器适配层**必须**通过 Process Runtime 启动 Chrome，不能自己调用
  `child_process.spawn` 绕过隔离策略。

## 4. 启动一个环境

以「用户启动一个时区为 `America/Los_Angeles` 的环境」为例：

1. Renderer 发起 `virealm:environments:launch`（preload 暴露为
   `launchEnvironment(id)`）。
2. Main 侧 Environment Service 读取并校验环境配置，确认没有进行中的操作。
3. Environment Service 请求 Browser Adapter 准备启动：
   - 定位 Chrome；
   - 生成独立 `user-data-dir`；
   - 生成不含敏感信息的 Chrome 参数与 CDP 连接参数。
4. Browser Adapter 把进程描述与运行时策略交给 Process Runtime。
5. Process Runtime：
   - 校验请求与策略，包括可执行文件是否位于允许的程序目录；
   - 对照策略所需能力，确认系统能够满足；
   - Windows：创建 Job Object，按模式创建受限令牌或 AppContainer 属性；以挂起
     状态创建进程，加入 Job、读取子进程令牌回验隔离，然后恢复执行；
   - macOS：只接受 `managed`；创建进程时直接放入独立 POSIX 进程组，再用
     `getpgid` 与 `proc_pidinfo` 回验进程组与启动时间，不声称文件/网络隔离；
   - 任一验证失败则终止进程、释放句柄并返回结构化错误。
6. Browser Adapter 通过受控 CDP 连接设置并**验证**时区、语言等配置。
7. Environment Service 汇总结果。任一步失败都必须回收已创建的资源，再向 UI
   报告具体失败原因。

时区属于 Browser Adapter，AppContainer 属于 Process Runtime。两者独立实现，
通过环境配置组合起来，互不引用。

桌面层在这条链路上的职责边界：

- Renderer 只调用 preload 的固定方法，不参与任何编排。
- Main 负责配置校验、状态聚合（期望 / 已应用 / 已验证 / 不支持）、持久化与
  退出清理，不复制浏览器启动逻辑。
- 环境状态永远来自运行时查询，不来自本地缓存的「运行中」标记。
- 停止流程以「运行时确认进程已退出」为完成条件；CDP 断开不等于进程退出。

## 5. Rust 内部分层

`crates/process-runtime` 保持单一 crate：

```
src/
├── capabilities/     能力探测（四态：supported / unsupported / unavailable / not_verified）
├── diagnostics/      结构化事件，不负责展示
├── launch.rs         公共启动入口、请求规范化与路径边界校验
├── policy/           平台无关策略与校验
├── process/          进程身份、状态、终止与句柄所有权
├── platform/
│   ├── windows/      Job Object / AppContainer / Token / ACL / 进程创建 / 命名管道
│   └── macos/        POSIX 进程组 / proc_pidinfo / Unix socket
└── error.rs          稳定错误分类
```

`platform/windows` 与 `platform/macos` 是模块而不是独立 crate：平台门面
（`platform/mod.rs`）暴露同一组函数，上层不出现 `cfg` 分支。提前拆成
`process-runtime-windows` / `process-runtime-macos` 只会增加依赖管理成本；等平台
无关契约稳定、Linux 后端真实出现后，再评估拆分。

隔离模式的实际边界必须写清楚：

- `managed`：Windows 为普通进程 + Job Object，macOS 为独立 POSIX 进程组；两者都
  只约束生命周期与资源，**不是**沙箱。
- `restricted`：受限令牌 + Low 完整性，降低写入中完整性位置的能力，但不按路径
  限制文件，也不限制网络。Windows 专属。
- `app_container`：唯一能够宣称文件/网络隔离的模式，通过 AppContainer 令牌与
  显式 ACL 实现。Windows 专属。
- macOS 没有 `restricted` / `app_container` 的等价物；运行时会以
  `capability_unavailable` 拒绝，而不是用 `sandbox-exec` 或 RLIMIT 近似。
- macOS 也没有按进程树聚合的进程数/内存上限；带 `maxProcesses` 或
  `memoryLimitBytes` 的请求会被拒绝，桌面界面禁用这两个字段。

## 6. 部署形态

Process Runtime 与桌面宿主之间有两种候选形态：

| 形态 | 优点 | 成本 |
| --- | --- | --- |
| 独立服务进程 + 本地端点（Windows 命名管道 / macOS Unix socket） | 明确的安全边界；运行时崩溃不影响 UI；便于单独升级与审计 | 需要设计端点访问控制、协议版本协商、生命周期与重连 |
| 作为原生库集成进桌面应用 | 部署简单、调用直接 | 安全边界与 UI 进程重合；崩溃影响面更大 |

**当前实现采用第一种形态**：`virealm-runtime serve --pipe <address>` 以独立进程
提供协议 2 的 NDJSON 接口；参数名沿用 `--pipe`，地址在 Windows 上是命名管道
（`\\.\pipe\virealm-runtime-v2`），在 macOS 上是 Unix domain socket
（默认 `$TMPDIR/virealm-runtime-v2.sock`，权限 0600，连接时校验同 UID）。
`packages/runtime-client` 的 `RuntimeHost` 负责启动与守护，`RuntimeClient` 负责
连接与请求。桌面端的 `RuntimeController` 拥有这条端点：它负责启动守护进程、
能力探测、失败后的重启，并在正常退出时删除自己生成的 socket。

仍然没有解决的部分：Windows 命名管道 ACL 与调用方身份校验、重连与协议升级
协商、守护进程崩溃后的自动拉起策略。macOS socket 使用 `LOCAL_PEERCRED` 校验
调用方 UID，并在持有 `flock` 锁时清理陈旧 socket；正常退出不由守护进程删除
socket（避免与新实例竞争），由桌面控制器或下次启动持锁清理。
