import { CryptoEngine, KdbxCredentials, ProtectedValue } from "@keenext/kdbxweb";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { argon2d, argon2id } from "hash-wasm";
import { DatabaseError } from "./errors.js";
import { INPUT_LIMITS } from "./preflight.js";

// Only the isolated compatibility worker imports this module.
Object.defineProperties(globalThis, {
  DOMParser: { value: DOMParser, configurable: true },
  XMLSerializer: { value: XMLSerializer, configurable: true },
});

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
