import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadDatabase, saveDatabase } from "../dist/adapter.js";
import { credentials } from "../dist/candidate.js";
import { SYNTHETIC_PASSWORD } from "../dist/fixture.js";
import { ADAPTER_EDIT, applyAdapterEdit, interopProblems } from "../dist/interop.js";

// Written by KeePassXC 2.8.0 via `pnpm interop -- --write-fixtures` (synthetic data only).
const directory = new URL("./fixtures/keepassxc/", import.meta.url);
const files = readdirSync(directory).filter((name) => name.endsWith(".kdbx"));
const password = () => credentials(SYNTHETIC_PASSWORD);

function expectations(name: string) {
  const imported = name === "keepassxc-import.kdbx";
  return { interopEntry: !imported, publicCustomData: !imported, attachments: true };
}

describe("independent KeePassXC-written fixtures", () => {
  it("covers every cipher/KDF/compression rewrite plus a KeePassXC-native import", () => {
    expect(files).toHaveLength(13);
  });

  it.each(files)("%s opens writable with all synthetic data intact", async (name) => {
    const loaded = await loadDatabase(
      new Uint8Array(readFileSync(new URL(name, directory))),
      password(),
    );
    expect(loaded.header.version).toBe("4.1");
    const [cipher, kdf, compression] = name.replace(".kdbx", "").split("-");
    if (name !== "keepassxc-import.kdbx") {
      expect(loaded.header).toMatchObject({ cipher, kdf, compression });
    }
    expect(loaded.readOnlyReasons).toEqual([]);
    expect(interopProblems(loaded.db, expectations(name))).toEqual([]);

    applyAdapterEdit(loaded.db);
    const reopened = await loadDatabase(new Uint8Array(await saveDatabase(loaded)), password());
    expect(reopened.readOnlyReasons).toEqual([]);
    expect(reopened.header).toEqual({ ...loaded.header, headerBytes: reopened.header.headerBytes });
    expect(interopProblems(reopened.db, expectations(name))).toEqual([]);
    const created = [...reopened.db.getDefaultGroup().allEntries()].find(
      (entry) => entry.fields.get("Title") === ADAPTER_EDIT.title,
    );
    expect(created?.fields.get(ADAPTER_EDIT.field)).toBeDefined();
  });
});
