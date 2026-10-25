import { beforeAll, describe, expect, it } from "vitest";
import {
  BinaryStream,
  CryptoEngine,
  Kdbx,
  KdbxContext,
  KdbxError,
  KdbxHeader,
  ProtectedValue,
} from "@keenext/kdbxweb";
import { credentials } from "../dist/candidate.js";
import { createFixture, SYNTHETIC_PASSWORD } from "../dist/fixture.js";
import type { Cipher, Kdf } from "../dist/index.js";

const matrix = (["aes256", "chacha20"] as const).flatMap((cipher) =>
  (["argon2id", "argon2d", "aes"] as const).map((kdf) => ({ cipher, kdf })),
);

describe.each(matrix)("candidate authentication: $cipher / $kdf", ({ cipher, kdf }) => {
  let bytes: Uint8Array<ArrayBuffer>;
  beforeAll(async () => {
    bytes = new Uint8Array(await (await fixture(cipher, kdf)).save());
  });

  it("rejects wrong credentials without claiming to distinguish corruption", async () => {
    await expect(
      Kdbx.load(bytes.buffer, credentials("wrong synthetic password")),
    ).rejects.toMatchObject({
      code: "InvalidKey",
    });
  });

  it("rejects tampered encrypted block data", async () => {
    const tampered = bytes.slice();
    tampered[tampered.length - 50] = (tampered[tampered.length - 50] ?? 0) ^ 1;
    await expect(
      Kdbx.load(tampered.buffer, credentials(SYNTHETIC_PASSWORD)),
    ).rejects.toBeInstanceOf(KdbxError);
  });

  it("authenticates the final empty block", async () => {
    const tampered = bytes.slice();
    tampered[tampered.length - 36] = (tampered[tampered.length - 36] ?? 0) ^ 1;
    await expect(
      Kdbx.load(tampered.buffer, credentials(SYNTHETIC_PASSWORD)),
    ).rejects.toBeInstanceOf(KdbxError);
  });

  it("rejects truncated block streams", async () => {
    await expect(
      Kdbx.load(bytes.slice(0, -1).buffer, credentials(SYNTHETIC_PASSWORD)),
    ).rejects.toBeInstanceOf(KdbxError);
  });

  it("uses independently fresh master seed, KDF salt and IV for each save", async () => {
    const db = await fixture(cipher, kdf);
    const first = randomness(await db.save());
    const second = randomness(await db.save());
    for (let index = 0; index < first.length; index++) {
      expect(first[index]).not.toEqual(second[index]);
    }
  });
});

describe("candidate preservation and known limitations", () => {
  it("round-trips binary bytes, zero-byte attachments and deduplication", async () => {
    const db = await fixture("aes256", "argon2id");
    const loaded = await Kdbx.load(await db.save(), credentials(SYNTHETIC_PASSWORD));
    const entry = loaded.getDefaultGroup().groups.find((group) => group.entries.length)!
      .entries[0]!;
    const attachment = entry.binaries.get("..\\untrusted-name.cer")!;
    expect("value" in attachment ? attachment.value : attachment).toEqual(
      new Uint8Array([0, 255, 128, 13, 10]).buffer,
    );
    const empty = entry.binaries.get("empty")!;
    expect("value" in empty ? empty.value : empty).toEqual(new ArrayBuffer(0));
    expect(entry.binaries.get("duplicate")).toEqual(attachment);
    expect(entry.history).toHaveLength(1);
    expect(entry.fields.get("Password")).toBeInstanceOf(ProtectedValue);
    expect(entry.fields.get("protected-custom")).toBeInstanceOf(ProtectedValue);
    expect(entry.qualityCheck).toBe(false);
  });

  it("preserves the protection flag of empty protected values", async () => {
    const db = await fixture("aes256", "argon2id");
    const entry = db.getDefaultGroup().groups.find((group) => group.entries.length)!.entries[0]!;
    entry.fields.set("empty-protected", ProtectedValue.fromString(""));
    const loaded = await Kdbx.load(await db.save(), credentials(SYNTHETIC_PASSWORD));
    const reopened = loaded.getDefaultGroup().groups.find((group) => group.entries.length)!
      .entries[0]!;
    const value = reopened.fields.get("empty-protected");
    expect(value).toBeInstanceOf(ProtectedValue);
    expect((value as ProtectedValue).getText()).toBe("");
    expect((reopened.fields.get("Password") as ProtectedValue).getText()).toBe(
      "synthetic-new-secret",
    );
  });

  it("keeps empty attachments from XML binary pools", async () => {
    const db = await fixture("aes256", "argon2id");
    // KeePass exports an empty attachment exactly like this.
    const xml = (await db.saveXml()).replace(
      '<Binary ID="1"/>',
      '<Binary ID="1" Compressed="True" />',
    );
    expect(xml).toContain('<Binary ID="1" Compressed="True" />');
    const loaded = await Kdbx.loadXml(xml, credentials(SYNTHETIC_PASSWORD));
    const entry = loaded.getDefaultGroup().groups.find((group) => group.entries.length)!
      .entries[0]!;
    const empty = entry.binaries.get("empty");
    expect(empty && "value" in empty ? empty.value : empty).toEqual(new ArrayBuffer(0));
  });

  it("rejects unsupported Argon2 versions rather than silently substituting", async () => {
    await expect(
      CryptoEngine.argon2(new ArrayBuffer(32), new ArrayBuffer(32), 1024, 2, 32, 1, 2, 0x10),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });
});

async function fixture(cipher: Cipher, kdf: Kdf): Promise<Kdbx> {
  return createFixture({ cipher, kdf, compression: "gzip" });
}

function randomness(bytes: ArrayBuffer): string[] {
  const header = KdbxHeader.read(new BinaryStream(bytes), new KdbxContext({ kdbx: new Kdbx() }));
  const salt = header.kdfParameters!.get("S");
  if (!(salt instanceof ArrayBuffer)) throw new Error("Missing synthetic fixture salt.");
  return [header.masterSeed!, header.encryptionIV!, salt].map((value) =>
    Buffer.from(value).toString("hex"),
  );
}
