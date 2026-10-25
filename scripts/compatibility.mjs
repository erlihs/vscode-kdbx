import { arch, cpus, platform, release } from "node:os";
import { runCompatibilityProbe } from "../packages/core/dist/index.js";

console.log(
  `Synthetic fixtures only | Node ${process.version} | ${platform()} ${release()} ${arch()}`,
);
console.log(`Reference CPU: ${cpus()[0]?.model ?? "unavailable"}`);
const rows = [];
for (const cipher of ["aes256", "chacha20"]) {
  for (const kdf of ["argon2id", "argon2d", "aes"]) {
    for (const compression of ["gzip", "none"]) {
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
    }
  }
}
console.table(rows);
console.log(
  "GATE NOT PASSED: unbounded decoded loading remains unresolved. See docs/compatibility.md.",
);
if (process.argv.includes("--require-gate")) process.exitCode = 1;
