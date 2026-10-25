// Packaging smoke test: installs the packaged VSIX into a downloaded VS Code and runs
// the locked editor and compatibility self-test in its extension host (synthetic data only).
//   VSCODE_VERSION=<x.y.z|stable> pnpm smoke
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
} from "@vscode/test-electron";

const version = process.env.VSCODE_VERSION || "stable";
const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const vsix = here("../dist/kdbx.vsix");
const harness = here("./harness");
// Responsiveness target from the specification: busy feedback within 250 ms.
const MAX_LAG_MS = 250;

const work = mkdtempSync(join(tmpdir(), "kdbx-smoke-"));
const extensionsDir = join(work, "extensions");
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

  for (const trusted of [true, false]) {
    const mode = trusted ? "trusted" : "restricted";
    const userDataDir = join(work, `${mode}-user-data`);
    const reportPath = join(work, `${mode}-report.json`);
    const workspace = join(work, `${mode}-workspace`);
    mkdirSync(workspace);
    const fixture = join(workspace, "synthetic.kdbx");
    copyFileSync(here("../../core/test/fixtures/keepass/aes256-argon2id-gzip.kdbx"), fixture);
    const original = readFileSync(fixture);
    mkdirSync(join(userDataDir, "User"), { recursive: true });
    writeFileSync(
      join(userDataDir, "User", "settings.json"),
      JSON.stringify({
        "security.workspace.trust.enabled": true,
        "security.workspace.trust.startupPrompt": "never",
        "security.workspace.trust.untrustedFiles": "open",
      }),
    );
    // test-electron's runTests always disables trust, so launch explicitly to
    // exercise a real Restricted Mode window rather than a simulated flag.
    const run = spawnSync(
      executable,
      [
        "--no-sandbox",
        "--disable-gpu-sandbox",
        "--disable-updates",
        "--no-cached-data",
        `--extensionDevelopmentPath=${harness}`,
        `--extensionTestsPath=${join(harness, "index.cjs")}`,
        "--extensions-dir",
        extensionsDir,
        "--user-data-dir",
        userDataDir,
        ...(trusted ? ["--disable-workspace-trust"] : []),
        "--skip-welcome",
        "--skip-release-notes",
        workspace,
      ],
      {
        stdio: "inherit",
        // Covers startup, editor (90 s), session (60 s) and compatibility (150 s) steps.
        timeout: 330_000,
        env: {
          ...process.env,
          KDBX_REPORT: reportPath,
          KDBX_EXTENSIONS_DIR: extensionsDir,
          KDBX_EDITOR_FIXTURE: fixture,
          KDBX_EXPECT_TRUST: String(trusted),
        },
      },
    );
    if (run.error || run.status !== 0) {
      const diagnostics = process.env.KDBX_SMOKE_DIAGNOSTICS;
      const logs = join(userDataDir, "logs");
      if (diagnostics && existsSync(logs)) {
        const destination = join(diagnostics, mode);
        mkdirSync(destination, { recursive: true });
        cpSync(logs, join(destination, "logs"), { recursive: true });
        console.error(`Synthetic smoke VS Code logs saved to ${destination}`);
      }
      if (run.error) throw run.error;
      throw new Error(`${mode} VS Code smoke exited ${run.status ?? run.signal}.`);
    }

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    console.log(
      `${mode} | VS Code ${report.vscode} | Electron ${report.electron} | Node ${report.node} | ` +
        `${report.platform}-${report.arch}`,
    );
    console.table(report.cases);
    console.log(
      `Extension-host event-loop lag: baseline ${report.baselineLagMs} ms idle, ` +
        `max ${report.maxEventLoopLagMs} ms while self-test workers ran`,
    );
    const failed = report.cases.filter((item) => !item.ok);
    if (failed.length) throw new Error(`${failed.length} self-test cases failed.`);
    if (report.cases.length !== 13) throw new Error("The self-test did not run every case.");
    if (report.maxEventLoopLagMs > MAX_LAG_MS) {
      throw new Error(`Extension host blocked for ${report.maxEventLoopLagMs} ms.`);
    }
    if (!report.editor?.ok || report.editor.trusted !== trusted) {
      throw new Error("The installed custom editor did not pass its environment/lifecycle checks.");
    }
    if (!report.sessionWorker?.ok) {
      throw new Error("The installed persistent session worker did not pass.");
    }
    if (!original.equals(readFileSync(fixture)))
      throw new Error("The locked editor changed the database.");
    console.log(`OK: the packaged VSIX editor and worker passed in ${mode} mode.`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
