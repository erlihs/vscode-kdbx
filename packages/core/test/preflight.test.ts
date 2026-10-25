import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { BinaryStream, Consts, Int64, Kdbx, VarDictionary } from "@keenext/kdbxweb";
import { credentials } from "../dist/candidate.js";
import { createFixture, SYNTHETIC_PASSWORD } from "../dist/fixture.js";
import { DatabaseError, INPUT_LIMITS, inspectHeader } from "../dist/index.js";

let fixture: Uint8Array<ArrayBuffer>;

beforeAll(async () => {
  fixture = new Uint8Array(
    await (await createFixture({ cipher: "aes256", kdf: "argon2id", compression: "gzip" })).save(),
  );
});

function fieldOffset(bytes: Uint8Array, wanted: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 12; offset < bytes.length;) {
    const id = view.getUint8(offset);
    if (id === wanted) return offset;
    offset += 5 + view.getUint32(offset + 1, true);
    if (id === 0) break;
  }
  throw new Error("Synthetic header field not found.");
}

function checksum(bytes: Uint8Array): void {
  const end = fieldOffset(bytes, 0) + 9;
  bytes.set(createHash("sha256").update(bytes.subarray(0, end)).digest(), end);
}

function expectCode(bytes: Uint8Array, code: DatabaseError["code"]): void {
  expect(() => inspectHeader(bytes)).toThrow(expect.objectContaining({ code }));
}

describe("bounded, unauthenticated header inspection", () => {
  it("identifies explicit 4.1 and settings", () => {
    expect(inspectHeader(fixture)).toMatchObject({
      version: "4.1",
      cipher: "aes256",
      kdf: "argon2id",
      compression: "gzip",
      memoryBytes: 1024 * 1024,
      parallelism: 1,
      iterations: 2,
    });
  });

  it("identifies explicit 4.0 and settings", async () => {
    const db = await createFixture({
      version: "4.0",
      cipher: "aes256",
      kdf: "argon2id",
      compression: "gzip",
    });
    expect(inspectHeader(new Uint8Array(await db.save()))).toMatchObject({
      version: "4.0",
      cipher: "aes256",
      kdf: "argon2id",
      compression: "gzip",
    });
  });

  it.each([0, 7, 11, 12, 15, 80, 200])("rejects truncation at %s bytes", (length) => {
    expectCode(fixture.slice(0, length), "FORMAT");
  });

  it.each([
    [3, 1],
    [4, 2],
    [5, 0],
  ])("rejects KDBX %s.%s", (major, minor) => {
    const bytes = fixture.slice();
    const view = new DataView(bytes.buffer);
    view.setUint16(8, minor, true);
    view.setUint16(10, major, true);
    expectCode(bytes, "UNSUPPORTED");
  });

  it("rejects an incorrect signature", () => {
    const bytes = fixture.slice();
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    expectCode(bytes, "FORMAT");
  });

  it("rejects header checksum tampering before KDF work", () => {
    const bytes = fixture.slice();
    const offset = fieldOffset(bytes, 4) + 5;
    bytes[offset] = (bytes[offset] ?? 0) ^ 1;
    expectCode(bytes, "FORMAT");
  });

  it("rejects an unknown cipher", () => {
    const bytes = fixture.slice();
    bytes.fill(0, fieldOffset(bytes, 2) + 5, fieldOffset(bytes, 2) + 21);
    checksum(bytes);
    expectCode(bytes, "UNSUPPORTED");
  });

  it("rejects unknown header fields rather than silently dropping them", () => {
    const bytes = fixture.slice();
    bytes[fieldOffset(bytes, 12)] = 99;
    expectCode(bytes, "UNSUPPORTED");
  });

  it("rejects impossible field lengths before allocation", () => {
    const bytes = fixture.slice();
    new DataView(bytes.buffer).setUint32(13, 0xffffffff, true);
    expectCode(bytes, "RESOURCE_LIMIT");
  });

  it("accepts exactly 100 MiB encrypted input and rejects one byte more", () => {
    const bytes = new Uint8Array(INPUT_LIMITS.encryptedBytes + 1);
    bytes.set(fixture);
    expect(inspectHeader(bytes.subarray(0, INPUT_LIMITS.encryptedBytes)).version).toBe("4.1");
    expectCode(bytes, "RESOURCE_LIMIT");
  });

  it("enforces the exact 64 KiB header boundary", () => {
    const oldLength = inspectHeader(fixture).headerBytes;
    for (const newLength of [INPUT_LIMITS.headerBytes, INPUT_LIMITS.headerBytes + 1]) {
      const commentLength = newLength - oldLength - 5;
      const bytes = new Uint8Array(newLength + 64);
      bytes.set(fixture.subarray(0, 12));
      bytes[12] = 1;
      new DataView(bytes.buffer).setUint32(13, commentLength, true);
      bytes.set(fixture.subarray(12, oldLength), 17 + commentLength);
      bytes.set(createHash("sha256").update(bytes.subarray(0, newLength)).digest(), newLength);
      if (newLength === INPUT_LIMITS.headerBytes)
        expect(inspectHeader(bytes).headerBytes).toBe(newLength);
      else expectCode(bytes, "RESOURCE_LIMIT");
    }
  });

  it("reports a full-width UInt64 work value as a resource error", async () => {
    const db = await Kdbx.load(fixture.buffer, credentials(SYNTHETIC_PASSWORD));
    db.header.kdfParameters!.set(
      "I",
      VarDictionary.ValueType.UInt64,
      new Int64(0xffffffff, 0xffffffff),
    );
    expectCode(rewriteHeader(db), "RESOURCE_LIMIT");
  });

  it.each([
    [
      "M",
      VarDictionary.ValueType.UInt64,
      INPUT_LIMITS.argonMemoryBytes,
      INPUT_LIMITS.argonMemoryBytes + 1024,
    ],
    [
      "I",
      VarDictionary.ValueType.UInt64,
      INPUT_LIMITS.argonIterations,
      INPUT_LIMITS.argonIterations + 1,
    ],
    [
      "P",
      VarDictionary.ValueType.UInt32,
      INPUT_LIMITS.argonParallelism,
      INPUT_LIMITS.argonParallelism + 1,
    ],
  ])(
    "enforces the exact %s admission boundary without running the KDF",
    async (key, type, at, above) => {
      const db = await Kdbx.load(fixture.buffer, credentials(SYNTHETIC_PASSWORD));
      const parameters = db.header.kdfParameters!;
      for (const value of [at, above]) {
        parameters.set(
          key,
          type,
          type === VarDictionary.ValueType.UInt64 ? Int64.from(value) : value,
        );
        const bytes = rewriteHeader(db);
        if (value === at) expect(inspectHeader(bytes).kdf).toBe("argon2id");
        else expectCode(bytes, "RESOURCE_LIMIT");
      }
    },
  );

  it("rejects unsupported Argon2 1.0 explicitly", async () => {
    const db = await Kdbx.load(fixture.buffer, credentials(SYNTHETIC_PASSWORD));
    db.header.kdfParameters!.set("V", VarDictionary.ValueType.UInt32, 0x10);
    expectCode(rewriteHeader(db), "UNSUPPORTED");
  });

  it("rejects unknown KDF parameters and authentication extensions", async () => {
    const db = await Kdbx.load(fixture.buffer, credentials(SYNTHETIC_PASSWORD));
    db.header.kdfParameters!.set("K", VarDictionary.ValueType.Bytes, new ArrayBuffer(32));
    expectCode(rewriteHeader(db), "UNSUPPORTED");
  });

  it("enforces the AES rounds boundary before expensive work", async () => {
    const db = await Kdbx.load(fixture.buffer, credentials(SYNTHETIC_PASSWORD));
    db.setKdf(Consts.KdfId.Aes);
    for (const rounds of [INPUT_LIMITS.aesRounds, INPUT_LIMITS.aesRounds + 1]) {
      db.header.kdfParameters!.set("R", VarDictionary.ValueType.UInt64, Int64.from(rounds));
      const bytes = rewriteHeader(db);
      if (rounds === INPUT_LIMITS.aesRounds) expect(inspectHeader(bytes).iterations).toBe(rounds);
      else expectCode(bytes, "RESOURCE_LIMIT");
    }
  });
});

function rewriteHeader(db: Kdbx): Uint8Array<ArrayBuffer> {
  const stream = new BinaryStream();
  db.header.write(stream);
  const header = new Uint8Array(stream.getWrittenBytes());
  const result = new Uint8Array(header.byteLength + 64);
  result.set(header);
  result.set(createHash("sha256").update(header).digest(), header.byteLength);
  return result;
}
