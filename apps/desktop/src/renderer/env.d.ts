import type { DesktopApi } from "../shared/api.js";

declare global {
  interface Window {
    /**
     * The complete preload surface. It contains only named operations; there
     * is no generic IPC invoke, filesystem access or process control here.
     */
    readonly virealm: DesktopApi;
  }
}

export {};
