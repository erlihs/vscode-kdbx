import { describe, expect, it } from "vitest";
import { runCompatibilityProbe } from "../dist/index.js";

const matrix = (["aes256", "chacha20"] as const).flatMap((cipher) =>
  (["argon2id", "argon2d", "aes"] as const).flatMap((kdf) =>
    (["gzip", "none"] as const).map((compression) => ({ cipher, kdf, compression })),
  ),
);

describe("synthetic candidate compatibility (not independent KeePass interoperability)", () => {
  it.each(matrix)("$cipher / $kdf / $compression", async (options) => {
    const result = await runCompatibilityProbe(options);
    expect(result.header).toMatchObject({ ...options, version: "4.1" });
    expect(result.preserved).toBe(true);
    expect(result.freshRandomness).toBe(true);
    expect(result.encryptedBytes).toBeGreaterThan(0);
    // This is a characterized release blocker, not an accepted writable-data policy.
    expect(result.unknownXmlPreserved).toBe(false);
  });

  it("cancels before starting a worker", async () => {
    await expect(
      runCompatibilityProbe(matrix[0]!, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("terminates an in-flight worker on cancellation", async () => {
    const controller = new AbortController();
    const result = runCompatibilityProbe(matrix[0]!, { signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("terminates a worker that exceeds its deadline", async () => {
    await expect(runCompatibilityProbe(matrix[0]!, { timeoutMs: 1 })).rejects.toMatchObject({
      code: "RESOURCE_LIMIT",
    });
  });

  it.each([0, -1, Infinity, 1.5, 120001])("rejects invalid timeout %s", async (timeoutMs) => {
    await expect(runCompatibilityProbe(matrix[0]!, { timeoutMs })).rejects.toMatchObject({
      code: "RESOURCE_LIMIT",
    });
  });
});
