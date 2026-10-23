import type { IsolationMode } from "./contracts.js";

/**
 * Isolation modes the desktop accepts for a Chrome environment.
 *
 * The process runtime supports three modes and applies them correctly, but
 * Chromium's *browser* process cannot start inside a token the runtime has
 * already restricted: it aborts while initialising its own sandbox with
 * `STATUS_BREAKPOINT` (0x80000003) and never publishes a debugging endpoint.
 * Verified against Chrome 156.0.8078.48 on Windows 11 x86_64 with the real
 * runtime; a plain program runs normally under the same restricted token, so
 * the limitation belongs to Chromium and not to the runtime.
 *
 * The desktop only manages Chrome, so those modes are refused here rather
 * than offered and failed at launch time.
 */
export const BROWSER_INCOMPATIBLE_ISOLATION: ReadonlySet<IsolationMode> =
  new Set<IsolationMode>(["restricted", "app_container"]);

/** The one mode Chromium's browser process can run under. */
export const BROWSER_COMPATIBLE_ISOLATION: IsolationMode = "managed";

/** Why the two restricted modes are unavailable, in user-facing wording. */
export const BROWSER_INCOMPATIBLE_REASON =
  "受限令牌与 AppContainer 不适用于 Chrome：Chromium 的浏览器进程无法在被限制的令牌下启动自己的沙箱，会在启动时以 STATUS_BREAKPOINT 中止。请改用「Job Object 管理」。";

/** The same finding with the evidence behind it. */
export const BROWSER_INCOMPATIBLE_DETAIL =
  "受限令牌与 AppContainer 不适用于 Chrome：Chromium 的浏览器进程无法在被限制的令牌下启动自己的沙箱，会在启动时以 STATUS_BREAKPOINT（0x80000003）中止。已在 Chrome 156.0.8078.48 / Windows 11 上用真实运行时实测：同一令牌下的普通程序可以正常运行，因此这是 Chromium 自身的限制，而不是运行时的问题。这两种模式仍适用于运行时管理的其它程序。";

export function isBrowserCompatibleIsolation(mode: IsolationMode): boolean {
  return !BROWSER_INCOMPATIBLE_ISOLATION.has(mode);
}

/** Short label for a mode in the interface. */
export function isolationModeLabel(mode: IsolationMode): string {
  switch (mode) {
    case "managed":
      return "Job Object 管理";
    case "restricted":
      return "受限令牌";
    case "app_container":
      return "AppContainer";
  }
}
