import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts", "tests/electron/**/*.test.ts"],
    environment: "node",
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
