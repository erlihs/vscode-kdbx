import { runCompatibilityProbe } from "@vscode-kdbx/core";
import type { Argon2Parameters, FixtureOptions } from "@vscode-kdbx/core";

export interface SelfTestCase {
  name: string;
  ok: boolean;
  ms: number;
  /** Largest extension-host event-loop delay while this case ran. */
  lagMs: number;
  detail?: string;
}

export interface SelfTestReport {
  vscode: string;
  electron: string | undefined;
  node: string;
  platform: string;
  arch: string;
  /** Event-loop delay with no self-test work, attributable to VS Code itself. */
  baselineLagMs: number;
  cases: SelfTestCase[];
  /** Largest extension-host event-loop delay observed while workers ran. */
  maxEventLoopLagMs: number;
}

// Calibrated on the reference machine (see docs/compatibility.md); real cost, so the
// self-test shows that key derivation does not block the extension host.
const REFERENCE_ARGON2: Argon2Parameters = {
  memoryBytes: 128 * 1024 * 1024,
  iterations: 7,
  parallelism: 2,
};

/** Tracks the largest event-loop delay; `take()` returns it and starts a new window. */
function lagMonitor(): { take(): number; stop(): void } {
  let max = 0;
  let expected = performance.now() + 20;
  const timer = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - expected);
    expected = now + 20;
  }, 20);
  return {
    take() {
      const value = Math.round(max);
      max = 0;
      return value;
    },
    stop: () => clearInterval(timer),
  };
}

export async function runSelfTest(vscodeVersion: string): Promise<SelfTestReport> {
  const cases: SelfTestCase[] = [];
  const lag = lagMonitor();
  let baselineLagMs = 0;
  try {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    baselineLagMs = lag.take();
    const matrix: FixtureOptions[] = [];
    for (const cipher of ["aes256", "chacha20"] as const) {
      for (const kdf of ["argon2id", "argon2d", "aes"] as const) {
        for (const compression of ["gzip", "none"] as const) {
          matrix.push({ cipher, kdf, compression });
        }
      }
    }
    matrix.push({
      cipher: "chacha20",
      kdf: "argon2id",
      compression: "gzip",
      argon2: REFERENCE_ARGON2,
    });
    for (const fixture of matrix) {
      const name =
        `${fixture.cipher}/${fixture.kdf}/${fixture.compression}` +
        (fixture.argon2 ? " (reference KDF cost)" : "");
      const start = performance.now();
      console.log(`[kdbx self-test] Starting: ${name}`);
      try {
        const report = await runCompatibilityProbe(fixture, { timeoutMs: 120_000 });
        const ok =
          report.preserved &&
          report.freshRandomness &&
          report.unknownDataRefused &&
          report.header.version === "4.1";
        cases.push({ name, ok, ms: Math.round(performance.now() - start), lagMs: lag.take() });
        console.log(`[kdbx self-test] ${ok ? "Passed" : "Failed"}: ${name}`);
      } catch (error) {
        cases.push({
          name,
          ok: false,
          ms: Math.round(performance.now() - start),
          lagMs: lag.take(),
          detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
        console.error(`[kdbx self-test] Failed: ${name}: ${cases[cases.length - 1]?.detail}`);
      }
    }
  } finally {
    lag.stop();
  }
  return {
    vscode: vscodeVersion,
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    baselineLagMs,
    cases,
    maxEventLoopLagMs: Math.max(0, ...cases.map((item) => item.lagMs)),
  };
}
