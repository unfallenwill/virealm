import type { IsolationMode } from "./contracts.js";

/** The one mode Chromium's browser process can run under on either platform. */
export const BROWSER_COMPATIBLE_ISOLATION: IsolationMode = "managed";

/**
 * True for a macOS platform name, whichever spelling the caller has:
 * Node's `process.platform` says `darwin`; the capability report says `macos`.
 */
export function isMacosPlatform(platform: string | undefined): boolean {
  return platform === "darwin" || platform === "macos";
}

/**
 * Isolation modes the desktop refuses for a Chrome environment.
 *
 * On Windows the process runtime implements all three modes, but Chromium's
 * browser process cannot start inside a token the runtime has already
 * restricted: it aborts while initialising its own sandbox and never publishes
 * a debugging endpoint. The abort code is not stable across Chromium builds —
 * Chrome 156.0.8078.48 reports `STATUS_BREAKPOINT` (0x80000003), other builds
 * report a different code — so the incompatibility is established by the mode,
 * not by one magic number. Verified against real Chrome with the real runtime:
 * a plain program runs normally under the same restricted token, so the
 * limitation belongs to Chromium and not to the runtime.
 *
 * On macOS the same two modes have no implementation at all: the runtime only
 * provides the managed POSIX process-group tier and refuses to simulate the
 * Windows-only isolation primitives.
 *
 * The desktop only manages Chrome, so those modes are refused here rather than
 * offered and failed at launch time. The set is the same on both supported
 * platforms; the reason differs and is produced by the functions below.
 */
export function browserIncompatibleIsolation(): ReadonlySet<IsolationMode> {
  return INCOMPATIBLE_FOR_CHROME;
}

const INCOMPATIBLE_FOR_CHROME: ReadonlySet<IsolationMode> =
  new Set<IsolationMode>(["restricted", "app_container"]);

export function isBrowserCompatibleIsolation(mode: IsolationMode): boolean {
  return !browserIncompatibleIsolation().has(mode);
}

/** Why the two restricted modes are unavailable, in user-facing wording. */
export function browserIncompatibleReason(platform?: string): string {
  if (isMacosPlatform(platform)) {
    return "macOS 只提供「进程组管理」隔离：受限令牌与 AppContainer 是 Windows 专属能力，运行时会拒绝而不是模拟或降级。请使用「进程组管理」。";
  }
  return "受限令牌与 AppContainer 不适用于 Chrome：Chromium 的浏览器进程无法在被限制的令牌下启动自己的沙箱，会在启动阶段中止（中止码随 Chromium 版本而异）。请改用「Job Object 管理」。";
}

/** The same finding with the evidence behind it. */
export function browserIncompatibleDetail(platform?: string): string {
  if (isMacosPlatform(platform)) {
    return "macOS 的受管隔离是 POSIX 进程组：运行时把 Chrome 及其受管子进程放进同一进程组，停止或退出时向整组发送终止信号。它不提供文件系统或网络沙箱，也没有按进程树聚合的进程/内存上限。受限令牌与 AppContainer 在 macOS 上没有等价物，运行时会在创建进程前拒绝，而不是静默降级。";
  }
  return "受限令牌与 AppContainer 不适用于 Chrome：Chromium 的浏览器进程无法在被限制的令牌下启动自己的沙箱，会在启动阶段中止，中止码随 Chromium 版本而异（Chrome 156.0.8078.48 实测为 STATUS_BREAKPOINT / 0x80000003）。已在真实运行时上实测：同一令牌下的普通程序可以正常运行，因此这是 Chromium 自身的限制，而不是运行时的问题。这两种模式仍适用于运行时管理的其它程序。";
}

/** Short label for a mode in the interface. */
export function isolationModeLabel(
  mode: IsolationMode,
  platform?: string,
): string {
  switch (mode) {
    case "managed":
      return isMacosPlatform(platform) ? "进程组管理" : "Job Object 管理";
    case "restricted":
      return "受限令牌";
    case "app_container":
      return "AppContainer";
  }
}

/** macOS has no per-tree process or memory limit primitive. */
export function supportsResourceLimits(platform: string | undefined): boolean {
  return !isMacosPlatform(platform);
}
