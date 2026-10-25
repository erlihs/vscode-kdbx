import { isDeepStrictEqual } from "node:util";
import { parentPort, workerData } from "node:worker_threads";
import { ProtectedValue } from "@keenext/kdbxweb";
import type { KdbxContext } from "@keenext/kdbxweb";
import { loadDatabase, saveDatabase } from "./adapter.js";
import { credentials } from "./candidate.js";
import { DatabaseError } from "./errors.js";
import { createFixture, SYNTHETIC_PASSWORD } from "./fixture.js";
import type { FixtureOptions } from "./fixture.js";
import { inspectHeader } from "./preflight.js";
import type { WorkerReply } from "./probe.js";
import { snapshot } from "./snapshot.js";

async function probe(options: FixtureOptions): Promise<WorkerReply> {
  const start = performance.now();
  const db = await createFixture(options);
  const before = snapshot(db);
  const encrypted = await db.save();
  const header = inspectHeader(new Uint8Array(encrypted));
  const loaded = await loadDatabase(new Uint8Array(encrypted), credentials(SYNTHETIC_PASSWORD));
  if (loaded.readOnlyReasons.length) {
    throw new DatabaseError("COMPATIBILITY", "A fully modeled fixture was opened read-only.");
  }
  if (!isDeepStrictEqual(snapshot(loaded.db), before)) {
    throw new DatabaseError("COMPATIBILITY", "Candidate lost supported fixture metadata on load.");
  }
  const entry = loaded.db.getDefaultGroup().groups.find((group) => group.entries.length)
    ?.entries[0];
  if (!entry) throw new DatabaseError("COMPATIBILITY", "Candidate lost the fixture entry.");
  entry.pushHistory();
  entry.fields.set("Password", ProtectedValue.fromString("synthetic edited password"));
  const edited = snapshot(loaded.db);
  const saved = await saveDatabase(loaded);
  inspectHeader(new Uint8Array(saved));
  const reopened = await loadDatabase(new Uint8Array(saved), credentials(SYNTHETIC_PASSWORD));
  if (reopened.readOnlyReasons.length || !isDeepStrictEqual(snapshot(reopened.db), edited)) {
    throw new DatabaseError("COMPATIBILITY", "Candidate lost supported metadata after editing.");
  }
  const savedAgain = await saveDatabase(loaded);
  const secondHeader = inspectHeader(new Uint8Array(savedAgain));
  const freshRandomness = !Buffer.from(saved)
    .subarray(0, secondHeader.headerBytes)
    .equals(Buffer.from(savedAgain).subarray(0, secondHeader.headerBytes));
  if (!freshRandomness) {
    throw new DatabaseError("COMPATIBILITY", "Candidate reused per-save header randomness.");
  }

  // Unmodeled XML must make the database read-only instead of being dropped on save.
  const build = db.buildXml.bind(db);
  db.buildXml = (ctx: KdbxContext) => {
    build(ctx);
    const meta = db.xml?.getElementsByTagName("Meta")[0];
    const unknown = db.xml?.createElement("FutureMetadata");
    if (!meta || !unknown) throw new DatabaseError("COMPATIBILITY", "Fixture has no metadata.");
    unknown.textContent = "synthetic opaque data";
    meta.appendChild(unknown);
  };
  const withUnknown = await loadDatabase(
    new Uint8Array(await db.save()),
    credentials(SYNTHETIC_PASSWORD),
  );
  const unknownDataRefused = await saveDatabase(withUnknown).then(
    () => false,
    (error: unknown) => error instanceof DatabaseError && error.code === "READ_ONLY",
  );
  if (!unknownDataRefused) {
    throw new DatabaseError("COMPATIBILITY", "Unmodeled XML was not refused on save.");
  }
  return {
    ok: true,
    report: {
      header,
      encryptedBytes: encrypted.byteLength,
      elapsedMs: Math.round(performance.now() - start),
      preserved: true,
      freshRandomness: true,
      unknownDataRefused: true,
    },
  };
}

try {
  parentPort?.postMessage(await probe(workerData));
} catch (error) {
  const reply: WorkerReply =
    error instanceof DatabaseError
      ? { ok: false, code: error.code, message: error.message }
      : {
          ok: false,
          code: "COMPATIBILITY",
          message: "Candidate failed the synthetic round-trip probe.",
        };
  parentPort?.postMessage(reply);
}
