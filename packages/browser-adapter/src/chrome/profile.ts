import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { BrowserAdapterError } from "../domain/errors.js";
import type { ProfileLayout } from "../domain/environment.js";

const PROFILE_MARKER = "virealm-profile.json";
const MARKER_VERSION = 1;

export interface ProfileMarker {
  readonly version: number;
  readonly environmentId: string;
  readonly createdAtUnixMs: number;
}

/**
 * Resolve the profile layout. Names never participate: only the validated
 * environment id names directories, so a display-name change cannot move data.
 */
export function resolveProfileLayout(
  dataRoot: string,
  environmentId: string,
  override: string | undefined,
): ProfileLayout {
  const root = path.resolve(dataRoot);
  const environmentRoot = path.join(root, "environments", environmentId);
  const userDataDir =
    override === undefined
      ? path.join(environmentRoot, "chrome-data")
      : path.resolve(override);

  if (!isPathInside(root, userDataDir)) {
    throw new BrowserAdapterError(
      "invalid_configuration",
      "the Chrome data directory must be inside the Virealm data root",
      { path: "browser.userDataDir", userDataDir, dataRoot: root },
    );
  }

  return { environmentRoot, userDataDir };
}

/** True when `candidate` is `parent` or lives below it (case-insensitive). */
export function isPathInside(parent: string, candidate: string): boolean {
  const normalizedParent = path.resolve(parent).toLowerCase();
  const normalizedCandidate = path.resolve(candidate).toLowerCase();
  const relative = path.relative(normalizedParent, normalizedCandidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/** Reject Chrome's own default profile roots. */
export function isDefaultChromeProfilePath(
  candidate: string,
  localAppData: string | undefined,
): boolean {
  if (localAppData === undefined) {
    return false;
  }
  const defaults = [
    path.join(localAppData, "Google", "Chrome", "User Data"),
    path.join(localAppData, "Chromium", "User Data"),
  ];
  return defaults.some((root) => isPathInside(root, candidate));
}

/**
 * Create or adopt the profile directory.
 *
 * An existing non-empty directory without a Virealm marker is treated as
 * foreign data and refused rather than adopted or cleared. Nothing in an
 * existing profile is ever deleted here.
 */
export function prepareProfile(
  layout: ProfileLayout,
  environmentId: string,
  now: () => number,
): ProfileMarker {
  try {
    mkdirSync(layout.environmentRoot, { recursive: true });
    mkdirSync(layout.userDataDir, { recursive: true });
  } catch (error) {
    throw new BrowserAdapterError(
      "data_directory_conflict",
      "the Chrome data directory could not be created",
      { userDataDir: layout.userDataDir },
      error,
    );
  }

  const stats = lstatSync(layout.userDataDir);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new BrowserAdapterError(
      "data_directory_conflict",
      "the Chrome data directory is not a real directory",
      { userDataDir: layout.userDataDir },
    );
  }

  const markerPath = path.join(layout.userDataDir, PROFILE_MARKER);
  if (existsSync(markerPath)) {
    const marker = parseMarker(markerPath);
    if (marker.environmentId !== environmentId) {
      throw new BrowserAdapterError(
        "data_directory_conflict",
        "the Chrome data directory belongs to a different environment",
        { userDataDir: layout.userDataDir, expected: environmentId },
      );
    }
    removeStaleDevToolsPort(layout.userDataDir);
    return marker;
  }

  const entries = readdirSync(layout.userDataDir);
  if (entries.length > 0) {
    throw new BrowserAdapterError(
      "data_directory_conflict",
      "the Chrome data directory contains data that Virealm did not create",
      { userDataDir: layout.userDataDir },
    );
  }

  const marker: ProfileMarker = {
    version: MARKER_VERSION,
    environmentId,
    createdAtUnixMs: now(),
  };
  const temporary = `${markerPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  renameSync(temporary, markerPath);
  removeStaleDevToolsPort(layout.userDataDir);
  return marker;
}

export function readProfileMarker(
  userDataDir: string,
): ProfileMarker | undefined {
  const markerPath = path.join(userDataDir, PROFILE_MARKER);
  return existsSync(markerPath) ? parseMarker(markerPath) : undefined;
}

function parseMarker(markerPath: string): ProfileMarker {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch (error) {
    throw new BrowserAdapterError(
      "profile_corrupted",
      "the Virealm profile marker is not valid JSON",
      { markerPath },
      error,
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    parsed.version !== MARKER_VERSION ||
    !("environmentId" in parsed) ||
    typeof parsed.environmentId !== "string" ||
    !("createdAtUnixMs" in parsed) ||
    typeof parsed.createdAtUnixMs !== "number"
  ) {
    throw new BrowserAdapterError(
      "profile_corrupted",
      "the Virealm profile marker has an unsupported shape",
      { markerPath },
    );
  }

  return {
    version: MARKER_VERSION,
    environmentId: parsed.environmentId,
    createdAtUnixMs: parsed.createdAtUnixMs,
  };
}

/** A stale port file is removed before launch; Chrome recreates it. */
export function removeStaleDevToolsPort(userDataDir: string): void {
  const portFile = path.join(userDataDir, "DevToolsActivePort");
  try {
    if (statSync(portFile).isFile()) {
      rmSync(portFile, { force: true });
    }
  } catch {
    // Missing port file is the normal first-launch case.
  }
}

export function assertDirectoryWritable(layout: ProfileLayout): void {
  try {
    const probe = path.join(
      layout.userDataDir,
      `.virealm-write-probe-${String(process.pid)}`,
    );
    writeFileSync(probe, "", "utf8");
    rmSync(probe, { force: true });
  } catch (error) {
    throw new BrowserAdapterError(
      "data_directory_conflict",
      "the Chrome data directory is not writable",
      { userDataDir: layout.userDataDir },
      error,
    );
  }
}
