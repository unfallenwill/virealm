import path from "node:path";

/**
 * Path semantics for the host platform.
 *
 * Windows compares case-insensitively and treats both separators as
 * equivalent; POSIX platforms preserve case. Tests pass `platform`
 * explicitly so both layouts can be exercised on one machine.
 */
export type HostPlatform = string;

function pathApi(platform: string): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

/** Canonical comparison key: absolute, no trailing separator. */
export function pathKey(
  candidate: string,
  platform: string = process.platform,
): string {
  const api = pathApi(platform);
  const resolved = api.resolve(candidate).replace(/[\\/]+$/, "");
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function samePath(
  left: string,
  right: string,
  platform: string = process.platform,
): boolean {
  return pathKey(left, platform) === pathKey(right, platform);
}

/** True when `candidate` is `parent` or lives below it. */
export function isPathInside(
  parent: string,
  candidate: string,
  platform: string = process.platform,
): boolean {
  const api = pathApi(platform);
  const relative = api.relative(
    pathKey(parent, platform),
    pathKey(candidate, platform),
  );
  return (
    relative === "" || (!relative.startsWith("..") && !api.isAbsolute(relative))
  );
}

/**
 * The outermost `.app` bundle that contains a macOS executable, if any.
 *
 * Chrome's executable lives at `X.app/Contents/MacOS/Google Chrome`; the
 * bundle is the install root handed to the runtime's program policy. For a
 * helper nested in another bundle the outermost application is the install.
 */
export function bundleRootOf(
  executablePath: string,
  platform: string = process.platform,
): string | undefined {
  const api = pathApi(platform);
  let current = api.resolve(executablePath);
  let bundle: string | undefined;
  while (true) {
    if (api.basename(current).toLowerCase().endsWith(".app")) {
      bundle = current;
    }
    const parent = api.dirname(current);
    if (parent === current) {
      return bundle;
    }
    current = parent;
  }
}

/**
 * Directory that contains the browser installation.
 *
 * Windows uses the executable's directory. On macOS it is the enclosing
 * bundle, because policy roots name the application, not `Contents/MacOS`.
 */
export function chromeInstallRoot(
  executablePath: string,
  platform: string = process.platform,
): string {
  if (platform !== "win32") {
    const bundle = bundleRootOf(executablePath, platform);
    if (bundle !== undefined) {
      return bundle;
    }
  }
  const api = pathApi(platform);
  return api.dirname(api.resolve(executablePath));
}
