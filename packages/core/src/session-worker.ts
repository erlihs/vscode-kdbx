import { parentPort, workerData } from "node:worker_threads";
import { KdbxContext, KdbxError, ProtectedValue, XmlUtils } from "@keenext/kdbxweb";
import { loadDatabase, saveDatabase } from "./adapter.js";
import type { LoadedDatabase } from "./adapter.js";
import { credentials } from "./candidate.js";
import { DatabaseError } from "./errors.js";
import { INPUT_LIMITS, inspectHeader } from "./preflight.js";
import { isSessionRequest } from "./session-protocol.js";
import type { SessionCommand, SessionReply } from "./session-protocol.js";
import { scanXml } from "./xml-limits.js";
import { SerialQueue } from "./serial-queue.js";

if (typeof workerData !== "string" || !parentPort) {
  throw new DatabaseError("WORKER", "Invalid database worker initialization.");
}
const session: string = workerData;
const port = parentPort;
const queue = new SerialQueue();
let loaded: LoadedDatabase | undefined;

function unlocked(writable = false): LoadedDatabase {
  if (!loaded) throw new DatabaseError("LOCKED", "The database is locked.");
  if (writable && loaded.readOnlyReasons.length) {
    throw new DatabaseError(
      "READ_ONLY",
      "This database cannot be edited without losing unsupported data.",
    );
  }
  return loaded;
}

function checkModel(current: LoadedDatabase): void {
  const db = current.db;
  try {
    db.buildXml(new KdbxContext({ kdbx: db }));
    if (!db.xml) throw new DatabaseError("WORKER", "The database could not be serialized.");
    const nodes = db.xml.getElementsByTagName("*");
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]!;
      const protectedValue = XmlUtils.getNodeProtectedValue(node);
      // The writer inserts base64 ciphertext later. Include it without exposing plaintext.
      if (protectedValue) node.textContent = protectedValue.toString();
    }
    const xml = XmlUtils.serialize(db.xml);
    scanXml(xml);
    const xmlBytes = Buffer.byteLength(xml, "utf8");
    const binaryBytes = db.binaries
      .getAll()
      .reduce((size, binary) => size + binary.value.byteLength + 6, 0);
    if (xmlBytes + binaryBytes + 128 > INPUT_LIMITS.decodedBytes) {
      throw new DatabaseError(
        "RESOURCE_LIMIT",
        "The edited database exceeds the decoded-size limit.",
      );
    }
  } finally {
    db.xml = undefined;
  }
}

async function execute(command: SessionCommand): Promise<unknown> {
  switch (command.kind) {
    case "unlock": {
      if (loaded) throw new DatabaseError("INVALID_INPUT", "This session is already unlocked.");
      const key = credentials(command.password);
      command.password = "";
      try {
        loaded = await loadDatabase(new Uint8Array(command.bytes), key);
      } finally {
        new Uint8Array(command.bytes).fill(0);
      }
      return { readOnlyReasons: [...loaded.readOnlyReasons] };
    }
    case "list":
      return [...unlocked().db.getDefaultGroup().allEntries()].map((entry) => ({
        id: entry.uuid.toString(),
        title: typeof entry.fields.get("Title") === "string" ? entry.fields.get("Title") : "",
      }));
    case "createEntry": {
      const current = unlocked(true);
      const group = current.db.getDefaultGroup();
      const entry = current.db.createEntry(group);
      entry.fields.set("Title", command.title);
      try {
        checkModel(current);
      } catch (error) {
        group.entries.splice(group.entries.indexOf(entry), 1);
        throw error;
      }
      return entry.uuid.toString();
    }
    case "editEntry": {
      const current = unlocked(true);
      const db = current.db;
      const entry = [...db.getDefaultGroup().allEntries()].find(
        (candidate) => candidate.uuid.toString() === command.entryId,
      );
      if (!entry) throw new DatabaseError("INVALID_INPUT", "The selected entry no longer exists.");
      const fields = Object.entries(command.fields).map(
        ([name, field]) =>
          [name, field.protected ? ProtectedValue.fromString(field.value) : field.value] as const,
      );
      const previous = {
        fields: entry.fields,
        history: entry.history,
        editState: entry._editState,
        modified: entry.times.lastModTime,
      };
      entry.history = [...entry.history];
      entry._editState = structuredClone(entry._editState);
      try {
        entry.pushHistory();
        entry.fields = new Map(entry.fields);
        for (const [name, field] of fields) entry.fields.set(name, field);
        entry.times.lastModTime = new Date();
        checkModel(current);
      } catch (error) {
        entry.fields = previous.fields;
        entry.history = previous.history;
        entry._editState = previous.editState;
        entry.times.lastModTime = previous.modified;
        throw error;
      }
      return null;
    }
    case "changePassword": {
      const db = unlocked(true).db;
      const key = credentials(command.password);
      command.password = "";
      await key.ready;
      db.credentials = key;
      db.meta.keyChanged = new Date();
      return null;
    }
    case "serialize": {
      const current = unlocked(true);
      checkModel(current);
      const bytes = await saveDatabase(current);
      inspectHeader(new Uint8Array(bytes));
      return bytes;
    }
  }
}

port.on("message", (value: unknown) => {
  if (!isSessionRequest(value) || value.session !== session) {
    // A malformed protocol cannot be allowed to mutate an existing session.
    port.close();
    return;
  }
  void queue.run(async () => {
    let reply: SessionReply;
    try {
      const result = await execute(value.command);
      reply = { id: value.id, session, ok: true, result };
    } catch (error) {
      const failure =
        error instanceof KdbxError && error.code === "ResourceLimit"
          ? new DatabaseError("RESOURCE_LIMIT", "The edited database exceeds the local XML limits.")
          : error;
      reply = {
        id: value.id,
        session,
        ok: false,
        code: failure instanceof DatabaseError ? failure.code : "WORKER",
        message:
          failure instanceof DatabaseError
            ? failure.message
            : "The database worker operation failed.",
      };
    }
    const transfer = reply.ok && reply.result instanceof ArrayBuffer ? [reply.result] : [];
    port.postMessage(reply, transfer);
  });
});
