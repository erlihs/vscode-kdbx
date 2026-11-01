// Bundles the editor and probe worker with their runtime dependencies and WASM.
import { build } from "esbuild";
import { copyFile, mkdir, readdir } from "node:fs/promises";

for (const filename of ["README.md", "SECURITY.md", "LICENSE"]) {
  await copyFile(
    new URL(`../../${filename}`, import.meta.url),
    new URL(`./${filename}`, import.meta.url),
  );
}
const screenshots = new URL("../../docs/images/", import.meta.url);
const packagedScreenshots = new URL("./docs/images/", import.meta.url);
await mkdir(packagedScreenshots, { recursive: true });
for (const filename of await readdir(screenshots)) {
  if (filename.endsWith(".png")) {
    await copyFile(new URL(filename, screenshots), new URL(filename, packagedScreenshots));
  }
}

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
await build({
  ...shared,
  entryPoints: ["../core/dist/session-worker.js"],
  outfile: "dist/session-worker.js",
});
await build({
  entryPoints: ["src/webview.ts"],
  outfile: "dist/webview.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  legalComments: "external",
  logLevel: "warning",
});
