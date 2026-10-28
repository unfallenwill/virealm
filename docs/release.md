# 发布与安装包

发布流水线由 [`.github/workflows/release.yml`](../.github/workflows/release.yml)
定义：tag 触发构建 Windows NSIS 与 macOS DMG，两个安装包通过冒烟验证后自动
发布 GitHub Release。

## 1. 触发方式

### 正式发布

在已通过 CI 的提交上创建并推送严格三段版本 tag：

```bash
git tag v0.1.0
git push origin v0.1.0
```

- tag 必须是 `vX.Y.Z`；不接受前导零、预发布后缀或 `v1.2`。
- 两个平台构建与冒烟都成功后才创建 Release；任一失败则不发布。
- Release 自动公开（不是 draft），说明来自
  [`.github/release-notes.md`](../.github/release-notes.md)。

### 只构建、不发布（演练）

工作流支持 `workflow_dispatch`，用于在正式 tag 前验证安装器：

```bash
gh workflow run release.yml -f version=0.1.0
gh run watch
```

- 工作流文件需先在默认分支 `main` 上，演练才能从这里触发。
- 构建两个平台的安装包并运行同样的冒烟测试，但 `publish` job 被跳过，不创建
  Release。
- 产物在该 Actions run 的 Artifacts 中保留 7 天。

## 2. 版本规则

`prepare` job 从 tag（或 dispatch 输入）取得版本，`set-version.mjs` 在打包前
写入 `apps/desktop/package.json`。因此：

- 安装包文件名、应用 `app.getVersion()`、Windows `ProductVersion` 与 macOS
  `CFBundleShortVersionString` 都等于 tag 版本。
- 仓库中的源版本不会因为发布而被回写；tag 是发布版本的唯一来源。
- 根 `package.json`、`Cargo.toml` 与 lockfile 不随 tag 改变。

## 3. 安装包

### Windows

- 目标：NSIS，x64，一键、按当前用户安装到
  `%LOCALAPPDATA%\Programs\Virealm`，不需要管理员权限。
- `after-pack` 在 `win-unpacked` 上授予 `ALL APPLICATION PACKAGES`
  （`*S-1-15-2-1`）只读权限；NSIS 解包不保留 ACL，因此
  `apps/desktop/build-resources/installer.nsh` 在 `customInstall` 中再次递归
  授予同一 ACE。缺少该权限时 Electron 的沙箱渲染进程会拒绝启动。
- `customInstall` 从原生的 `%WINDIR%\Sysnative\icacls.exe` 调用 icacls（该
  别名只在 WOW64 下存在），从而绕开 32 位安装器的 `$SYSDIR` 重定向。授权失败
  会以非零码中止安装：`9001` 为找不到 icacls，`9002` 为 icacls 无法启动，
  `9003` 为超时，其余情况原样透传 icacls 的退出码。nsExec 在启动失败时压栈的是
  字符串 `error` 而非数字，因此状态必须用 `StrCmp` 比较，不能用 `IntCmp`。
- 冒烟脚本 `apps/desktop/scripts/verify-installer.ps1` 会静默安装，核对卸载
  注册项的 `DisplayVersion`、安装目录的可继承 ACL、主程序 / `app.asar` /
  运行时的读执行 ACE、应用的 `ProductVersion` 与运行时 `probe`，最后静默卸载。
  ACL 断言失败时会打印安装目录内容与实际 ACL，便于定位安装器侧的问题。
- 未签名，SmartScreen 可能提示；没有 MSI、Windows ARM64 或自动更新。

### macOS

- 目标：DMG，arm64；内含 `Virealm.app`。
- 冒烟脚本 `apps/desktop/scripts/verify-dmg.sh` 挂载 DMG，核对 bundle id、
  随包运行时（Mach-O、可执行、`platform=macos` 且
  `processGroup=supported`）与 `CFBundleShortVersionString`；任何检查失败都会
  强制卸载镜像。
- 未签名、未公证；跨机首次启动需要右键“打开”。仅 Apple silicon。
- 产物名为 `Virealm-<version>-win-x64.exe` 与
  `Virealm-<version>-mac-arm64.dmg`；发布 job 会断言这两个名字，避免把别的
  文件挂到 Release 上。

## 4. 本地构建

先构建 release 运行时与 workspace 包：

```bash
cargo build --release --locked -p virealm-process-runtime --bin virealm-runtime
corepack pnpm contracts:build
corepack pnpm runtime-client:build
corepack pnpm adapter:build
corepack pnpm desktop:build
```

然后按平台构建安装器：

```bash
corepack pnpm desktop:package:win
```

```bash
corepack pnpm desktop:package:mac
```

- `package:win` 需要 Windows 环境（或可用的交叉打包环境）；`package:mac`
  需要 macOS arm64。
- 本地构建不会自动改版本；需要指定版本时先运行
  `corepack pnpm --filter @virealm/desktop run set-version 0.1.0`。
- 原有的 `corepack pnpm desktop:package` 仍产出 `dir`
  （`win-unpacked` / `mac-arm64`），用于快速本地运行，不生成安装器。

## 5. 重跑与资产替换

- 构建失败：修复后重新运行该 run 的失败 job；重新推送同一 tag 需要先删除并
  重建远端 tag，属于破坏性操作。
- 两个构建 job 成功、`publish` 失败：重跑 `publish`；若 Release 已存在，
  `gh release upload --clobber` 会替换同名资产。
- 已存在的 Release 只替换资产，不改写说明文字；需要改说明时手动编辑 Release。

## 6. 未包含

- 代码签名、macOS 公证、自动更新、MSI、Windows ARM64、macOS Intel/Universal。
- 发布后的回滚自动化；删除 Release 或 tag 需要人工操作。

已知限制见 [known-limitations.md](known-limitations.md)。
