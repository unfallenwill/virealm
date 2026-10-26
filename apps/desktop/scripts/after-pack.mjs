import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, openSync, readSync } from "node:fs";
import path from "node:path";

// Electron's sandboxed renderer reads the application directory through the
// "ALL APPLICATION PACKAGES" group. When the package is unpacked somewhere that
// carries an AppContainer package ACE (a user profile directory, a shared
// folder), Electron refuses to start with
// "Sandboxed processes cannot read <dir>". Granting read/execute to the group
// is the remedy Electron itself prints, and it is what an installer under
// Program Files produces.
const ALL_APPLICATION_PACKAGES = "*S-1-15-2-1";

// Mach-O magic numbers: 32/64-bit, both byte orders, plus the universal header.
const MACH_O_MAGIC = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe,
]);

export default async function afterPack(context) {
  const platform = context.electronPlatformName;
  const fileName =
    platform === "win32" ? "virealm-runtime.exe" : "virealm-runtime";

  // electron-builder lays macOS resources out inside the .app bundle; other
  // platforms use a top-level "resources" directory.
  const resourcesDir =
    platform === "darwin"
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          "Contents",
          "Resources",
        )
      : path.join(context.appOutDir, "resources");
  const runtime = path.join(resourcesDir, "runtime", fileName);

  if (!existsSync(runtime)) {
    throw new Error(
      `the process runtime is missing from the package: ${runtime}. Build it with "cargo build --release -p virealm-process-runtime --bin virealm-runtime" before packaging.`,
    );
  }

  if (platform === "darwin") {
    chmodSync(runtime, 0o755);
    assertMachO(runtime);
    console.log(`[after-pack] verified and marked ${runtime} executable`);
    return;
  }

  if (platform !== "win32") {
    return;
  }

  try {
    execFileSync(
      "icacls",
      [context.appOutDir, "/grant", `${ALL_APPLICATION_PACKAGES}:(OI)(CI)(RX)`],
      { stdio: "pipe" },
    );
    console.log(
      `[after-pack] granted ${ALL_APPLICATION_PACKAGES} read/execute on ${context.appOutDir}`,
    );
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    throw new Error(
      `could not grant ${ALL_APPLICATION_PACKAGES} read/execute on ${context.appOutDir}; the sandboxed renderer would refuse to start. ${output}`,
      { cause: error },
    );
  }
}

function assertMachO(file) {
  const descriptor = openSync(file, "r");
  try {
    const header = Buffer.alloc(4);
    if (readSync(descriptor, header, 0, 4, 0) !== 4) {
      throw new Error(`the process runtime is too short to be Mach-O: ${file}`);
    }
    if (!MACH_O_MAGIC.has(header.readUInt32BE(0))) {
      throw new Error(
        `the process runtime is not a Mach-O executable: ${file}. Rebuild it on macOS with "cargo build --release -p virealm-process-runtime --bin virealm-runtime".`,
      );
    }
  } finally {
    closeSync(descriptor);
  }
}
