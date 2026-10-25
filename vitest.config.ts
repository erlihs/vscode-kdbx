import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/{core,extension}/test/**/*.test.ts"],
    testTimeout: 30_000,
    maxWorkers: 2,
  },
});
