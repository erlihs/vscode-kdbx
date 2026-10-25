import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    alias: {
      vscode: fileURLToPath(new URL("./packages/extension/test/vscode-mock.ts", import.meta.url)),
    },
    include: ["packages/{core,extension}/test/**/*.test.ts"],
    testTimeout: 30_000,
    maxWorkers: 2,
  },
});
