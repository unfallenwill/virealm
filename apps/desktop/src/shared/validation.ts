/**
 * Runtime validation for everything the renderer sends across the IPC
 * boundary. These checks are deliberately independent of Electron and of the
 * browser adapter: they reject malformed shapes before any privileged code
 * runs, while the adapter remains the authority on browser semantics.
 */
import {
  ENVIRONMENT_ID_PATTERN,
  type BrowserDraft,
  type EnvironmentDraft,
  type GeolocationDraft,
  type IsolationMode,
  type LaunchDraft,
  type RuntimePolicyDraft,
  type ThemePreference,
  type ViewportDraft,
} from "./contracts.js";

export interface ValidationIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

const DRAFT_FIELDS = new Set([
  "name",
  "browser",
  "timezone",
  "locale",
  "viewport",
  "geolocation",
  "runtimePolicy",
  "launch",
]);
const BROWSER_FIELDS = new Set(["executablePath"]);
const VIEWPORT_FIELDS = new Set(["width", "height", "deviceScaleFactor"]);
const GEOLOCATION_FIELDS = new Set(["latitude", "longitude", "accuracy"]);
const POLICY_FIELDS = new Set([
  "isolation",
  "maxProcesses",
  "memoryLimitBytes",
]);
const LAUNCH_FIELDS = new Set(["additionalArguments"]);
const STOP_FIELDS = new Set(["force"]);
const REMOVE_FIELDS = new Set(["deleteData"]);
const ISOLATION_MODES: ReadonlySet<string> = new Set([
  "managed",
  "restricted",
  "app_container",
]);
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}
const MAX_ARGUMENTS = 32;
const MAX_ARGUMENT_LENGTH = 512;
const MIN_MEMORY = 16 * 1024 * 1024;
const MAX_MEMORY = 64 * 1024 * 1024 * 1024;

class Issues {
  readonly items: ValidationIssue[] = [];

  add(path: string, code: string, message: string): void {
    this.items.push({ path, code, message });
  }

  unknownFields(
    value: Record<string, unknown>,
    allowed: ReadonlySet<string>,
    prefix: string,
  ): void {
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        this.add(`${prefix}${key}`, "unknown_field", "unknown field");
      }
    }
  }
}

export function parseEnvironmentId(input: unknown): ParseResult<string> {
  if (typeof input !== "string" || !ENVIRONMENT_ID_PATTERN.test(input)) {
    return {
      ok: false,
      issues: [
        {
          path: "id",
          code: "invalid_value",
          message: "environment id has an invalid format",
        },
      ],
    };
  }
  return { ok: true, value: input };
}

export function parseEnvironmentDraft(
  input: unknown,
): ParseResult<EnvironmentDraft> {
  const issues = new Issues();
  if (!isRecord(input)) {
    return invalid("draft", "invalid_type", "draft must be an object");
  }
  issues.unknownFields(input, DRAFT_FIELDS, "");

  const name = parseName(input.name, issues);
  const browser = parseBrowser(input.browser, issues);
  const timezone = optionalString(input, "timezone", issues, (value) =>
    isValidTimeZone(value)
      ? undefined
      : { code: "invalid_value", message: "timezone is not a known IANA zone" },
  );
  const locale = optionalString(input, "locale", issues, (value) =>
    isValidLocale(value)
      ? undefined
      : { code: "invalid_value", message: "locale is not a valid BCP-47 tag" },
  );
  const viewport = parseViewport(input.viewport, issues);
  const geolocation = parseGeolocation(input.geolocation, issues);
  const runtimePolicy = parseRuntimePolicy(input.runtimePolicy, issues);
  const launch = parseLaunch(input.launch, issues);

  if (issues.items.length === 0) {
    if (
      name !== undefined &&
      browser !== undefined &&
      runtimePolicy !== undefined
    ) {
      return {
        ok: true,
        value: {
          name,
          browser,
          runtimePolicy,
          ...(timezone === undefined ? {} : { timezone }),
          ...(locale === undefined ? {} : { locale }),
          ...(viewport === undefined ? {} : { viewport }),
          ...(geolocation === undefined ? {} : { geolocation }),
          ...(launch === undefined ? {} : { launch }),
        },
      };
    }
    issues.add("draft", "invalid_value", "draft is incomplete");
  }

  return { ok: false, issues: issues.items };
}

const SETTINGS_FIELDS = new Set(["theme", "defaultBrowserPath"]);
const THEMES: ReadonlySet<string> = new Set(["dark", "light", "system"]);

export interface SettingsPatch {
  readonly theme?: ThemePreference;
  readonly defaultBrowserPath?: string | undefined;
}

export function parseSettingsPatch(input: unknown): ParseResult<SettingsPatch> {
  if (!isRecord(input)) {
    return invalid("settings", "invalid_type", "settings must be an object");
  }
  const issues = new Issues();
  issues.unknownFields(input, SETTINGS_FIELDS, "");
  const theme = input.theme;
  if (
    theme !== undefined &&
    (typeof theme !== "string" || !THEMES.has(theme))
  ) {
    issues.add("theme", "invalid_value", "theme must be dark, light or system");
  }
  let defaultBrowserPath: string | undefined;
  if ("defaultBrowserPath" in input) {
    const value = input.defaultBrowserPath;
    if (value !== undefined) {
      if (
        typeof value !== "string" ||
        value.trim().length === 0 ||
        value.length > 4096 ||
        hasControlCharacters(value)
      ) {
        issues.add(
          "defaultBrowserPath",
          "invalid_value",
          "defaultBrowserPath must be a path string or undefined",
        );
      } else {
        defaultBrowserPath = value.trim();
      }
    }
  }
  if (issues.items.length > 0) {
    return { ok: false, issues: issues.items };
  }
  return {
    ok: true,
    value: {
      ...(theme === undefined ? {} : { theme: theme as ThemePreference }),
      ...("defaultBrowserPath" in input ? { defaultBrowserPath } : {}),
    },
  };
}

export interface UpdateRequest {
  readonly id: string;
  readonly draft: EnvironmentDraft;
}

/** `{ id, draft }` used by the update channel. */
export function parseUpdateRequest(input: unknown): ParseResult<UpdateRequest> {
  if (!isRecord(input)) {
    return invalid(
      "request",
      "invalid_type",
      "update request must be an object",
    );
  }
  const issues = new Issues();
  issues.unknownFields(input, new Set(["id", "draft"]), "");
  const id = parseEnvironmentId(input.id);
  if (!id.ok) {
    issues.items.push(...id.issues);
  }
  const draft = parseEnvironmentDraft(input.draft);
  if (!draft.ok) {
    issues.items.push(...draft.issues);
  }
  if (!issues.items.length && id.ok && draft.ok) {
    return { ok: true, value: { id: id.value, draft: draft.value } };
  }
  return { ok: false, issues: issues.items };
}

export interface StopRequest {
  readonly force: boolean;
}

export function parseStopRequest(input: unknown): ParseResult<StopRequest> {
  if (input === undefined) {
    return { ok: true, value: { force: false } };
  }
  if (!isRecord(input)) {
    return invalid("options", "invalid_type", "stop options must be an object");
  }
  const issues = new Issues();
  issues.unknownFields(input, STOP_FIELDS, "options.");
  const force = input.force;
  if (force !== undefined && typeof force !== "boolean") {
    issues.add("options.force", "invalid_type", "force must be a boolean");
  }
  if (issues.items.length) {
    return { ok: false, issues: issues.items };
  }
  return { ok: true, value: { force: force === true } };
}

export interface RemoveRequest {
  readonly deleteData: boolean;
}

export function parseRemoveRequest(input: unknown): ParseResult<RemoveRequest> {
  if (input === undefined) {
    return { ok: true, value: { deleteData: false } };
  }
  if (!isRecord(input)) {
    return invalid(
      "options",
      "invalid_type",
      "remove options must be an object",
    );
  }
  const issues = new Issues();
  issues.unknownFields(input, REMOVE_FIELDS, "options.");
  const deleteData = input.deleteData;
  if (deleteData !== undefined && typeof deleteData !== "boolean") {
    issues.add(
      "options.deleteData",
      "invalid_type",
      "deleteData must be a boolean",
    );
  }
  if (issues.items.length) {
    return { ok: false, issues: issues.items };
  }
  return { ok: true, value: { deleteData: deleteData === true } };
}

function parseName(value: unknown, issues: Issues): string | undefined {
  if (typeof value !== "string") {
    issues.add("name", "required", "name is required");
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    issues.add("name", "required", "name must not be empty");
    return undefined;
  }
  if (trimmed.length > 128) {
    issues.add("name", "invalid_value", "name is at most 128 characters");
  }
  if (hasControlCharacters(trimmed)) {
    issues.add(
      "name",
      "invalid_value",
      "name must not contain control characters",
    );
  }
  return trimmed;
}

function parseBrowser(
  value: unknown,
  issues: Issues,
): BrowserDraft | undefined {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    issues.add("browser", "invalid_type", "browser must be an object");
    return undefined;
  }
  issues.unknownFields(value, BROWSER_FIELDS, "browser.");
  const executablePath = value.executablePath;
  if (executablePath === undefined) {
    return {};
  }
  if (
    typeof executablePath !== "string" ||
    executablePath.trim().length === 0
  ) {
    issues.add(
      "browser.executablePath",
      "invalid_type",
      "executablePath must be a non-empty string",
    );
    return undefined;
  }
  if (executablePath.length > 4096 || hasControlCharacters(executablePath)) {
    issues.add(
      "browser.executablePath",
      "invalid_value",
      "executablePath is not a valid path string",
    );
    return undefined;
  }
  return { executablePath: executablePath.trim() };
}

function parseViewport(
  value: unknown,
  issues: Issues,
): ViewportDraft | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    issues.add("viewport", "invalid_type", "viewport must be an object");
    return undefined;
  }
  issues.unknownFields(value, VIEWPORT_FIELDS, "viewport.");
  const width = integerInRange(value.width, 320, 7680);
  const height = integerInRange(value.height, 200, 4320);
  if (width === undefined) {
    issues.add(
      "viewport.width",
      "invalid_value",
      "viewport width must be an integer between 320 and 7680",
    );
  }
  if (height === undefined) {
    issues.add(
      "viewport.height",
      "invalid_value",
      "viewport height must be an integer between 200 and 4320",
    );
  }
  let deviceScaleFactor: number | undefined;
  if (value.deviceScaleFactor !== undefined) {
    const scale = value.deviceScaleFactor;
    if (
      typeof scale !== "number" ||
      !Number.isFinite(scale) ||
      scale < 0.5 ||
      scale > 4
    ) {
      issues.add(
        "viewport.deviceScaleFactor",
        "invalid_value",
        "deviceScaleFactor must be between 0.5 and 4",
      );
    } else {
      deviceScaleFactor = scale;
    }
  }
  if (width === undefined || height === undefined) {
    return undefined;
  }
  return {
    width,
    height,
    ...(deviceScaleFactor === undefined ? {} : { deviceScaleFactor }),
  };
}

function parseGeolocation(
  value: unknown,
  issues: Issues,
): GeolocationDraft | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    issues.add("geolocation", "invalid_type", "geolocation must be an object");
    return undefined;
  }
  issues.unknownFields(value, GEOLOCATION_FIELDS, "geolocation.");
  const latitude = finiteInRange(value.latitude, -90, 90);
  const longitude = finiteInRange(value.longitude, -180, 180);
  if (latitude === undefined) {
    issues.add(
      "geolocation.latitude",
      "invalid_value",
      "latitude must be between -90 and 90",
    );
  }
  if (longitude === undefined) {
    issues.add(
      "geolocation.longitude",
      "invalid_value",
      "longitude must be between -180 and 180",
    );
  }
  let accuracy: number | undefined;
  if (value.accuracy !== undefined) {
    const parsed = finiteInRange(value.accuracy, 0, 100_000);
    if (parsed === undefined) {
      issues.add(
        "geolocation.accuracy",
        "invalid_value",
        "accuracy must be between 0 and 100000 metres",
      );
    } else {
      accuracy = parsed;
    }
  }
  if (latitude === undefined || longitude === undefined) {
    return undefined;
  }
  return {
    latitude,
    longitude,
    ...(accuracy === undefined ? {} : { accuracy }),
  };
}

function parseRuntimePolicy(
  value: unknown,
  issues: Issues,
): RuntimePolicyDraft | undefined {
  const before = issues.items.length;
  if (value === undefined) {
    issues.add("runtimePolicy", "required", "runtimePolicy is required");
    return undefined;
  }
  if (!isRecord(value)) {
    issues.add(
      "runtimePolicy",
      "invalid_type",
      "runtimePolicy must be an object",
    );
    return undefined;
  }
  issues.unknownFields(value, POLICY_FIELDS, "runtimePolicy.");
  const isolation = value.isolation;
  if (typeof isolation !== "string" || !ISOLATION_MODES.has(isolation)) {
    issues.add(
      "runtimePolicy.isolation",
      "invalid_value",
      "isolation must be managed, restricted or app_container",
    );
    return undefined;
  }
  const maxProcesses =
    value.maxProcesses === undefined
      ? undefined
      : integerInRange(value.maxProcesses, 1, 512);
  if (value.maxProcesses !== undefined && maxProcesses === undefined) {
    issues.add(
      "runtimePolicy.maxProcesses",
      "invalid_value",
      "maxProcesses must be an integer between 1 and 512",
    );
  }
  const memoryLimitBytes =
    value.memoryLimitBytes === undefined
      ? undefined
      : integerInRange(value.memoryLimitBytes, MIN_MEMORY, MAX_MEMORY);
  if (value.memoryLimitBytes !== undefined && memoryLimitBytes === undefined) {
    issues.add(
      "runtimePolicy.memoryLimitBytes",
      "invalid_value",
      "memoryLimitBytes must be between 16 MiB and 64 GiB",
    );
  }
  if (issues.items.length > before) {
    return undefined;
  }
  return {
    isolation: isolation as IsolationMode,
    ...(maxProcesses === undefined ? {} : { maxProcesses }),
    ...(memoryLimitBytes === undefined ? {} : { memoryLimitBytes }),
  };
}

function parseLaunch(value: unknown, issues: Issues): LaunchDraft | undefined {
  const before = issues.items.length;
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    issues.add("launch", "invalid_type", "launch must be an object");
    return undefined;
  }
  issues.unknownFields(value, LAUNCH_FIELDS, "launch.");
  const raw = value.additionalArguments;
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    issues.add(
      "launch.additionalArguments",
      "invalid_type",
      "additionalArguments must be an array",
    );
    return undefined;
  }
  if (raw.length > MAX_ARGUMENTS) {
    issues.add(
      "launch.additionalArguments",
      "invalid_value",
      `at most ${String(MAX_ARGUMENTS)} extra arguments are allowed`,
    );
    return undefined;
  }
  const argumentsList: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const path = `launch.additionalArguments.${String(index)}`;
    if (typeof entry !== "string") {
      issues.add(path, "invalid_type", "each argument must be a string");
      continue;
    }
    if (
      entry.length === 0 ||
      entry.length > MAX_ARGUMENT_LENGTH ||
      hasControlCharacters(entry)
    ) {
      issues.add(path, "invalid_value", "argument is not a valid switch");
      continue;
    }
    if (!entry.startsWith("--")) {
      issues.add(path, "invalid_value", "argument must start with --");
      continue;
    }
    if (seen.has(entry)) {
      issues.add(path, "duplicate", "argument is repeated");
      continue;
    }
    seen.add(entry);
    argumentsList.push(entry);
  }
  if (issues.items.length > before) {
    return undefined;
  }
  return argumentsList.length ? { additionalArguments: argumentsList } : {};
}

function optionalString(
  source: Record<string, unknown>,
  key: string,
  issues: Issues,
  check: (
    value: string,
  ) => { readonly code: string; readonly message: string } | undefined,
): string | undefined {
  const value = source[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.add(key, "invalid_type", `${key} must be a non-empty string`);
    return undefined;
  }
  if (value.length > 128 || hasControlCharacters(value)) {
    issues.add(key, "invalid_value", `${key} is not a valid string`);
    return undefined;
  }
  const problem = check(value);
  if (problem !== undefined) {
    issues.add(key, problem.code, problem.message);
    return undefined;
  }
  return value;
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function isValidLocale(value: string): boolean {
  try {
    const canonical = Intl.getCanonicalLocales(value);
    return canonical.length === 1;
  } catch {
    return false;
  }
}

function integerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return undefined;
  }
  return value;
}

function finiteInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    return undefined;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid<T>(
  path: string,
  code: string,
  message: string,
): ParseResult<T> {
  return { ok: false, issues: [{ path, code, message }] };
}
