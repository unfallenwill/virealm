import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * The production document keeps `script-src 'self'`. Vite's development
 * server injects an inline React refresh preamble, so only the dev server
 * rewrites the policy; the built HTML never receives the relaxation.
 */
function developmentCsp(): Plugin {
  return {
    name: "virealm-development-csp",
    transformIndexHtml(html, context) {
      if (context.server === undefined) {
        return html;
      }
      return html.replace(
        "script-src 'self'",
        "script-src 'self' 'unsafe-inline'",
      );
    },
  };
}

export default defineConfig({
  root: path.resolve(import.meta.dirname, "src/renderer"),
  base: "./",
  plugins: [react(), developmentCsp()],
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/renderer"),
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
