import { CryptoEngine, KdbxCredentials, KdbxFormat, ProtectedValue } from "@keenext/kdbxweb";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { argon2d, argon2id } from "hash-wasm";
import { DatabaseError } from "./errors.js";
import type { Argon2Parameters } from "./defaults.js";
import { INPUT_LIMITS } from "./preflight.js";
import { scanXml } from "./xml-limits.js";

/** Refuses oversized or DTD-bearing XML before any DOM is allocated. */
class BoundedDOMParser extends DOMParser {
  override parseFromString(source: string, mimeType: string) {
    scanXml(source);
    return super.parseFromString(source, mimeType);
  }
}

// Only the isolated compatibility worker imports this module.
Object.defineProperties(globalThis, {
  DOMParser: { value: BoundedDOMParser, configurable: true },
  XMLSerializer: { value: XMLSerializer, configurable: true },
});
KdbxFormat.maxDecompressedBytes = INPUT_LIMITS.decodedBytes;

CryptoEngine.setArgon2Impl(
  async (password, salt, memory, iterations, length, parallelism, type, version) => {
    if (version !== 0x13) {
      throw new DatabaseError("UNSUPPORTED", "Argon2 version 1.0 is not supported.");
    }
    if (
      !Number.isSafeInteger(memory) ||
      memory < 8 * parallelism ||
      memory * 1024 > INPUT_LIMITS.argonMemoryBytes ||
      !Number.isSafeInteger(iterations) ||
      iterations < 1 ||
      iterations > INPUT_LIMITS.argonIterations ||
      !Number.isSafeInteger(parallelism) ||
      parallelism < 1 ||
      parallelism > INPUT_LIMITS.argonParallelism ||
      length !== 32
    ) {
      throw new DatabaseError("RESOURCE_LIMIT", "Argon2 settings exceed experimental limits.");
    }
    const implementation =
      type === CryptoEngine.Argon2TypeArgon2id
        ? argon2id
        : type === CryptoEngine.Argon2TypeArgon2d
          ? argon2d
          : undefined;
    if (!implementation) {
      throw new DatabaseError("UNSUPPORTED", "Unsupported Argon2 variant.");
    }
    const key = await implementation({
      password: new Uint8Array(password),
      salt: new Uint8Array(salt),
      memorySize: memory,
      iterations,
      parallelism,
      hashLength: length,
      outputType: "binary",
    });
    try {
      return key.slice().buffer;
    } finally {
      key.fill(0);
    }
  },
);

export function credentials(password: string): KdbxCredentials {
  return new KdbxCredentials(ProtectedValue.fromString(password));
}

/** Duration of one Argon2id derivation with synthetic inputs; run it in a worker. */
export async function measureArgon2id(parameters: Argon2Parameters): Promise<number> {
  const start = performance.now();
  const key = await argon2id({
    password: new Uint8Array(32),
    salt: crypto.getRandomValues(new Uint8Array(32)),
    memorySize: parameters.memoryBytes / 1024,
    iterations: parameters.iterations,
    parallelism: parameters.parallelism,
    hashLength: 32,
    outputType: "binary",
  });
  key.fill(0);
  return performance.now() - start;
}
