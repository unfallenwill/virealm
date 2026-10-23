/** Stable environment identifier: this, never the display name, names paths. */
export const ENVIRONMENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Runtime isolation requested for the Chrome process.
 *
 * `managed` is Job Object containment, not a sandbox. The adapter never
 * downgrades a requested mode when the platform cannot provide it.
 */
export type IsolationPreference = "managed" | "restricted" | "app_container";

export interface BrowserSelection {
  /**
   * Explicit Chrome executable. When omitted the adapter uses the highest
   * version found in the standard install locations.
   */
  readonly executablePath?: string;
  /** Exact Chrome version expected at launch, e.g. `"156.0.8078.48"`. */
  readonly version?: string;
  /**
   * Override for the profile directory. When omitted the adapter allocates
   * `<dataRoot>/environments/<id>/chrome-data`.
   */
  readonly userDataDir?: string;
}

export interface ViewportConfig {
  readonly width: number;
  readonly height: number;
  /** Emulated devicePixelRatio. Only claimed when CDP reports it back. */
  readonly deviceScaleFactor?: number;
}

export interface GeolocationConfig {
  readonly latitude: number;
  readonly longitude: number;
  /** Metres. Chrome defaults to 0 when omitted. */
  readonly accuracy?: number;
}

export interface RuntimePolicyConfig {
  readonly isolation: IsolationPreference;
  readonly maxProcesses?: number;
  readonly memoryLimitBytes?: number;
}

export interface PersistenceConfig {
  /** Profiles are always persistent in this phase; `ephemeral` is rejected. */
  readonly mode: "persistent";
}

export interface LaunchSettings {
  /** URLs opened in the first page. Defaults to `about:blank`. */
  readonly initialUrls?: readonly string[];
  /** Extra Chrome switches. Security-relevant switches are rejected. */
  readonly additionalArguments?: readonly string[];
}

/**
 * Declared environment configuration. This is intent, not evidence: only the
 * resolved config and the verified report describe what Chrome actually uses.
 */
export interface BrowserEnvironmentConfig {
  readonly id: string;
  readonly name: string;
  readonly browser: BrowserSelection;
  /** BCP-47 language tag, e.g. `en-US`. */
  readonly locale?: string;
  /** IANA time zone, e.g. `Asia/Singapore`. */
  readonly timezone?: string;
  readonly viewport?: ViewportConfig;
  readonly geolocation?: GeolocationConfig;
  readonly runtimePolicy: RuntimePolicyConfig;
  readonly persistence: PersistenceConfig;
  readonly launch?: LaunchSettings;
}

/** A Chrome executable found on this machine. */
export interface DiscoveredBrowser {
  readonly executablePath: string;
  /** Version parsed from the install layout, or `"unknown"`. */
  readonly version: string;
  readonly source: string;
}

export interface ProfileLayout {
  /** Runtime data directory passed to the process runtime. */
  readonly environmentRoot: string;
  /** Value of `--user-data-dir`. Contains the persistent profile. */
  readonly userDataDir: string;
}

/** Declared configuration after paths, Chrome and locale were resolved. */
export interface ResolvedBrowserEnvironment {
  readonly config: BrowserEnvironmentConfig;
  readonly browser: DiscoveredBrowser;
  readonly profile: ProfileLayout;
  readonly canonicalLocale: string | undefined;
  readonly viewport: ViewportConfig | undefined;
  readonly geolocation: GeolocationConfig | undefined;
}
