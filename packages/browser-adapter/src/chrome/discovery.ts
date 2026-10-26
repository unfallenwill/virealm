import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { DiscoveredBrowser } from "../domain/environment.js";
import { bundleRootOf } from "../platform/paths.js";

export interface ChromeSearchRoots {
  /** Usually `%ProgramFiles%`. */
  readonly programFiles: string | undefined;
  /** Usually `%ProgramFiles(x86)%`. */
  readonly programFilesX86: string | undefined;
  /** Usually `%LOCALAPPDATA%`. */
  readonly localAppData: string | undefined;
  /** Home directory; per-user macOS install roots derive from it. */
  readonly home: string | undefined;
  /** Directories that contain `.app` bundles, e.g. `/Applications`. */
  readonly applicationsRoots: readonly string[];
}

export interface ChromeDiscoveryOptions {
  /** Explicit executable. Wins over every discovered installation. */
  readonly executablePath?: string;
  /** Additional candidate executables, e.g. Chrome for Testing. */
  readonly extraPaths?: readonly string[];
  /** Injectable roots for tests and unusual layouts. */
  readonly roots?: Partial<ChromeSearchRoots>;
  /**
   * Install layout to inspect. Defaults to the current platform so tests can
   * exercise the Windows and macOS layouts independently of the host.
   */
  readonly platform?: string;
}

const WINDOWS_VERSION_DIRECTORY = /^\d+\.\d+\.\d+\.\d+$/;
const MAC_VERSION = /^\d+(?:\.\d+){1,3}$/;

const WINDOWS_EXECUTABLE_NAMES = new Set(["chrome.exe", "chromium.exe"]);
const MAC_EXECUTABLE_NAMES = new Set([
  "Google Chrome",
  "Google Chrome Canary",
  "Google Chrome for Testing",
  "Chromium",
]);

/** Bundles found in the standard macOS application directories. */
const MAC_BUNDLES = [
  { bundle: "Google Chrome.app", executable: "Google Chrome" },
  { bundle: "Chromium.app", executable: "Chromium" },
  { bundle: "Google Chrome Canary.app", executable: "Google Chrome Canary" },
  {
    bundle: "Google Chrome for Testing.app",
    executable: "Google Chrome for Testing",
  },
] as const;

/** Search the standard per-user and machine-wide Chrome install roots. */
export function discoverBrowsers(
  options: ChromeDiscoveryOptions = {},
): readonly DiscoveredBrowser[] {
  const platform = options.platform ?? process.platform;
  const roots = resolveRoots(options.roots, platform);
  const found: DiscoveredBrowser[] = [];
  const seen = new Set<string>();

  const add = (browser: DiscoveredBrowser | undefined): void => {
    if (browser === undefined) {
      return;
    }
    const key = dedupeKey(browser.executablePath);
    if (!seen.has(key)) {
      seen.add(key);
      found.push(browser);
    }
  };

  if (options.executablePath !== undefined) {
    add(
      inspectExecutable(
        options.executablePath,
        "explicit",
        undefined,
        platform,
      ),
    );
  }
  for (const candidate of options.extraPaths ?? []) {
    add(inspectExecutable(candidate, "extra", undefined, platform));
  }

  for (const [root, source] of [
    [roots.programFiles, "program_files"],
    [roots.programFilesX86, "program_files_x86"],
    [roots.localAppData, "local_app_data"],
  ] as const) {
    if (root === undefined || root.length === 0) {
      continue;
    }
    const application = path.join(root, "Google", "Chrome", "Application");
    for (const browser of discoverInApplication(application, source)) {
      add(browser);
    }
  }

  for (const root of roots.applicationsRoots) {
    if (root.length === 0) {
      continue;
    }
    for (const browser of discoverInApplicationsRoot(root)) {
      add(browser);
    }
  }

  return found;
}

/** Standard install roots for the current process environment. */
export function defaultChromeRoots(
  platform: string = process.platform,
): ChromeSearchRoots {
  if (platform === "win32") {
    return {
      programFiles: process.env.ProgramFiles,
      programFilesX86: process.env["ProgramFiles(x86)"],
      localAppData: process.env.LOCALAPPDATA,
      home: process.env.USERPROFILE,
      applicationsRoots: [],
    };
  }

  const home = homedir();
  return {
    programFiles: undefined,
    programFilesX86: undefined,
    localAppData: undefined,
    home,
    applicationsRoots: ["/Applications", path.join(home, "Applications")],
  };
}

function resolveRoots(
  overrides: Partial<ChromeSearchRoots> | undefined,
  platform: string,
): ChromeSearchRoots {
  return { ...defaultChromeRoots(platform), ...overrides };
}

function discoverInApplication(
  application: string,
  source: string,
): DiscoveredBrowser[] {
  if (!isDirectory(application)) {
    return [];
  }

  const entries = safeReaddir(application);
  const versions = entries
    .filter((entry) => WINDOWS_VERSION_DIRECTORY.test(entry))
    .sort(compareVersionsDescending);

  const browsers: DiscoveredBrowser[] = [];
  for (const version of versions) {
    const executable = path.join(application, version, "chrome.exe");
    const inspected = inspectExecutable(executable, source, version, "win32");
    if (inspected !== undefined) {
      browsers.push(inspected);
    }
  }

  if (browsers.length === 0) {
    const fallback = inspectExecutable(
      path.join(application, "chrome.exe"),
      source,
      versions[0] ?? "unknown",
      "win32",
    );
    if (fallback !== undefined) {
      browsers.push(fallback);
    }
  }

  return browsers;
}

function discoverInApplicationsRoot(root: string): DiscoveredBrowser[] {
  if (!isDirectory(root)) {
    return [];
  }

  const browsers: DiscoveredBrowser[] = [];
  for (const { bundle, executable } of MAC_BUNDLES) {
    const inspected = inspectExecutable(
      path.join(root, bundle, "Contents", "MacOS", executable),
      "applications",
      undefined,
      "darwin",
    );
    if (inspected !== undefined) {
      browsers.push(inspected);
    }
  }
  return browsers;
}

/** Validate one candidate without assuming it exists. */
export function inspectExecutable(
  candidate: string,
  source: string,
  knownVersion?: string,
  platform: string = process.platform,
): DiscoveredBrowser | undefined {
  const executablePath = path.resolve(candidate);

  if (platform === "win32") {
    if (
      !WINDOWS_EXECUTABLE_NAMES.has(
        path.basename(executablePath).toLowerCase(),
      ) ||
      path.extname(executablePath).toLowerCase() !== ".exe"
    ) {
      return undefined;
    }
    try {
      if (!statSync(executablePath).isFile()) {
        return undefined;
      }
    } catch {
      return undefined;
    }
  } else {
    if (!MAC_EXECUTABLE_NAMES.has(path.basename(executablePath))) {
      return undefined;
    }
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(executablePath);
    } catch {
      return undefined;
    }
    // A bundle executable that is not executable cannot be launched.
    if (!stats.isFile() || (stats.mode & 0o111) === 0) {
      return undefined;
    }
  }

  return {
    executablePath,
    version:
      knownVersion ??
      (platform === "win32"
        ? versionFromInstallPath(executablePath, platform)
        : versionFromMacBundle(executablePath)) ??
      "unknown",
    source,
  };
}

/**
 * Read the Chrome version that belongs to a Windows executable.
 *
 * Older layouts put `chrome.exe` in `...\Application\<version>\`; current
 * Chrome keeps the launcher at `...\Application\chrome.exe` and the versioned
 * payload in a sibling `...\Application\<version>\` directory. Both are read
 * from the install layout, never from a running process.
 */
export function versionFromInstallPath(
  executablePath: string,
  platform: string = process.platform,
): string | undefined {
  const api = platform === "win32" ? path.win32 : path.posix;
  const directory = api.dirname(executablePath);
  const parent = api.basename(directory);
  if (WINDOWS_VERSION_DIRECTORY.test(parent)) {
    return parent;
  }

  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return undefined;
  }
  return entries
    .filter((entry) => WINDOWS_VERSION_DIRECTORY.test(entry))
    .sort(compareVersionsDescending)[0];
}

/**
 * Read the Chrome version from a macOS `.app` bundle.
 *
 * The framework's `Versions/<version>` directory is authoritative because it
 * names the payload that is actually installed. `Info.plist` is only a
 * fallback for unusual bundles that carry no framework directory.
 */
export function versionFromMacBundle(
  executablePath: string,
): string | undefined {
  const bundle = bundleRootOf(executablePath);
  if (bundle === undefined) {
    return undefined;
  }

  const frameworks = path.join(bundle, "Contents", "Frameworks");
  let best: string | undefined;
  for (const entry of safeReaddir(frameworks)) {
    if (!entry.endsWith(".framework")) {
      continue;
    }
    for (const version of safeReaddir(
      path.join(frameworks, entry, "Versions"),
    )) {
      if (
        MAC_VERSION.test(version) &&
        (best === undefined || compareVersionsDescending(version, best) < 0)
      ) {
        best = version;
      }
    }
  }
  if (best !== undefined) {
    return best;
  }

  return versionFromInfoPlist(path.join(bundle, "Contents", "Info.plist"));
}

/** Parse `CFBundleShortVersionString` from an XML property list. */
export function versionFromInfoPlist(plistPath: string): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(plistPath, "utf8");
  } catch {
    return undefined;
  }
  const match =
    /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>\s*(\d+(?:\.\d+){1,3})\s*<\/string>/.exec(
      contents,
    );
  return match?.[1];
}

export function compareVersionsDescending(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 4; index += 1) {
    const difference = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function safeReaddir(candidate: string): string[] {
  try {
    return readdirSync(candidate);
  } catch {
    return [];
  }
}

/**
 * Deduplicate installs that resolve to the same file. Symlinks are followed
 * when the platform allows it; the comparison stays case-insensitive only on
 * Windows.
 */
function dedupeKey(executablePath: string): string {
  let canonical = path.resolve(executablePath);
  try {
    canonical = realpathSync(canonical);
  } catch {
    // The candidate may already be gone; the resolved path is still unique.
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}
