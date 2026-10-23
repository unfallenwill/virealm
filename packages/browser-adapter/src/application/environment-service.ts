import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type {
  Capability,
  CapabilityReport,
  LaunchParams,
  LaunchPolicy,
  ProcessStatus,
} from "@virealm/contracts";

import {
  buildChromeArguments,
  assertSafeLaunchArguments,
} from "../chrome/launch-options.js";
import {
  assertLoopbackEndpoint,
  readDevToolsEndpoint,
  waitForDevToolsEndpoint,
} from "../chrome/devtools-endpoint.js";
import { assertDirectoryWritable, prepareProfile } from "../chrome/profile.js";
import { EnvironmentConfigApplier } from "../environment/config-applier.js";
import {
  validateEnvironment,
  type ValidationContext,
} from "../environment/validation.js";
import type {
  DiscoveredBrowser,
  IsolationPreference,
  ResolvedBrowserEnvironment,
} from "../domain/environment.js";
import {
  BrowserAdapterError,
  isBrowserAdapterError,
} from "../domain/errors.js";
import type {
  ApplyConfigOptions,
  BrowserEnvironmentState,
  BrowserPageSummary,
  EnvironmentConfigReport,
  EnvironmentStatus,
  EnvironmentValidationResult,
  LaunchResult,
  PersistedRuntimeState,
  StopOptions,
} from "../domain/status.js";
import { isNavigableUrl } from "../domain/urls.js";
import type {
  BrowserConnectorPort,
  BrowserSessionPort,
  ChromeDiscoveryPort,
  RuntimePort,
  RuntimeStateStorePort,
} from "./ports.js";

/**
 * `STATUS_BREAKPOINT`: Chromium's `__debugbreak()` after its own sandbox
 * fails to initialise.
 */
const STATUS_BREAKPOINT = 0x80000003;

function isolationLabel(isolation: IsolationPreference): string {
  switch (isolation) {
    case "managed":
      return "managed";
    case "restricted":
      return "restricted-token";
    case "app_container":
      return "AppContainer";
  }
}

export interface EnvironmentTimeouts {
  readonly launchMs: number;
  readonly cdpConnectMs: number;
  readonly stopMs: number;
  readonly configVerifyMs: number;
  readonly endpointProbeMs: number;
}

export interface EnvironmentServiceOptions {
  readonly dataRoot: string;
  readonly runtime: RuntimePort;
  readonly connector: BrowserConnectorPort;
  readonly discovery: ChromeDiscoveryPort;
  readonly stateStore: RuntimeStateStorePort;
  /** Used only to reject Chrome's default profile roots. */
  readonly localAppData?: string;
  readonly now?: () => number;
  readonly timeouts?: Partial<EnvironmentTimeouts>;
  /** Controlled endpoint returning `{ "acceptLanguage": "..." }`. */
  readonly networkProbeUrl?: string;
}

const DEFAULT_TIMEOUTS: EnvironmentTimeouts = {
  launchMs: 30_000,
  cdpConnectMs: 15_000,
  stopMs: 15_000,
  configVerifyMs: 5_000,
  endpointProbeMs: 1_500,
};

interface ActiveEnvironment {
  resolved: ResolvedBrowserEnvironment;
  processInstanceId: string;
  pid: number;
  startedAtUnixMs: number;
  endpoint: string;
  browserVersion: string;
  session: BrowserSessionPort | undefined;
  applier: EnvironmentConfigApplier | undefined;
  lastReport: EnvironmentConfigReport | undefined;
  cdpConnectedAtUnixMs: number | undefined;
  unsubscribers: (() => void)[];
}

/**
 * Orchestrates browser environments through ports. Every Chrome process comes
 * from the Rust Process Runtime; this class never imports `child_process` and
 * never touches a Windows API, so it is testable with fakes.
 */
export class EnvironmentService {
  private readonly options: EnvironmentServiceOptions;
  private readonly timeouts: EnvironmentTimeouts;
  private readonly now: () => number;
  private readonly active = new Map<string, ActiveEnvironment>();
  private readonly phases = new Map<string, "starting" | "stopping">();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(options: EnvironmentServiceOptions) {
    this.options = options;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.now = options.now ?? Date.now;
  }

  discoverBrowsers(executablePath?: string): readonly DiscoveredBrowser[] {
    return this.options.discovery.discover(executablePath);
  }

  validateEnvironment(input: unknown): EnvironmentValidationResult {
    return validateEnvironment(input, this.validationContext());
  }

  async launchEnvironment(input: unknown): Promise<LaunchResult> {
    const resolved = this.resolve(input);
    const environmentId = resolved.config.id;

    return this.withLock(environmentId, async () => {
      this.phases.set(environmentId, "starting");
      let launched: ProcessStatus | undefined;
      try {
        if (this.active.has(environmentId)) {
          throw new BrowserAdapterError(
            "environment_already_running",
            "this environment already has an active browser",
            { environmentId },
          );
        }
        await this.rejectStaleRunningRecord(environmentId);
        this.assertNoSharedProfile(resolved);

        const capabilities = await this.options.runtime.getCapabilities();
        assertIsolation(capabilities, resolved);

        prepareProfile(resolved.profile, environmentId, this.now);
        assertDirectoryWritable(resolved.profile);

        const argumentsList = buildChromeArguments({
          userDataDir: resolved.profile.userDataDir,
          locale: resolved.config.locale,
          viewport: resolved.viewport,
          initialUrls: resolved.config.launch?.initialUrls,
          additionalArguments: resolved.config.launch?.additionalArguments,
        });
        assertSafeLaunchArguments(argumentsList);

        launched = await this.options.runtime.launch(
          buildLaunchParams(resolved, argumentsList),
        );
        if (launched.state.state !== "running") {
          throw new BrowserAdapterError(
            "launch_failed",
            "Chrome was not running after the runtime launched it",
            { state: launched.state.state },
          );
        }

        const active: ActiveEnvironment = {
          resolved,
          processInstanceId: launched.processInstanceId,
          pid: launched.pid,
          startedAtUnixMs: launched.startedAtUnixMs,
          endpoint: "",
          browserVersion: resolved.browser.version,
          session: undefined,
          applier: undefined,
          lastReport: undefined,
          cdpConnectedAtUnixMs: undefined,
          unsubscribers: [],
        };
        this.active.set(environmentId, active);
        await this.persist(active, "starting");

        const endpoint = await waitForDevToolsEndpoint(
          resolved.profile.userDataDir,
          {
            timeoutMs: this.timeouts.launchMs,
            checkAlive: async () =>
              this.checkAlive(
                active.processInstanceId,
                resolved.config.runtimePolicy.isolation,
              ),
          },
        );
        assertLoopbackEndpoint(endpoint);
        active.endpoint = endpoint.endpoint;

        await this.attach(active);
        await this.assertStillRunning(active, resolved);
        const report = await this.applyAndRemember(active);
        await this.persist(active, "running");
        return {
          status: this.buildStatus(active, "running", undefined),
          config: report,
        };
      } catch (error) {
        const failure = toLaunchError(error);
        if (launched !== undefined) {
          await this.failLaunch(environmentId, resolved, launched, failure);
        }
        throw failure;
      } finally {
        this.phases.delete(environmentId);
      }
    });
  }

  async stopEnvironment(
    environmentId: string,
    options: StopOptions = {},
  ): Promise<EnvironmentStatus> {
    return this.withLock(environmentId, async () => {
      this.phases.set(environmentId, "stopping");
      try {
        const active = this.active.get(environmentId);
        if (active !== undefined) {
          await this.stopActive(active, options);
          const stopped = this.persistedStopped(active);
          await this.options.stateStore.write(stopped);
          return this.statusFromPersisted(stopped);
        }

        const persisted = await this.options.stateStore.read(environmentId);
        if (persisted === undefined) {
          throw new BrowserAdapterError(
            "environment_not_found",
            "no environment with this id is known to the adapter",
            { environmentId },
          );
        }
        if (!isLiveState(persisted.state)) {
          return this.statusFromPersisted(persisted);
        }

        const status = await this.tryStatus(persisted.processInstanceId);
        if (status !== undefined && status.state.state !== "exited") {
          await this.options.runtime.terminate(persisted.processInstanceId);
        } else if (
          status === undefined &&
          persisted.endpoint !== undefined &&
          (await this.endpointAlive(persisted.endpoint))
        ) {
          await this.closeThroughCdp(persisted.endpoint);
        }

        const stopped: PersistedRuntimeState = {
          ...persisted,
          state: "stopped",
          endpoint: undefined,
          lastError: undefined,
          updatedAtUnixMs: this.now(),
        };
        await this.options.stateStore.write(stopped);
        return this.statusFromPersisted(stopped);
      } finally {
        this.phases.delete(environmentId);
      }
    });
  }

  async getEnvironmentStatus(
    environmentId: string,
  ): Promise<EnvironmentStatus> {
    const phase = this.phases.get(environmentId);
    const active = this.active.get(environmentId);

    if (active !== undefined) {
      if (phase !== undefined) {
        return this.buildStatus(active, phase, undefined);
      }
      return this.refreshActive(active);
    }

    if (phase !== undefined) {
      return {
        environmentId,
        state: phase,
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
    }

    const persisted = await this.options.stateStore.read(environmentId);
    if (persisted === undefined) {
      throw new BrowserAdapterError(
        "environment_not_found",
        "no environment with this id is known to the adapter",
        { environmentId },
      );
    }
    return this.reconcilePersisted(persisted);
  }

  async connectEnvironment(input: unknown): Promise<LaunchResult> {
    const resolved = this.resolve(input);
    const environmentId = resolved.config.id;

    return this.withLock(environmentId, async () => {
      this.phases.set(environmentId, "starting");
      try {
        const active = this.active.get(environmentId);
        if (active !== undefined) {
          assertSameRunningConfiguration(active.resolved, resolved);
          if (active.session?.isConnected() === true) {
            return {
              status: this.buildStatus(active, "running", undefined),
              config:
                active.lastReport ?? (await this.applyAndRemember(active)),
            };
          }
          await this.attach(active, resolved);
          const report = await this.applyAndRemember(active);
          await this.persist(active, "running");
          return {
            status: this.buildStatus(active, "running", undefined),
            config: report,
          };
        }

        const persisted = await this.options.stateStore.read(environmentId);
        if (persisted === undefined) {
          throw new BrowserAdapterError(
            "environment_not_found",
            "no environment with this id is known to the adapter",
            { environmentId },
          );
        }
        if (!isLiveState(persisted.state)) {
          throw new BrowserAdapterError(
            "browser_exited",
            "the recorded browser is not running",
            { environmentId, state: persisted.state },
          );
        }
        assertProfileMatchesRecord(resolved, persisted);

        const processStatus = await this.tryStatus(persisted.processInstanceId);
        if (processStatus?.state.state === "exited") {
          await this.markExited(persisted, processStatus);
          throw new BrowserAdapterError(
            "browser_exited",
            "Chrome exited before the adapter could reconnect",
            {
              environmentId,
              exitCode: processStatus.state.exitCode,
            },
          );
        }
        const advertised = readDevToolsEndpoint(resolved.profile.userDataDir);
        if (advertised !== undefined) {
          assertLoopbackEndpoint(advertised);
        }
        const endpoint = advertised?.endpoint ?? persisted.endpoint;

        if (
          processStatus === undefined &&
          (endpoint === undefined || !(await this.endpointAlive(endpoint)))
        ) {
          const stopped: PersistedRuntimeState = {
            ...persisted,
            state: "stopped",
            endpoint: undefined,
            lastError: {
              code: "browser_exited",
              message:
                "the browser no longer has a reachable debugging endpoint",
            },
            updatedAtUnixMs: this.now(),
          };
          await this.options.stateStore.write(stopped);
          throw new BrowserAdapterError(
            "browser_exited",
            "Chrome is no longer reachable over CDP",
            { environmentId },
          );
        }
        if (endpoint === undefined) {
          throw new BrowserAdapterError(
            "cdp_disconnected",
            "the persisted runtime state has no debugging endpoint",
            { environmentId },
          );
        }

        const reconnected: ActiveEnvironment = {
          resolved,
          processInstanceId: persisted.processInstanceId,
          pid: persisted.pid,
          startedAtUnixMs: persisted.startedAtUnixMs,
          endpoint,
          browserVersion: persisted.browserVersion ?? resolved.browser.version,
          session: undefined,
          applier: undefined,
          lastReport: undefined,
          cdpConnectedAtUnixMs: undefined,
          unsubscribers: [],
        };
        this.active.set(environmentId, reconnected);
        try {
          await this.attach(reconnected);
          const report = await this.applyAndRemember(reconnected);
          await this.persist(reconnected, "running");
          return {
            status: this.buildStatus(reconnected, "running", undefined),
            config: report,
          };
        } catch (error) {
          await this.disposeActive(reconnected, true);
          this.active.delete(environmentId);
          throw error;
        }
      } finally {
        this.phases.delete(environmentId);
      }
    });
  }

  async disconnectEnvironment(
    environmentId: string,
  ): Promise<EnvironmentStatus> {
    return this.withLock(environmentId, async () => {
      const active = this.active.get(environmentId);
      if (active === undefined) {
        const persisted = await this.options.stateStore.read(environmentId);
        if (persisted === undefined) {
          throw new BrowserAdapterError(
            "environment_not_found",
            "no environment with this id is known to the adapter",
            { environmentId },
          );
        }
        return this.reconcilePersisted(persisted);
      }
      if (active.session === undefined) {
        return this.buildStatus(active, "running", undefined);
      }
      await this.disposeActive(active, true);
      return this.buildStatus(active, "running", undefined);
    });
  }

  async applyEnvironmentConfig(
    environmentId: string,
    input?: unknown,
  ): Promise<EnvironmentConfigReport> {
    return this.withLock(environmentId, async () => {
      const active = this.requireConnected(environmentId);
      const resolved =
        input === undefined ? active.resolved : this.resolve(input);
      assertSameRunningConfiguration(active.resolved, resolved);
      active.resolved = resolved;
      const applier = active.applier;
      if (applier === undefined) {
        throw new BrowserAdapterError(
          "cdp_disconnected",
          "the environment has no CDP connection",
          { environmentId },
        );
      }
      const report = await applier.apply(resolved);
      active.lastReport = report;
      return report;
    });
  }

  async verifyEnvironmentConfig(
    environmentId: string,
    input?: unknown,
    options: ApplyConfigOptions = {},
  ): Promise<EnvironmentConfigReport> {
    return this.withLock(environmentId, async () => {
      const active = this.requireConnected(environmentId);
      const resolved =
        input === undefined ? active.resolved : this.resolve(input);
      assertSameRunningConfiguration(active.resolved, resolved);
      active.resolved = resolved;
      const applier = active.applier;
      if (applier === undefined) {
        throw new BrowserAdapterError(
          "cdp_disconnected",
          "the environment has no CDP connection",
          { environmentId },
        );
      }
      const report = await applier.verify(resolved, {
        ...(options.networkProbeUrl === undefined &&
        this.options.networkProbeUrl === undefined
          ? {}
          : {
              networkProbeUrl:
                options.networkProbeUrl ?? this.options.networkProbeUrl,
            }),
        timeoutMs: options.timeoutMs ?? this.timeouts.configVerifyMs,
      });
      active.lastReport = report;
      return report;
    });
  }

  listPages(environmentId: string): readonly BrowserPageSummary[] {
    const session = this.requireConnected(environmentId).session;
    return session?.pages().map(toPageSummary) ?? [];
  }

  async openPage(
    environmentId: string,
    url: string,
  ): Promise<BrowserPageSummary> {
    assertNavigablePageUrl(url);
    return this.withLock(environmentId, async () => {
      const active = this.requireConnected(environmentId);
      const session = active.session;
      if (session === undefined) {
        throw this.notConnected(environmentId);
      }
      const page = await session.newPage(url);
      if (active.applier !== undefined) {
        await active.applier.applyToPage(page, active.resolved);
        active.lastReport = active.applier.buildReport(active.resolved);
      }
      return toPageSummary(page);
    });
  }

  async navigatePage(
    environmentId: string,
    pageId: string,
    url: string,
  ): Promise<BrowserPageSummary> {
    assertNavigablePageUrl(url);
    return this.withLock(environmentId, async () => {
      const active = this.requireConnected(environmentId);
      const page = active.session
        ?.pages()
        .find((candidate) => candidate.pageId === pageId);
      if (page === undefined) {
        throw new BrowserAdapterError(
          "target_not_found",
          "no page with this id is open in the environment",
          { environmentId, pageId },
        );
      }
      await page.navigate(url);
      if (active.applier !== undefined) {
        await active.applier.applyToPage(page, active.resolved);
        active.lastReport = active.applier.buildReport(active.resolved);
      }
      return toPageSummary(page);
    });
  }

  async closePage(environmentId: string, pageId: string): Promise<void> {
    await this.withLock(environmentId, async () => {
      const active = this.requireConnected(environmentId);
      const page = active.session
        ?.pages()
        .find((candidate) => candidate.pageId === pageId);
      if (page === undefined) {
        throw new BrowserAdapterError(
          "target_not_found",
          "no page with this id is open in the environment",
          { environmentId, pageId },
        );
      }
      await page.close();
      if (active.applier !== undefined) {
        active.lastReport = active.applier.buildReport(active.resolved);
      }
    });
  }

  /** Release every CDP connection. Browser processes keep running. */
  async disconnectAll(): Promise<void> {
    for (const active of this.active.values()) {
      await this.disposeActive(active, true);
    }
  }

  private validationContext(): ValidationContext {
    return {
      dataRoot: this.options.dataRoot,
      discovery: this.options.discovery,
      localAppData: this.options.localAppData,
    };
  }

  private resolve(input: unknown): ResolvedBrowserEnvironment {
    const result = this.validateEnvironment(input);
    if (!result.valid || result.resolved === undefined) {
      throw new BrowserAdapterError(
        "invalid_configuration",
        "the environment configuration was rejected",
        { issues: result.issues },
      );
    }
    return result.resolved;
  }

  private async rejectStaleRunningRecord(environmentId: string): Promise<void> {
    const persisted = await this.options.stateStore.read(environmentId);
    if (persisted === undefined || !isLiveState(persisted.state)) {
      return;
    }
    const status = await this.tryStatus(persisted.processInstanceId);
    if (status?.state.state === "running") {
      throw new BrowserAdapterError(
        "environment_already_running",
        "the process runtime still owns a browser for this environment",
        { environmentId, processInstanceId: persisted.processInstanceId },
      );
    }
    if (status?.state.state === "starting") {
      throw new BrowserAdapterError(
        "environment_already_running",
        "the process runtime is still starting a browser for this environment",
        { environmentId, processInstanceId: persisted.processInstanceId },
      );
    }
    if (
      status === undefined &&
      persisted.endpoint !== undefined &&
      (await this.endpointAlive(persisted.endpoint))
    ) {
      throw new BrowserAdapterError(
        "environment_already_running",
        "a browser for this environment is still serving its debugging endpoint",
        { environmentId },
      );
    }
    await this.options.stateStore.write({
      ...persisted,
      state: "stopped",
      endpoint: undefined,
      lastError:
        status?.state.state === "exited"
          ? {
              code: "browser_exited",
              message: `Chrome had exited with code ${String(status.state.exitCode)}`,
            }
          : persisted.lastError,
      updatedAtUnixMs: this.now(),
    });
  }

  private assertNoSharedProfile(resolved: ResolvedBrowserEnvironment): void {
    const candidate = normalizePath(resolved.profile.userDataDir);
    for (const active of this.active.values()) {
      if (
        active.resolved.config.id !== resolved.config.id &&
        normalizePath(active.resolved.profile.userDataDir) === candidate
      ) {
        throw new BrowserAdapterError(
          "data_directory_conflict",
          "another running environment uses the same Chrome data directory",
          {
            userDataDir: resolved.profile.userDataDir,
            otherEnvironmentId: active.resolved.config.id,
          },
        );
      }
    }
  }

  private async attach(
    active: ActiveEnvironment,
    resolved: ResolvedBrowserEnvironment = active.resolved,
  ): Promise<void> {
    assertSafeRecordedEndpoint(active.endpoint);
    const session = await this.options.connector.connect(
      active.endpoint,
      this.timeouts.cdpConnectMs,
    );
    const actualVersion = normalizeBrowserVersion(session.version());
    const expected =
      resolved.config.browser.version ?? resolved.browser.version;
    if (
      expected !== "unknown" &&
      expected.length > 0 &&
      actualVersion !== expected
    ) {
      await session.disconnect().catch(() => undefined);
      throw new BrowserAdapterError(
        "chrome_incompatible",
        `expected Chrome ${expected}, the CDP endpoint reports ${actualVersion}`,
        { expected, actual: actualVersion },
      );
    }

    active.session = session;
    active.browserVersion = actualVersion;
    active.applier = new EnvironmentConfigApplier(session, this.now);
    active.cdpConnectedAtUnixMs = this.now();
    active.resolved = resolved;
    this.wire(active, session);
  }

  private wire(active: ActiveEnvironment, session: BrowserSessionPort): void {
    const offPage = session.onPageCreated((page) => {
      const applier = active.applier;
      if (applier === undefined) {
        return;
      }
      void applier
        .applyToPage(page, active.resolved)
        .then(() => {
          active.lastReport = applier.buildReport(active.resolved);
        })
        .catch(() => {
          active.lastReport = applier.buildReport(active.resolved);
        });
    });
    const offDisconnect = session.onDisconnected(() => {
      this.unwire(active);
      const applier = active.applier;
      active.applier = undefined;
      active.session = undefined;
      active.cdpConnectedAtUnixMs = undefined;
      if (applier !== undefined) {
        void applier.dispose().catch(() => undefined);
      }
    });
    active.unsubscribers.push(offPage, offDisconnect);
  }

  private unwire(active: ActiveEnvironment): void {
    const unsubscribers = active.unsubscribers;
    active.unsubscribers = [];
    for (const unsubscribe of unsubscribers) {
      try {
        unsubscribe();
      } catch {
        // Listener teardown must never mask the lifecycle result.
      }
    }
  }

  private async applyAndRemember(
    active: ActiveEnvironment,
  ): Promise<EnvironmentConfigReport> {
    const applier = active.applier;
    if (applier === undefined) {
      throw this.notConnected(active.resolved.config.id);
    }
    try {
      const report = await applier.apply(active.resolved);
      active.lastReport = report;
      return report;
    } catch (error) {
      throw new BrowserAdapterError(
        "config_apply_failed",
        "applying the environment configuration over CDP failed",
        { environmentId: active.resolved.config.id },
        error,
      );
    }
  }

  private async refreshActive(
    active: ActiveEnvironment,
  ): Promise<EnvironmentStatus> {
    const status = await this.tryStatus(active.processInstanceId);
    if (status === undefined) {
      if (active.session?.isConnected() === true) {
        return this.buildStatus(active, "running", undefined);
      }
      if (await this.endpointAlive(active.endpoint)) {
        return this.buildStatus(active, "running", undefined);
      }
      return this.finalizeDead(active, undefined);
    }
    if (status.state.state === "exited") {
      return this.finalizeDead(active, status);
    }
    return this.buildStatus(
      active,
      status.state.state === "starting" ? "starting" : "running",
      undefined,
    );
  }

  private async finalizeDead(
    active: ActiveEnvironment,
    status: ProcessStatus | undefined,
  ): Promise<EnvironmentStatus> {
    const exitCode =
      status?.state.state === "exited" ? status.state.exitCode : undefined;
    const lastError = {
      code: "browser_exited",
      message:
        exitCode === undefined
          ? "Chrome is no longer reachable and the runtime does not own it"
          : `Chrome exited without a stop request (exit code ${String(exitCode)})`,
    };
    await this.disposeActive(active, status === undefined);
    this.active.delete(active.resolved.config.id);

    const state: BrowserEnvironmentState =
      exitCode === undefined || exitCode !== 0 ? "failed" : "stopped";
    const persisted: PersistedRuntimeState = {
      environmentId: active.resolved.config.id,
      processInstanceId: active.processInstanceId,
      pid: active.pid,
      startedAtUnixMs: active.startedAtUnixMs,
      userDataDir: active.resolved.profile.userDataDir,
      endpoint: undefined,
      browserVersion: active.browserVersion,
      state,
      updatedAtUnixMs: this.now(),
      lastError,
    };
    await this.options.stateStore.write(persisted);
    return this.statusFromPersisted(persisted);
  }

  private async reconcilePersisted(
    persisted: PersistedRuntimeState,
  ): Promise<EnvironmentStatus> {
    if (!isLiveState(persisted.state)) {
      return this.statusFromPersisted(persisted);
    }

    const status = await this.tryStatus(persisted.processInstanceId);
    if (status?.state.state === "exited") {
      return this.statusFromPersisted(await this.markExited(persisted, status));
    }
    if (status?.state.state === "running") {
      if (persisted.state !== "running") {
        const running: PersistedRuntimeState = {
          ...persisted,
          state: "running",
          updatedAtUnixMs: this.now(),
        };
        await this.options.stateStore.write(running);
        return this.statusFromPersisted(running);
      }
      return this.statusFromPersisted(persisted);
    }
    if (status?.state.state === "starting") {
      return this.statusFromPersisted(persisted);
    }

    if (
      persisted.endpoint !== undefined &&
      (await this.endpointAlive(persisted.endpoint))
    ) {
      if (persisted.state !== "running") {
        const running: PersistedRuntimeState = {
          ...persisted,
          state: "running",
          updatedAtUnixMs: this.now(),
        };
        await this.options.stateStore.write(running);
        return this.statusFromPersisted(running);
      }
      return this.statusFromPersisted(persisted);
    }

    const stopped: PersistedRuntimeState = {
      ...persisted,
      state: "stopped",
      endpoint: undefined,
      updatedAtUnixMs: this.now(),
    };
    await this.options.stateStore.write(stopped);
    return this.statusFromPersisted(stopped);
  }

  private async markExited(
    persisted: PersistedRuntimeState,
    status: ProcessStatus,
  ): Promise<PersistedRuntimeState> {
    const exitCode =
      status.state.state === "exited" ? status.state.exitCode : 0;
    const stopped: PersistedRuntimeState = {
      ...persisted,
      state: exitCode === 0 ? "stopped" : "failed",
      endpoint: undefined,
      lastError: {
        code: "browser_exited",
        message: `Chrome exited without a stop request (exit code ${String(exitCode)})`,
      },
      updatedAtUnixMs: this.now(),
    };
    await this.options.stateStore.write(stopped);
    return stopped;
  }

  private async stopActive(
    active: ActiveEnvironment,
    options: StopOptions,
  ): Promise<void> {
    const mode = options.mode ?? "graceful";
    const timeoutMs = options.timeoutMs ?? this.timeouts.stopMs;
    const environmentId = active.resolved.config.id;

    if (mode === "graceful" && active.session?.isConnected() === true) {
      await active.session
        .sendBrowserCommand("Browser.close")
        .catch(() => undefined);
      const exited = await this.waitForExit(
        active.processInstanceId,
        timeoutMs,
      );
      if (!exited) {
        await this.options.runtime.terminate(active.processInstanceId);
      }
    } else {
      await this.options.runtime.terminate(active.processInstanceId);
    }

    await this.disposeActive(active, true);
    this.active.delete(environmentId);
  }

  private async waitForExit(
    processInstanceId: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.tryStatus(processInstanceId);
      if (status === undefined || status.state.state === "exited") {
        return true;
      }
      await delay(100);
    }
    return false;
  }

  private async closeThroughCdp(endpoint: string): Promise<void> {
    let session: BrowserSessionPort | undefined;
    try {
      session = await this.options.connector.connect(
        endpoint,
        this.timeouts.cdpConnectMs,
      );
      await session.sendBrowserCommand("Browser.close");
    } catch {
      // Chrome may already be gone; the probe below decides.
    } finally {
      if (session !== undefined) {
        await session.disconnect().catch(() => undefined);
      }
    }
    const deadline = Date.now() + this.timeouts.stopMs;
    while (Date.now() < deadline) {
      if (!(await this.endpointAlive(endpoint))) {
        return;
      }
      await delay(100);
    }
    throw new BrowserAdapterError(
      "cdp_timeout",
      "Chrome did not exit after a CDP close request",
      { endpoint: redactEndpoint(endpoint) },
    );
  }

  private async disposeActive(
    active: ActiveEnvironment,
    disconnect: boolean,
  ): Promise<void> {
    this.unwire(active);
    const applier = active.applier;
    active.applier = undefined;
    if (applier !== undefined) {
      await applier.dispose().catch(() => undefined);
    }
    const session = active.session;
    active.session = undefined;
    active.cdpConnectedAtUnixMs = undefined;
    if (disconnect && session?.isConnected() === true) {
      await session.disconnect().catch(() => undefined);
    }
  }

  private async failLaunch(
    environmentId: string,
    resolved: ResolvedBrowserEnvironment,
    launched: ProcessStatus,
    error: BrowserAdapterError,
  ): Promise<void> {
    await this.options.runtime
      .terminate(launched.processInstanceId)
      .catch(() => undefined);
    const active = this.active.get(environmentId);
    if (active !== undefined) {
      await this.disposeActive(active, false);
      this.active.delete(environmentId);
    }
    await this.options.stateStore
      .write({
        environmentId,
        processInstanceId: launched.processInstanceId,
        pid: launched.pid,
        startedAtUnixMs: launched.startedAtUnixMs,
        userDataDir: resolved.profile.userDataDir,
        endpoint: undefined,
        browserVersion: undefined,
        state: "failed",
        updatedAtUnixMs: this.now(),
        lastError: { code: error.code, message: error.message },
      })
      .catch(() => undefined);
  }

  private async persist(
    active: ActiveEnvironment,
    state: BrowserEnvironmentState,
  ): Promise<void> {
    await this.options.stateStore.write({
      environmentId: active.resolved.config.id,
      processInstanceId: active.processInstanceId,
      pid: active.pid,
      startedAtUnixMs: active.startedAtUnixMs,
      userDataDir: active.resolved.profile.userDataDir,
      endpoint: state === "running" ? active.endpoint : undefined,
      browserVersion: active.browserVersion,
      state,
      updatedAtUnixMs: this.now(),
      lastError: undefined,
    });
  }

  private persistedStopped(active: ActiveEnvironment): PersistedRuntimeState {
    return {
      environmentId: active.resolved.config.id,
      processInstanceId: active.processInstanceId,
      pid: active.pid,
      startedAtUnixMs: active.startedAtUnixMs,
      userDataDir: active.resolved.profile.userDataDir,
      endpoint: undefined,
      browserVersion: active.browserVersion,
      state: "stopped",
      updatedAtUnixMs: this.now(),
      lastError: undefined,
    };
  }

  private buildStatus(
    active: ActiveEnvironment,
    state: BrowserEnvironmentState,
    lastError: { code: string; message: string } | undefined,
  ): EnvironmentStatus {
    const connected =
      state === "running" && (active.session?.isConnected() ?? false);
    return {
      environmentId: active.resolved.config.id,
      state,
      processInstanceId: active.processInstanceId,
      pid: active.pid,
      startedAtUnixMs: active.startedAtUnixMs,
      userDataDir: active.resolved.profile.userDataDir,
      browserVersion: active.browserVersion,
      cdp: {
        connected,
        endpoint: state === "running" ? active.endpoint : undefined,
        connectedAtUnixMs: connected ? active.cdpConnectedAtUnixMs : undefined,
      },
      lastError,
    };
  }

  private statusFromPersisted(
    persisted: PersistedRuntimeState,
  ): EnvironmentStatus {
    return {
      environmentId: persisted.environmentId,
      state: persisted.state,
      processInstanceId: persisted.processInstanceId,
      pid: persisted.pid,
      startedAtUnixMs: persisted.startedAtUnixMs,
      userDataDir: persisted.userDataDir,
      browserVersion: persisted.browserVersion,
      cdp: {
        connected: false,
        endpoint:
          persisted.state === "running" ? persisted.endpoint : undefined,
        connectedAtUnixMs: undefined,
      },
      lastError: persisted.lastError,
    };
  }

  private requireConnected(environmentId: string): ActiveEnvironment {
    const active = this.active.get(environmentId);
    if (active === undefined) {
      throw new BrowserAdapterError(
        "environment_not_found",
        "this environment is not running under this adapter instance",
        { environmentId },
      );
    }
    if (!(active.session?.isConnected() ?? false)) {
      throw this.notConnected(environmentId);
    }
    return active;
  }

  private notConnected(environmentId: string): BrowserAdapterError {
    return new BrowserAdapterError(
      "cdp_disconnected",
      "the environment is running but has no CDP connection",
      { environmentId },
    );
  }

  private async checkAlive(
    processInstanceId: string,
    isolation: IsolationPreference,
  ): Promise<{ alive: boolean; detail?: string }> {
    const status = await this.tryStatus(processInstanceId);
    if (status === undefined) {
      return {
        alive: false,
        detail: "the process runtime no longer owns this process",
      };
    }
    if (status.state.state === "exited") {
      this.assertBrowserDidNotAbort(status.state.exitCode, isolation);
      return {
        alive: false,
        detail: `Chrome exited during launch with code ${String(status.state.exitCode)}`,
      };
    }
    return { alive: true, detail: status.state.state };
  }

  /**
   * Chromium's browser process aborts with `STATUS_BREAKPOINT` when it
   * cannot start its own sandbox inside an already restricted token. The
   * runtime applied the requested isolation correctly; the browser refuses to
   * run inside it, so the request must not be reported as a generic failure.
   */
  private assertBrowserDidNotAbort(
    exitCode: number,
    isolation: IsolationPreference,
  ): void {
    if (exitCode !== STATUS_BREAKPOINT || isolation === "managed") {
      return;
    }
    throw new BrowserAdapterError(
      "unsupported_isolation",
      `Chrome aborted during startup with STATUS_BREAKPOINT (${String(exitCode)}): the Chromium browser process cannot start its own sandbox inside a ${isolationLabel(isolation)} token. Use the managed Job Object isolation for Chrome.`,
      { isolation, exitCode, reason: "status_breakpoint" },
    );
  }

  /**
   * The browser can publish its debugging endpoint and abort immediately
   * afterwards, so the liveness of the process is checked again before any
   * configuration is applied.
   */
  private async assertStillRunning(
    active: ActiveEnvironment,
    resolved: ResolvedBrowserEnvironment,
  ): Promise<void> {
    const status = await this.tryStatus(active.processInstanceId);
    if (status?.state.state !== "exited") {
      return;
    }
    this.assertBrowserDidNotAbort(
      status.state.exitCode,
      resolved.config.runtimePolicy.isolation,
    );
  }

  private async tryStatus(
    processInstanceId: string,
  ): Promise<ProcessStatus | undefined> {
    try {
      return await this.options.runtime.getStatus(processInstanceId);
    } catch (error) {
      if (isBrowserAdapterError(error)) {
        if (
          error.code === "runtime_unavailable" ||
          error.code === "runtime_ipc_failure"
        ) {
          throw error;
        }
        if (
          error.code === "runtime_operation_failed" &&
          contractCode(error) === "process_not_found"
        ) {
          return undefined;
        }
      }
      throw error;
    }
  }

  private async endpointAlive(endpoint: string): Promise<boolean> {
    try {
      const url = new URL(endpoint);
      if (
        (url.protocol !== "ws:" && url.protocol !== "wss:") ||
        !isLoopbackHost(url.hostname)
      ) {
        return false;
      }
      url.protocol = url.protocol === "wss:" ? "https:" : "http:";
      url.pathname = "/json/version";
      url.search = "";
      url.hash = "";
      const response = await fetch(url, {
        signal: AbortSignal.timeout(this.timeouts.endpointProbeMs),
      });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }

  private async withLock<T>(
    environmentId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.locks.get(environmentId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(
      () => gate,
      () => gate,
    );
    this.locks.set(environmentId, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.locks.get(environmentId) === queued) {
        this.locks.delete(environmentId);
      }
    }
  }
}

function buildLaunchParams(
  resolved: ResolvedBrowserEnvironment,
  argumentsList: readonly string[],
): LaunchParams {
  const isolation = resolved.config.runtimePolicy.isolation;
  const installRoot = path.dirname(resolved.browser.executablePath);
  const containment = {
    killOnClose: true as const,
    ...(resolved.config.runtimePolicy.maxProcesses === undefined
      ? {}
      : { maxProcesses: resolved.config.runtimePolicy.maxProcesses }),
    ...(resolved.config.runtimePolicy.memoryLimitBytes === undefined
      ? {}
      : {
          memoryLimitBytes: resolved.config.runtimePolicy.memoryLimitBytes,
        }),
  };

  const policy: LaunchPolicy =
    isolation === "app_container"
      ? {
          isolation: "app_container",
          allowedProgramRoots: [installRoot],
          fileAccess: {
            kind: "restricted",
            dataDirectory: "read_write",
            additionalRoots: [{ path: installRoot, access: "read_only" }],
          },
          networkAccess: "allow",
          containment,
        }
      : isolation === "restricted"
        ? {
            isolation: "restricted",
            allowedProgramRoots: [installRoot],
            fileAccess: { kind: "inherited" },
            networkAccess: "allow",
            containment,
          }
        : {
            isolation: "managed",
            allowedProgramRoots: [installRoot],
            fileAccess: { kind: "inherited" },
            networkAccess: "allow",
            containment,
          };

  return {
    environmentId: resolved.config.id,
    executable: resolved.browser.executablePath,
    arguments: [...argumentsList],
    workingDirectory: resolved.profile.environmentRoot,
    dataDirectory: resolved.profile.environmentRoot,
    policy,
  };
}

function assertIsolation(
  capabilities: CapabilityReport,
  resolved: ResolvedBrowserEnvironment,
): void {
  const isolation = resolved.config.runtimePolicy.isolation;
  const requirements: readonly {
    readonly name: string;
    readonly capability: Capability;
  }[] =
    isolation === "app_container"
      ? [
          {
            name: "appContainer",
            capability: capabilities.appContainer,
          },
          {
            name: "appContainerAcl",
            capability: capabilities.appContainerAcl,
          },
        ]
      : isolation === "restricted"
        ? [
            {
              name: "restrictedToken",
              capability: capabilities.restrictedToken,
            },
          ]
        : [
            {
              name: "jobObject",
              capability: capabilities.jobObject,
            },
          ];

  for (const { name, capability } of requirements) {
    if (capability.state !== "supported") {
      throw new BrowserAdapterError(
        "unsupported_isolation",
        `runtime isolation "${isolation}" needs ${name}, which is ${capability.state}`,
        {
          environmentId: resolved.config.id,
          isolation,
          capability: name,
          state: capability.state,
          detail: capability.detail,
        },
      );
    }
  }
}

function assertSameRunningConfiguration(
  current: ResolvedBrowserEnvironment,
  next: ResolvedBrowserEnvironment,
): void {
  if (current.config.id !== next.config.id) {
    throw new BrowserAdapterError(
      "invalid_configuration",
      "the configuration names a different environment",
      {
        environmentId: current.config.id,
        configuredId: next.config.id,
      },
    );
  }
  const profileChanged =
    normalizePath(current.profile.userDataDir) !==
    normalizePath(next.profile.userDataDir);
  const executableChanged =
    current.browser.executablePath.toLowerCase() !==
    next.browser.executablePath.toLowerCase();
  const policyChanged =
    current.config.runtimePolicy.isolation !==
      next.config.runtimePolicy.isolation ||
    current.config.runtimePolicy.maxProcesses !==
      next.config.runtimePolicy.maxProcesses ||
    current.config.runtimePolicy.memoryLimitBytes !==
      next.config.runtimePolicy.memoryLimitBytes ||
    current.config.persistence.mode !== next.config.persistence.mode;
  if (profileChanged || executableChanged || policyChanged) {
    throw new BrowserAdapterError(
      "invalid_configuration",
      "profile, executable and runtime policy cannot change while the environment is running",
      {
        environmentId: current.config.id,
        profileChanged,
        executableChanged,
        policyChanged,
      },
    );
  }
}

function assertProfileMatchesRecord(
  resolved: ResolvedBrowserEnvironment,
  persisted: PersistedRuntimeState,
): void {
  if (
    normalizePath(resolved.profile.userDataDir) !==
    normalizePath(persisted.userDataDir)
  ) {
    throw new BrowserAdapterError(
      "invalid_configuration",
      "the configuration now points at a different Chrome data directory than the running browser",
      {
        environmentId: resolved.config.id,
        configured: resolved.profile.userDataDir,
        running: persisted.userDataDir,
      },
    );
  }
}

function assertSafeRecordedEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new BrowserAdapterError(
      "cdp_disconnected",
      "the recorded CDP endpoint is not a valid URL",
    );
  }
  if (
    url.protocol !== "ws:" ||
    !isLoopbackHost(url.hostname) ||
    !url.pathname.startsWith("/devtools/browser/")
  ) {
    throw new BrowserAdapterError(
      "cdp_disconnected",
      "the recorded CDP endpoint is not a loopback browser endpoint",
      { endpoint: redactEndpoint(endpoint) },
    );
  }
}

function assertNavigablePageUrl(url: string): void {
  if (!isNavigableUrl(url)) {
    throw new BrowserAdapterError(
      "invalid_configuration",
      "page URLs must use http, https or about:blank",
      { url },
    );
  }
}

function toPageSummary(page: {
  readonly pageId: string;
  url(): string;
}): BrowserPageSummary {
  return { pageId: page.pageId, url: page.url() };
}

function normalizeBrowserVersion(version: string): string {
  return version
    .trim()
    .replace(/^(?:Headless)?Chrome\//i, "")
    .trim();
}

function normalizePath(candidate: string): string {
  return path
    .resolve(candidate)
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function redactEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  return `${url.protocol}//${url.host}${url.pathname}`;
}

function toLaunchError(error: unknown): BrowserAdapterError {
  if (isBrowserAdapterError(error)) {
    if (
      error.code === "runtime_operation_failed" &&
      (contractCode(error) === "capability_unavailable" ||
        contractCode(error) === "policy_violation")
    ) {
      return new BrowserAdapterError(
        "unsupported_isolation",
        "the runtime refused the requested isolation policy",
        {
          contractCode: contractCode(error),
          runtimeMessage: error.message,
        },
        error,
      );
    }
    return error;
  }
  return new BrowserAdapterError(
    "launch_failed",
    "launching Chrome through the process runtime failed",
    undefined,
    error,
  );
}

function contractCode(error: BrowserAdapterError): string | undefined {
  const value = error.details?.contractCode;
  return typeof value === "string" ? value : undefined;
}

function isLiveState(state: BrowserEnvironmentState): boolean {
  return state === "starting" || state === "running" || state === "stopping";
}
