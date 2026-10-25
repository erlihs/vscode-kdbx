import { isDeepStrictEqual } from "node:util";
import { parentPort, workerData } from "node:worker_threads";
import { Kdbx, ProtectedValue } from "@keenext/kdbxweb";
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
  const loaded = await Kdbx.load(encrypted, credentials(SYNTHETIC_PASSWORD));
  if (!isDeepStrictEqual(snapshot(loaded), before)) {
    throw new DatabaseError("COMPATIBILITY", "Candidate lost supported fixture metadata on load.");
  }
  const entry = loaded.getDefaultGroup().groups.find((group) => group.entries.length)?.entries[0];
  if (!entry) throw new DatabaseError("COMPATIBILITY", "Candidate lost the fixture entry.");
  entry.pushHistory();
  entry.fields.set("Password", ProtectedValue.fromString("synthetic edited password"));
  const edited = snapshot(loaded);
  const saved = await loaded.save();
  inspectHeader(new Uint8Array(saved));
  const reopened = await Kdbx.load(saved, credentials(SYNTHETIC_PASSWORD));
  if (!isDeepStrictEqual(snapshot(reopened), edited)) {
    throw new DatabaseError("COMPATIBILITY", "Candidate lost supported metadata after editing.");
  }
  const savedAgain = await loaded.save();
  const secondHeader = inspectHeader(new Uint8Array(savedAgain));
  const freshRandomness = !Buffer.from(saved)
    .subarray(0, secondHeader.headerBytes)
    .equals(Buffer.from(savedAgain).subarray(0, secondHeader.headerBytes));
  if (!freshRandomness) {
    throw new DatabaseError("COMPATIBILITY", "Candidate reused per-save header randomness.");
  }

  // Characterize unknown XML loss instead of claiming preserveXml makes saves safe.
  const xml = await db.saveXml();
  const unknown = await Kdbx.loadXml(
    xml.replace("</Meta>", "<FutureMetadata>synthetic opaque data</FutureMetadata></Meta>"),
    credentials(SYNTHETIC_PASSWORD),
  );
  unknown.header.versionMinor = 1;
  const unknownSaved = await unknown.save();
  const unknownReloaded = await Kdbx.load(unknownSaved, credentials(SYNTHETIC_PASSWORD));
  const unknownXmlPreserved = (await unknownReloaded.saveXml()).includes("<FutureMetadata>");
  return {
    ok: true,
    report: {
      header,
      encryptedBytes: encrypted.byteLength,
      elapsedMs: Math.round(performance.now() - start),
      preserved: true,
      freshRandomness: true,
      unknownXmlPreserved,
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
