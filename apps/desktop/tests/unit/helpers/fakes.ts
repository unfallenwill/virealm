import path from "node:path";

import {
  BrowserAdapterError,
  type BrowserEnvironmentConfig,
  type ConfigFieldResult,
  type DiscoveredBrowser,
  type EnvironmentConfigReport,
  type EnvironmentStatus,
  type EnvironmentValidationResult,
  type LaunchResult,
  type StopOptions,
} from "@virealm/browser-adapter";

import type {
  EnvironmentDraft,
  EnvironmentRecord,
  IsolationMode,
} from "../../../src/shared/contracts.js";
import type {
  FileOperations,
  StoreWarning,
} from "../../../src/main/persistence/environment-store.js";
import type { EnvironmentStore } from "../../../src/main/persistence/environment-store.js";
import type { AdapterPort } from "../../../src/main/services/environment-service.js";
import type { ProfileCleanup } from "../../../src/main/services/profile-cleanup.js";

/** Absolute on the host platform, so path checks behave as in production. */
export const TEST_DATA_ROOT = path.resolve("virealm-test-data");
export const TEST_CHROME_PATH = path.join(
  TEST_DATA_ROOT,
  "Chrome",
  "chrome.exe",
);

export class MemoryFiles implements FileOperations {
  readonly files = new Map<string, string>();
  writes: string[] = [];
  renames: { readonly from: string; readonly to: string }[] = [];
  failWrite = false;
  failRename = false;
  failMkdir = false;
  failRead: Error | undefined;
  renameTargetMissing = false;

  readFile(filePath: string): Promise<string> {
    if (this.failRead !== undefined) {
      return Promise.reject(this.failRead);
    }
    const content = this.files.get(filePath);
    if (content === undefined) {
      return Promise.reject(notFound(filePath));
    }
    return Promise.resolve(content);
  }

  mkdir(): Promise<void> {
    if (this.failMkdir) {
      return Promise.reject(new Error("mkdir failed"));
    }
    return Promise.resolve();
  }

  writeDurable(filePath: string, content: string): Promise<void> {
    if (this.failWrite) {
      return Promise.reject(new Error("disk full"));
    }
    this.files.set(filePath, content);
    this.writes.push(filePath);
    return Promise.resolve();
  }

  rename(from: string, to: string): Promise<void> {
    if (this.failRename) {
      return Promise.reject(new Error("rename failed"));
    }
    if (this.renameTargetMissing) {
      return Promise.reject(notFound(from));
    }
    const content = this.files.get(from);
    if (content === undefined) {
      return Promise.reject(notFound(from));
    }
    this.files.delete(from);
    this.files.set(to, content);
    this.renames.push({ from, to });
    return Promise.resolve();
  }

  unlink(filePath: string): Promise<void> {
    this.files.delete(filePath);
    return Promise.resolve();
  }
}

export class MemoryEnvironmentStore implements EnvironmentStore {
  readonly records: EnvironmentRecord[] = [];
  private storeWarning: StoreWarning | undefined;
  createCalls = 0;
  updateCalls = 0;
  removeCalls = 0;

  list(): Promise<readonly EnvironmentRecord[]> {
    return Promise.resolve(
      [...this.records].sort(
        (left, right) => left.createdAtUnixMs - right.createdAtUnixMs,
      ),
    );
  }

  get(id: string): Promise<EnvironmentRecord | undefined> {
    return Promise.resolve(this.records.find((record) => record.id === id));
  }

  create(record: EnvironmentRecord): Promise<void> {
    this.createCalls += 1;
    if (this.records.some((entry) => entry.id === record.id)) {
      return Promise.reject(
        new BrowserAdapterError("internal_error", "duplicate id"),
      );
    }
    this.records.push(record);
    return Promise.resolve();
  }

  update(record: EnvironmentRecord): Promise<void> {
    this.updateCalls += 1;
    const index = this.records.findIndex((entry) => entry.id === record.id);
    if (index < 0) {
      return Promise.reject(new Error("missing record"));
    }
    this.records[index] = record;
    return Promise.resolve();
  }

  remove(id: string): Promise<void> {
    this.removeCalls += 1;
    const index = this.records.findIndex((entry) => entry.id === id);
    if (index >= 0) {
      this.records.splice(index, 1);
    }
    return Promise.resolve();
  }

  warning(): StoreWarning | undefined {
    return this.storeWarning;
  }

  setWarning(warning: StoreWarning | undefined): void {
    this.storeWarning = warning;
  }
}

export class FakeAdapter implements AdapterPort {
  statuses = new Map<string, EnvironmentStatus>();
  discovered: DiscoveredBrowser[] = [
    {
      executablePath: TEST_CHROME_PATH,
      version: "156.0.0.0",
      source: "system",
    },
  ];
  validation: EnvironmentValidationResult = {
    valid: true,
    issues: [],
    resolved: undefined,
  };
  report: EnvironmentConfigReport = reportFor("env-test");
  launchError: Error | undefined;
  verifyError: Error | undefined;
  applyError: Error | undefined;
  stopError: Error | undefined;
  statusError: Error | undefined;
  connectError: Error | undefined;
  discoverError: Error | undefined;
  launchCalls = 0;
  stopCalls: {
    readonly id: string;
    readonly options: StopOptions | undefined;
  }[] = [];
  applyCalls: { readonly id: string; readonly config: unknown }[] = [];
  verifyCalls: {
    readonly id: string;
    readonly input: unknown;
    readonly timeoutMs: number | undefined;
  }[] = [];
  connectCalls = 0;
  statusQueries = 0;
  pendingLaunch: Promise<LaunchResult> | undefined;

  discoverBrowsers(executablePath?: string): readonly DiscoveredBrowser[] {
    if (this.discoverError !== undefined) {
      throw this.discoverError;
    }
    if (executablePath === undefined) {
      return this.discovered;
    }
    const match = this.discovered.find(
      (browser) => browser.executablePath === executablePath,
    );
    return match === undefined ? [] : [match];
  }

  validateEnvironment(input: unknown): EnvironmentValidationResult {
    const config = input as BrowserEnvironmentConfig;
    if (config.id.length === 0) {
      return {
        valid: false,
        issues: [
          {
            path: "id",
            code: "invalid_value",
            message: "id is required",
          },
        ],
        resolved: undefined,
      };
    }
    return this.validation;
  }

  launchEnvironment(input: unknown): Promise<LaunchResult> {
    this.launchCalls += 1;
    if (this.pendingLaunch !== undefined) {
      return this.pendingLaunch;
    }
    if (this.launchError !== undefined) {
      return Promise.reject(this.launchError);
    }
    const config = input as BrowserEnvironmentConfig;
    const status = runningStatus(config.id);
    this.statuses.set(config.id, status);
    return Promise.resolve({
      status,
      config:
        this.report.environmentId === config.id
          ? this.report
          : reportFor(config.id),
    });
  }

  stopEnvironment(
    environmentId: string,
    options?: StopOptions,
  ): Promise<EnvironmentStatus> {
    this.stopCalls.push({ id: environmentId, options });
    if (this.stopError !== undefined) {
      return Promise.reject(this.stopError);
    }
    const status = stoppedStatus(environmentId);
    this.statuses.set(environmentId, status);
    return Promise.resolve(status);
  }

  getEnvironmentStatus(environmentId: string): Promise<EnvironmentStatus> {
    this.statusQueries += 1;
    if (this.statusError !== undefined) {
      return Promise.reject(this.statusError);
    }
    const status = this.statuses.get(environmentId);
    if (status === undefined) {
      return Promise.reject(
        new BrowserAdapterError(
          "environment_not_found",
          `environment ${environmentId} is not managed`,
        ),
      );
    }
    return Promise.resolve(status);
  }

  applyEnvironmentConfig(
    environmentId: string,
    input?: unknown,
  ): Promise<EnvironmentConfigReport> {
    this.applyCalls.push({ id: environmentId, config: input });
    if (this.applyError !== undefined) {
      return Promise.reject(this.applyError);
    }
    return Promise.resolve(
      this.report.environmentId === environmentId
        ? this.report
        : reportFor(environmentId),
    );
  }

  verifyEnvironmentConfig(
    environmentId: string,
    input?: unknown,
    options?: { readonly timeoutMs?: number },
  ): Promise<EnvironmentConfigReport> {
    this.verifyCalls.push({
      id: environmentId,
      input,
      timeoutMs: options?.timeoutMs,
    });
    if (this.verifyError !== undefined) {
      return Promise.reject(this.verifyError);
    }
    return Promise.resolve(
      this.report.environmentId === environmentId
        ? this.report
        : reportFor(environmentId),
    );
  }

  connectEnvironment(input: unknown): Promise<LaunchResult> {
    this.connectCalls += 1;
    if (this.connectError !== undefined) {
      return Promise.reject(this.connectError);
    }
    const config = input as BrowserEnvironmentConfig;
    const status = runningStatus(config.id);
    this.statuses.set(config.id, status);
    return Promise.resolve({ status, config: reportFor(config.id) });
  }
}

export class FakeCleanup implements ProfileCleanup {
  assertCalls: {
    readonly record: EnvironmentRecord;
    readonly dir: string | undefined;
  }[] = [];
  removeCalls: {
    readonly record: EnvironmentRecord;
    readonly dir: string | undefined;
  }[] = [];
  assertError: Error | undefined;
  removeError: Error | undefined;

  assertSafe(
    record: EnvironmentRecord,
    userDataDir: string | undefined,
  ): Promise<void> {
    this.assertCalls.push({ record, dir: userDataDir });
    if (this.assertError !== undefined) {
      return Promise.reject(this.assertError);
    }
    return Promise.resolve();
  }

  remove(
    record: EnvironmentRecord,
    userDataDir: string | undefined,
  ): Promise<void> {
    this.removeCalls.push({ record, dir: userDataDir });
    if (this.removeError !== undefined) {
      return Promise.reject(this.removeError);
    }
    return Promise.resolve();
  }
}

export function draftFor(
  overrides: Partial<EnvironmentDraft> = {},
): EnvironmentDraft {
  const base: EnvironmentDraft = {
    name: "测试环境",
    browser: {},
    timezone: "Asia/Shanghai",
    locale: "zh-CN",
    viewport: { width: 1440, height: 900 },
    runtimePolicy: { isolation: "managed" },
  };
  return { ...base, ...overrides };
}

export interface RecordOptions {
  readonly id?: string;
  readonly dataRoot?: string;
  readonly isolation?: IsolationMode;
  readonly pendingRestart?: boolean;
  readonly name?: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly executablePath?: string;
}

export function recordFor(options: RecordOptions = {}): EnvironmentRecord {
  const id = options.id ?? "env-test";
  const dataRoot = options.dataRoot ?? TEST_DATA_ROOT;
  return {
    id,
    name: options.name ?? "测试环境",
    browser:
      options.executablePath === undefined
        ? {}
        : { executablePath: options.executablePath },
    timezone: "Asia/Shanghai",
    locale: "zh-CN",
    viewport: { width: 1440, height: 900 },
    runtimePolicy: { isolation: options.isolation ?? "managed" },
    createdAtUnixMs: options.createdAt ?? 1_000,
    updatedAtUnixMs: options.updatedAt ?? 1_000,
    pendingRestart: options.pendingRestart ?? false,
    dataDir: path.join(dataRoot, "environments", id, "chrome-data"),
  };
}

export function runningStatus(
  environmentId: string,
  overrides: Partial<EnvironmentStatus> = {},
): EnvironmentStatus {
  const base: EnvironmentStatus = {
    environmentId,
    state: "running",
    processInstanceId: `proc-${environmentId}`,
    pid: 4_242,
    startedAtUnixMs: 1_700_000_000_000,
    userDataDir: undefined,
    browserVersion: "156.0.0.0",
    cdp: {
      connected: true,
      endpoint: "ws://127.0.0.1:9222/devtools/browser/secret-path",
      connectedAtUnixMs: 1_700_000_000_100,
    },
    lastError: undefined,
  };
  return { ...base, ...overrides };
}

export function stoppedStatus(
  environmentId: string,
  overrides: Partial<EnvironmentStatus> = {},
): EnvironmentStatus {
  const base: EnvironmentStatus = {
    environmentId,
    state: "stopped",
    processInstanceId: undefined,
    pid: undefined,
    startedAtUnixMs: undefined,
    userDataDir: undefined,
    browserVersion: undefined,
    cdp: {
      connected: false,
      endpoint: undefined,
      connectedAtUnixMs: undefined,
    },
    lastError: undefined,
  };
  return { ...base, ...overrides };
}

export function reportFor(
  environmentId: string,
  overrides: {
    readonly status?: ConfigFieldResult["status"];
    readonly timezone?: string;
    readonly locale?: string;
  } = {},
): EnvironmentConfigReport {
  const status = overrides.status ?? "verified";
  const fields: ConfigFieldResult[] = [
    {
      field: "timezone",
      status,
      requested: overrides.timezone ?? "Asia/Shanghai",
      observed:
        status === "verified" ? (overrides.timezone ?? "Asia/Shanghai") : "UTC",
      reason: status === "failed" ? "timezone mismatch" : undefined,
      capability: "Emulation.setTimezoneOverride",
    },
    {
      field: "locale",
      status,
      requested: overrides.locale ?? "zh-CN",
      observed: status === "verified" ? (overrides.locale ?? "zh-CN") : "en-US",
      reason: undefined,
      capability: "Emulation.setLocaleOverride",
    },
    {
      field: "viewport",
      status,
      requested: { width: 1440, height: 900 },
      observed: { width: 1440, height: 900 },
      reason: undefined,
      capability: "Emulation.setDeviceMetricsOverride",
    },
  ];
  return {
    environmentId,
    capturedAtUnixMs: 1_700_000_001_000,
    fields,
    pages: [
      {
        pageId: "initial",
        url: "http://127.0.0.1:9/",
        fields,
      },
    ],
  };
}

export function notFound(filePath: string): Error {
  return Object.assign(new Error(`ENOENT: ${filePath}`), { code: "ENOENT" });
}
