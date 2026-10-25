import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { BinaryStream, Kdbx, KdbxContext, VarDictionary } from "@keenext/kdbxweb";
import { loadDatabase, saveDatabase } from "../dist/adapter.js";
import { credentials } from "../dist/candidate.js";
import { createFixture, SYNTHETIC_PASSWORD } from "../dist/fixture.js";
import { snapshot } from "../dist/snapshot.js";

const password = () => credentials(SYNTHETIC_PASSWORD);

async function fixture(): Promise<Kdbx> {
  return createFixture({ cipher: "aes256", kdf: "argon2id", compression: "gzip" });
}

/** Saves a fixture whose XML is altered after the candidate builds it. */
async function saveWithXml(db: Kdbx, mutate: (doc: Document) => void): Promise<Uint8Array> {
  const build = db.buildXml.bind(db);
  db.buildXml = (ctx: KdbxContext) => {
    build(ctx);
    mutate(db.xml!);
  };
  try {
    return new Uint8Array(await db.save());
  } finally {
    db.buildXml = build;
  }
}

function append(doc: Document, parent: string, name: string, text?: string): Element {
  const node = doc.createElement(name);
  if (text !== undefined) node.textContent = text;
  doc.getElementsByTagName(parent)[0]!.appendChild(node);
  return node;
}

describe("unknown-data policy: preserve exactly or refuse writing", () => {
  it("keeps a fully modeled database writable and round-trips it", async () => {
    const db = await fixture();
    const loaded = await loadDatabase(new Uint8Array(await db.save()), password());
    expect(loaded.readOnlyReasons).toEqual([]);
    expect(loaded.db.xml).toBeUndefined();
    const reopened = await Kdbx.load(await saveDatabase(loaded), password());
    expect(isDeepStrictEqual(snapshot(reopened), snapshot(db))).toBe(true);
  });

  it.each([
    ["unknown metadata element", (doc: Document) => append(doc, "Meta", "FutureMetadata", "x")],
    ["empty unknown element", (doc: Document) => append(doc, "Entry", "FutureFlag")],
    ["unknown nested element", (doc: Document) => append(doc, "Group", "Future", "y")],
    [
      "unknown attribute",
      (doc: Document) => doc.getElementsByTagName("Entry")[0]!.setAttribute("Future", "z"),
    ],
    [
      "value the model normalizes",
      (doc: Document) => {
        doc.getElementsByTagName("EnableAutoType")[0]!.textContent = "maybe";
      },
    ],
  ])("refuses to write a database with an %s", async (_name, mutate) => {
    const bytes = await saveWithXml(await fixture(), mutate);
    const loaded = await loadDatabase(bytes, password());
    expect(loaded.readOnlyReasons).toEqual([
      "The file contains XML data this version cannot save.",
    ]);
    await expect(saveDatabase(loaded)).rejects.toMatchObject({ code: "READ_ONLY" });
  });

  it("treats equivalent KeePassXC spellings as lossless", async () => {
    const bytes = await saveWithXml(await fixture(), (doc) => {
      doc.getElementsByTagName("EnableAutoType")[0]!.textContent = "false";
      doc.getElementsByTagName("Tags")[1]!.textContent = "one,two";
      append(doc, "AutoType", "DefaultSequence");
    });
    expect((await loadDatabase(bytes, password())).readOnlyReasons).toEqual([]);
  });

  it("treats KeePass spellings and its writer stamp as lossless", async () => {
    const bytes = await saveWithXml(await fixture(), (doc) => {
      doc.getElementsByTagName("Generator")[0]!.textContent = "KeePass";
      doc.getElementsByTagName("EnableSearching")[0]!.textContent = "Null";
      doc.getElementsByTagName("Tags")[1]!.textContent = "one;two";
    });
    expect((await loadDatabase(bytes, password())).readOnlyReasons).toEqual([]);
  });

  it("refuses a tag the candidate would split differently", async () => {
    const bytes = await saveWithXml(await fixture(), (doc) => {
      doc.getElementsByTagName("Tags")[1]!.textContent = "one:two";
    });
    expect((await loadDatabase(bytes, password())).readOnlyReasons).toHaveLength(1);
  });

  it("refuses to write a database with an unknown inner header field", async () => {
    const db = await fixture();
    const write = db.header.writeInnerHeader.bind(db.header);
    db.header.writeInnerHeader = (stm: BinaryStream, ctx: KdbxContext) => {
      stm.setUint8(0x7f);
      stm.setUint32(1, true);
      stm.setUint8(1);
      write(stm, ctx);
    };
    const loaded = await loadDatabase(new Uint8Array(await db.save()), password());
    expect(loaded.readOnlyReasons).toEqual([
      "The file contains header fields this version cannot save.",
    ]);
    await expect(saveDatabase(loaded)).rejects.toMatchObject({ code: "READ_ONLY" });
  });

  it("refuses Argon2 1.0 during preflight, before any key derivation", async () => {
    const db = await fixture();
    db.header.kdfParameters!.set("V", VarDictionary.ValueType.UInt32, 0x10);
    db.header.generateSalts();
    const stream = new BinaryStream();
    db.header.write(stream);
    const header = new Uint8Array(stream.getWrittenBytes());
    const bytes = new Uint8Array(header.byteLength + 64);
    bytes.set(header);
    bytes.set(createHash("sha256").update(header).digest(), header.byteLength);
    await expect(loadDatabase(bytes, password())).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: "Only Argon2 version 1.3 is supported by the selected provider.",
    });
  });

  it("maps wrong credentials without exposing library errors", async () => {
    const bytes = new Uint8Array(await (await fixture()).save());
    await expect(
      loadDatabase(bytes, credentials("wrong synthetic password")),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_OR_INTEGRITY" });
  });
});
