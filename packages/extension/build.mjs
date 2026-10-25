// Bundles the extension and its probe worker as CommonJS, with every dependency
// (including the patched KDBX library and embedded WASM) inlined; the VSIX ships
// only these two files and package.json.
import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: false,
  logLevel: "warning",
  legalComments: "external",
  // The core resolves its worker with `new URL("./probe-worker.js", import.meta.url)`.
  define: { "import.meta.url": "__kdbxModuleUrl" },
  banner: { js: 'const __kdbxModuleUrl = require("node:url").pathToFileURL(__filename).href;' },
};

await build({
  ...shared,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  external: ["vscode"],
});
await build({
  ...shared,
  entryPoints: ["../core/dist/probe-worker.js"],
  outfile: "dist/probe-worker.js",
});
