import type { IpcMain, IpcMainInvokeEvent } from "electron";

import {
  IPC_CHANNELS,
  type AppInfoView,
  type DiagnosticsView,
  type EnvironmentDraft,
  type IpcChannel,
  type IpcResult,
  type RuntimeStatusView,
} from "../shared/contracts.js";
import {
  parseEnvironmentDraft,
  parseEnvironmentId,
  parseRemoveRequest,
  parseSettingsPatch,
  parseStopRequest,
  parseUpdateRequest,
} from "../shared/validation.js";
import { DesktopError, invalidRequest, toIpcError } from "./errors.js";
import type { DesktopLog } from "./logging.js";
import type { SettingsStore } from "./persistence/settings-store.js";
import type { RuntimeController } from "./runtime/runtime-controller.js";
import type { DesktopEnvironmentService } from "./services/environment-service.js";

export interface IpcDependencies {
  readonly service: DesktopEnvironmentService;
  readonly runtime: RuntimeController;
  readonly settings: SettingsStore;
  readonly appInfo: () => AppInfoView;
  readonly log: DesktopLog;
}

export type SenderAuthorizer = (event: IpcMainInvokeEvent) => boolean;

export type IpcHandlers = Readonly<
  Record<IpcChannel, (payload: unknown) => Promise<unknown>>
>;

/** Pure handler table: no Electron dependency, so it is directly testable. */
export function createIpcHandlers(dependencies: IpcDependencies): IpcHandlers {
  const { service, runtime, settings, appInfo } = dependencies;
  return {
    [IPC_CHANNELS.environmentsList]: async () => service.list(),
    [IPC_CHANNELS.environmentsGet]: async (payload) =>
      service.get(readId(payload)),
    [IPC_CHANNELS.environmentsCreate]: async (payload) =>
      service.create(readDraft(payload)),
    [IPC_CHANNELS.environmentsUpdate]: async (payload) => {
      const request = parseUpdateRequest(payload);
      if (!request.ok) {
        throw invalidRequest("修改请求无效。", request.issues);
      }
      return service.update(request.value.id, request.value.draft);
    },
    [IPC_CHANNELS.environmentsRemove]: async (payload) => {
      const request = readObject(payload, ["id", "options"], "删除请求");
      const id = readId(request.id);
      const options = parseRemoveRequest(request.options);
      if (!options.ok) {
        throw invalidRequest("删除选项无效。", options.issues);
      }
      await service.remove(id, options.value);
      return { removed: true as const };
    },
    [IPC_CHANNELS.environmentsLaunch]: async (payload) =>
      service.launch(readId(payload)),
    [IPC_CHANNELS.environmentsStop]: async (payload) => {
      const request = readObject(payload, ["id", "options"], "停止请求");
      const id = readId(request.id);
      const options = parseStopRequest(request.options);
      if (!options.ok) {
        throw invalidRequest("停止选项无效。", options.issues);
      }
      return service.stop(id, options.value);
    },
    [IPC_CHANNELS.environmentsVerify]: async (payload) =>
      service.verify(readId(payload)),
    [IPC_CHANNELS.environmentsDiagnostics]: async (
      payload,
    ): Promise<DiagnosticsView> => {
      const id = readId(payload);
      const environment = await service.get(id);
      return {
        environment,
        runtime: await runtime.status(),
        logs: service.logsFor(id),
        app: appInfo(),
      };
    },
    [IPC_CHANNELS.browsersDiscover]: () =>
      Promise.resolve(service.discoverBrowsers()),
    [IPC_CHANNELS.runtimeStatus]: async (): Promise<RuntimeStatusView> =>
      runtime.status(),
    [IPC_CHANNELS.runtimeRestart]: async (): Promise<RuntimeStatusView> =>
      runtime.retry(),
    [IPC_CHANNELS.appInfo]: () => Promise.resolve(appInfo()),
    [IPC_CHANNELS.settingsGet]: async () => settings.get(),
    [IPC_CHANNELS.settingsUpdate]: async (payload) => {
      const patch = parseSettingsPatch(payload);
      if (!patch.ok) {
        throw invalidRequest("设置内容无效。", patch.issues);
      }
      return settings.update(patch.value);
    },
  };
}

/**
 * Register the allowlisted channels. Every call is attributed to the one
 * application window and to an allowed document URL; everything else is
 * rejected before a handler runs.
 */
export function registerIpcHandlers(
  ipcMain: Pick<IpcMain, "handle">,
  handlers: IpcHandlers,
  authorize: SenderAuthorizer,
  log: DesktopLog,
): void {
  for (const channel of Object.values(IPC_CHANNELS)) {
    ipcMain.handle(
      channel,
      async (
        event: IpcMainInvokeEvent,
        payload: unknown,
      ): Promise<IpcResult<unknown>> => {
        if (!authorize(event)) {
          log.warn("ipc_rejected", "已拒绝来自未授权页面的调用。");
          return {
            ok: false,
            error: {
              code: "invalid_request",
              message: "调用来源未获授权。",
            },
          };
        }
        try {
          return { ok: true, data: await handlers[channel](payload) };
        } catch (error) {
          const view = toIpcError(error);
          log.warn(
            "ipc_failed",
            `IPC 操作失败：${view.code}`,
            view.details?.environmentId === undefined
              ? undefined
              : String(view.details.environmentId),
          );
          return { ok: false, error: view };
        }
      },
    );
  }
}

function readId(payload: unknown): string {
  const parsed = parseEnvironmentId(payload);
  if (!parsed.ok) {
    throw invalidRequest("环境 id 无效。", parsed.issues);
  }
  return parsed.value;
}

function readDraft(payload: unknown): EnvironmentDraft {
  const parsed = parseEnvironmentDraft(payload);
  if (!parsed.ok) {
    throw invalidRequest("环境配置无效。", parsed.issues);
  }
  return parsed.value;
}

function readObject(
  payload: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new DesktopError("invalid_request", `${label}必须是对象。`);
  }
  const record = payload as Record<string, unknown>;
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new DesktopError("invalid_request", `${label}包含未知字段。`);
    }
  }
  return record;
}
