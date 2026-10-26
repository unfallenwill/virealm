import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserAdapter, ProcessRuntimeClient } from "@virealm/browser-adapter";
import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  session,
  type IpcMainInvokeEvent,
} from "electron";

import type { AppInfoView } from "../shared/contracts.js";
import { createIpcHandlers, registerIpcHandlers } from "./ipc.js";
import { DesktopLog } from "./logging.js";
import { JsonEnvironmentStore } from "./persistence/environment-store.js";
import { JsonSettingsStore } from "./persistence/settings-store.js";
import { RuntimeController } from "./runtime/runtime-controller.js";
import { startProbeServer, type ProbeServer } from "./runtime/probe-server.js";
import { DesktopEnvironmentService } from "./services/environment-service.js";
import { SafeProfileCleanup } from "./services/profile-cleanup.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

const log = new DesktopLog();
let mainWindow: BrowserWindow | undefined;
let runtime: RuntimeController | undefined;
let adapter: BrowserAdapter | undefined;
let service: DesktopEnvironmentService | undefined;
let probe: ProbeServer | undefined;
let quitting = false;
let bootFailed = false;

interface WiredApp {
  readonly runtime: RuntimeController;
  readonly adapter: BrowserAdapter;
  readonly service: DesktopEnvironmentService;
  readonly settings: JsonSettingsStore;
  readonly appInfo: () => AppInfoView;
  readonly dataRoot: string;
  readonly rendererIndex: string;
}

let wired: WiredApp | undefined;

function createWindow(wiredApp: WiredApp): BrowserWindow {
  const devServerUrl = process.env.VIREALM_DEV_SERVER_URL;
  const window = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "Virealm",
    backgroundColor: "#111315",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(moduleDirectory, "..", "preload", "index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged || process.env.VIREALM_DEVTOOLS === "1",
    },
  });

  window.once("ready-to-show", () => {
    window.show();
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    const allowed =
      devServerUrl !== undefined &&
      url.startsWith(new URL(devServerUrl).origin);
    if (!allowed) {
      event.preventDefault();
      log.warn("navigation_blocked", "已阻止应用窗口导航到外部页面。");
    }
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    log.error(
      "renderer_gone",
      `渲染进程退出（${details.reason}），请重新启动应用。`,
    );
  });

  if (devServerUrl === undefined) {
    void window.loadFile(wiredApp.rendererIndex);
  } else {
    void window.loadURL(devServerUrl);
  }
  return window;
}

function authorizeSender(
  event: IpcMainInvokeEvent,
  devServerUrl: string | undefined,
  rendererIndex: string,
): boolean {
  if (event.sender !== mainWindow?.webContents) {
    return false;
  }
  if (event.senderFrame !== event.sender.mainFrame) {
    return false;
  }
  const url = event.senderFrame.url;
  if (devServerUrl !== undefined) {
    return url.startsWith(new URL(devServerUrl).origin);
  }
  if (!url.startsWith("file://")) {
    return false;
  }
  try {
    return path.resolve(fileURLToPath(url)) === path.resolve(rendererIndex);
  } catch {
    return false;
  }
}

async function wire(): Promise<WiredApp> {
  const userDataDir = app.getPath("userData");
  const dataRoot = path.join(userDataDir, "data");
  const settings = new JsonSettingsStore(
    path.join(userDataDir, "settings.json"),
  );

  probe = await startProbeServer().catch((error: unknown) => {
    log.warn(
      "probe_unavailable",
      `本地语言检测端点不可用，Accept-Language 将显示为未验证：${messageOf(error)}`,
    );
    return undefined;
  });

  runtime = new RuntimeController({
    appRoot: path.resolve(moduleDirectory, "..", ".."),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    log,
  });

  adapter = new BrowserAdapter({
    dataRoot,
    // The adapter translates runtime failures into its own error categories.
    // Handing it the raw client would collapse every runtime error into one
    // generic message and hide the real cause from the interface.
    runtime: new ProcessRuntimeClient(runtime.client),
    ...(probe === undefined ? {} : { networkProbeUrl: probe.url }),
  });

  const store = new JsonEnvironmentStore(
    path.join(userDataDir, "environments.json"),
  );
  service = new DesktopEnvironmentService({
    store,
    adapter,
    dataRoot,
    cleanup: new SafeProfileCleanup(dataRoot),
    log,
  });
  await service.initialize();

  const rendererIndex = path.join(
    moduleDirectory,
    "..",
    "renderer",
    "index.html",
  );
  const appInfo = (): AppInfoView => ({
    name: "Virealm",
    version: app.getVersion(),
    userDataDir,
    dataRoot,
    runtimeExecutable: runtime?.runtimeExecutable,
    electronVersion: process.versions.electron ?? "unknown",
    chromeVersion: process.versions.chrome ?? "unknown",
  });

  return {
    runtime,
    adapter,
    service,
    settings,
    appInfo,
    dataRoot,
    rendererIndex,
  };
}

async function start(): Promise<void> {
  if (process.platform === "darwin") {
    // macOS needs the standard menu for Cmd+C/V/Q and the app menu.
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: "appMenu" },
        { role: "editMenu" },
        { role: "windowMenu" },
      ]),
    );
  } else {
    Menu.setApplicationMenu(null);
  }
  if (process.platform === "win32") {
    app.setAppUserModelId("com.virealm.desktop");
  }

  try {
    wired = await wire();
  } catch (error) {
    bootFailed = true;
    log.error("startup_failed", `应用初始化失败：${messageOf(error)}`);
    dialog.showErrorBox(
      "Virealm 无法启动",
      `初始化失败：${messageOf(error)}\n\n诊断信息已写入应用日志。`,
    );
    app.quit();
    return;
  }

  const appWired = wired;
  const devServerUrl = process.env.VIREALM_DEV_SERVER_URL;
  const handlers = createIpcHandlers({
    service: appWired.service,
    runtime: appWired.runtime,
    settings: appWired.settings,
    appInfo: appWired.appInfo,
    log,
  });
  registerIpcHandlers(
    ipcMain,
    handlers,
    (event: IpcMainInvokeEvent) =>
      authorizeSender(event, devServerUrl, appWired.rendererIndex),
    log,
  );

  session.defaultSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => {
      callback(false);
    },
  );
  session.defaultSession.setPermissionCheckHandler(() => false);

  mainWindow = createWindow(appWired);
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });

  // Runtime startup can take seconds; the window and its runtime panel appear
  // immediately and reflect the real state while this resolves.
  void appWired.runtime
    .initialize()
    .then((status) => {
      if (!status.available) {
        log.warn(
          "runtime_unavailable",
          status.error?.message ?? "运行时不可用。",
        );
      }
    })
    .catch((error: unknown) => {
      log.error("runtime_probe_failed", messageOf(error));
    });

  log.info("app_started", `Virealm ${app.getVersion()} 已启动。`);
}

async function shutdown(): Promise<void> {
  const current = wired;
  if (current === undefined) {
    return;
  }
  const deadline = new Promise<void>((resolve) => {
    setTimeout(resolve, 12_000);
  });
  const work = (async (): Promise<void> => {
    try {
      const environments = await current.service.list();
      await Promise.allSettled(
        environments
          .filter(
            (environment) =>
              environment.state === "running" ||
              environment.state === "starting" ||
              environment.state === "stopping",
          )
          .map((environment) =>
            current.service.stop(environment.id, { force: true }),
          ),
      );
    } catch (error) {
      log.warn("shutdown_environment_failed", messageOf(error));
    }
    await current.adapter.close().catch((error: unknown) => {
      log.warn("shutdown_adapter_failed", messageOf(error));
    });
    await current.runtime.stop().catch((error: unknown) => {
      log.warn("shutdown_runtime_failed", messageOf(error));
    });
    await probe?.close().catch(() => undefined);
    probe = undefined;
  })();
  await Promise.race([work, deadline]);
}

// Automated tests and local development can isolate registry, settings and
// browser profiles from the real user data directory. Packaged builds always
// use the OS-provided location.
//
// The path has to be replaced before the single instance lock is requested:
// Electron keys that lock on the user data directory, so an override applied
// later would still collide with an installed instance.
const userDataOverride = process.env.VIREALM_USER_DATA_DIR;
if (!app.isPackaged && userDataOverride !== undefined) {
  app.setPath("userData", path.resolve(userDataOverride));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow !== undefined) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", (event) => {
    if (quitting) {
      return;
    }
    event.preventDefault();
    quitting = true;
    if (bootFailed) {
      app.quit();
      return;
    }
    void shutdown().finally(() => {
      app.quit();
    });
  });

  app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      log.error("startup_failed", messageOf(error));
      app.quit();
    });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
