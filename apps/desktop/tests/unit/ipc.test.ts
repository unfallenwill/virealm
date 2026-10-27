import { tmpdir } from "node:os";
import path from "node:path";

import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";

import { DesktopError } from "../../src/main/errors.js";
import {
  createIpcHandlers,
  registerIpcHandlers,
  type IpcHandlers,
} from "../../src/main/ipc.js";
import { DesktopLog } from "../../src/main/logging.js";
import type { SettingsStore } from "../../src/main/persistence/settings-store.js";
import type { RuntimeController } from "../../src/main/runtime/runtime-controller.js";
import type { DesktopEnvironmentService } from "../../src/main/services/environment-service.js";
import {
  IPC_CHANNELS,
  type AppInfoView,
  type EnvironmentView,
  type IpcResult,
  type RuntimeStatusView,
} from "../../src/shared/contracts.js";
import { draftFor, recordFor } from "./helpers/fakes.js";

function view(): EnvironmentView {
  return {
    ...recordFor(),
    state: "stopped",
    cdp: { connected: false },
    warnings: [],
  };
}

const appInfo: AppInfoView = {
  name: "Virealm",
  version: "0.1.0",
  userDataDir: path.join(tmpdir(), "virealm-data"),
  dataRoot: path.join(tmpdir(), "virealm-data", "data"),
  runtimeExecutable: path.join(tmpdir(), "virealm-runtime"),
  electronVersion: "45",
  chromeVersion: "156",
};

const runtimeView: RuntimeStatusView = {
  available: true,
  pipePath:
    process.platform === "win32"
      ? String.raw`\\.\pipe\test`
      : path.join(tmpdir(), "virealm-runtime.sock"),
  executablePath: path.join(tmpdir(), "virealm-runtime"),
  error: undefined,
  platform: { os: "windows", architecture: "x86_64", elevated: false },
  isolation: [],
  checkedAtUnixMs: 1,
};

interface Calls {
  readonly service: {
    list: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    launch: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    verify: ReturnType<typeof vi.fn>;
    logsFor: ReturnType<typeof vi.fn>;
    discoverBrowsers: ReturnType<typeof vi.fn>;
  };
  readonly runtime: {
    status: ReturnType<typeof vi.fn>;
    retry: ReturnType<typeof vi.fn>;
  };
  readonly settings: {
    get: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  readonly log: DesktopLog;
}

function handlers(): { handlers: IpcHandlers; calls: Calls } {
  const service = {
    list: vi.fn(() => Promise.resolve([view()])),
    get: vi.fn(() => Promise.resolve(view())),
    create: vi.fn(() => Promise.resolve(view())),
    update: vi.fn(() =>
      Promise.resolve({
        environment: view(),
        appliedFields: ["timezone"],
        restartFields: [],
        message: "ok",
      }),
    ),
    remove: vi.fn(() => Promise.resolve()),
    launch: vi.fn(() => Promise.resolve(view())),
    stop: vi.fn(() => Promise.resolve(view())),
    verify: vi.fn(() => Promise.resolve(view())),
    logsFor: vi.fn(() => []),
    discoverBrowsers: vi.fn(() => []),
  };
  const runtime = {
    status: vi.fn(() => Promise.resolve(runtimeView)),
    retry: vi.fn(() => Promise.resolve(runtimeView)),
  };
  const settings = {
    get: vi.fn(() => Promise.resolve({ theme: "dark" as const })),
    update: vi.fn(() =>
      Promise.resolve({
        theme: "light" as const,
        defaultBrowserPath: undefined,
      }),
    ),
  };
  const log = new DesktopLog(() => 1);
  const table = createIpcHandlers({
    service: service as unknown as DesktopEnvironmentService,
    runtime: runtime as unknown as RuntimeController,
    settings: settings as unknown as SettingsStore,
    appInfo: () => appInfo,
    log,
  });
  return {
    handlers: table,
    calls: { service, runtime, settings, log },
  };
}

describe("createIpcHandlers", () => {
  it("covers every allowlisted channel", () => {
    const { handlers: table } = handlers();
    expect(Object.keys(table).sort()).toEqual(
      Object.values(IPC_CHANNELS).sort(),
    );
  });

  it("lists environments", async () => {
    const { handlers: table, calls } = handlers();
    const result = await table[IPC_CHANNELS.environmentsList](undefined);
    expect(result).toEqual([view()]);
    expect(calls.service.list).toHaveBeenCalledOnce();
  });

  it("reads validated ids", async () => {
    const { handlers: table, calls } = handlers();
    expect(await table[IPC_CHANNELS.environmentsGet]("env-test")).toEqual(
      view(),
    );
    await expect(
      table[IPC_CHANNELS.environmentsGet]("BAD"),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(calls.service.get).toHaveBeenCalledTimes(1);
  });

  it("validates create drafts", async () => {
    const { handlers: table, calls } = handlers();
    expect(await table[IPC_CHANNELS.environmentsCreate](draftFor())).toEqual(
      view(),
    );
    await expect(
      table[IPC_CHANNELS.environmentsCreate]({ name: "" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(calls.service.create).toHaveBeenCalledTimes(1);
  });

  it("validates update requests", async () => {
    const { handlers: table, calls } = handlers();
    const result = await table[IPC_CHANNELS.environmentsUpdate]({
      id: "env-test",
      draft: draftFor(),
    });
    expect(result).toMatchObject({ appliedFields: ["timezone"] });
    await expect(
      table[IPC_CHANNELS.environmentsUpdate]({
        id: "env-test",
        draft: draftFor(),
        extra: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(calls.service.update).toHaveBeenCalledOnce();
  });

  it("validates remove requests and defaults to keeping data", async () => {
    const { handlers: table, calls } = handlers();
    expect(
      await table[IPC_CHANNELS.environmentsRemove]({ id: "env-test" }),
    ).toEqual({ removed: true });
    expect(calls.service.remove).toHaveBeenCalledWith("env-test", {
      deleteData: false,
    });

    await table[IPC_CHANNELS.environmentsRemove]({
      id: "env-test",
      options: { deleteData: true },
    });
    expect(calls.service.remove).toHaveBeenLastCalledWith("env-test", {
      deleteData: true,
    });

    await expect(
      table[IPC_CHANNELS.environmentsRemove]({
        id: "env-test",
        options: { deleteData: "yes" },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      table[IPC_CHANNELS.environmentsRemove]({
        id: "env-test",
        extra: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      table[IPC_CHANNELS.environmentsRemove]("env-test"),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("validates stop options", async () => {
    const { handlers: table, calls } = handlers();
    await table[IPC_CHANNELS.environmentsStop]({ id: "env-test" });
    expect(calls.service.stop).toHaveBeenCalledWith("env-test", {
      force: false,
    });
    await table[IPC_CHANNELS.environmentsStop]({
      id: "env-test",
      options: { force: true },
    });
    expect(calls.service.stop).toHaveBeenLastCalledWith("env-test", {
      force: true,
    });

    await expect(
      table[IPC_CHANNELS.environmentsStop]({
        id: "env-test",
        options: { force: 1 },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      table[IPC_CHANNELS.environmentsStop](null),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("launches and verifies by id", async () => {
    const { handlers: table, calls } = handlers();
    await table[IPC_CHANNELS.environmentsLaunch]("env-test");
    await table[IPC_CHANNELS.environmentsVerify]("env-test");
    expect(calls.service.launch).toHaveBeenCalledWith("env-test");
    expect(calls.service.verify).toHaveBeenCalledWith("env-test");
  });

  it("assembles diagnostics from live status and logs", async () => {
    const { handlers: table, calls } = handlers();
    const result =
      await table[IPC_CHANNELS.environmentsDiagnostics]("env-test");
    expect(result).toEqual({
      environment: view(),
      runtime: runtimeView,
      logs: [],
      app: appInfo,
    });
    expect(calls.runtime.status).toHaveBeenCalledOnce();
    expect(calls.service.logsFor).toHaveBeenCalledWith("env-test");
  });

  it("returns browser, runtime and app information", async () => {
    const { handlers: table, calls } = handlers();
    expect(await table[IPC_CHANNELS.browsersDiscover](undefined)).toEqual([]);
    expect(await table[IPC_CHANNELS.runtimeStatus](undefined)).toEqual(
      runtimeView,
    );
    expect(await table[IPC_CHANNELS.runtimeRestart](undefined)).toEqual(
      runtimeView,
    );
    expect(await table[IPC_CHANNELS.appInfo](undefined)).toEqual(appInfo);
    expect(calls.runtime.retry).toHaveBeenCalledOnce();
  });

  it("validates settings patches", async () => {
    const { handlers: table, calls } = handlers();
    expect(await table[IPC_CHANNELS.settingsGet](undefined)).toEqual({
      theme: "dark",
    });
    expect(
      await table[IPC_CHANNELS.settingsUpdate]({ theme: "light" }),
    ).toEqual({
      theme: "light",
      defaultBrowserPath: undefined,
    });
    await expect(
      table[IPC_CHANNELS.settingsUpdate]({ theme: "neon" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(calls.settings.update).toHaveBeenCalledOnce();
  });
});

describe("registerIpcHandlers", () => {
  interface Registered {
    readonly channel: string;
    readonly handler: (
      event: IpcMainInvokeEvent,
      payload: unknown,
    ) => Promise<IpcResult<unknown>>;
  }

  function register(authorize: (event: IpcMainInvokeEvent) => boolean): {
    readonly entries: Registered[];
    readonly log: DesktopLog;
    readonly calls: Calls;
  } {
    const { handlers: table, calls } = handlers();
    const entries: Registered[] = [];
    const ipcMain = {
      handle: (channel: string, handler: Registered["handler"]) => {
        entries.push({ channel, handler });
      },
    };
    const log = new DesktopLog(() => 1);
    registerIpcHandlers(ipcMain, table, authorize, log);
    return { entries, log, calls };
  }

  function event(): IpcMainInvokeEvent {
    return { sender: {}, senderFrame: {} } as unknown as IpcMainInvokeEvent;
  }

  it("registers every channel and authorises the sender", async () => {
    const { entries } = register(() => true);
    expect(entries).toHaveLength(Object.values(IPC_CHANNELS).length);
    const list = entries.find(
      (entry) => entry.channel === IPC_CHANNELS.environmentsList,
    );
    expect(await list?.handler(event(), undefined)).toEqual({
      ok: true,
      data: [view()],
    });
  });

  it("rejects unauthorised senders before running a handler", async () => {
    const { entries, log, calls } = register(() => false);
    const launch = entries.find(
      (entry) => entry.channel === IPC_CHANNELS.environmentsLaunch,
    );
    expect(await launch?.handler(event(), "env-test")).toEqual({
      ok: false,
      error: {
        code: "invalid_request",
        message: "调用来源未获授权。",
      },
    });
    expect(calls.service.launch).not.toHaveBeenCalled();
    expect(log.list().map((entry) => entry.code)).toEqual(["ipc_rejected"]);
  });

  it("converts handler failures into structured responses and logs", async () => {
    const { entries, log, calls } = register(() => true);
    calls.service.launch.mockRejectedValue(
      new DesktopError("launch_failed", "Chrome failed", {
        details: { environmentId: "env-test" },
      }),
    );
    const launch = entries.find(
      (entry) => entry.channel === IPC_CHANNELS.environmentsLaunch,
    );
    expect(await launch?.handler(event(), "env-test")).toEqual({
      ok: false,
      error: {
        code: "launch_failed",
        message: "Chrome failed",
        details: { environmentId: "env-test" },
      },
    });
    expect(log.list()[0]).toMatchObject({
      code: "ipc_failed",
      environmentId: "env-test",
    });
  });

  it("logs failures without an environment id", async () => {
    const { entries, log, calls } = register(() => true);
    calls.service.list.mockRejectedValue(new Error("boom"));
    const list = entries.find(
      (entry) => entry.channel === IPC_CHANNELS.environmentsList,
    );
    const result = await list?.handler(event(), undefined);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "internal_error" },
    });
    expect(log.list()[0]?.environmentId).toBeUndefined();
  });
});
