import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  isBrowserAdapterError,
  type BrowserEnvironmentConfig,
  type ConfigFieldResult,
  type DiscoveredBrowser,
  type EnvironmentConfigReport,
  type EnvironmentStatus,
  type EnvironmentValidationResult,
  type LaunchResult,
  type StopOptions,
} from "@virealm/browser-adapter";

import {
  ENVIRONMENT_ID_PATTERN,
  type BrowserInfo,
  type ConfigFieldView,
  type EnvironmentDraft,
  type EnvironmentMutationResult,
  type EnvironmentPhase,
  type EnvironmentRecord,
  type EnvironmentView,
  type LaunchRecord,
  type PageConfigView,
  type VerificationView,
} from "../../shared/contracts.js";
import type { ValidationIssue } from "../../shared/validation.js";
import {
  BROWSER_INCOMPATIBLE_REASON,
  isBrowserCompatibleIsolation,
} from "../../shared/isolation.js";
import { DesktopError } from "../errors.js";
import type { DesktopLog } from "../logging.js";
import type { EnvironmentStore } from "../persistence/environment-store.js";
import type { ProfileCleanup } from "./profile-cleanup.js";
import { expectedProfileDir } from "./profile-cleanup.js";

/** The subset of BrowserAdapter this service depends on. */
export interface AdapterPort {
  discoverBrowsers(executablePath?: string): readonly DiscoveredBrowser[];
  validateEnvironment(input: unknown): EnvironmentValidationResult;
  launchEnvironment(input: unknown): Promise<LaunchResult>;
  stopEnvironment(
    environmentId: string,
    options?: StopOptions,
  ): Promise<EnvironmentStatus>;
  getEnvironmentStatus(environmentId: string): Promise<EnvironmentStatus>;
  applyEnvironmentConfig(
    environmentId: string,
    input?: unknown,
  ): Promise<EnvironmentConfigReport>;
  verifyEnvironmentConfig(
    environmentId: string,
    input?: unknown,
    options?: { readonly timeoutMs?: number },
  ): Promise<EnvironmentConfigReport>;
  connectEnvironment(input: unknown): Promise<LaunchResult>;
}

export interface EnvironmentServiceOptions {
  readonly store: EnvironmentStore;
  readonly adapter: AdapterPort;
  readonly dataRoot: string;
  readonly cleanup: ProfileCleanup;
  readonly log: DesktopLog;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly verifyTimeoutMs?: number;
}

interface VerificationCacheEntry {
  readonly report: EnvironmentConfigReport;
  readonly stale: boolean;
}

type Operation = "launching" | "stopping";

interface StatusLookup {
  readonly status: EnvironmentStatus | undefined;
  readonly error:
    { readonly code: string; readonly message: string } | undefined;
}

/**
 * Desktop-side environment orchestration.
 *
 * It owns metadata and user intent, delegates every browser operation to the
 * adapter, and never spawns a process or talks to CDP itself.
 */
export class DesktopEnvironmentService {
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly verifyTimeoutMs: number;
  private readonly runningConfigs = new Map<string, EnvironmentRecord>();
  private readonly verifications = new Map<string, VerificationCacheEntry>();
  private readonly operations = new Map<string, Operation>();
  private readonly dataRoot: string;

  constructor(private readonly options: EnvironmentServiceOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? defaultId;
    this.verifyTimeoutMs = options.verifyTimeoutMs ?? 10_000;
    this.dataRoot = path.resolve(options.dataRoot);
  }

  async initialize(): Promise<void> {
    const records = await this.options.store.list();
    const warning = this.options.store.warning();
    if (warning !== undefined) {
      this.options.log.warn(warning.code, warning.message);
    }
    this.options.log.info(
      "desktop_ready",
      `已加载 ${String(records.length)} 个环境配置。`,
    );
  }

  async list(): Promise<readonly EnvironmentView[]> {
    const records = await this.options.store.list();
    return Promise.all(records.map((record) => this.buildView(record)));
  }

  async get(id: string): Promise<EnvironmentView> {
    return this.buildView(await this.requireRecord(id));
  }

  async create(draft: EnvironmentDraft): Promise<EnvironmentView> {
    const id = await this.allocateId();
    const now = this.now();
    const record: EnvironmentRecord = {
      ...draft,
      id,
      createdAtUnixMs: now,
      updatedAtUnixMs: now,
      pendingRestart: false,
      dataDir: expectedProfileDir(this.dataRoot, id),
    };
    this.validateConfiguration(record, true);
    await this.options.store.create(record);
    this.options.log.info(
      "environment_created",
      `已创建环境「${record.name}」。`,
      id,
    );
    return this.buildView(record);
  }

  async update(
    id: string,
    draft: EnvironmentDraft,
  ): Promise<EnvironmentMutationResult> {
    const existing = await this.requireRecord(id);
    this.assertRecordLayout(existing);
    const candidate: EnvironmentRecord = {
      ...draft,
      id: existing.id,
      createdAtUnixMs: existing.createdAtUnixMs,
      updatedAtUnixMs: this.now(),
      pendingRestart: existing.pendingRestart,
      dataDir: existing.dataDir,
      ...(existing.lastLaunch === undefined
        ? {}
        : { lastLaunch: existing.lastLaunch }),
    };
    this.validateConfiguration(candidate, true);

    const lookup = await this.lookupStatus(id);
    const state = this.effectiveState(id, lookup);
    if (state === "starting" || state === "stopping") {
      throw new DesktopError(
        "environment_busy",
        "环境正在启动或停止，请稍后再保存修改。",
        { details: { environmentId: id } },
      );
    }

    const changed = changedFields(existing, candidate);
    if (changed.length === 0) {
      return {
        environment: await this.buildView(existing),
        appliedFields: [],
        restartFields: [],
        message: "配置没有变化。",
      };
    }

    if (state === "running") {
      return this.applyRunningUpdate(existing, candidate, changed);
    }

    const saved: EnvironmentRecord = {
      ...candidate,
      pendingRestart: false,
    };
    await this.options.store.update(saved);
    this.options.log.info(
      "environment_updated",
      `已保存环境「${saved.name}」的配置；下次启动时生效。`,
      id,
    );
    return {
      environment: await this.buildView(saved),
      appliedFields: [],
      restartFields: [],
      message:
        state === "unknown"
          ? "运行时状态未知，配置已保存，将在下次成功启动时生效。"
          : "环境未运行，配置已保存，将在下次启动时生效。",
    };
  }

  async remove(
    id: string,
    options: { readonly deleteData: boolean },
  ): Promise<void> {
    const record = await this.requireRecord(id);
    this.assertRecordLayout(record);
    const lookup = await this.lookupStatus(id);
    const state = this.effectiveState(id, lookup);
    if (state === "running" || state === "starting" || state === "stopping") {
      throw new DesktopError(
        "environment_running",
        "环境仍在运行，请先停止再删除。",
        { details: { environmentId: id } },
      );
    }
    if (options.deleteData) {
      if (this.operations.has(id)) {
        throw new DesktopError(
          "environment_busy",
          "环境有操作正在进行，请稍后再删除。",
          { details: { environmentId: id } },
        );
      }
      if (state === "unknown") {
        throw new DesktopError(
          "data_cleanup_refused",
          "无法确认环境已经停止，为避免删除正在使用的数据，已拒绝清理。",
          { details: { environmentId: id } },
        );
      }
      await this.options.cleanup.assertSafe(record, lookup.status?.userDataDir);
    }

    await this.options.store.remove(id);
    this.verifications.delete(id);
    this.runningConfigs.delete(id);
    this.options.log.info(
      "environment_removed",
      options.deleteData
        ? `已删除环境「${record.name}」及其浏览器数据。`
        : `已删除环境「${record.name}」，浏览器数据保留。`,
      id,
    );
    if (options.deleteData) {
      try {
        await this.options.cleanup.remove(record, lookup.status?.userDataDir);
      } catch (error) {
        throw new DesktopError(
          "data_cleanup_failed",
          "环境记录已删除，但浏览器数据目录未能清理，请查看诊断信息。",
          { cause: error, details: { environmentId: id } },
        );
      }
    }
  }

  async launch(id: string): Promise<EnvironmentView> {
    const record = await this.requireRecord(id);
    this.assertRecordLayout(record);
    this.assertIdle(id);
    this.operations.set(id, "launching");
    try {
      this.validateConfiguration(record);
      const config = toAdapterConfig(record);
      const result = await this.options.adapter.launchEnvironment(config);
      this.runningConfigs.set(id, record);
      let report = result.config;
      try {
        report = await this.options.adapter.verifyEnvironmentConfig(
          id,
          undefined,
          { timeoutMs: this.verifyTimeoutMs },
        );
      } catch (error) {
        this.options.log.warn(
          "verification_unavailable",
          `环境已启动，但无法读取配置验证结果：${describe(error)}`,
          id,
        );
      }
      this.verifications.set(id, { report, stale: false });
      const saved: EnvironmentRecord = {
        ...record,
        pendingRestart: false,
        lastLaunch: this.launchRecord(
          true,
          undefined,
          `Chrome ${result.status.browserVersion ?? "已启动"}，配置验证：${verificationSummary(report)}`,
        ),
      };
      await this.persistQuietly(saved, id);
      this.options.log.info(
        "environment_started",
        `环境「${record.name}」已启动。`,
        id,
      );
      return await this.buildView(saved);
    } catch (error) {
      const recorded: EnvironmentRecord = {
        ...record,
        lastLaunch: this.launchRecord(
          false,
          errorCode(error),
          `启动失败：${describe(error)}`,
        ),
      };
      await this.persistQuietly(recorded, id);
      this.options.log.error(
        "environment_start_failed",
        `环境「${record.name}」启动失败：${describe(error)}`,
        id,
      );
      throw asDesktopError(error, "launch_failed", "启动环境失败。");
    } finally {
      this.operations.delete(id);
    }
  }

  async stop(
    id: string,
    options: { readonly force: boolean },
  ): Promise<EnvironmentView> {
    const record = await this.requireRecord(id);
    this.assertIdle(id);
    this.operations.set(id, "stopping");
    try {
      await this.options.adapter.stopEnvironment(id, {
        mode: options.force ? "force" : "graceful",
      });
      this.markVerificationStale(id);
      this.runningConfigs.delete(id);
      let current = record;
      if (record.pendingRestart) {
        // The next launch will use the saved configuration, so the "restart
        // required" flag no longer describes anything the user must do.
        current = { ...record, pendingRestart: false };
        await this.persistQuietly(current, id);
      }
      this.options.log.info(
        "environment_stopped",
        `环境「${record.name}」已停止。`,
        id,
      );
      return await this.buildView(current);
    } catch (error) {
      this.options.log.error(
        "environment_stop_failed",
        `停止环境「${record.name}」失败：${describe(error)}`,
        id,
      );
      throw asDesktopError(error, "internal_error", "停止环境失败。");
    } finally {
      this.operations.delete(id);
    }
  }

  async verify(id: string): Promise<EnvironmentView> {
    const record = await this.requireRecord(id);
    this.assertRecordLayout(record);
    const lookup = await this.lookupStatus(id);
    const state = this.effectiveState(id, lookup);
    if (state !== "running") {
      throw new DesktopError(
        "environment_not_running",
        "环境未运行，无法验证浏览器配置。",
        { details: { environmentId: id } },
      );
    }
    const configRecord = this.runningRecordFor(record, id);
    const config = toAdapterConfig(configRecord);
    try {
      if (lookup.status?.cdp.connected !== true) {
        await this.options.adapter.connectEnvironment(config);
        this.runningConfigs.set(id, configRecord);
      }
      const report = await this.options.adapter.verifyEnvironmentConfig(
        id,
        undefined,
        { timeoutMs: this.verifyTimeoutMs },
      );
      this.verifications.set(id, { report, stale: false });
      this.options.log.info(
        "configuration_verified",
        `已读取环境「${record.name}」的配置验证结果。`,
        id,
      );
      return await this.buildView(record);
    } catch (error) {
      throw asDesktopError(
        error,
        "config_verification_failed",
        "验证配置失败。",
      );
    }
  }

  discoverBrowsers(): readonly BrowserInfo[] {
    try {
      return this.options.adapter.discoverBrowsers().map((browser) => ({
        executablePath: browser.executablePath,
        version: browser.version,
        source: browser.source,
      }));
    } catch (error) {
      throw asDesktopError(error, "chrome_not_found", "无法检查 Chrome 安装。");
    }
  }

  logsFor(id: string): ReturnType<DesktopLog["list"]> {
    return this.options.log.list(id);
  }

  warning(): ReturnType<EnvironmentStore["warning"]> {
    return this.options.store.warning();
  }

  private async applyRunningUpdate(
    existing: EnvironmentRecord,
    candidate: EnvironmentRecord,
    changed: readonly string[],
  ): Promise<EnvironmentMutationResult> {
    const id = existing.id;
    const hotFields = changed.filter((field) => isHotField(field, candidate));
    const restartFields = changed.filter(
      (field) => field !== "name" && !hotFields.includes(field),
    );
    let verification: EnvironmentConfigReport | undefined;

    if (hotFields.length > 0) {
      const base = this.runningRecordFor(existing, id);
      const appliedRecord: EnvironmentRecord = {
        ...base,
        name: candidate.name,
        ...(candidate.timezone === undefined
          ? {}
          : { timezone: candidate.timezone }),
        ...(candidate.locale === undefined ? {} : { locale: candidate.locale }),
        ...(candidate.viewport === undefined
          ? {}
          : { viewport: candidate.viewport }),
        ...(candidate.geolocation === undefined
          ? {}
          : { geolocation: candidate.geolocation }),
      };
      const appliedConfig = toAdapterConfig(appliedRecord);
      let report: EnvironmentConfigReport;
      try {
        await this.options.adapter.applyEnvironmentConfig(id, appliedConfig);
        report = await this.options.adapter.verifyEnvironmentConfig(
          id,
          appliedConfig,
          { timeoutMs: this.verifyTimeoutMs },
        );
      } catch (error) {
        throw new DesktopError(
          "config_apply_failed",
          "配置未能应用到运行中的浏览器，已保留上一次有效配置。",
          { cause: error, details: { environmentId: id } },
        );
      }

      const required = new Set(hotFields.map(verificationField));
      const failed = report.fields.filter(
        (field) => required.has(field.field) && field.status !== "verified",
      );
      if (failed.length > 0) {
        await this.options.adapter
          .applyEnvironmentConfig(id, toAdapterConfig(base))
          .catch(() => undefined);
        throw new DesktopError(
          "config_verification_failed",
          "配置已应用但验证未通过，已恢复上一次有效配置。",
          {
            issues: failed.map(fieldIssue),
            details: { environmentId: id },
          },
        );
      }
      verification = report;
      this.runningConfigs.set(id, appliedRecord);
    }

    const saved: EnvironmentRecord = {
      ...candidate,
      pendingRestart: existing.pendingRestart || restartFields.length > 0,
    };
    await this.options.store.update(saved);
    if (verification !== undefined) {
      this.verifications.set(id, { report: verification, stale: false });
    } else if (restartFields.length > 0) {
      this.markVerificationStale(id);
    }
    const parts: string[] = [];
    if (hotFields.length > 0) {
      parts.push(`已立即应用：${hotFields.join("、")}`);
    }
    if (restartFields.length > 0) {
      parts.push(`需重启后生效：${restartFields.join("、")}`);
    }
    if (changed.includes("name")) {
      parts.push("名称已更新");
    }
    const message = parts.join("；") || "配置已保存。";
    this.options.log.info(
      "environment_updated",
      `环境「${saved.name}」：${message}。`,
      id,
    );
    return {
      environment: await this.buildView(saved),
      appliedFields: hotFields,
      restartFields,
      message,
    };
  }

  private runningRecordFor(
    record: EnvironmentRecord,
    id: string,
  ): EnvironmentRecord {
    const running = this.runningConfigs.get(id);
    if (running !== undefined) {
      return running;
    }
    if (record.pendingRestart) {
      throw new DesktopError(
        "environment_restart_required",
        "运行中的浏览器仍使用旧配置；请重启环境后再修改或验证。",
        { details: { environmentId: id } },
      );
    }
    this.runningConfigs.set(id, record);
    return record;
  }

  private async buildView(record: EnvironmentRecord): Promise<EnvironmentView> {
    const lookup = await this.lookupStatus(record.id);
    const state = this.effectiveState(record.id, lookup);
    const status = lookup.status;
    const expected = expectedProfileDir(this.dataRoot, record.id);
    const warnings: string[] = [];
    if (path.resolve(record.dataDir) !== expected) {
      warnings.push(
        "记录中的数据目录与当前数据根不一致；启动、验证或清理数据会被拒绝。",
      );
    }
    if (lookup.error !== undefined) {
      warnings.push(`运行时状态不可用：${lookup.error.message}`);
    }
    if (record.pendingRestart) {
      warnings.push("有配置修改需要重启环境后生效。");
    }
    const storeWarning = this.options.store.warning();
    if (storeWarning !== undefined) {
      warnings.push(storeWarning.message);
    }
    if (status?.lastError !== undefined) {
      warnings.push(`最近错误：${status.lastError.message}`);
    }

    const cached = this.verifications.get(record.id);
    const verification =
      cached === undefined
        ? undefined
        : toVerificationView(
            cached.report,
            cached.stale || state !== "running",
          );
    const discovered = this.discoverBrowser(record.browser.executablePath);
    const discoveredVersion = status?.browserVersion ?? discovered?.version;
    if (discovered === undefined && state !== "running") {
      warnings.push(
        record.browser.executablePath === undefined
          ? "未在标准位置找到 Chrome；可以手动指定 Chrome 可执行文件。"
          : "指定的 Chrome 可执行文件不可用，请重新选择。",
      );
    }
    const origin = endpointOrigin(status?.cdp.endpoint);
    // The adapter keeps the last process identity in its persisted record so a
    // stopped or failed environment can be diagnosed. It is not a live process,
    // so never surface it as if it were still running.
    const processAlive =
      state === "running" || state === "starting" || state === "stopping";

    return {
      ...record,
      state,
      ...(!processAlive || status?.processInstanceId === undefined
        ? {}
        : { processInstanceId: status.processInstanceId }),
      ...(!processAlive || status?.pid === undefined
        ? {}
        : { pid: status.pid }),
      ...(!processAlive || status?.startedAtUnixMs === undefined
        ? {}
        : { startedAtUnixMs: status.startedAtUnixMs }),
      ...(discoveredVersion === undefined
        ? {}
        : { browserVersion: discoveredVersion }),
      cdp: {
        connected: status?.cdp.connected === true,
        ...(origin === undefined ? {} : { endpointOrigin: origin }),
      },
      ...(lookup.error !== undefined
        ? { lastError: lookup.error }
        : status?.lastError === undefined
          ? {}
          : { lastError: status.lastError }),
      ...(verification === undefined ? {} : { verification }),
      warnings,
    };
  }

  private effectiveState(id: string, lookup: StatusLookup): EnvironmentPhase {
    const operation = this.operations.get(id);
    if (lookup.error !== undefined && operation === undefined) {
      return "unknown";
    }
    if (operation === "launching") {
      return lookup.status?.state === "running" ? "running" : "starting";
    }
    if (operation === "stopping") {
      return lookup.status?.state === "stopped" ? "stopped" : "stopping";
    }
    if (lookup.status !== undefined) {
      return lookup.status.state;
    }
    return lookup.error === undefined ? "stopped" : "unknown";
  }

  private async lookupStatus(id: string): Promise<StatusLookup> {
    try {
      const status = await this.options.adapter.getEnvironmentStatus(id);
      return { status, error: undefined };
    } catch (error) {
      if (
        isBrowserAdapterError(error) &&
        error.code === "environment_not_found"
      ) {
        return { status: undefined, error: undefined };
      }
      return {
        status: undefined,
        error: {
          code: isBrowserAdapterError(error)
            ? error.code
            : "runtime_operation_failed",
          message: describe(error),
        },
      };
    }
  }

  private validateConfiguration(
    record: EnvironmentRecord,
    allowMissingChrome = false,
  ): void {
    this.assertBrowserCompatibleIsolation(record);
    let result: EnvironmentValidationResult;
    try {
      result = this.options.adapter.validateEnvironment(
        toAdapterConfig(record),
      );
    } catch (error) {
      throw new DesktopError("invalid_configuration", "环境配置无法校验。", {
        cause: error,
        details: { environmentId: record.id },
      });
    }
    const blocking = allowMissingChrome
      ? result.issues.filter(
          (issue) =>
            !(
              issue.code === "chrome_not_found" &&
              issue.path === "browser.executablePath"
            ),
        )
      : result.issues;
    if (!result.valid && blocking.length > 0) {
      throw new DesktopError(
        "invalid_configuration",
        "环境配置未通过校验，请检查标记的字段。",
        {
          issues: blocking.map(toValidationIssue),
          details: { environmentId: record.id },
        },
      );
    }
  }

  /**
   * Chromium's browser process refuses to run inside a token the runtime has
   * already restricted, so the desktop does not accept those modes for a
   * Chrome environment. The rule is checked before the adapter is asked to
   * launch anything, so the user gets the reason instead of a runtime
   * failure.
   */
  private assertBrowserCompatibleIsolation(record: EnvironmentRecord): void {
    if (isBrowserCompatibleIsolation(record.runtimePolicy.isolation)) {
      return;
    }
    throw new DesktopError(
      "unsupported_isolation",
      BROWSER_INCOMPATIBLE_REASON,
      {
        details: {
          environmentId: record.id,
          isolation: record.runtimePolicy.isolation,
        },
      },
    );
  }

  private assertRecordLayout(record: EnvironmentRecord): void {
    const expected = expectedProfileDir(this.dataRoot, record.id);
    if (path.resolve(record.dataDir) !== expected) {
      throw new DesktopError(
        "data_directory_conflict",
        "环境记录中的数据目录与受管理目录不一致，操作已拒绝。",
        { details: { environmentId: record.id } },
      );
    }
  }

  private assertIdle(id: string): void {
    if (this.operations.has(id)) {
      throw new DesktopError(
        "environment_busy",
        "该环境已有启动或停止操作正在进行。",
        { details: { environmentId: id } },
      );
    }
  }

  private async requireRecord(id: string): Promise<EnvironmentRecord> {
    if (!ENVIRONMENT_ID_PATTERN.test(id)) {
      throw new DesktopError("invalid_request", "环境 id 格式无效。", {
        details: { environmentId: id },
      });
    }
    const record = await this.options.store.get(id);
    if (record === undefined) {
      throw new DesktopError("environment_not_found", "找不到该环境。", {
        details: { environmentId: id },
      });
    }
    return record;
  }

  private async allocateId(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = this.createId();
      if (!ENVIRONMENT_ID_PATTERN.test(candidate)) {
        throw new DesktopError("internal_error", "生成的环境 id 不符合规则。");
      }
      if ((await this.options.store.get(candidate)) === undefined) {
        return candidate;
      }
    }
    throw new DesktopError("internal_error", "无法生成唯一的环境 id。");
  }

  private discoverBrowser(
    executablePath: string | undefined,
  ): DiscoveredBrowser | undefined {
    try {
      return this.options.adapter.discoverBrowsers(executablePath)[0];
    } catch {
      return undefined;
    }
  }

  private launchRecord(
    ok: boolean,
    code: string | undefined,
    message: string,
  ): LaunchRecord {
    return {
      atUnixMs: this.now(),
      ok,
      message,
      ...(code === undefined ? {} : { code }),
    };
  }

  private async persistQuietly(
    record: EnvironmentRecord,
    id: string,
  ): Promise<void> {
    try {
      await this.options.store.update(record);
    } catch (error) {
      this.options.log.warn(
        "last_launch_not_saved",
        `无法保存最近启动结果：${describe(error)}`,
        id,
      );
    }
  }

  private markVerificationStale(id: string): void {
    const cached = this.verifications.get(id);
    if (cached !== undefined) {
      this.verifications.set(id, { ...cached, stale: true });
    }
  }
}

export function toAdapterConfig(
  record: EnvironmentRecord,
): BrowserEnvironmentConfig {
  return {
    id: record.id,
    name: record.name,
    browser: {
      userDataDir: record.dataDir,
      ...(record.browser.executablePath === undefined
        ? {}
        : { executablePath: record.browser.executablePath }),
    },
    runtimePolicy: {
      isolation: record.runtimePolicy.isolation,
      ...(record.runtimePolicy.maxProcesses === undefined
        ? {}
        : { maxProcesses: record.runtimePolicy.maxProcesses }),
      ...(record.runtimePolicy.memoryLimitBytes === undefined
        ? {}
        : { memoryLimitBytes: record.runtimePolicy.memoryLimitBytes }),
    },
    persistence: { mode: "persistent" },
    ...(record.timezone === undefined ? {} : { timezone: record.timezone }),
    ...(record.locale === undefined ? {} : { locale: record.locale }),
    ...(record.viewport === undefined ? {} : { viewport: record.viewport }),
    ...(record.geolocation === undefined
      ? {}
      : { geolocation: record.geolocation }),
    ...(record.launch?.additionalArguments === undefined
      ? {}
      : {
          launch: {
            additionalArguments: [...record.launch.additionalArguments],
          },
        }),
  };
}

export function changedFields(
  left: EnvironmentRecord,
  right: EnvironmentRecord,
): string[] {
  const changed: string[] = [];
  if (left.name !== right.name) {
    changed.push("name");
  }
  if (left.browser.executablePath !== right.browser.executablePath) {
    changed.push("browser.executablePath");
  }
  if (left.timezone !== right.timezone) {
    changed.push("timezone");
  }
  if (left.locale !== right.locale) {
    changed.push("locale");
  }
  if (left.viewport?.width !== right.viewport?.width) {
    changed.push("viewport.width");
  }
  if (left.viewport?.height !== right.viewport?.height) {
    changed.push("viewport.height");
  }
  if (left.viewport?.deviceScaleFactor !== right.viewport?.deviceScaleFactor) {
    changed.push("viewport.deviceScaleFactor");
  }
  if (left.geolocation?.latitude !== right.geolocation?.latitude) {
    changed.push("geolocation.latitude");
  }
  if (left.geolocation?.longitude !== right.geolocation?.longitude) {
    changed.push("geolocation.longitude");
  }
  if (left.geolocation?.accuracy !== right.geolocation?.accuracy) {
    changed.push("geolocation.accuracy");
  }
  if (left.runtimePolicy.isolation !== right.runtimePolicy.isolation) {
    changed.push("runtimePolicy.isolation");
  }
  if (left.runtimePolicy.maxProcesses !== right.runtimePolicy.maxProcesses) {
    changed.push("runtimePolicy.maxProcesses");
  }
  if (
    left.runtimePolicy.memoryLimitBytes !== right.runtimePolicy.memoryLimitBytes
  ) {
    changed.push("runtimePolicy.memoryLimitBytes");
  }
  if (
    !sameArguments(
      left.launch?.additionalArguments,
      right.launch?.additionalArguments,
    )
  ) {
    changed.push("launch.additionalArguments");
  }
  return changed;
}

function isHotField(field: string, candidate: EnvironmentRecord): boolean {
  if (field === "timezone") {
    return candidate.timezone !== undefined;
  }
  if (field === "locale") {
    return candidate.locale !== undefined;
  }
  if (field.startsWith("viewport.")) {
    return candidate.viewport !== undefined;
  }
  if (field.startsWith("geolocation.")) {
    return candidate.geolocation !== undefined;
  }
  return false;
}

function verificationField(field: string): ConfigFieldResult["field"] {
  if (field === "viewport.deviceScaleFactor") {
    return "deviceScaleFactor";
  }
  if (field.startsWith("viewport.")) {
    return "viewport";
  }
  if (field.startsWith("geolocation.")) {
    return "geolocation";
  }
  return field === "locale" ? "locale" : "timezone";
}

function fieldIssue(field: ConfigFieldResult): ValidationIssue {
  return {
    path: `config.${field.field}`,
    code: field.status,
    message:
      field.reason ?? `浏览器返回的实际值与期望值不一致（${field.field}）。`,
  };
}

function toValidationIssue(
  issue: EnvironmentValidationResult["issues"][number],
): ValidationIssue {
  return { path: issue.path, code: issue.code, message: issue.message };
}

function sameArguments(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function toVerificationView(
  report: EnvironmentConfigReport,
  stale: boolean,
): VerificationView {
  return {
    capturedAtUnixMs: report.capturedAtUnixMs,
    stale,
    fields: report.fields.map(toFieldView),
    pages: report.pages.map(toPageView),
  };
}

function toFieldView(field: ConfigFieldResult): ConfigFieldView {
  return {
    field: field.field,
    status: field.status,
    requested: field.requested,
    observed: field.observed,
    reason: field.reason,
    capability: field.capability,
  };
}

function toPageView(
  page: EnvironmentConfigReport["pages"][number],
): PageConfigView {
  return {
    pageId: page.pageId,
    url: page.url,
    fields: page.fields.map(toFieldView),
  };
}

function verificationSummary(report: EnvironmentConfigReport): string {
  const verified = report.fields.filter(
    (field) => field.status === "verified",
  ).length;
  const failed = report.fields.filter(
    (field) => field.status === "failed",
  ).length;
  const unsupported = report.fields.filter(
    (field) => field.status === "unsupported",
  ).length;
  const parts = [`${String(verified)} 项已验证`];
  if (failed > 0) {
    parts.push(`${String(failed)} 项失败`);
  }
  if (unsupported > 0) {
    parts.push(`${String(unsupported)} 项不支持`);
  }
  return parts.join("，");
}

function endpointOrigin(endpoint: string | undefined): string | undefined {
  if (endpoint === undefined) {
    return undefined;
  }
  try {
    return new URL(endpoint).origin;
  } catch {
    return undefined;
  }
}

function describe(error: unknown): string {
  if (isBrowserAdapterError(error) || error instanceof Error) {
    return error.message;
  }
  return "未知错误";
}

function errorCode(error: unknown): string | undefined {
  if (isBrowserAdapterError(error) || error instanceof DesktopError) {
    return error.code;
  }
  return undefined;
}

function asDesktopError(
  error: unknown,
  fallback: DesktopError["code"],
  message: string,
): DesktopError {
  if (error instanceof DesktopError) {
    return error;
  }
  if (isBrowserAdapterError(error)) {
    const details = sanitizeAdapterDetails(error.details);
    return new DesktopError(error.code, error.message, {
      ...(details === undefined ? {} : { details }),
      cause: error,
    });
  }
  return new DesktopError(fallback, message, { cause: error });
}

function sanitizeAdapterDetails(
  details: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, string | number | boolean>> | undefined {
  if (details === undefined) {
    return undefined;
  }
  const selected: Record<string, string | number | boolean> = {};
  for (const key of ["environmentId", "operation", "contractCode"]) {
    const value = details[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      selected[key] = value;
    }
  }
  return Object.keys(selected).length > 0 ? selected : undefined;
}

function defaultId(): string {
  return `env-${randomUUID().slice(0, 8)}`;
}
