import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  CapabilityReport,
  LaunchParams,
  ProcessStatus,
} from "@virealm/contracts";

import type {
  BrowserConnectorPort,
  BrowserPagePort,
  BrowserSessionPort,
  CdpSessionPort,
  ChromeDiscoveryPort,
  RuntimePort,
  RuntimeStateStorePort,
} from "../../../src/application/ports.js";
import {
  EnvironmentService,
  type EnvironmentServiceOptions,
} from "../../../src/application/environment-service.js";
import type {
  BrowserEnvironmentConfig,
  DiscoveredBrowser,
} from "../../../src/domain/environment.js";
import { BrowserAdapterError } from "../../../src/domain/errors.js";
import type { PersistedRuntimeState } from "../../../src/domain/status.js";

export const TEST_CHROME_VERSION = "156.0.8078.48";
export const TEST_CHROME = path.join(
  tmpdir(),
  "VirealmTestChrome",
  "Application",
  TEST_CHROME_VERSION,
  "chrome.exe",
);
export const TEST_MAC_CHROME = path.join(
  tmpdir(),
  "VirealmTestChrome.app",
  "Contents",
  "MacOS",
  "Google Chrome",
);
export const TEST_ENDPOINT = "ws://127.0.0.1:45678/devtools/browser/fake";

export function supportedCapabilities(
  overrides: Partial<CapabilityReport> = {},
): CapabilityReport {
  return {
    platform: {
      os: "windows",
      version: { major: 10, minor: 0, build: 26_200 },
      architecture: "x86_64",
      elevated: false,
      integrityLevel: "medium",
    },
    jobObject: { state: "supported" },
    appContainer: { state: "supported" },
    appContainerAcl: { state: "supported" },
    restrictedToken: { state: "supported" },
    processMitigation: { state: "supported" },
    etw: { state: "supported" },
    ...overrides,
  };
}

/** A macOS report: Windows-only entries are unsupported, process groups run. */
export function macosCapabilities(
  overrides: Partial<CapabilityReport> = {},
): CapabilityReport {
  return {
    platform: {
      os: "macos",
      version: { major: 27, minor: 0, build: 1 },
      osVersion: "27.0.1",
      architecture: "arm64",
      elevated: false,
      integrityLevel: "unknown",
    },
    jobObject: { state: "unsupported" },
    appContainer: { state: "unsupported" },
    appContainerAcl: { state: "unsupported" },
    restrictedToken: { state: "unsupported" },
    processMitigation: { state: "unsupported" },
    etw: { state: "unsupported" },
    processGroup: { state: "supported" },
    resourceLimits: {
      maxProcesses: { state: "unavailable" },
      memoryLimit: { state: "unavailable" },
    },
    ...overrides,
  };
}

export function requireValue<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("expected a value, received undefined");
  }
  return value;
}

export class FakeRuntime implements RuntimePort {
  readonly launches: LaunchParams[] = [];
  readonly statuses = new Map<string, ProcessStatus>();
  capabilities: CapabilityReport = supportedCapabilities();
  capabilitiesError: Error | undefined;
  launchError: Error | undefined;
  statusError: Error | undefined;
  terminateCalls = 0;
  onLaunch: ((params: LaunchParams, status: ProcessStatus) => void) | undefined;
  launchState: "starting" | "running" = "running";
  capabilitiesGate: Promise<void> | undefined;
  capabilitiesHook: (() => void) | undefined;
  terminateGate: Promise<void> | undefined;
  terminateHook: (() => void) | undefined;
  private nextPid = 4_000;

  async getCapabilities(): Promise<CapabilityReport> {
    this.capabilitiesHook?.();
    if (this.capabilitiesGate !== undefined) {
      await this.capabilitiesGate;
    }
    if (this.capabilitiesError !== undefined) {
      throw this.capabilitiesError;
    }
    return this.capabilities;
  }

  launch(params: LaunchParams): Promise<ProcessStatus> {
    if (this.launchError !== undefined) {
      throw this.launchError;
    }
    this.launches.push(params);
    this.nextPid += 1;
    const pid = this.nextPid;
    const status: ProcessStatus = {
      processInstanceId: `${String(pid)}:133000000000000000`,
      pid,
      creationTime100ns: "133000000000000000",
      startedAtUnixMs: 1_700_000_000_000,
      state:
        this.launchState === "running"
          ? { state: "running", pid }
          : { state: "starting" },
      applied: {
        mode: params.policy.isolation,
        jobObjectAttached: this.capabilities.platform.os !== "macos",
        appContainerToken: params.policy.isolation === "app_container",
        restrictedToken: params.policy.isolation === "restricted",
        lowIntegrity: params.policy.isolation !== "managed",
        fileAccessRestricted: params.policy.isolation === "app_container",
        networkAccess: params.policy.networkAccess,
        networkCapabilitiesVerified: true,
        ...(this.capabilities.platform.os === "macos"
          ? {
              processGroupAttached: true,
              processGroupId: pid,
              killOnCloseArmed: true,
            }
          : {}),
      },
    };
    this.statuses.set(status.processInstanceId, status);
    this.onLaunch?.(params, status);
    return Promise.resolve(status);
  }

  getStatus(processInstanceId: string): Promise<ProcessStatus> {
    if (this.statusError !== undefined) {
      return Promise.reject(this.statusError);
    }
    const status = this.statuses.get(processInstanceId);
    if (status === undefined) {
      return Promise.reject(
        new BrowserAdapterError(
          "runtime_operation_failed",
          "the runtime does not own this process",
          { contractCode: "process_not_found" },
        ),
      );
    }
    return Promise.resolve(status);
  }

  async terminate(processInstanceId: string): Promise<ProcessStatus> {
    this.terminateCalls += 1;
    this.terminateHook?.();
    if (this.terminateGate !== undefined) {
      await this.terminateGate;
    }
    const status = this.statuses.get(processInstanceId);
    if (status === undefined) {
      throw new BrowserAdapterError(
        "runtime_operation_failed",
        "the runtime does not own this process",
        { contractCode: "process_not_found" },
      );
    }
    const exited: ProcessStatus = {
      ...status,
      state: { state: "exited", exitCode: 0 },
    };
    this.statuses.set(processInstanceId, exited);
    return exited;
  }

  markExited(processInstanceId: string, exitCode: number): void {
    const status = this.statuses.get(processInstanceId);
    if (status === undefined) {
      return;
    }
    this.statuses.set(processInstanceId, {
      ...status,
      state: { state: "exited", exitCode },
    });
  }
}

export class FakeCdpSession implements CdpSessionPort {
  readonly sent: { method: string; params: Record<string, unknown> }[] = [];
  failMethods: ReadonlySet<string> = new Set();
  detached = false;
  private readonly page: FakePage;

  constructor(page: FakePage) {
    this.page = page;
  }

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const actual = params ?? {};
    this.sent.push({ method, params: actual });
    if (this.failMethods.has(method)) {
      return Promise.reject(new Error(`forced ${method} failure`));
    }
    this.page.applyCommand(method, actual);
    return Promise.resolve({});
  }

  detach(): Promise<void> {
    this.detached = true;
    return Promise.resolve();
  }
}

export class FakePage implements BrowserPagePort {
  readonly pageId: string;
  currentUrl: string;
  timezone = "UTC";
  language = "en-US";
  languages = "en-US";
  userAgent = "FakeChrome/156.0";
  acceptLanguage = "en-US,en";
  viewport = {
    width: 1_280,
    height: 720,
    screenWidth: 1_280,
    screenHeight: 720,
  };
  pixelRatio = 1;
  probeResult: unknown = { acceptLanguage: "en-US,en" };
  geolocationResult: unknown = {
    supported: true,
    latitude: 1.3521,
    longitude: 103.8198,
    accuracy: 20,
  };
  evaluateError: Error | undefined;
  failMethods: ReadonlySet<string> = new Set();
  reflectTimezone = true;
  reflectLocale = true;
  reflectViewport = true;
  reflectDeviceScale = true;
  reflectAcceptLanguage = true;
  reflectGeolocation = true;
  closed = false;
  onClose: (() => void) | undefined;
  readonly cdpSessions: FakeCdpSession[] = [];

  constructor(pageId: string, url = "about:blank") {
    this.pageId = pageId;
    this.currentUrl = url;
  }

  evaluate<T>(expression: string): Promise<T> {
    if (this.evaluateError !== undefined) {
      return Promise.reject(this.evaluateError);
    }
    return Promise.resolve(this.respond(expression) as T);
  }

  navigate(url: string): Promise<void> {
    this.currentUrl = url;
    return Promise.resolve();
  }

  createCdpSession(): Promise<CdpSessionPort> {
    const session = new FakeCdpSession(this);
    session.failMethods = this.failMethods;
    this.cdpSessions.push(session);
    return Promise.resolve(session);
  }

  close(): Promise<void> {
    this.closed = true;
    this.onClose?.();
    return Promise.resolve();
  }

  url(): string {
    return this.currentUrl;
  }

  applyCommand(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "Emulation.setTimezoneOverride":
        if (this.reflectTimezone) {
          this.timezone = String(params.timezoneId);
        }
        return;
      case "Emulation.setLocaleOverride":
        if (this.reflectLocale) {
          this.language = String(params.locale);
          this.languages = String(params.locale);
        }
        return;
      case "Network.setUserAgentOverride":
        if (this.reflectAcceptLanguage) {
          this.acceptLanguage = String(params.acceptLanguage);
          this.probeResult = {
            acceptLanguage: this.acceptLanguage,
          };
        }
        if (typeof params.userAgent === "string") {
          this.userAgent = params.userAgent;
        }
        return;
      case "Emulation.setDeviceMetricsOverride":
        if (this.reflectViewport) {
          this.viewport = {
            ...this.viewport,
            width: Number(params.width),
            height: Number(params.height),
          };
        }
        if (this.reflectDeviceScale) {
          this.pixelRatio = Number(params.deviceScaleFactor);
        }
        return;
      case "Emulation.setGeolocationOverride":
        if (this.reflectGeolocation) {
          this.geolocationResult = {
            supported: true,
            latitude: Number(params.latitude),
            longitude: Number(params.longitude),
            accuracy: Number(params.accuracy),
          };
        }
        return;
      default:
        return;
    }
  }

  private respond(expression: string): unknown {
    if (expression.includes("resolvedOptions().timeZone")) {
      return this.timezone;
    }
    if (expression.includes("navigator.language")) {
      return { language: this.language, languages: this.languages };
    }
    if (expression.includes("innerWidth")) {
      return {
        ...this.viewport,
        devicePixelRatio: this.pixelRatio,
      };
    }
    if (expression.includes("window.devicePixelRatio")) {
      return this.pixelRatio;
    }
    if (expression.includes("navigator.userAgent")) {
      return this.userAgent;
    }
    if (expression.includes("getCurrentPosition")) {
      return this.geolocationResult;
    }
    if (expression.includes("fetch(")) {
      if (this.probeResult instanceof Error) {
        throw this.probeResult;
      }
      return this.probeResult;
    }
    throw new Error(`unexpected page expression: ${expression}`);
  }
}

export class FakeSession implements BrowserSessionPort {
  readonly pagesList: FakePage[] = [];
  readonly commands: { method: string; params: Record<string, unknown> }[] = [];
  versionValue = TEST_CHROME_VERSION;
  connected = true;
  onBrowserClose: (() => void) | undefined;
  browserCommandError: Error | undefined;
  private pageListeners = new Set<(page: BrowserPagePort) => void>();
  private disconnectListeners = new Set<() => void>();
  private nextPageId = 1;

  constructor(initialPages = 1) {
    for (let index = 0; index < initialPages; index += 1) {
      this.pagesList.push(this.createPage());
    }
  }

  version(): string {
    return this.versionValue;
  }

  pages(): readonly BrowserPagePort[] {
    return this.pagesList;
  }

  async newPage(url: string): Promise<BrowserPagePort> {
    const page = this.createPage();
    this.pagesList.push(page);
    if (url.length > 0) {
      await page.navigate(url);
    }
    for (const listener of [...this.pageListeners]) {
      listener(page);
    }
    return page;
  }

  onPageCreated(listener: (page: BrowserPagePort) => void): () => void {
    this.pageListeners.add(listener);
    return (): void => {
      this.pageListeners.delete(listener);
    };
  }

  onDisconnected(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return (): void => {
      this.disconnectListeners.delete(listener);
    };
  }

  sendBrowserCommand(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    this.commands.push({ method, params: params ?? {} });
    if (this.browserCommandError !== undefined) {
      return Promise.reject(this.browserCommandError);
    }
    if (method === "Browser.close") {
      this.onBrowserClose?.();
    }
    return Promise.resolve({});
  }

  disconnect(): Promise<void> {
    this.emitDisconnected();
    return Promise.resolve();
  }

  isConnected(): boolean {
    return this.connected;
  }

  emitDisconnected(): void {
    this.connected = false;
    for (const listener of [...this.disconnectListeners]) {
      listener();
    }
  }

  emitPage(page: FakePage): void {
    this.pagesList.push(page);
    for (const listener of [...this.pageListeners]) {
      listener(page);
    }
  }

  private createPage(): FakePage {
    const page = new FakePage(`page-${String(this.nextPageId)}`);
    this.nextPageId += 1;
    page.onClose = (): void => {
      const index = this.pagesList.indexOf(page);
      if (index >= 0) {
        this.pagesList.splice(index, 1);
      }
    };
    return page;
  }
}

export class FakeConnector implements BrowserConnectorPort {
  readonly endpoints: string[] = [];
  readonly sessions: FakeSession[] = [];
  readonly timeouts: number[] = [];
  connectError: Error | undefined;
  sessionFactory: () => FakeSession = () => new FakeSession();

  connect(endpoint: string, timeoutMs: number): Promise<BrowserSessionPort> {
    this.endpoints.push(endpoint);
    this.timeouts.push(timeoutMs);
    if (this.connectError !== undefined) {
      return Promise.reject(this.connectError);
    }
    const session = this.sessionFactory();
    this.sessions.push(session);
    return Promise.resolve(session);
  }
}

export class FakeDiscovery implements ChromeDiscoveryPort {
  constructor(
    readonly browsers: readonly DiscoveredBrowser[] = [
      {
        executablePath: TEST_CHROME,
        version: TEST_CHROME_VERSION,
        source: "test",
      },
    ],
  ) {}

  discover(executablePath?: string): readonly DiscoveredBrowser[] {
    if (executablePath === undefined) {
      return this.browsers;
    }
    return this.browsers.filter(
      (browser) =>
        browser.executablePath.toLowerCase() ===
        path.resolve(executablePath).toLowerCase(),
    );
  }
}

export class MemoryStateStore implements RuntimeStateStorePort {
  readonly entries = new Map<string, PersistedRuntimeState>();
  readCount = 0;
  writeCount = 0;
  failWrites = false;

  read(environmentId: string): Promise<PersistedRuntimeState | undefined> {
    this.readCount += 1;
    const entry = this.entries.get(environmentId);
    return Promise.resolve(entry === undefined ? undefined : { ...entry });
  }

  list(): Promise<readonly PersistedRuntimeState[]> {
    return Promise.resolve([...this.entries.values()]);
  }

  write(state: PersistedRuntimeState): Promise<void> {
    this.writeCount += 1;
    if (this.failWrites) {
      return Promise.reject(
        new BrowserAdapterError(
          "persistence_corrupted",
          "forced write failure",
        ),
      );
    }
    this.entries.set(state.environmentId, { ...state });
    return Promise.resolve();
  }
}

export function makeConfig(
  overrides: Partial<BrowserEnvironmentConfig> = {},
): BrowserEnvironmentConfig {
  return {
    id: "env_a",
    name: "Environment A",
    browser: {
      executablePath: TEST_CHROME,
      version: TEST_CHROME_VERSION,
    },
    runtimePolicy: { isolation: "managed" },
    persistence: { mode: "persistent" },
    ...overrides,
  };
}

export function publishEndpoint(runtime: FakeRuntime, port = 45_678): void {
  runtime.onLaunch = (params): void => {
    const userDataDir = userDataDirFrom(params);
    if (userDataDir === undefined) {
      return;
    }
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(
      path.join(userDataDir, "DevToolsActivePort"),
      `${String(port)}\n/devtools/browser/fake\n`,
      "utf8",
    );
  };
}

export function userDataDirFrom(params: LaunchParams): string | undefined {
  const prefix = "--user-data-dir=";
  const argument = params.arguments.find((entry) => entry.startsWith(prefix));
  return argument?.slice(prefix.length);
}

export interface Harness {
  readonly root: string;
  readonly dataRoot: string;
  readonly runtime: FakeRuntime;
  readonly connector: FakeConnector;
  readonly discovery: FakeDiscovery;
  readonly store: MemoryStateStore;
  readonly service: EnvironmentService;
}

export interface HarnessOptions {
  readonly dataRoot?: string;
  readonly runtime?: FakeRuntime;
  readonly connector?: FakeConnector;
  readonly discovery?: FakeDiscovery;
  readonly store?: MemoryStateStore;
  readonly timeouts?: EnvironmentServiceOptions["timeouts"];
  readonly networkProbeUrl?: string;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const root = mkdtempSync(path.join(tmpdir(), "virealm-adapter-"));
  const dataRoot = options.dataRoot ?? path.join(root, "data");
  const runtime = options.runtime ?? new FakeRuntime();
  const connector = options.connector ?? new FakeConnector();
  const discovery = options.discovery ?? new FakeDiscovery();
  const store = options.store ?? new MemoryStateStore();
  const service = new EnvironmentService({
    dataRoot,
    runtime,
    connector,
    discovery,
    stateStore: store,
    localAppData: path.join(root, "local-app-data"),
    homeDirectory: path.join(root, "home"),
    ...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
    ...(options.networkProbeUrl === undefined
      ? {}
      : { networkProbeUrl: options.networkProbeUrl }),
  });
  return { root, dataRoot, runtime, connector, discovery, store, service };
}

export function launchConfigPath(harness: Harness, id = "env_a"): string {
  return path.join(harness.dataRoot, "environments", id, "chrome-data");
}
