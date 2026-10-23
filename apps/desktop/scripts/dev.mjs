import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { context } from "esbuild";
import { createServer } from "vite";

const appRoot = path.resolve(import.meta.dirname, "..");
const dist = path.join(appRoot, "dist");
const require = createRequire(import.meta.url);
const electronPath = require("electron");

await mkdir(path.join(dist, "main"), { recursive: true });
await mkdir(path.join(dist, "preload"), { recursive: true });

const server = await createServer({
  configFile: path.join(appRoot, "vite.config.ts"),
  mode: "development",
});
await server.listen();

const devUrl =
  server.resolvedUrls?.local[0] ??
  `http://localhost:${String(server.config.server.port ?? 5173)}`;

// Main/preload are rebuilt on change, but Electron is not restarted
// automatically: restart it to pick up main-process changes.
const mainContext = await context({
  entryPoints: [path.join(appRoot, "src/main/index.ts")],
  outfile: path.join(dist, "main/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  legalComments: "none",
  external: ["electron", "playwright-core"],
  logLevel: "warning",
});

const preloadContext = await context({
  entryPoints: [path.join(appRoot, "src/preload/index.ts")],
  outfile: path.join(dist, "preload/index.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
  legalComments: "none",
  external: ["electron"],
  logLevel: "warning",
});

await mainContext.watch();
await preloadContext.watch();

const electron = spawn(electronPath, ["."], {
  cwd: appRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    VIREALM_DEV_SERVER_URL: devUrl,
    ELECTRON_ENABLE_LOGGING: "1",
  },
});

let closing = false;
async function close(code) {
  if (closing) {
    return;
  }
  closing = true;
  electron.kill();
  await Promise.allSettled([mainContext.dispose(), preloadContext.dispose()]);
  await server.close();
  process.exit(code);
}

electron.on("exit", (code) => {
  void close(code ?? 0);
});
process.on("SIGINT", () => {
  void close(0);
});
process.on("SIGTERM", () => {
  void close(0);
});
