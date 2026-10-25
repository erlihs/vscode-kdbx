import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/core/test/**/*.test.ts"],
    testTimeout: 30_000,
    maxWorkers: 2,
  },
});
