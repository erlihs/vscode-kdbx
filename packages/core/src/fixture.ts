import { Consts, Int64, Kdbx, KdbxUuid, ProtectedValue, VarDictionary } from "@keenext/kdbxweb";
import { credentials } from "./candidate.js";
import type { Argon2Parameters } from "./defaults.js";
import type { Cipher, Kdf } from "./preflight.js";

export interface FixtureOptions {
  cipher: Cipher;
  kdf: Kdf;
  compression: "none" | "gzip";
  /** Real Argon2 cost instead of the cheap fixture parameters (Argon2 KDFs only). */
  argon2?: Argon2Parameters;
}

export const SYNTHETIC_PASSWORD = "synthetic-compatibility-only";
export const FIXTURE_DATE = new Date("2025-01-02T03:04:05Z");

/** Adds KeePass-shaped synthetic entries (two history states each) for sizing tests. */
export function addSyntheticEntries(db: Kdbx, count: number, offset = 0, noteChars = 0): void {
  const group = db.getDefaultGroup();
  const notes = "Synthetic note text for calibration only. ".padEnd(noteChars, "x");
  for (let index = offset; index < offset + count; index++) {
    const entry = db.createEntry(group);
    entry.fields.set("Title", `Synthetic entry ${index}`);
    entry.fields.set("UserName", `user${index}@example.invalid`);
    entry.fields.set("URL", `https://example.invalid/${index}`);
    entry.fields.set("Notes", notes);
    entry.tags = ["synthetic", "calibration"];
    for (let state = 0; state < 2; state++) {
      entry.fields.set("Password", ProtectedValue.fromString(`synthetic-${index}-${state}`));
      entry.pushHistory();
    }
    entry.fields.set("Password", ProtectedValue.fromString(`synthetic-${index}`));
  }
}

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
    // Deliberately cheap synthetic fixtures unless real cost is requested.
    const argon2 = options.argon2 ?? { memoryBytes: 1024 * 1024, iterations: 2, parallelism: 1 };
    parameters.set("M", VarDictionary.ValueType.UInt64, Int64.from(argon2.memoryBytes));
    parameters.set("I", VarDictionary.ValueType.UInt64, Int64.from(argon2.iterations));
    parameters.set("P", VarDictionary.ValueType.UInt32, argon2.parallelism);
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
