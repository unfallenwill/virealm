import { discoverBrowsers } from "./chrome/discovery.js";
import type {
  BrowserConnectorPort,
  ChromeDiscoveryPort,
  RuntimePort,
  RuntimeStateStorePort,
} from "./application/ports.js";
import {
  EnvironmentService,
  type EnvironmentTimeouts,
} from "./application/environment-service.js";
import { PlaywrightBrowserConnector } from "./cdp/playwright-session.js";
import type { DiscoveredBrowser } from "./domain/environment.js";
import type {
  ApplyConfigOptions,
  BrowserPageSummary,
  EnvironmentConfigReport,
  EnvironmentStatus,
  EnvironmentValidationResult,
  LaunchResult,
  StopOptions,
} from "./domain/status.js";
import { JsonRuntimeStateStore } from "./persistence/runtime-state-store.js";
import { ProcessRuntimeClient } from "./runtime/process-runtime-client.js";

export interface BrowserAdapterOptions {
  /**
   * Root for Virealm-managed per-environment data. Environment ids, never
   * display names, become directory names below this root.
   */
  readonly dataRoot: string;
  /**
   * Existing Process Runtime connection. When omitted the adapter connects to
   * the default runtime pipe; it never starts or spawns the runtime itself.
   */
  readonly runtime?: RuntimePort;
  readonly runtimePipePath?: string;
  readonly connector?: BrowserConnectorPort;
  readonly discovery?: ChromeDiscoveryPort;
  readonly stateStore?: RuntimeStateStorePort;
  /** Extra Chrome executables, for example Chrome for Testing. */
  readonly chromeSearchPaths?: readonly string[];
  readonly localAppData?: string;
  readonly timeouts?: Partial<EnvironmentTimeouts>;
  readonly networkProbeUrl?: string;
  readonly now?: () => number;
}

/**
 * Public browser environment API.
 *
 * Everything Chrome-specific (argv, CDP, profiles, runtime handles) stays
 * behind this boundary; callers express intent with
 * `BrowserEnvironmentConfig` and read explicit status and verification
 * reports.
 */
export class BrowserAdapter {
  readonly service: EnvironmentService;
  private readonly ownedRuntime: ProcessRuntimeClient | undefined;

  constructor(options: BrowserAdapterOptions) {
    const owned =
      options.runtime === undefined
        ? new ProcessRuntimeClient(
            options.runtimePipePath === undefined
              ? {}
              : { pipePath: options.runtimePipePath },
          )
        : undefined;
    this.ownedRuntime = owned;
    const runtime = options.runtime ?? owned;
    if (runtime === undefined) {
      throw new Error("browser adapter runtime wiring is inconsistent");
    }

    const discovery: ChromeDiscoveryPort =
      options.discovery ??
      ({
        discover: (executablePath?: string): readonly DiscoveredBrowser[] =>
          discoverBrowsers({
            ...(executablePath === undefined ? {} : { executablePath }),
            ...(options.chromeSearchPaths === undefined
              ? {}
              : { extraPaths: options.chromeSearchPaths }),
          }),
      } satisfies ChromeDiscoveryPort);

    const stateStore =
      options.stateStore ?? new JsonRuntimeStateStore(options.dataRoot);

    this.service = new EnvironmentService({
      dataRoot: options.dataRoot,
      runtime,
      connector: options.connector ?? new PlaywrightBrowserConnector(),
      discovery,
      stateStore,
      ...(options.localAppData === undefined
        ? process.env.LOCALAPPDATA === undefined
          ? {}
          : { localAppData: process.env.LOCALAPPDATA }
        : { localAppData: options.localAppData }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
      ...(options.networkProbeUrl === undefined
        ? {}
        : { networkProbeUrl: options.networkProbeUrl }),
    });
  }

  discoverBrowsers(executablePath?: string): readonly DiscoveredBrowser[] {
    return this.service.discoverBrowsers(executablePath);
  }

  validateEnvironment(input: unknown): EnvironmentValidationResult {
    return this.service.validateEnvironment(input);
  }

  launchEnvironment(input: unknown): Promise<LaunchResult> {
    return this.service.launchEnvironment(input);
  }

  stopEnvironment(
    environmentId: string,
    options?: StopOptions,
  ): Promise<EnvironmentStatus> {
    return this.service.stopEnvironment(environmentId, options);
  }

  getEnvironmentStatus(environmentId: string): Promise<EnvironmentStatus> {
    return this.service.getEnvironmentStatus(environmentId);
  }

  connectEnvironment(input: unknown): Promise<LaunchResult> {
    return this.service.connectEnvironment(input);
  }

  disconnectEnvironment(environmentId: string): Promise<EnvironmentStatus> {
    return this.service.disconnectEnvironment(environmentId);
  }

  applyEnvironmentConfig(
    environmentId: string,
    input?: unknown,
  ): Promise<EnvironmentConfigReport> {
    return this.service.applyEnvironmentConfig(environmentId, input);
  }

  verifyEnvironmentConfig(
    environmentId: string,
    input?: unknown,
    options?: ApplyConfigOptions,
  ): Promise<EnvironmentConfigReport> {
    return this.service.verifyEnvironmentConfig(environmentId, input, options);
  }

  listPages(environmentId: string): Promise<readonly BrowserPageSummary[]> {
    return Promise.resolve(this.service.listPages(environmentId));
  }

  openPage(environmentId: string, url: string): Promise<BrowserPageSummary> {
    return this.service.openPage(environmentId, url);
  }

  navigatePage(
    environmentId: string,
    pageId: string,
    url: string,
  ): Promise<BrowserPageSummary> {
    return this.service.navigatePage(environmentId, pageId, url);
  }

  closePage(environmentId: string, pageId: string): Promise<void> {
    return this.service.closePage(environmentId, pageId);
  }

  /**
   * Release adapter-owned resources. CDP connections are closed; browser
   * processes and their profiles are left running for a later reconnect.
   */
  async close(): Promise<void> {
    await this.service.disconnectAll();
    this.ownedRuntime?.close();
  }
}
