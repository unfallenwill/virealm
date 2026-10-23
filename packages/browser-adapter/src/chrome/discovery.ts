import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import type { DiscoveredBrowser } from "../domain/environment.js";

export interface ChromeSearchRoots {
  /** Usually `%ProgramFiles%`. */
  readonly programFiles: string | undefined;
  /** Usually `%ProgramFiles(x86)%`. */
  readonly programFilesX86: string | undefined;
  /** Usually `%LOCALAPPDATA%`. */
  readonly localAppData: string | undefined;
}

export interface ChromeDiscoveryOptions {
  /** Explicit executable. Wins over every discovered installation. */
  readonly executablePath?: string;
  /** Additional candidate executables, e.g. Chrome for Testing. */
  readonly extraPaths?: readonly string[];
  /** Injectable roots for tests and unusual layouts. */
  readonly roots?: Partial<ChromeSearchRoots>;
}

const VERSION_DIRECTORY = /^\d+\.\d+\.\d+\.\d+$/;
const EXECUTABLE_NAMES = new Set(["chrome.exe", "chromium.exe"]);

/** Search the standard per-user and machine-wide Chrome install roots. */
export function discoverBrowsers(
  options: ChromeDiscoveryOptions = {},
): readonly DiscoveredBrowser[] {
  const roots = resolveRoots(options.roots);
  const found: DiscoveredBrowser[] = [];
  const seen = new Set<string>();

  const add = (browser: DiscoveredBrowser | undefined): void => {
    if (browser === undefined) {
      return;
    }
    const key = browser.executablePath.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      found.push(browser);
    }
  };

  if (options.executablePath !== undefined) {
    add(inspectExecutable(options.executablePath, "explicit"));
  }
  for (const candidate of options.extraPaths ?? []) {
    add(inspectExecutable(candidate, "extra"));
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

  return found;
}

/** Standard install roots for the current process environment. */
export function defaultChromeRoots(): ChromeSearchRoots {
  return {
    programFiles: process.env.ProgramFiles,
    programFilesX86: process.env["ProgramFiles(x86)"],
    localAppData: process.env.LOCALAPPDATA,
  };
}

function resolveRoots(
  overrides: Partial<ChromeSearchRoots> | undefined,
): ChromeSearchRoots {
  return { ...defaultChromeRoots(), ...overrides };
}

function discoverInApplication(
  application: string,
  source: string,
): DiscoveredBrowser[] {
  if (!existsSync(application)) {
    return [];
  }

  let entries: string[];
  try {
    entries = readdirSync(application);
  } catch {
    return [];
  }

  const versions = entries
    .filter((entry) => VERSION_DIRECTORY.test(entry))
    .sort(compareVersionsDescending);

  const browsers: DiscoveredBrowser[] = [];
  for (const version of versions) {
    const executable = path.join(application, version, "chrome.exe");
    const inspected = inspectExecutable(executable, source, version);
    if (inspected !== undefined) {
      browsers.push(inspected);
    }
  }

  if (browsers.length === 0) {
    const fallback = inspectExecutable(
      path.join(application, "chrome.exe"),
      source,
      versions[0] ?? "unknown",
    );
    if (fallback !== undefined) {
      browsers.push(fallback);
    }
  }

  return browsers;
}

/** Validate one candidate without assuming it exists. */
export function inspectExecutable(
  candidate: string,
  source: string,
  knownVersion?: string,
): DiscoveredBrowser | undefined {
  const executablePath = path.resolve(candidate);
  if (
    !EXECUTABLE_NAMES.has(path.basename(executablePath).toLowerCase()) ||
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

  return {
    executablePath,
    version:
      knownVersion ?? versionFromInstallPath(executablePath) ?? "unknown",
    source,
  };
}

/**
 * Read the Chrome version that belongs to an executable.
 *
 * Older layouts put `chrome.exe` in `...\Application\<version>\`; current
 * Chrome keeps the launcher at `...\Application\chrome.exe` and the versioned
 * payload in a sibling `...\Application\<version>\` directory. Both are read
 * from the install layout, never from a running process.
 */
export function versionFromInstallPath(
  executablePath: string,
): string | undefined {
  const directory = path.dirname(executablePath);
  const parent = path.basename(directory);
  if (VERSION_DIRECTORY.test(parent)) {
    return parent;
  }

  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return undefined;
  }
  return entries
    .filter((entry) => VERSION_DIRECTORY.test(entry))
    .sort(compareVersionsDescending)[0];
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
