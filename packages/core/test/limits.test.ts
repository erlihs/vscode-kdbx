import { describe, expect, it } from "vitest";
import { Consts, Kdbx, KdbxFormat } from "@keenext/kdbxweb";
import { loadDatabase } from "../dist/adapter.js";
import { credentials } from "../dist/candidate.js";
import { createFixture, SYNTHETIC_PASSWORD } from "../dist/fixture.js";
import { INPUT_LIMITS } from "../dist/preflight.js";
import { scanXml } from "../dist/xml-limits.js";

const limits = { xmlChars: 1_000, xmlElements: 4, xmlDepth: 2 };
const code = (xml: string) => {
  try {
    scanXml(xml, limits);
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code;
  }
};

describe("XML pre-scan before DOM allocation", () => {
  it("enforces the exact element boundary", () => {
    expect(code("<a><b/><b/><b/></a>")).toBe("ok");
    expect(code("<a><b/><b/><b/><b/></a>")).toBe("ResourceLimit");
  });

  it("enforces the exact depth boundary; self-closing tags do not nest", () => {
    expect(code("<a><b><c/></b></a>")).toBe("ok");
    expect(code("<a><b><c></c></b></a>")).toBe("ResourceLimit");
    expect(code("<a></a><a><b></b></a>")).toBe("ok");
  });

  it("enforces the exact size boundary", () => {
    const at = `<a>${"x".repeat(limits.xmlChars - 7)}</a>`;
    expect(at).toHaveLength(limits.xmlChars);
    expect(code(at)).toBe("ok");
    expect(code(`${at} `)).toBe("ResourceLimit");
  });

  it("ignores markup-like text in attributes, comments, CDATA and instructions", () => {
    expect(
      code(`<?xml version="1.0"?><a x="> <b>" y='<'><!-- <b><b><b> --><![CDATA[<b><b>]]></a>`),
    ).toBe("ok");
  });

  it("rejects document type declarations, so entities can never expand", () => {
    expect(code('<!DOCTYPE a [<!ENTITY e "x">]><a>&e;</a>')).toBe("FileCorrupt");
  });

  it.each(["<a", "<!-- open", "<![CDATA[ open", "<?pi"])("rejects unterminated %s", (xml) => {
    expect(code(xml)).toBe("FileCorrupt");
  });
});

describe("bounded decoded loading through the adapter", () => {
  const password = () => credentials(SYNTHETIC_PASSWORD);

  async function withDecodedLimit<T>(bytes: number, action: () => Promise<T>): Promise<T> {
    KdbxFormat.maxDecompressedBytes = bytes;
    try {
      return await action();
    } finally {
      KdbxFormat.maxDecompressedBytes = INPUT_LIMITS.decodedBytes;
    }
  }

  async function bomb(size: number): Promise<Uint8Array> {
    const db = await createFixture({ cipher: "aes256", kdf: "aes", compression: "gzip" });
    const entry = db.getDefaultGroup().groups.find((group) => group.entries.length)!.entries[0]!;
    entry.binaries.set("zeros", await db.createBinary(new ArrayBuffer(size)));
    return new Uint8Array(await db.save());
  }

  it("aborts decompression once the decoded budget is exceeded", async () => {
    const bytes = await bomb(8 * 1024 * 1024);
    expect(bytes.byteLength).toBeLessThan(64 * 1024);
    await expect(
      withDecodedLimit(1024 * 1024, () => loadDatabase(bytes, password())),
    ).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
    // The same file is accepted under the configured ceiling.
    const loaded = await loadDatabase(bytes, password());
    expect(loaded.readOnlyReasons).toEqual([]);
  });

  it("counts compressed XML binaries against the same budget", async () => {
    const db = await createFixture({ cipher: "aes256", kdf: "aes", compression: "gzip" });
    const entry = db.getDefaultGroup().groups.find((group) => group.entries.length)!.entries[0]!;
    entry.binaries.set("zeros", await db.createBinary(new ArrayBuffer(2 * 1024 * 1024)));
    const xml = await db.saveXml();
    const gzipped = Buffer.from(
      (await import("node:zlib")).gzipSync(Buffer.alloc(2 * 1024 * 1024)),
    ).toString("base64");
    const compressedPool = xml.replace(
      /<Binary ID="(\d+)">[A-Za-z0-9+/=]{1000,}<\/Binary>/,
      `<Binary ID="$1" Compressed="True">${gzipped}</Binary>`,
    );
    expect(compressedPool).toContain('Compressed="True"');
    await expect(
      withDecodedLimit(1024 * 1024, () => Kdbx.loadXml(compressedPool, password())),
    ).rejects.toMatchObject({ code: Consts.ErrorCodes.ResourceLimit });
  });

  it("rejects excessively nested groups before building a DOM", async () => {
    const db = await createFixture({ cipher: "aes256", kdf: "aes", compression: "gzip" });
    let group = db.getDefaultGroup();
    for (let level = 0; level < INPUT_LIMITS.xmlDepth; level++) {
      group = db.createGroup(group, `level ${level}`);
    }
    const bytes = new Uint8Array(await db.save());
    await expect(loadDatabase(bytes, password())).rejects.toMatchObject({
      code: "RESOURCE_LIMIT",
    });
  });
});
