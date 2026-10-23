import { defineConfig } from "vitest/config";

/**
 * Unit and security tests run against the desktop's pure core. Electron and
 * real Chrome live in the integration configuration so a unit run never needs
 * a display or a browser installation.
 */
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/security/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: [
        "src/main/errors.ts",
        "src/main/ipc.ts",
        "src/main/logging.ts",
        "src/main/persistence/**/*.ts",
        "src/main/runtime/probe-server.ts",
        "src/main/services/**/*.ts",
        "src/shared/validation.ts",
      ],
      exclude: ["src/main/services/environment-service.ts.types.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
  },
});
