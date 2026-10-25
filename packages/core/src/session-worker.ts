import { parentPort, workerData } from "node:worker_threads";
import {
  ByteUtils,
  Consts,
  CryptoEngine,
  Int64,
  Kdbx,
  KdbxBinaries,
  KdbxContext,
  KdbxEntry,
  KdbxError,
  KdbxGroup,
  KdbxUuid,
  ProtectedValue,
  VarDictionary,
  XmlUtils,
} from "@keenext/kdbxweb";
import { loadDatabase, saveDatabase } from "./adapter.js";
import type { LoadedDatabase } from "./adapter.js";
import { credentials, measureArgon2id } from "./candidate.js";
import { calibrateArgon2id } from "./defaults.js";
import { DatabaseError } from "./errors.js";
import { INPUT_LIMITS, inspectHeader } from "./preflight.js";
import { isSessionRequest } from "./session-protocol.js";
import type { SessionCommand, SessionReply } from "./session-protocol.js";
import { scanXml } from "./xml-limits.js";
import { SerialQueue } from "./serial-queue.js";
import { WorkerEdits } from "./worker-edits.js";

if (typeof workerData !== "string" || !parentPort) {
  throw new DatabaseError("WORKER", "Invalid database worker initialization.");
}
const session: string = workerData;
const port = parentPort;
const queue = new SerialQueue();
let loaded: LoadedDatabase | undefined;
let edits: WorkerEdits | undefined;

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
  const group = (id: string): KdbxGroup => {
    const found = unlocked().db.getGroup(id);
    if (!found) throw new DatabaseError("INVALID_INPUT", "The selected group no longer exists.");
    return found;
  };
  const entry = (id: string): KdbxEntry => {
    const found = unlocked()
      .db.groups.flatMap((root) => [...root.allEntries()])
      .find((candidate) => candidate.uuid.toString() === id);
    if (!found) throw new DatabaseError("INVALID_INPUT", "The selected entry no longer exists.");
    return found;
  };
  const plain = (value: string | ProtectedValue | undefined): string =>
    typeof value === "string" ? value : "";
  const binary = (value: Parameters<typeof KdbxBinaries.isKdbxBinaryWithHash>[0]) => {
    if (KdbxBinaries.isKdbxBinaryWithHash(value)) return value.value;
    if (value instanceof ArrayBuffer || value instanceof ProtectedValue) return value;
    throw new DatabaseError("INVALID_INPUT", "The selected attachment no longer exists.");
  };
  switch (command.kind) {
    case "unlock": {
      if (loaded) throw new DatabaseError("INVALID_INPUT", "This session is already unlocked.");
      const key = credentials(command.password);
      command.password = "";
      try {
        loaded = await loadDatabase(new Uint8Array(command.bytes), key);
        edits = new WorkerEdits(loaded.db);
      } finally {
        new Uint8Array(command.bytes).fill(0);
      }
      return { readOnlyReasons: [...loaded.readOnlyReasons] };
    }
    case "newDatabase": {
      if (loaded) throw new DatabaseError("INVALID_INPUT", "This session is already unlocked.");
      const key = credentials(command.password);
      command.password = "";
      const { parameters } = await calibrateArgon2id(measureArgon2id);
      const db = Kdbx.create(key, "Database");
      db.setVersion(4);
      db.header.versionMinor = 1;
      db.header.dataCipherUuid = new KdbxUuid(Consts.CipherId.Aes);
      db.setKdf(Consts.KdfId.Argon2id);
      const kdf = db.header.kdfParameters!;
      kdf.set("M", VarDictionary.ValueType.UInt64, Int64.from(parameters.memoryBytes));
      kdf.set("I", VarDictionary.ValueType.UInt64, Int64.from(parameters.iterations));
      kdf.set("P", VarDictionary.ValueType.UInt32, parameters.parallelism);
      kdf.set("V", VarDictionary.ValueType.UInt32, 0x13);
      const bytes = await db.save();
      loaded = { db, header: inspectHeader(new Uint8Array(bytes)), readOnlyReasons: [] };
      edits = new WorkerEdits(db);
      return { readOnlyReasons: [] };
    }
    case "recover":
      unlocked();
      return edits!.recover(command.credentialsChanged);
    case "markSaved":
      unlocked();
      return edits!.markSaved();
    case "listGroups":
      return unlocked()
        .db.groups.flatMap((root) => [...root.allGroups()])
        .map((item) => ({
          id: item.uuid.toString(),
          parentId: item.parentGroup?.uuid.toString() ?? null,
          name: item.name ?? "",
          recycleBin: item.uuid.equals(unlocked().db.meta.recycleBinUuid!),
        }));
    case "list":
      return unlocked()
        .db.groups.flatMap((root) => [...root.allEntries()])
        .map((item) => ({
          id: item.uuid.toString(),
          title: plain(item.fields.get("Title")),
          groupId: item.parentGroup!.uuid.toString(),
          username: plain(item.fields.get("UserName")),
          url: plain(item.fields.get("URL")),
          tags: [...item.tags],
        }));
    case "getEntry": {
      const item = entry(command.entryId);
      return {
        id: item.uuid.toString(),
        groupId: item.parentGroup!.uuid.toString(),
        fields: Object.fromEntries(
          [...item.fields].map(([name, value]) => [
            name,
            value instanceof ProtectedValue ? { protected: true } : { value, protected: false },
          ]),
        ),
        tags: [...item.tags],
        created: item.times.creationTime?.toISOString(),
        modified: item.times.lastModTime?.toISOString(),
        historyCount: item.history.length,
        attachments: [...item.binaries].map(([name, value]) => {
          const data = binary(value);
          return { name, size: data.byteLength, protected: data instanceof ProtectedValue };
        }),
      };
    }
    case "readField": {
      const value = entry(command.entryId).fields.get(command.name);
      if (value === undefined)
        throw new DatabaseError("INVALID_INPUT", "The selected field no longer exists.");
      return value instanceof ProtectedValue ? value.getText() : value;
    }
    case "listHistory":
      return entry(command.entryId).history.map((item, index) => ({
        index,
        modified: item.times.lastModTime?.toISOString(),
      }));
    case "exportAttachment": {
      const value = binary(entry(command.entryId).binaries.get(command.name));
      return value instanceof ProtectedValue ? value.getBinary().slice().buffer : value.slice(0);
    }
    case "serialize": {
      const current = unlocked(true);
      checkModel(current);
      const bytes = await saveDatabase(current);
      inspectHeader(new Uint8Array(bytes));
      return bytes;
    }
    case "undo":
    case "redo": {
      const current = unlocked(true);
      return edits!.travel(command.kind === "redo", () => checkModel(current));
    }
    default: {
      const current = unlocked(true);
      const db = current.db;
      return edits!.run(
        async (touch) => {
          const move = (object: KdbxEntry | KdbxGroup, parent: KdbxGroup | null): void => {
            if (object instanceof KdbxGroup) {
              if (!object.parentGroup)
                throw new DatabaseError(
                  "INVALID_INPUT",
                  "The root group cannot be moved or deleted.",
                );
              for (let ancestor = parent; ancestor; ancestor = ancestor.parentGroup ?? null) {
                if (ancestor === object)
                  throw new DatabaseError(
                    "INVALID_INPUT",
                    "A group cannot be moved inside itself.",
                  );
              }
            }
            touch(object);
            if (object.parentGroup) touch(object.parentGroup);
            if (parent) touch(parent);
            else touch(db, ["deletedObjects"]);
            db.move(object, parent);
          };
          const remove = (object: KdbxEntry | KdbxGroup, permanent: boolean): void => {
            if (
              object instanceof KdbxGroup &&
              (!object.parentGroup || object.uuid.equals(db.meta.recycleBinUuid!))
            ) {
              throw new DatabaseError(
                "INVALID_INPUT",
                "The root and recycle bin groups cannot be deleted.",
              );
            }
            if (permanent) move(object, null);
            else {
              touch(db.meta);
              touch(db.getDefaultGroup());
              db.createRecycleBin();
              move(object, db.getGroup(db.meta.recycleBinUuid!)!);
            }
          };
          const edit = (item: KdbxEntry): void => {
            touch(item);
            item.pushHistory();
            item.times.lastModTime = new Date();
          };
          switch (command.kind) {
            case "createGroup": {
              const parent = group(command.parentId);
              touch(parent);
              return db.createGroup(parent, command.name).uuid.toString();
            }
            case "renameGroup": {
              const item = group(command.groupId);
              touch(item);
              item.name = command.name;
              item.times.lastModTime = new Date();
              return null;
            }
            case "moveGroup":
              move(group(command.groupId), group(command.parentId));
              return null;
            case "deleteGroup":
              remove(group(command.groupId), command.permanent);
              return null;
            case "createEntry": {
              const parent = command.groupId ? group(command.groupId) : db.getDefaultGroup();
              touch(parent);
              const item = db.createEntry(parent);
              item.fields.set("Title", command.title);
              return item.uuid.toString();
            }
            case "duplicateEntry": {
              const source = entry(command.entryId);
              const parent = source.parentGroup!;
              touch(parent);
              const item = new KdbxEntry();
              item.copyFrom(source);
              item.uuid = KdbxUuid.random();
              item.parentGroup = parent;
              item.previousParentGroup = undefined;
              item.history = source.history.map((history) => {
                const copy = new KdbxEntry();
                copy.copyFrom(history);
                copy.uuid = item.uuid;
                return copy;
              });
              parent.entries.push(item);
              return item.uuid.toString();
            }
            case "deleteEntry":
              remove(entry(command.entryId), command.permanent);
              return null;
            case "editEntry":
            case "updateEntry": {
              const item = entry(command.entryId);
              const update =
                command.kind === "editEntry" ? { fields: command.fields } : command.update;
              const parent = update.groupId ? group(update.groupId) : undefined;
              edit(item);
              for (const name of update.removeFields ?? []) item.fields.delete(name);
              for (const [name, field] of Object.entries(update.fields ?? {})) {
                item.fields.set(
                  name,
                  field.protected ? ProtectedValue.fromString(field.value) : field.value,
                );
              }
              if (update.tags) item.tags = [...update.tags];
              if (parent && parent !== item.parentGroup) move(item, parent);
              return null;
            }
            case "restoreHistory": {
              const item = entry(command.entryId);
              const history = item.history[command.index];
              if (!history)
                throw new DatabaseError(
                  "INVALID_INPUT",
                  "The selected history item no longer exists.",
                );
              edit(item);
              item.copyFrom(history);
              item.times.lastModTime = new Date();
              return null;
            }
            case "importAttachment": {
              const item = entry(command.entryId);
              edit(item);
              const hash = ByteUtils.bytesToHex(await CryptoEngine.sha256(command.bytes));
              const existing = db.binaries.getValueByHash(hash);
              if (existing) {
                item.binaries.set(command.name, { hash, value: existing });
                return null;
              }
              const slot = {
                get value() {
                  return db.binaries.getValueByHash(hash);
                },
                set value(value: ReturnType<typeof db.binaries.getValueByHash>) {
                  if (value) db.binaries.addWithHash({ hash, value });
                  else db.binaries.deleteWithHash(hash);
                },
              };
              touch(slot);
              item.binaries.set(command.name, await db.createBinary(command.bytes.slice(0)));
              return null;
            }
            case "renameAttachment":
            case "removeAttachment": {
              const item = entry(command.entryId);
              const value = item.binaries.get(command.name);
              if (!value)
                throw new DatabaseError(
                  "INVALID_INPUT",
                  "The selected attachment no longer exists.",
                );
              if (
                command.kind === "renameAttachment" &&
                command.name !== command.newName &&
                item.binaries.has(command.newName)
              ) {
                throw new DatabaseError(
                  "INVALID_INPUT",
                  "An attachment with the new name already exists.",
                );
              }
              edit(item);
              item.binaries.delete(command.name);
              if (command.kind === "renameAttachment") item.binaries.set(command.newName, value);
              return null;
            }
            case "changePassword": {
              const key = credentials(command.password);
              command.password = "";
              await key.ready;
              touch(db, ["credentials"]);
              touch(db.meta);
              db.credentials = key;
              db.meta.keyChanged = new Date();
              return null;
            }
          }
        },
        () => checkModel(current),
      );
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
