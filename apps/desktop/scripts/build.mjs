import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";

const appRoot = path.resolve(import.meta.dirname, "..");
const dist = path.join(appRoot, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// Renderer: Vite owns HTML, CSS and the React bundle.
await viteBuild({
  configFile: path.join(appRoot, "vite.config.ts"),
  mode: "production",
});

// Main process: ESM. Electron and Playwright stay external; Playwright cannot
// be bundled safely because it resolves its own driver files at runtime.
await esbuild({
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

// Preload: sandboxed CommonJS, exposing only the typed bridge.
await esbuild({
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

console.log("Desktop build written to dist/ (renderer, main, preload).");
