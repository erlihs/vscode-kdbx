import { describe, expect, it } from "vitest";
import { Consts, Kdbx, KdbxFormat } from "@keenext/kdbxweb";
import { gzipSync } from "node:zlib";
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

  async function compressedXml(binaryCount: number): Promise<string> {
    const db = await createFixture({ cipher: "aes256", kdf: "aes", compression: "gzip" });
    const entry = db.getDefaultGroup().groups.find((group) => group.entries.length)!.entries[0]!;
    for (let index = 0; index < binaryCount; index++) {
      const bytes = new Uint8Array(2 * 1024 * 1024);
      bytes.fill(index);
      entry.binaries.set(`large-${index}`, await db.createBinary(bytes.buffer));
    }
    let replacements = 0;
    const xml = (await db.saveXml()).replace(
      /<Binary ID="(\d+)">([A-Za-z0-9+/=]{1000,})<\/Binary>/g,
      (_match, id: string, base64: string) => {
        replacements++;
        return `<Binary ID="${id}" Compressed="True">${gzipSync(Buffer.from(base64, "base64")).toString("base64")}</Binary>`;
      },
    );
    expect(replacements).toBe(binaryCount);
    return xml;
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

  it("applies independent budgets to concurrent valid loads", async () => {
    const bytes = await bomb(2 * 1024 * 1024);
    await withDecodedLimit(3 * 1024 * 1024, async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => loadDatabase(bytes, password())),
      );
      expect(results.map((result) => result.status)).toEqual(Array(5).fill("fulfilled"));
    });
  });

  it("keeps an over-limit concurrent load from exhausting a valid load's budget", async () => {
    const large = await bomb(4 * 1024 * 1024);
    const small = await bomb(2 * 1024 * 1024);
    await withDecodedLimit(3 * 1024 * 1024, async () => {
      const results = await Promise.allSettled([
        loadDatabase(large, password()),
        loadDatabase(small, password()),
      ]);
      expect(results[0]).toMatchObject({
        status: "rejected",
        reason: { code: "RESOURCE_LIMIT" },
      });
      expect(results[1]).toMatchObject({ status: "fulfilled" });
    });
  });

  it("starts a fresh budget after a failed load", async () => {
    const large = await bomb(4 * 1024 * 1024);
    const small = await bomb(2 * 1024 * 1024);
    await withDecodedLimit(3 * 1024 * 1024, async () => {
      await expect(loadDatabase(large, password())).rejects.toMatchObject({
        code: "RESOURCE_LIMIT",
      });
      expect((await loadDatabase(small, password())).readOnlyReasons).toEqual([]);
    });
  });

  it("captures each load's configured ceiling before awaiting credentials", async () => {
    const bytes = await bomb(2 * 1024 * 1024);
    await withDecodedLimit(3 * 1024 * 1024, async () => {
      const admitted = loadDatabase(bytes, password());
      KdbxFormat.maxDecompressedBytes = 1024 * 1024;
      const refused = loadDatabase(bytes, password());
      const results = await Promise.allSettled([admitted, refused]);
      expect(results[0]).toMatchObject({ status: "fulfilled" });
      expect(results[1]).toMatchObject({
        status: "rejected",
        reason: { code: "RESOURCE_LIMIT" },
      });
    });
  });

  it("counts compressed XML binaries against the same budget", async () => {
    const xml = await compressedXml(1);
    await expect(
      withDecodedLimit(1024 * 1024, () => Kdbx.loadXml(xml, password())),
    ).rejects.toMatchObject({ code: Consts.ErrorCodes.ResourceLimit });
  });

  it("applies independent budgets to concurrent XML imports", async () => {
    const xml = await compressedXml(1);
    await withDecodedLimit(3 * 1024 * 1024, async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => Kdbx.loadXml(xml, password())),
      );
      expect(results.map((result) => result.status)).toEqual(Array(5).fill("fulfilled"));
    });
  });

  it("shares one budget across every compressed XML binary in a load", async () => {
    const xml = await compressedXml(2);
    await expect(
      withDecodedLimit(3 * 1024 * 1024, () => Kdbx.loadXml(xml, password())),
    ).rejects.toMatchObject({ code: Consts.ErrorCodes.ResourceLimit });
    await withDecodedLimit(5 * 1024 * 1024, async () => {
      await Kdbx.loadXml(xml, password());
    });
  });

  it("includes inline entry binaries in the XML load's shared budget", async () => {
    const gzipped = gzipSync(Buffer.alloc(2 * 1024 * 1024)).toString("base64");
    const xml = (await compressedXml(1)).replace(
      "</Entry>",
      `<Binary><Key>inline</Key><Value Compressed="True">${gzipped}</Value></Binary></Entry>`,
    );
    await expect(
      withDecodedLimit(3 * 1024 * 1024, () => Kdbx.loadXml(xml, password())),
    ).rejects.toMatchObject({ code: Consts.ErrorCodes.ResourceLimit });
    await withDecodedLimit(5 * 1024 * 1024, async () => {
      await Kdbx.loadXml(xml, password());
    });
  });

  it("shares a budget between the payload and compressed XML binaries", async () => {
    const db = await createFixture({ cipher: "aes256", kdf: "aes", compression: "gzip" });
    const entry = db.getDefaultGroup().groups.find((group) => group.entries.length)!.entries[0]!;
    entry.binaries.set("large", await db.createBinary(new ArrayBuffer(2 * 1024 * 1024)));
    const build = db.buildXml.bind(db);
    const gzipped = gzipSync(Buffer.alloc(2 * 1024 * 1024)).toString("base64");
    db.buildXml = (ctx) => {
      build(ctx);
      const doc = db.xml!;
      const pool = doc.createElement("Binaries");
      const binary = doc.createElement("Binary");
      binary.setAttribute("ID", "100");
      binary.setAttribute("Compressed", "True");
      binary.textContent = gzipped;
      pool.appendChild(binary);
      doc.getElementsByTagName("Meta")[0]!.appendChild(pool);
    };
    const bytes = new Uint8Array(await db.save());
    await expect(
      withDecodedLimit(3 * 1024 * 1024, () => loadDatabase(bytes, password())),
    ).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
    await withDecodedLimit(5 * 1024 * 1024, async () => {
      await loadDatabase(bytes, password());
    });
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
