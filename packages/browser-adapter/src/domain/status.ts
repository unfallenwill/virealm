export type BrowserEnvironmentState =
  "stopped" | "starting" | "running" | "stopping" | "failed";

export interface CdpStatus {
  readonly connected: boolean;
  readonly endpoint: string | undefined;
  readonly connectedAtUnixMs: number | undefined;
}

export interface EnvironmentStatus {
  readonly environmentId: string;
  readonly state: BrowserEnvironmentState;
  readonly processInstanceId: string | undefined;
  readonly pid: number | undefined;
  readonly startedAtUnixMs: number | undefined;
  readonly userDataDir: string | undefined;
  readonly browserVersion: string | undefined;
  readonly cdp: CdpStatus;
  readonly lastError:
    { readonly code: string; readonly message: string } | undefined;
}

export type ConfigField =
  | "timezone"
  | "locale"
  | "acceptLanguage"
  | "viewport"
  | "deviceScaleFactor"
  | "geolocation";

/**
 * Every outcome is explicit. There is no boolean shortcut: "applied" means a
 * CDP command succeeded, "verified" means the page reported the value back,
 * and "not_verified" means the adapter could not observe it.
 */
export type ConfigFieldStatus =
  "applied" | "verified" | "unsupported" | "failed" | "not_verified";

export type ConfigFieldValue =
  | string
  | number
  | boolean
  | Readonly<Record<string, string | number | boolean>>;

export interface ConfigFieldResult {
  readonly field: ConfigField;
  readonly status: ConfigFieldStatus;
  readonly requested: ConfigFieldValue | undefined;
  readonly observed: ConfigFieldValue | undefined;
  readonly reason: string | undefined;
  /** Capability or CDP method involved, when relevant. */
  readonly capability: string | undefined;
}

export interface PageConfigReport {
  readonly pageId: string;
  readonly url: string;
  readonly fields: readonly ConfigFieldResult[];
}

export interface EnvironmentConfigReport {
  readonly environmentId: string;
  readonly capturedAtUnixMs: number;
  /** Per-field aggregation across pages. */
  readonly fields: readonly ConfigFieldResult[];
  readonly pages: readonly PageConfigReport[];
}

/** A page or tab the adapter manages inside one environment. */
export interface BrowserPageSummary {
  readonly pageId: string;
  readonly url: string;
}

export interface EnvironmentValidationIssue {
  /** Dotted path into the declared configuration. */
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface EnvironmentValidationResult {
  readonly valid: boolean;
  readonly issues: readonly EnvironmentValidationIssue[];
  readonly resolved:
    import("./environment.js").ResolvedBrowserEnvironment | undefined;
}

/**
 * Handle state the adapter needs to reconcile a browser it started. This is
 * not an environment registry: it stores no configuration and is never used
 * to decide what an environment should be.
 */
export interface PersistedRuntimeState {
  readonly environmentId: string;
  readonly processInstanceId: string;
  readonly pid: number;
  readonly startedAtUnixMs: number;
  readonly userDataDir: string;
  readonly endpoint: string | undefined;
  readonly browserVersion: string | undefined;
  readonly state: BrowserEnvironmentState;
  readonly updatedAtUnixMs: number;
  readonly lastError:
    { readonly code: string; readonly message: string } | undefined;
}

export interface LaunchResult {
  readonly status: EnvironmentStatus;
  readonly config: EnvironmentConfigReport;
}

export interface ApplyConfigOptions {
  /** Probe endpoint returning `{ "acceptLanguage": "..." }` for header checks. */
  readonly networkProbeUrl?: string;
  readonly timeoutMs?: number;
}

export interface StopOptions {
  /**
   * `graceful` asks Chrome to close over CDP and lets it flush the profile,
   * escalating to the runtime when it does not exit. `force` terminates the
   * job immediately through the runtime.
   */
  readonly mode?: "graceful" | "force";
  readonly timeoutMs?: number;
}
