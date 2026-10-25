import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadDatabase, saveDatabase } from "../dist/adapter.js";
import { credentials } from "../dist/candidate.js";
import { SYNTHETIC_PASSWORD } from "../dist/fixture.js";
import { ADAPTER_EDIT, applyAdapterEdit, interopProblems } from "../dist/interop.js";

// Written by KeePass 2.61.1 and KeePassXC 2.8.0 via `pnpm interop -- --app <app> --write-fixtures`
// from synthetic data only.
const applications = [
  { app: "keepass", count: 12 },
  { app: "keepassxc", count: 13 },
];
const password = () => credentials(SYNTHETIC_PASSWORD);

describe.each(applications)("independent $app-written fixtures", ({ app, count }) => {
  const directory = new URL(`./fixtures/${app}/`, import.meta.url);
  const files = readdirSync(directory).filter((name) => name.endsWith(".kdbx"));
  const imported = (name: string) => name === `${app}-import.kdbx`;
  const expectations = (name: string) => ({
    interopEntry: !imported(name),
    publicCustomData: !imported(name),
    attachments: true,
  });

  it("covers every cipher/KDF/compression rewrite", () => {
    expect(files).toHaveLength(count);
  });

  it.each(files)("%s opens writable with all synthetic data intact", async (name) => {
    const loaded = await loadDatabase(
      new Uint8Array(readFileSync(new URL(name, directory))),
      password(),
    );
    expect(loaded.header.version).toBe("4.1");
    if (!imported(name)) {
      const [cipher, kdf, compression] = name.replace(".kdbx", "").split("-");
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
