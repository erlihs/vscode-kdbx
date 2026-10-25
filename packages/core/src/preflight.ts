import {
  BinaryStream,
  Consts,
  Int64,
  Kdbx,
  KdbxContext,
  KdbxError,
  KdbxHeader,
} from "@keenext/kdbxweb";
import { createHash, timingSafeEqual } from "node:crypto";
import { DatabaseError } from "./errors.js";

// Experimental admission ceilings, not new-database security defaults.
export const INPUT_LIMITS = Object.freeze({
  encryptedBytes: 100 * 1024 * 1024,
  headerBytes: 64 * 1024,
  argonMemoryBytes: 256 * 1024 * 1024,
  argonIterations: 10,
  argonParallelism: 4,
  aesRounds: 10_000_000,
  // All bytes decompressed by one load: inner header attachments plus XML.
  decodedBytes: 256 * 1024 * 1024,
  // Sized so a database at both XML ceilings stays well inside WORKER_RESOURCE_LIMITS
  // (about 2.2 KiB of worker heap per element; measured by `pnpm calibrate`).
  xmlChars: 32 * 1024 * 1024,
  xmlElements: 500_000,
  xmlDepth: 256,
});

export type Cipher = "aes256" | "chacha20";
export type Kdf = "argon2id" | "argon2d" | "aes";

export interface HeaderInfo {
  version: "4.0" | "4.1";
  cipher: Cipher;
  kdf: Kdf;
  compression: "none" | "gzip";
  headerBytes: number;
  iterations: number;
  memoryBytes?: number;
  parallelism?: number;
}

function invalid(): never {
  throw new DatabaseError("FORMAT", "The KDBX header is truncated or malformed.");
}

function unsupported(message: string): never {
  throw new DatabaseError("UNSUPPORTED", message);
}

function positiveInteger(value: unknown, maximum: number, name: string): number {
  const number = value instanceof Int64 ? value.hi * 0x1_0000_0000 + value.lo : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number < 1) {
    invalid();
  }
  if (number > maximum) {
    throw new DatabaseError(
      "RESOURCE_LIMIT",
      `${name} exceeds the experimental local limit. Settings will not be reduced.`,
    );
  }
  if (!Number.isSafeInteger(number)) invalid();
  return number;
}

export function inspectHeader(bytes: Uint8Array): HeaderInfo {
  if (bytes.byteLength > INPUT_LIMITS.encryptedBytes) {
    throw new DatabaseError("RESOURCE_LIMIT", "Encrypted database exceeds the 100 MiB limit.");
  }
  if (bytes.byteLength < 12) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x9aa2d903 || view.getUint32(4, true) !== 0xb54bfb67) {
    throw new DatabaseError("FORMAT", "Not a KeePass KDBX database.");
  }
  const minor = view.getUint16(8, true);
  if ((minor !== 0 && minor !== 1) || view.getUint16(10, true) !== 4) {
    unsupported("Only KDBX 4.0 and 4.1 are supported; convert a separate copy in KeePass.");
  }

  let offset = 12;
  const fields = new Set<number>();
  while (true) {
    if (offset + 5 > bytes.byteLength) invalid();
    const id = view.getUint8(offset);
    const length = view.getUint32(offset + 1, true);
    offset += 5;
    if (offset + length > INPUT_LIMITS.headerBytes) {
      throw new DatabaseError("RESOURCE_LIMIT", "KDBX header exceeds the 64 KiB limit.");
    }
    if (offset + length > bytes.byteLength || fields.has(id)) invalid();
    fields.add(id);
    if (![0, 1, 2, 3, 4, 7, 11, 12].includes(id)) {
      unsupported("An unknown KDBX header field cannot be safely round-tripped.");
    }
    if (id === 0) {
      if (length !== 4) invalid();
      offset += length;
      break;
    }
    offset += length;
  }
  if (![2, 3, 4, 7, 11].every((id) => fields.has(id)) || offset + 64 > bytes.byteLength) {
    invalid();
  }
  const expectedHash = bytes.subarray(offset, offset + 32);
  const hash = createHash("sha256").update(bytes.subarray(0, offset)).digest();
  if (!timingSafeEqual(hash, expectedHash)) {
    throw new DatabaseError("FORMAT", "The KDBX header checksum does not match.");
  }

  let header: KdbxHeader;
  try {
    header = KdbxHeader.read(
      new BinaryStream(bytes.slice(0, offset).buffer),
      new KdbxContext({ kdbx: new Kdbx() }),
    );
  } catch (error) {
    if (error instanceof KdbxError || error instanceof RangeError) invalid();
    throw error;
  }
  const cipherId = header.dataCipherUuid?.toString();
  const cipher =
    cipherId === Consts.CipherId.Aes
      ? "aes256"
      : cipherId === Consts.CipherId.ChaCha20
        ? "chacha20"
        : unsupported("Only AES-256 and ChaCha20 databases are supported.");
  const parameters = header.kdfParameters;
  if (!parameters) invalid();
  const uuid = parameters.get("$UUID");
  if (!(uuid instanceof ArrayBuffer)) invalid();
  const kdfId = Buffer.from(uuid).toString("base64");
  const kdf =
    kdfId === Consts.KdfId.Argon2id
      ? "argon2id"
      : kdfId === Consts.KdfId.Argon2d
        ? "argon2d"
        : kdfId === Consts.KdfId.Aes
          ? "aes"
          : unsupported("This key derivation function is not supported.");
  const allowedKeys = kdf === "aes" ? ["$UUID", "S", "R"] : ["$UUID", "S", "P", "I", "M", "V"];
  if (new Set(parameters.keys()).size !== parameters.length) invalid();
  if (parameters.keys().some((key) => !allowedKeys.includes(key))) {
    unsupported("Unsupported KDF parameters; no writable round trip is permitted.");
  }
  const salt = parameters.get("S");
  if (!(salt instanceof ArrayBuffer) || salt.byteLength !== 32) invalid();
  if (
    !(parameters.get(kdf === "aes" ? "R" : "I") instanceof Int64) ||
    (kdf !== "aes" &&
      (!(parameters.get("M") instanceof Int64) || typeof parameters.get("P") !== "number"))
  ) {
    invalid();
  }
  const compression =
    header.compression === 0
      ? "none"
      : header.compression === 1
        ? "gzip"
        : unsupported("Unsupported KDBX compression.");
  const result: HeaderInfo = {
    version: minor === 0 ? "4.0" : "4.1",
    cipher,
    kdf,
    compression,
    headerBytes: offset,
    iterations: positiveInteger(
      parameters.get(kdf === "aes" ? "R" : "I"),
      kdf === "aes" ? INPUT_LIMITS.aesRounds : INPUT_LIMITS.argonIterations,
      "KDF work",
    ),
  };
  const expectedIv = cipher === "aes256" ? 16 : 12;
  if (header.encryptionIV?.byteLength !== expectedIv || header.masterSeed?.byteLength !== 32) {
    invalid();
  }
  if (kdf !== "aes") {
    if (parameters.get("V") !== 0x13) {
      unsupported("Only Argon2 version 1.3 is supported by the selected provider.");
    }
    result.memoryBytes = positiveInteger(
      parameters.get("M"),
      INPUT_LIMITS.argonMemoryBytes,
      "Argon2 memory",
    );
    result.parallelism = positiveInteger(
      parameters.get("P"),
      INPUT_LIMITS.argonParallelism,
      "Argon2 parallelism",
    );
    if (result.memoryBytes % 1024 !== 0 || result.memoryBytes < 8192 * result.parallelism) {
      invalid();
    }
  }
  return result;
}
