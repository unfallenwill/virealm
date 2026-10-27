import path from "node:path";

import type { ChromeDiscoveryPort } from "../application/ports.js";
import {
  ENVIRONMENT_ID_PATTERN,
  type BrowserEnvironmentConfig,
  type BrowserSelection,
  type DiscoveredBrowser,
  type GeolocationConfig,
  type LaunchSettings,
  type PersistenceConfig,
  type RuntimePolicyConfig,
  type ViewportConfig,
} from "../domain/environment.js";
import type {
  EnvironmentValidationIssue,
  EnvironmentValidationResult,
} from "../domain/status.js";
import { unsafeArgumentReason } from "../chrome/launch-options.js";
import {
  isDefaultChromeProfilePath,
  resolveProfileLayout,
} from "../chrome/profile.js";
import { isNavigableUrl } from "../domain/urls.js";
import { pathKey } from "../platform/paths.js";

export interface ValidationContext {
  readonly dataRoot: string;
  readonly discovery: ChromeDiscoveryPort;
  /** Windows: usually `%LOCALAPPDATA%`. */
  readonly localAppData: string | undefined;
  /** macOS: home directory whose Chrome profile roots must be refused. */
  readonly homeDirectory?: string | undefined;
  /** Path semantics used for comparisons. Defaults to the host platform. */
  readonly platform?: string | undefined;
}

const TOP_LEVEL_FIELDS = new Set([
  "id",
  "name",
  "browser",
  "locale",
  "timezone",
  "viewport",
  "geolocation",
  "runtimePolicy",
  "persistence",
  "launch",
]);
const BROWSER_FIELDS = new Set(["executablePath", "version", "userDataDir"]);
const VIEWPORT_FIELDS = new Set(["width", "height", "deviceScaleFactor"]);
const GEOLOCATION_FIELDS = new Set(["latitude", "longitude", "accuracy"]);
const RUNTIME_POLICY_FIELDS = new Set([
  "isolation",
  "maxProcesses",
  "memoryLimitBytes",
]);
const PERSISTENCE_FIELDS = new Set(["mode"]);
const LAUNCH_FIELDS = new Set(["initialUrls", "additionalArguments"]);

/**
 * Validate declared configuration before any process exists.
 *
 * Returns issues rather than throwing so a caller can present every problem at
 * once. `resolved` is present only when the whole configuration is usable.
 */
export function validateEnvironment(
  input: unknown,
  context: ValidationContext,
): EnvironmentValidationResult {
  const issues: EnvironmentValidationIssue[] = [];
  const add = (pathName: string, code: string, message: string): void => {
    issues.push({ path: pathName, code, message });
  };

  if (!isRecord(input)) {
    return {
      valid: false,
      issues: [
        {
          path: "/",
          code: "invalid_type",
          message: "environment configuration must be an object",
        },
      ],
      resolved: undefined,
    };
  }

  reportUnknownFields(input, TOP_LEVEL_FIELDS, "", add);

  const id = readString(input, "id");
  if (id === undefined || id.length === 0) {
    add("id", "required", "environment id is required");
  } else if (!ENVIRONMENT_ID_PATTERN.test(id)) {
    add(
      "id",
      "invalid_value",
      "environment id must match [a-z0-9][a-z0-9_-]{0,63}",
    );
  }

  const name = readString(input, "name");
  if (name === undefined || name.trim().length === 0) {
    add("name", "required", "environment name is required");
  } else if (name.trim().length > 128) {
    add("name", "invalid_value", "environment name is at most 128 characters");
    // eslint-disable-next-line no-control-regex
  } else if (/[\u0000-\u001f\u007f]/.test(name)) {
    add(
      "name",
      "invalid_value",
      "environment name contains control characters",
    );
  }

  const browser = parseBrowser(input.browser, add);
  const runtimePolicy = parseRuntimePolicy(input.runtimePolicy, add);
  const persistence = parsePersistence(input.persistence, add);
  const locale = parseLocale(input.locale, add);
  const timezone = parseTimezone(input.timezone, add);
  const viewport = parseViewport(input.viewport, add);
  const geolocation = parseGeolocation(input.geolocation, add);
  const launch = parseLaunch(input.launch, add);

  if (!path.isAbsolute(context.dataRoot)) {
    add("dataRoot", "invalid_path", "the Virealm data root must be absolute");
  }

  let profile:
    | {
        environmentRoot: string;
        userDataDir: string;
      }
    | undefined;
  if (id !== undefined && ENVIRONMENT_ID_PATTERN.test(id)) {
    try {
      profile = resolveProfileLayout(context.dataRoot, id, browser.userDataDir);
    } catch (error) {
      add(
        "browser.userDataDir",
        "invalid_path",
        error instanceof Error
          ? error.message
          : "invalid Chrome data directory",
      );
    }
  }

  if (
    browser.userDataDir !== undefined &&
    isDefaultChromeProfilePath(browser.userDataDir, {
      localAppData: context.localAppData,
      homeDirectory: context.homeDirectory,
      platform: context.platform,
    })
  ) {
    add(
      "browser.userDataDir",
      "invalid_path",
      "Chrome's default profile directory cannot be used for remote debugging",
    );
  }

  const discovered = context.discovery.discover(browser.executablePath);
  const selected = selectBrowser(discovered, browser, context.platform);
  if (browser.executablePath !== undefined && selected === undefined) {
    add(
      "browser.executablePath",
      "chrome_not_found",
      "the configured Chrome executable does not exist or is not a Chrome executable",
    );
  } else if (browser.executablePath === undefined && selected === undefined) {
    add(
      "browser.executablePath",
      "chrome_not_found",
      "no Chrome installation was found in the standard locations",
    );
  }

  if (
    selected !== undefined &&
    browser.version !== undefined &&
    selected.version !== browser.version
  ) {
    add(
      "browser.version",
      "chrome_incompatible",
      `expected Chrome ${browser.version}, found ${selected.version}`,
    );
  }

  if (
    selected !== undefined &&
    browser.version !== undefined &&
    selected.version === "unknown"
  ) {
    add(
      "browser.version",
      "chrome_incompatible",
      "the Chrome version could not be determined from this executable",
    );
  }

  if (
    issues.length > 0 ||
    selected === undefined ||
    profile === undefined ||
    id === undefined ||
    name === undefined
  ) {
    return { valid: false, issues, resolved: undefined };
  }

  const config: BrowserEnvironmentConfig = {
    id,
    name,
    browser,
    runtimePolicy,
    persistence,
    ...(locale === undefined ? {} : { locale }),
    ...(timezone === undefined ? {} : { timezone }),
    ...(viewport === undefined ? {} : { viewport }),
    ...(geolocation === undefined ? {} : { geolocation }),
    ...(launch === undefined ? {} : { launch }),
  };

  return {
    valid: true,
    issues,
    resolved: {
      config,
      browser: selected,
      profile,
      canonicalLocale:
        locale === undefined ? undefined : canonicalLocale(locale),
      viewport,
      geolocation,
    },
  };
}

function selectBrowser(
  discovered: readonly DiscoveredBrowser[],
  browser: BrowserSelection,
  platform: string | undefined,
): DiscoveredBrowser | undefined {
  if (browser.executablePath !== undefined) {
    const expected = pathKey(browser.executablePath, platform);
    return discovered.find(
      (candidate) => pathKey(candidate.executablePath, platform) === expected,
    );
  }
  return discovered[0];
}

function parseBrowser(
  value: unknown,
  add: (path: string, code: string, message: string) => void,
): BrowserSelection {
  if (value === undefined) {
    add("browser", "required", "browser configuration is required");
    return {};
  }
  if (!isRecord(value)) {
    add("browser", "invalid_type", "browser configuration must be an object");
    return {};
  }
  reportUnknownFields(value, BROWSER_FIELDS, "browser", add);

  const executablePath = optionalString(
    value,
    "executablePath",
    "browser",
    add,
    true,
  );
  const version = optionalString(value, "version", "browser", add, false);
  const userDataDir = optionalString(
    value,
    "userDataDir",
    "browser",
    add,
    true,
  );

  return {
    ...(executablePath === undefined ? {} : { executablePath }),
    ...(version === undefined ? {} : { version }),
    ...(userDataDir === undefined ? {} : { userDataDir }),
  };
}

function parseRuntimePolicy(
  value: unknown,
  add: (path: string, code: string, message: string) => void,
): RuntimePolicyConfig {
  if (!isRecord(value)) {
    add(
      "runtimePolicy",
      "required",
      "runtimePolicy with an isolation mode is required",
    );
    return { isolation: "managed" };
  }
  reportUnknownFields(value, RUNTIME_POLICY_FIELDS, "runtimePolicy", add);

  const isolation = value.isolation;
  if (
    isolation !== "managed" &&
    isolation !== "restricted" &&
    isolation !== "app_container"
  ) {
    add(
      "runtimePolicy.isolation",
      "invalid_value",
      "isolation must be managed, restricted or app_container",
    );
  }

  const maxProcesses = optionalPositiveInteger(
    value,
    "maxProcesses",
    "runtimePolicy",
    add,
  );
  const memoryLimitBytes = optionalPositiveInteger(
    value,
    "memoryLimitBytes",
    "runtimePolicy",
    add,
  );

  return {
    isolation:
      isolation === "restricted" || isolation === "app_container"
        ? isolation
        : "managed",
    ...(maxProcesses === undefined ? {} : { maxProcesses }),
    ...(memoryLimitBytes === undefined ? {} : { memoryLimitBytes }),
  };
}

function parsePersistence(
  value: unknown,
  add: (path: string, code: string, message: string) => void,
): PersistenceConfig {
  if (!isRecord(value)) {
    add("persistence", "required", "persistence configuration is required");
    return { mode: "persistent" };
  }
  reportUnknownFields(value, PERSISTENCE_FIELDS, "persistence", add);
  if (value.mode !== "persistent") {
    add(
      "persistence.mode",
      "unsupported",
      "only persistent profiles are supported in this phase",
    );
  }
  return { mode: "persistent" };
}

function parseLocale(
  value: unknown,
  add: (path: string, code: string, message: string) => void,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    add("locale", "invalid_type", "locale must be a non-empty BCP-47 tag");
    return undefined;
  }
  const candidate = value.trim();
  try {
    Intl.getCanonicalLocales(candidate);
  } catch {
    add(
      "locale",
      "invalid_value",
      `"${candidate}" is not a valid BCP-47 locale`,
    );
    return undefined;
  }
  return candidate;
}

function canonicalLocale(value: string): string {
  return Intl.getCanonicalLocales(value)[0] ?? value;
}

function parseTimezone(
  value: unknown,
  add: (path: string, code: string, message: string) => void,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    add("timezone", "invalid_type", "timezone must be a non-empty IANA name");
    return undefined;
  }
  const candidate = value.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
  } catch {
    add(
      "timezone",
      "invalid_value",
      `"${candidate}" is not an IANA time zone this platform recognises`,
    );
    return undefined;
  }
  return candidate;
}

function parseViewport(
  value: unknown,
  add: (path: string, code: string, message: string) => void,
): ViewportConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    add("viewport", "invalid_type", "viewport must be an object");
    return undefined;
  }
  reportUnknownFields(value, VIEWPORT_FIELDS, "viewport", add);

  const width = value.width;
  const height = value.height;
  if (!isIntegerInRange(width, 320, 7_680)) {
    add("viewport.width", "invalid_value", "viewport width must be 320..7680");
  }
  if (!isIntegerInRange(height, 240, 4_320)) {
    add(
      "viewport.height",
      "invalid_value",
      "viewport height must be 240..4320",
    );
  }
  const deviceScaleFactor = value.deviceScaleFactor;
  if (
    deviceScaleFactor !== undefined &&
    (typeof deviceScaleFactor !== "number" ||
      !Number.isFinite(deviceScaleFactor) ||
      deviceScaleFactor < 0.5 ||
      deviceScaleFactor > 4)
  ) {
    add(
      "viewport.deviceScaleFactor",
      "invalid_value",
      "deviceScaleFactor must be between 0.5 and 4",
    );
  }

  if (
    !isIntegerInRange(width, 320, 7_680) ||
    !isIntegerInRange(height, 240, 4_320)
  ) {
    return undefined;
  }

  return {
    width,
    height,
    ...(typeof deviceScaleFactor === "number" ? { deviceScaleFactor } : {}),
  };
}

function parseGeolocation(
  value: unknown,
  add: (path: string, code: string, message: string) => void,
): GeolocationConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    add("geolocation", "invalid_type", "geolocation must be an object");
    return undefined;
  }
  reportUnknownFields(value, GEOLOCATION_FIELDS, "geolocation", add);

  const latitude = value.latitude;
  const longitude = value.longitude;
  const accuracy = value.accuracy;
  if (typeof latitude !== "number" || latitude < -90 || latitude > 90) {
    add("geolocation.latitude", "invalid_value", "latitude must be -90..90");
  }
  if (typeof longitude !== "number" || longitude < -180 || longitude > 180) {
    add(
      "geolocation.longitude",
      "invalid_value",
      "longitude must be -180..180",
    );
  }
  if (
    accuracy !== undefined &&
    (typeof accuracy !== "number" ||
      !Number.isFinite(accuracy) ||
      accuracy < 0 ||
      accuracy > 100_000)
  ) {
    add("geolocation.accuracy", "invalid_value", "accuracy must be 0..100000");
  }

  if (
    typeof latitude !== "number" ||
    latitude < -90 ||
    latitude > 90 ||
    typeof longitude !== "number" ||
    longitude < -180 ||
    longitude > 180
  ) {
    return undefined;
  }

  return {
    latitude,
    longitude,
    ...(typeof accuracy === "number" ? { accuracy } : {}),
  };
}

function parseLaunch(
  value: unknown,
  add: (path: string, code: string, message: string) => void,
): LaunchSettings | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    add("launch", "invalid_type", "launch settings must be an object");
    return undefined;
  }
  reportUnknownFields(value, LAUNCH_FIELDS, "launch", add);

  const initialUrls = optionalStringArray(
    value,
    "initialUrls",
    "launch",
    add,
    8,
  );
  if (initialUrls !== undefined) {
    for (const [index, url] of initialUrls.entries()) {
      if (!isNavigableUrl(url)) {
        add(
          `launch.initialUrls.${String(index)}`,
          "invalid_value",
          "start URLs must use http, https or about",
        );
      }
    }
  }

  const additionalArguments = optionalStringArray(
    value,
    "additionalArguments",
    "launch",
    add,
    64,
  );
  if (additionalArguments !== undefined) {
    for (const [index, argument] of additionalArguments.entries()) {
      const reason = unsafeArgumentReason(argument);
      if (reason !== undefined) {
        add(
          `launch.additionalArguments.${String(index)}`,
          "invalid_value",
          `refusing Chrome argument: ${reason}`,
        );
      }
    }
  }

  if (initialUrls === undefined && additionalArguments === undefined) {
    return undefined;
  }
  return {
    ...(initialUrls === undefined ? {} : { initialUrls }),
    ...(additionalArguments === undefined ? {} : { additionalArguments }),
  };
}

function reportUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  prefix: string,
  add: (path: string, code: string, message: string) => void,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      add(
        prefix.length === 0 ? key : `${prefix}.${key}`,
        "unknown_field",
        `unknown configuration field "${key}"`,
      );
    }
  }
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  prefix: string,
  add: (path: string, code: string, message: string) => void,
  requireAbsolute: boolean,
): string | undefined {
  const candidate = value[key];
  if (candidate === undefined) {
    return undefined;
  }
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    add(
      `${prefix}.${key}`,
      "invalid_type",
      `${key} must be a non-empty string`,
    );
    return undefined;
  }
  if (requireAbsolute && !path.isAbsolute(candidate)) {
    add(`${prefix}.${key}`, "invalid_path", `${key} must be an absolute path`);
    return undefined;
  }
  return candidate;
}

function optionalStringArray(
  value: Record<string, unknown>,
  key: string,
  prefix: string,
  add: (path: string, code: string, message: string) => void,
  maxItems: number,
): string[] | undefined {
  const candidate = value[key];
  if (candidate === undefined) {
    return undefined;
  }
  if (!Array.isArray(candidate)) {
    add(`${prefix}.${key}`, "invalid_type", `${key} must be an array`);
    return undefined;
  }
  if (candidate.length > maxItems) {
    add(
      `${prefix}.${key}`,
      "invalid_value",
      `${key} accepts at most ${String(maxItems)} entries`,
    );
    return undefined;
  }
  if (candidate.some((entry) => typeof entry !== "string")) {
    add(`${prefix}.${key}`, "invalid_type", `${key} entries must be strings`);
    return undefined;
  }
  return candidate as string[];
}

function optionalPositiveInteger(
  value: Record<string, unknown>,
  key: string,
  prefix: string,
  add: (path: string, code: string, message: string) => void,
): number | undefined {
  const candidate = value[key];
  if (candidate === undefined) {
    return undefined;
  }
  if (
    typeof candidate !== "number" ||
    !Number.isInteger(candidate) ||
    candidate <= 0
  ) {
    add(
      `${prefix}.${key}`,
      "invalid_value",
      `${key} must be a positive integer`,
    );
    return undefined;
  }
  return candidate;
}

function readString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}
