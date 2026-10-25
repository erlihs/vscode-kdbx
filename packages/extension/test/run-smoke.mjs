// Packaging smoke test: installs the packaged VSIX into a downloaded VS Code and runs
// the compatibility self-test in its extension host (synthetic data only).
//   VSCODE_VERSION=<x.y.z|stable> pnpm smoke
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from "@vscode/test-electron";

const version = process.env.VSCODE_VERSION || "stable";
const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const vsix = here("../dist/kdbx.vsix");
const harness = here("./harness");
// Responsiveness target from the specification: busy feedback within 250 ms.
const MAX_LAG_MS = 250;

const work = mkdtempSync(join(tmpdir(), "kdbx-smoke-"));
const extensionsDir = join(work, "extensions");
const userDataDir = join(work, "user-data");
const reportPath = join(work, "report.json");
try {
  const executable = await downloadAndUnzipVSCode(version);
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executable);
  const install = spawnSync(
    cli,
    [...cliArgs, "--extensions-dir", extensionsDir, "--install-extension", vsix],
    { encoding: "utf8", shell: process.platform === "win32" },
  );
  if (install.status !== 0)
    throw new Error(`VSIX install failed:\n${install.stdout}${install.stderr}`);

  await runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: harness,
    extensionTestsPath: join(harness, "index.cjs"),
    launchArgs: [
      "--extensions-dir",
      extensionsDir,
      "--user-data-dir",
      userDataDir,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
    ],
    extensionTestsEnv: { KDBX_REPORT: reportPath, KDBX_EXTENSIONS_DIR: extensionsDir },
  });

  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  console.log(
    `VS Code ${report.vscode} | Electron ${report.electron} | Node ${report.node} | ` +
      `${report.platform}-${report.arch}`,
  );
  console.table(report.cases);
  console.log(`Max extension-host event-loop lag: ${report.maxEventLoopLagMs} ms`);
  const failed = report.cases.filter((item) => !item.ok);
  if (failed.length) throw new Error(`${failed.length} self-test cases failed.`);
  if (report.cases.length !== 13) throw new Error("The self-test did not run every case.");
  if (report.maxEventLoopLagMs > MAX_LAG_MS) {
    throw new Error(`Extension host blocked for ${report.maxEventLoopLagMs} ms.`);
  }
  console.log("OK: the packaged VSIX passed in the VS Code extension host.");
} finally {
  rmSync(work, { recursive: true, force: true });
}
