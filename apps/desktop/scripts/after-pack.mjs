import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// Electron's sandboxed renderer reads the application directory through the
// "ALL APPLICATION PACKAGES" group. When the package is unpacked somewhere that
// carries an AppContainer package ACE (a user profile directory, a shared
// folder), Electron refuses to start with
// "Sandboxed processes cannot read <dir>". Granting read/execute to the group
// is the remedy Electron itself prints, and it is what an installer under
// Program Files produces.
const ALL_APPLICATION_PACKAGES = "*S-1-15-2-1";
const RUNTIME_RESOURCE = path.join(
  "resources",
  "runtime",
  "virealm-runtime.exe",
);

export default async function afterPack(context) {
  const appOutDir = context.appOutDir;
  const runtime = path.join(appOutDir, RUNTIME_RESOURCE);
  if (!existsSync(runtime)) {
    throw new Error(
      `the process runtime is missing from the package: ${runtime}. Build it with "cargo build --release -p virealm-process-runtime --bin virealm-runtime" before packaging.`,
    );
  }

  if (process.platform !== "win32") {
    return;
  }

  try {
    execFileSync(
      "icacls",
      [appOutDir, "/grant", `${ALL_APPLICATION_PACKAGES}:(OI)(CI)(RX)`],
      { stdio: "pipe" },
    );
    console.log(
      `[after-pack] granted ${ALL_APPLICATION_PACKAGES} read/execute on ${appOutDir}`,
    );
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    throw new Error(
      `could not grant ${ALL_APPLICATION_PACKAGES} read/execute on ${appOutDir}; the sandboxed renderer would refuse to start. ${output}`,
      { cause: error },
    );
  }
}
