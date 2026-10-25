import { Consts, Int64, Kdbx, KdbxUuid, ProtectedValue, VarDictionary } from "@keenext/kdbxweb";
import { credentials } from "./candidate.js";
import type { Cipher, Kdf } from "./preflight.js";

export interface FixtureOptions {
  cipher: Cipher;
  kdf: Kdf;
  compression: "none" | "gzip";
}

export const SYNTHETIC_PASSWORD = "synthetic-compatibility-only";
export const FIXTURE_DATE = new Date("2025-01-02T03:04:05Z");

export async function createFixture(options: FixtureOptions): Promise<Kdbx> {
  const db = Kdbx.create(credentials(SYNTHETIC_PASSWORD), "Synthetic compatibility fixture");
  db.setVersion(4);
  db.header.versionMinor = 1;
  db.header.dataCipherUuid = new KdbxUuid(
    options.cipher === "aes256" ? Consts.CipherId.Aes : Consts.CipherId.ChaCha20,
  );
  db.header.compression = options.compression === "gzip" ? 1 : 0;
  db.setKdf(
    options.kdf === "aes"
      ? Consts.KdfId.Aes
      : options.kdf === "argon2d"
        ? Consts.KdfId.Argon2d
        : Consts.KdfId.Argon2id,
  );
  const parameters = db.header.kdfParameters;
  if (!parameters) throw new Error("Candidate did not initialize KDF parameters.");
  if (options.kdf === "aes") {
    parameters.set("R", VarDictionary.ValueType.UInt64, Int64.from(1000));
  } else {
    // Deliberately cheap synthetic fixtures, never product defaults.
    parameters.set("M", VarDictionary.ValueType.UInt64, Int64.from(1024 * 1024));
    parameters.set("I", VarDictionary.ValueType.UInt64, Int64.from(2));
    parameters.set("P", VarDictionary.ValueType.UInt32, 1);
    parameters.set("V", VarDictionary.ValueType.UInt32, 0x13);
  }
  const root = db.getDefaultGroup();
  root.tags = ["group-tag"];
  const group = db.createGroup(root, "Duplicate title");
  group.customData = new Map([
    ["plugin-group", { value: "opaque group data", lastModified: FIXTURE_DATE }],
  ]);
  const entry = db.createEntry(group);
  entry.fields.set("Title", "Duplicate title");
  entry.fields.set("UserName", "synthetic user\twith tab");
  entry.fields.set("Password", ProtectedValue.fromString("synthetic-secret"));
  entry.fields.set("URL", "https://example.invalid/");
  entry.fields.set("Notes", "Plain text only\n<script>synthetic</script>");
  entry.fields.set("custom", "custom value");
  entry.fields.set("protected-custom", ProtectedValue.fromString("synthetic protected value"));
  entry.fields.set("empty-protected", ProtectedValue.fromString(""));
  entry.times.creationTime = FIXTURE_DATE;
  entry.times.lastModTime = FIXTURE_DATE;
  entry.tags = ["one", "two"];
  entry.qualityCheck = false;
  entry.previousParentGroup = root.uuid;
  entry.customData = new Map([
    ["plugin-entry", { value: "opaque entry data", lastModified: FIXTURE_DATE }],
  ]);
  entry.autoType.items = [
    { window: "synthetic window", keystrokeSequence: "{USERNAME}{TAB}{PASSWORD}" },
  ];
  entry.binaries.set(
    "..\\untrusted-name.cer",
    await db.createBinary(new Uint8Array([0, 255, 128, 13, 10]).buffer),
  );
  entry.binaries.set("empty", await db.createBinary(new ArrayBuffer(0)));
  entry.binaries.set(
    "duplicate",
    await db.createBinary(new Uint8Array([0, 255, 128, 13, 10]).buffer),
  );
  entry.pushHistory();
  entry.fields.set("Password", ProtectedValue.fromString("synthetic-new-secret"));
  const duplicate = db.createEntry(group);
  duplicate.fields.set("Title", "Duplicate title");
  duplicate.fields.set("Password", ProtectedValue.fromString("synthetic duplicate password"));
  db.meta.customData.set("plugin-meta", { value: "opaque metadata", lastModified: FIXTURE_DATE });
  db.meta.customIcons.set(KdbxUuid.random().toString(), {
    data: new Uint8Array([1, 2, 3]).buffer,
    name: "synthetic icon",
    lastModified: FIXTURE_DATE,
  });
  db.header.publicCustomData = new VarDictionary();
  db.header.publicCustomData.set("synthetic", VarDictionary.ValueType.String, "public metadata");
  db.addDeletedObject(KdbxUuid.random(), FIXTURE_DATE);
  for (const object of root.allGroupsAndEntries()) {
    object.times.creationTime = FIXTURE_DATE;
    object.times.lastModTime = FIXTURE_DATE;
  }
  return db;
}
