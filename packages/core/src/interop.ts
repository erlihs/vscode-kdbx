import { Kdbx, KdbxEntry, ProtectedValue } from "@keenext/kdbxweb";
import type { KdbxBinary, KdbxBinaryWithHash } from "@keenext/kdbxweb";
import { credentials } from "./candidate.js";
import { FIXTURE_DATE, SYNTHETIC_PASSWORD } from "./fixture.js";

// Synthetic-fixture oracle only. It compares known synthetic values after another
// application rewrote a fixture; never use it with real databases.

export const INTEROP_ENTRY = Object.freeze({
  path: "/kpxc-entry",
  title: "kpxc-entry",
  userName: "kpxc-user",
  password: "kpxc-secret",
});

export const ADAPTER_EDIT = Object.freeze({
  path: "/adapter-entry",
  title: "adapter-entry",
  field: "adapter-edit",
  value: "written by adapter",
});

/** Creates a root entry and, if present, edits the KeePassXC-added entry. */
export function applyAdapterEdit(db: Kdbx): void {
  const created = db.createEntry(db.getDefaultGroup());
  created.fields.set("Title", ADAPTER_EDIT.title);
  created.fields.set(ADAPTER_EDIT.field, ProtectedValue.fromString(ADAPTER_EDIT.value));
  const added = [...db.getDefaultGroup().allEntries()].find(
    (item) => item.fields.get("Title") === INTEROP_ENTRY.title,
  );
  if (added) {
    added.pushHistory();
    added.fields.set(ADAPTER_EDIT.field, ProtectedValue.fromString(ADAPTER_EDIT.value));
  }
}

/** Checks a decrypted XML export produced by another application. */
export async function exportedXmlProblems(
  xml: string,
  expected: InteropExpectations,
): Promise<string[]> {
  const db = await Kdbx.loadXml(xml, credentials(SYNTHETIC_PASSWORD));
  const problems = interopProblems(db, expected);
  const entries = [...db.getDefaultGroup().allEntries()];
  const edited = (title: string): KdbxEntry | undefined =>
    entries.find(
      (item) =>
        item.fields.get("Title") === title &&
        sameField(item, ADAPTER_EDIT.field, { protected: ADAPTER_EDIT.value }),
    );
  if (!edited(ADAPTER_EDIT.title)) problems.push("adapter-created entry is missing");
  if (expected.interopEntry && edited(INTEROP_ENTRY.title)?.history.length !== 1) {
    problems.push("adapter edit of the KeePassXC entry is missing");
  }
  return problems;
}

export interface InteropExpectations {
  /** KeePassXC added `INTEROP_ENTRY` with its own writer. */
  interopEntry: boolean;
  /** Public header custom data cannot survive an XML import. */
  publicCustomData: boolean;
  /** KeePassXC XML exports omit attachment contents; verify those separately. */
  attachments: boolean;
}

/** Synthetic attachment names and expected hex contents of the fixture entry. */
export const FIXTURE_ATTACHMENTS: readonly (readonly [string, string])[] = [
  ["..\\untrusted-name.cer", "00ff800d0a"],
  ["duplicate", "00ff800d0a"],
  ["empty", ""],
];

export function interopProblems(db: Kdbx, expected: InteropExpectations): string[] {
  const problems: string[] = [];
  const check = (ok: boolean, problem: string): void => {
    if (!ok) problems.push(problem);
  };
  const entries = [...db.getDefaultGroup().allEntries()];
  const entry = entries.find((item) => item.fields.get("custom") === "custom value");
  if (!entry) return ["fixture entry is missing"];

  check(entry.parentGroup?.name === "Duplicate title", "fixture entry moved");
  const fields: [string, string | { protected: string }][] = [
    ["Title", "Duplicate title"],
    ["UserName", "synthetic user\twith tab"],
    ["Password", { protected: "synthetic-new-secret" }],
    ["URL", "https://example.invalid/"],
    ["Notes", "Plain text only\n<script>synthetic</script>"],
    ["custom", "custom value"],
    ["protected-custom", { protected: "synthetic protected value" }],
    ["empty-protected", { protected: "" }],
  ];
  for (const [name, value] of fields) {
    check(sameField(entry, name, value), `field ${name} changed`);
  }
  if (expected.attachments) {
    for (const [name, hex] of FIXTURE_ATTACHMENTS) {
      check(binary(entry, name) === hex, `attachment ${name} changed`);
    }
  }
  check(entry.history.length === 1, "history length changed");
  const old = entry.history[0];
  check(
    !!old && sameField(old, "Password", { protected: "synthetic-secret" }),
    "history password changed",
  );
  check(entry.tags.join() === "one,two", "entry tags changed");
  check(entry.qualityCheck === false, "quality-check flag changed");
  check(!!entry.previousParentGroup, "previous parent group lost");
  check(entry.times.creationTime?.getTime() === FIXTURE_DATE.getTime(), "creation time changed");
  check(
    entry.customData?.get("plugin-entry")?.value === "opaque entry data",
    "entry custom data lost",
  );
  check(
    entry.autoType.items.some(
      (item) =>
        item.window === "synthetic window" &&
        item.keystrokeSequence === "{USERNAME}{TAB}{PASSWORD}",
    ),
    "auto-type association lost",
  );
  check(
    entries.some(
      (item) =>
        item !== entry &&
        item.fields.get("Title") === "Duplicate title" &&
        sameField(item, "Password", { protected: "synthetic duplicate password" }),
    ),
    "duplicate-title entry lost",
  );
  check(db.getDefaultGroup().tags.join() === "group-tag", "group tags changed");
  check(
    db
      .getDefaultGroup()
      .groups.some((group) => group.customData?.get("plugin-group")?.value === "opaque group data"),
    "group custom data lost",
  );
  const meta = db.meta.customData.get("plugin-meta");
  check(
    meta?.value === "opaque metadata" && meta.lastModified?.getTime() === FIXTURE_DATE.getTime(),
    "metadata custom data changed",
  );
  check(
    [...db.meta.customIcons.values()].some(
      (icon) =>
        icon.name === "synthetic icon" && Buffer.from(icon.data).toString("hex") === "010203",
    ),
    "custom icon changed",
  );
  check(db.deletedObjects.length === 1, "deleted-object records changed");
  const recycleBin = db
    .getDefaultGroup()
    .groups.find(
      (group) => group.uuid.equals(db.meta.recycleBinUuid) && group.name === "Recycle Bin",
    );
  check(db.meta.recycleBinEnabled === true && !!recycleBin, "recycle bin reference lost");
  if (expected.publicCustomData) {
    check(
      db.header.publicCustomData?.get("synthetic") === "public metadata",
      "public custom data lost",
    );
  }
  if (expected.interopEntry) {
    const added = entries.find((item) => item.fields.get("Title") === INTEROP_ENTRY.title);
    check(
      !!added &&
        added.fields.get("UserName") === INTEROP_ENTRY.userName &&
        sameField(added, "Password", { protected: INTEROP_ENTRY.password }),
      "KeePassXC-added entry is wrong",
    );
  }
  return problems;
}

function sameField(entry: KdbxEntry, name: string, value: string | { protected: string }): boolean {
  const field = entry.fields.get(name);
  return typeof value === "string"
    ? field === value
    : field instanceof ProtectedValue && field.getText() === value.protected;
}

function binary(entry: KdbxEntry, name: string): string | undefined {
  const value: KdbxBinary | KdbxBinaryWithHash | undefined = entry.binaries.get(name);
  if (value === undefined) return undefined;
  const data =
    value instanceof ProtectedValue || value instanceof ArrayBuffer ? value : value.value;
  const bytes = data instanceof ProtectedValue ? data.getBinary() : new Uint8Array(data);
  return Buffer.from(bytes).toString("hex");
}
