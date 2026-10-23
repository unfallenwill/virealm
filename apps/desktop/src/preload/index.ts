import { contextBridge, ipcRenderer } from "electron";

import type { DesktopApi } from "../shared/api.js";
import {
  IPC_CHANNELS,
  type IpcChannel,
  type IpcResult,
} from "../shared/contracts.js";

async function invoke<T>(
  channel: IpcChannel,
  payload?: unknown,
): Promise<IpcResult<T>> {
  const response: unknown = await ipcRenderer.invoke(channel, payload);
  return response as IpcResult<T>;
}

const api: DesktopApi = {
  listEnvironments: () => invoke(IPC_CHANNELS.environmentsList),
  getEnvironment: (id) => invoke(IPC_CHANNELS.environmentsGet, id),
  createEnvironment: (draft) => invoke(IPC_CHANNELS.environmentsCreate, draft),
  updateEnvironment: (id, draft) =>
    invoke(IPC_CHANNELS.environmentsUpdate, { id, draft }),
  removeEnvironment: (id, options) =>
    invoke(IPC_CHANNELS.environmentsRemove, { id, options }),
  launchEnvironment: (id) => invoke(IPC_CHANNELS.environmentsLaunch, id),
  stopEnvironment: (id, options) =>
    invoke(IPC_CHANNELS.environmentsStop, { id, options }),
  verifyEnvironment: (id) => invoke(IPC_CHANNELS.environmentsVerify, id),
  environmentDiagnostics: (id) =>
    invoke(IPC_CHANNELS.environmentsDiagnostics, id),
  discoverBrowsers: () => invoke(IPC_CHANNELS.browsersDiscover),
  runtimeStatus: () => invoke(IPC_CHANNELS.runtimeStatus),
  restartRuntime: () => invoke(IPC_CHANNELS.runtimeRestart),
  appInfo: () => invoke(IPC_CHANNELS.appInfo),
  getSettings: () => invoke(IPC_CHANNELS.settingsGet),
  updateSettings: (patch) => invoke(IPC_CHANNELS.settingsUpdate, patch),
};

contextBridge.exposeInMainWorld("virealm", api);
