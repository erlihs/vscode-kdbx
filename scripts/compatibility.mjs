import { arch, cpus, platform, release } from "node:os";
import { runCompatibilityProbe } from "../packages/core/dist/index.js";

console.log(
  `Synthetic fixtures only | Node ${process.version} | ${platform()} ${release()} ${arch()}`,
);
console.log(`Reference CPU: ${cpus()[0]?.model ?? "unavailable"}`);
const rows = [];
let failed = 0;
for (const cipher of ["aes256", "chacha20"]) {
  for (const kdf of ["argon2id", "argon2d", "aes"]) {
    for (const compression of ["gzip", "none"]) {
      try {
        const report = await runCompatibilityProbe({ cipher, kdf, compression });
        rows.push({
          cipher,
          kdf,
          compression,
          version: report.header.version,
          preserved: report.preserved,
          randomness: report.freshRandomness,
          unknownRefused: report.unknownDataRefused,
          bytes: report.encryptedBytes,
          ms: report.elapsedMs,
        });
      } catch (error) {
        failed++;
        rows.push({ cipher, kdf, compression, error: error?.code ?? String(error) });
      }
    }
  }
}
console.table(rows);
// Interoperability, calibration and VS Code packaging evidence come from
// `pnpm interop`, `pnpm calibrate` and `pnpm smoke`; see docs/compatibility.md.
console.log(
  failed
    ? `GATE NOT PASSED: ${failed} synthetic probe cases failed. See docs/compatibility.md.`
    : "GATE PASSED: all synthetic probe cases succeeded. See docs/compatibility.md for the " +
        "interoperability, calibration and VS Code packaging evidence.",
);
if (failed) process.exitCode = 1;
