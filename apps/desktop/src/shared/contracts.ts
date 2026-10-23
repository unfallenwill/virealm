/**
 * Types exchanged between the Electron main process, the preload bridge and
 * the renderer. Nothing here mentions CDP, argv, Playwright or runtime handles:
 * the desktop UI only expresses environment intent and reads explicit status.
 */

export const ENVIRONMENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type IsolationMode = "managed" | "restricted" | "app_container";

export type EnvironmentPhase =
  "stopped" | "starting" | "running" | "stopping" | "failed" | "unknown";

export interface ViewportDraft {
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor?: number;
}

export interface GeolocationDraft {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracy?: number;
}

export interface RuntimePolicyDraft {
  readonly isolation: IsolationMode;
  readonly maxProcesses?: number;
  readonly memoryLimitBytes?: number;
}

export interface BrowserDraft {
  /**
   * Explicit Chrome executable. Omitted means "use the newest Chrome found in
   * the standard install locations".
   */
  readonly executablePath?: string;
}

export interface LaunchDraft {
  /** Extra Chrome switches. Security-relevant switches are rejected later. */
  readonly additionalArguments?: readonly string[];
}

/** What the renderer sends when creating or replacing an environment. */
export interface EnvironmentDraft {
  readonly name: string;
  readonly browser: BrowserDraft;
  readonly timezone?: string;
  readonly locale?: string;
  readonly viewport?: ViewportDraft;
  readonly geolocation?: GeolocationDraft;
  readonly runtimePolicy: RuntimePolicyDraft;
  readonly launch?: LaunchDraft;
}

export interface LaunchRecord {
  readonly atUnixMs: number;
  readonly ok: boolean;
  readonly code?: string;
  readonly message: string;
}

/** The declared configuration the desktop owns. Runtime state is never stored. */
export interface EnvironmentRecord extends EnvironmentDraft {
  readonly id: string;
  readonly createdAtUnixMs: number;
  readonly updatedAtUnixMs: number;
  /**
   * True when a running browser is using an older configuration because the
   * edit only takes effect after a restart.
   */
  readonly pendingRestart: boolean;
  readonly lastLaunch?: LaunchRecord;
  /** Absolute directory owned by Browser Adapter's profile layout rules. */
  readonly dataDir: string;
}

export type ConfigFieldName =
  | "timezone"
  | "locale"
  | "acceptLanguage"
  | "viewport"
  | "deviceScaleFactor"
  | "geolocation";

export type ConfigFieldStatus =
  "applied" | "verified" | "unsupported" | "failed" | "not_verified";

export type ConfigValue =
  | string
  | number
  | boolean
  | Readonly<Record<string, string | number | boolean>>;

export interface ConfigFieldView {
  readonly field: ConfigFieldName;
  readonly status: ConfigFieldStatus;
  readonly requested: ConfigValue | undefined;
  readonly observed: ConfigValue | undefined;
  readonly reason: string | undefined;
  readonly capability: string | undefined;
}

export interface PageConfigView {
  readonly pageId: string;
  readonly url: string;
  readonly fields: readonly ConfigFieldView[];
}

export interface VerificationView {
  readonly capturedAtUnixMs: number;
  readonly stale: boolean;
  readonly fields: readonly ConfigFieldView[];
  readonly pages: readonly PageConfigView[];
}

export interface EnvironmentView extends EnvironmentRecord {
  readonly state: EnvironmentPhase;
  readonly processInstanceId?: string;
  readonly pid?: number;
  readonly startedAtUnixMs?: number;
  readonly browserVersion?: string;
  readonly cdp: {
    readonly connected: boolean;
    /** Origin only: the debugger path is not exposed to the renderer. */
    readonly endpointOrigin?: string;
  };
  readonly lastError?: {
    readonly code: string;
    readonly message: string;
  };
  readonly verification?: VerificationView;
  readonly warnings: readonly string[];
}

export interface EnvironmentMutationResult {
  readonly environment: EnvironmentView;
  /** Fields that were applied to the live browser during this edit. */
  readonly appliedFields: readonly string[];
  /** Fields that require stopping and starting the environment. */
  readonly restartFields: readonly string[];
  readonly message: string;
}

export type CapabilityState =
  "supported" | "unsupported" | "unavailable" | "not_verified";

export interface IsolationCapabilityView {
  readonly mode: IsolationMode;
  readonly state: CapabilityState;
  readonly detail: string | undefined;
}

export interface RuntimeStatusView {
  readonly available: boolean;
  readonly pipePath: string;
  readonly executablePath: string | undefined;
  readonly error:
    { readonly code: string; readonly message: string } | undefined;
  readonly platform:
    | {
        readonly os: string;
        readonly architecture: string;
        readonly elevated: boolean;
      }
    | undefined;
  readonly isolation: readonly IsolationCapabilityView[];
  readonly checkedAtUnixMs: number | undefined;
}

export interface BrowserInfo {
  readonly executablePath: string;
  readonly version: string;
  readonly source: string;
}

export interface LogEntryView {
  readonly atUnixMs: number;
  readonly level: "info" | "warn" | "error";
  readonly code: string;
  readonly message: string;
  readonly environmentId: string | undefined;
}

export interface DiagnosticsView {
  readonly environment: EnvironmentView;
  readonly runtime: RuntimeStatusView;
  readonly logs: readonly LogEntryView[];
  readonly app: AppInfoView;
}

export interface AppInfoView {
  readonly name: string;
  readonly version: string;
  readonly userDataDir: string;
  readonly dataRoot: string;
  readonly runtimeExecutable: string | undefined;
  readonly electronVersion: string;
  readonly chromeVersion: string;
}

export type ThemePreference = "dark" | "light" | "system";

/** Preferences the desktop can actually honour today. */
export interface AppSettingsView {
  readonly theme: ThemePreference;
  readonly defaultBrowserPath: string | undefined;
}

export interface ValidationIssueView {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface IpcErrorView {
  readonly code: string;
  readonly message: string;
  readonly issues?: readonly ValidationIssueView[];
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

export type IpcResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: IpcErrorView };

export const IPC_CHANNELS = {
  environmentsList: "virealm:environments:list",
  environmentsGet: "virealm:environments:get",
  environmentsCreate: "virealm:environments:create",
  environmentsUpdate: "virealm:environments:update",
  environmentsRemove: "virealm:environments:remove",
  environmentsLaunch: "virealm:environments:launch",
  environmentsStop: "virealm:environments:stop",
  environmentsVerify: "virealm:environments:verify",
  environmentsDiagnostics: "virealm:environments:diagnostics",
  browsersDiscover: "virealm:browsers:discover",
  runtimeStatus: "virealm:runtime:status",
  runtimeRestart: "virealm:runtime:restart",
  appInfo: "virealm:app:info",
  settingsGet: "virealm:settings:get",
  settingsUpdate: "virealm:settings:update",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
