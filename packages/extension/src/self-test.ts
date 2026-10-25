import { runCompatibilityProbe } from "@vscode-kdbx/core";
import type { Argon2Parameters, FixtureOptions } from "@vscode-kdbx/core";

export interface SelfTestCase {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

export interface SelfTestReport {
  vscode: string;
  electron: string | undefined;
  node: string;
  platform: string;
  arch: string;
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

export async function runSelfTest(vscodeVersion: string): Promise<SelfTestReport> {
  const cases: SelfTestCase[] = [];
  let maxLag = 0;
  let expected = performance.now() + 20;
  const timer = setInterval(() => {
    const now = performance.now();
    maxLag = Math.max(maxLag, now - expected);
    expected = now + 20;
  }, 20);
  try {
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
      try {
        const report = await runCompatibilityProbe(fixture, { timeoutMs: 120_000 });
        const ok =
          report.preserved &&
          report.freshRandomness &&
          report.unknownDataRefused &&
          report.header.version === "4.1";
        cases.push({ name, ok, ms: Math.round(performance.now() - start) });
      } catch (error) {
        cases.push({
          name,
          ok: false,
          ms: Math.round(performance.now() - start),
          detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
      }
    }
  } finally {
    clearInterval(timer);
  }
  return {
    vscode: vscodeVersion,
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    cases,
    maxEventLoopLagMs: Math.round(maxLag),
  };
}
