import type { ErrorCode } from "./errors.js";

export interface EntryFieldEdit {
  value: string;
  protected: boolean;
}

export interface EntryUpdate {
  fields?: Record<string, EntryFieldEdit>;
  removeFields?: string[];
  tags?: string[];
  groupId?: string;
}

export interface GroupSummary {
  id: string;
  parentId: string | null;
  name: string;
  recycleBin: boolean;
}

export interface EntrySummary {
  id: string;
  title: string;
  groupId: string;
  username: string;
  url: string;
  tags: string[];
}

export interface EntryDetails {
  id: string;
  groupId: string;
  fields: Record<string, { value?: string; protected: boolean }>;
  tags: string[];
  created: string | undefined;
  modified: string | undefined;
  historyCount: number;
  attachments: { name: string; size: number; protected: boolean }[];
}

export interface HistorySummary {
  index: number;
  modified: string | undefined;
}

export interface WorkerState {
  revision: number;
  dirty: boolean;
  credentialsChanged: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

export type SessionCommand =
  | { kind: "unlock"; bytes: ArrayBuffer; password: string }
  | { kind: "newDatabase"; password: string }
  | { kind: "recover"; credentialsChanged: boolean }
  | { kind: "list" | "listGroups" | "serialize" | "undo" | "redo" | "markSaved" }
  | { kind: "getEntry" | "duplicateEntry" | "listHistory"; entryId: string }
  | { kind: "readField"; entryId: string; name: string }
  | { kind: "createEntry"; title: string; groupId?: string }
  | { kind: "editEntry"; entryId: string; fields: Record<string, EntryFieldEdit> }
  | { kind: "updateEntry"; entryId: string; update: EntryUpdate }
  | { kind: "createGroup"; parentId: string; name: string }
  | { kind: "renameGroup"; groupId: string; name: string }
  | { kind: "moveGroup"; groupId: string; parentId: string }
  | { kind: "deleteGroup"; groupId: string; permanent: boolean }
  | { kind: "deleteEntry"; entryId: string; permanent: boolean }
  | { kind: "restoreHistory"; entryId: string; index: number }
  | { kind: "importAttachment"; entryId: string; name: string; bytes: ArrayBuffer }
  | { kind: "exportAttachment" | "removeAttachment"; entryId: string; name: string }
  | { kind: "renameAttachment"; entryId: string; name: string; newName: string }
  | { kind: "changePassword"; password: string };

export interface SessionRequest {
  id: number;
  session: string;
  command: SessionCommand;
}

export type SessionReply =
  | { id: number; session: string; ok: true; result: unknown }
  | { id: number; session: string; ok: false; code: ErrorCode; message: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum;
}

function xmlText(value: unknown, maximum: number): value is string {
  if (!text(value, maximum)) return false;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (
      (code < 0x20 && code !== 9 && code !== 10 && code !== 13) ||
      (code >= 0xd800 && code <= 0xdfff) ||
      code === 0xfffe ||
      code === 0xffff
    )
      return false;
  }
  return true;
}

const id = (value: unknown): value is string => text(value, 128) && value.length > 0;
const name = (value: unknown): value is string => xmlText(value, 256) && value.length > 0;
const names = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 64 && value.every(name);

function fields(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length > 0 &&
    Object.keys(value).length <= 64 &&
    Object.entries(value).every(
      ([key, field]) =>
        name(key) &&
        isRecord(field) &&
        keys(field, ["value", "protected"]) &&
        xmlText(field.value, 32_768) &&
        typeof field.protected === "boolean",
    )
  );
}

function update(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length > 0 &&
    keys(value, [], ["fields", "removeFields", "tags", "groupId"]) &&
    (!Object.hasOwn(value, "fields") || fields(value.fields)) &&
    (!Object.hasOwn(value, "removeFields") || names(value.removeFields)) &&
    (!Object.hasOwn(value, "tags") ||
      (names(value.tags) && value.tags.every((tag) => !/[;,]/.test(tag)))) &&
    (!Object.hasOwn(value, "groupId") || id(value.groupId))
  );
}

export function isSessionCommand(value: unknown): value is SessionCommand {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "unlock":
      return (
        keys(value, ["kind", "bytes", "password"]) &&
        value.bytes instanceof ArrayBuffer &&
        text(value.password, 16_384)
      );
    case "newDatabase":
    case "changePassword":
      return (
        keys(value, ["kind", "password"]) &&
        text(value.password, 16_384) &&
        value.password.length > 0
      );
    case "recover":
      return (
        keys(value, ["kind", "credentialsChanged"]) && typeof value.credentialsChanged === "boolean"
      );
    case "list":
    case "listGroups":
    case "serialize":
    case "undo":
    case "redo":
    case "markSaved":
      return keys(value, ["kind"]);
    case "createEntry":
      return (
        keys(value, ["kind", "title"], ["groupId"]) &&
        xmlText(value.title, 4096) &&
        (!Object.hasOwn(value, "groupId") || id(value.groupId))
      );
    case "editEntry":
      return (
        keys(value, ["kind", "entryId", "fields"]) && id(value.entryId) && fields(value.fields)
      );
    case "updateEntry":
      return (
        keys(value, ["kind", "entryId", "update"]) && id(value.entryId) && update(value.update)
      );
    case "getEntry":
    case "duplicateEntry":
    case "listHistory":
      return keys(value, ["kind", "entryId"]) && id(value.entryId);
    case "readField":
    case "exportAttachment":
    case "removeAttachment":
      return keys(value, ["kind", "entryId", "name"]) && id(value.entryId) && name(value.name);
    case "importAttachment":
      return (
        keys(value, ["kind", "entryId", "name", "bytes"]) &&
        id(value.entryId) &&
        name(value.name) &&
        value.bytes instanceof ArrayBuffer &&
        value.bytes.byteLength <= 10 * 1024 * 1024
      );
    case "renameAttachment":
      return (
        keys(value, ["kind", "entryId", "name", "newName"]) &&
        id(value.entryId) &&
        name(value.name) &&
        name(value.newName)
      );
    case "restoreHistory":
      return (
        keys(value, ["kind", "entryId", "index"]) &&
        id(value.entryId) &&
        Number.isSafeInteger(value.index) &&
        (value.index as number) >= 0
      );
    case "createGroup":
      return (
        keys(value, ["kind", "parentId", "name"]) &&
        id(value.parentId) &&
        xmlText(value.name, 4096) &&
        value.name.length > 0
      );
    case "renameGroup":
      return (
        keys(value, ["kind", "groupId", "name"]) &&
        id(value.groupId) &&
        xmlText(value.name, 4096) &&
        value.name.length > 0
      );
    case "moveGroup":
      return (
        keys(value, ["kind", "groupId", "parentId"]) && id(value.groupId) && id(value.parentId)
      );
    case "deleteGroup":
      return (
        keys(value, ["kind", "groupId", "permanent"]) &&
        id(value.groupId) &&
        typeof value.permanent === "boolean"
      );
    case "deleteEntry":
      return (
        keys(value, ["kind", "entryId", "permanent"]) &&
        id(value.entryId) &&
        typeof value.permanent === "boolean"
      );
    default:
      return false;
  }
}

export function isSessionRequest(value: unknown): value is SessionRequest {
  return (
    isRecord(value) &&
    keys(value, ["id", "session", "command"]) &&
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    value.id > 0 &&
    typeof value.session === "string" &&
    isSessionCommand(value.command)
  );
}

export function isWorkerState(value: unknown): value is WorkerState {
  return (
    isRecord(value) &&
    keys(value, ["revision", "dirty", "credentialsChanged", "canUndo", "canRedo"]) &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 0 &&
    ["dirty", "credentialsChanged", "canUndo", "canRedo"].every(
      (key) => typeof value[key] === "boolean",
    )
  );
}

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const date = (value: unknown): boolean =>
  value === undefined || (typeof value === "string" && Number.isFinite(Date.parse(value)));

/** Guard every worker result, including protected DTO masking, before it reaches the host. */
export function isSessionResult(command: SessionCommand, value: unknown): boolean {
  switch (command.kind) {
    case "unlock":
    case "newDatabase":
      return isRecord(value) && keys(value, ["readOnlyReasons"]) && strings(value.readOnlyReasons);
    case "serialize":
    case "exportAttachment":
      return value instanceof ArrayBuffer;
    case "readField":
      return typeof value === "string";
    case "recover":
    case "markSaved":
      return isWorkerState(value);
    case "listGroups":
      return (
        Array.isArray(value) &&
        value.every(
          (group) =>
            isRecord(group) &&
            keys(group, ["id", "parentId", "name", "recycleBin"]) &&
            id(group.id) &&
            (group.parentId === null || id(group.parentId)) &&
            typeof group.name === "string" &&
            typeof group.recycleBin === "boolean",
        )
      );
    case "list":
      return (
        Array.isArray(value) &&
        value.every(
          (entry) =>
            isRecord(entry) &&
            keys(entry, ["id", "title", "groupId", "username", "url", "tags"]) &&
            id(entry.id) &&
            id(entry.groupId) &&
            typeof entry.title === "string" &&
            typeof entry.username === "string" &&
            typeof entry.url === "string" &&
            strings(entry.tags),
        )
      );
    case "listHistory":
      return (
        Array.isArray(value) &&
        value.every(
          (item, index) =>
            isRecord(item) &&
            keys(item, ["index", "modified"]) &&
            item.index === index &&
            date(item.modified),
        )
      );
    case "getEntry":
      return (
        isRecord(value) &&
        keys(value, [
          "id",
          "groupId",
          "fields",
          "tags",
          "created",
          "modified",
          "historyCount",
          "attachments",
        ]) &&
        id(value.id) &&
        id(value.groupId) &&
        strings(value.tags) &&
        date(value.created) &&
        date(value.modified) &&
        Number.isSafeInteger(value.historyCount) &&
        (value.historyCount as number) >= 0 &&
        isRecord(value.fields) &&
        Object.values(value.fields).every(
          (field) =>
            isRecord(field) &&
            typeof field.protected === "boolean" &&
            (field.protected
              ? keys(field, ["protected"])
              : keys(field, ["protected", "value"]) && typeof field.value === "string"),
        ) &&
        Array.isArray(value.attachments) &&
        value.attachments.every(
          (attachment) =>
            isRecord(attachment) &&
            keys(attachment, ["name", "size", "protected"]) &&
            typeof attachment.name === "string" &&
            Number.isSafeInteger(attachment.size) &&
            (attachment.size as number) >= 0 &&
            typeof attachment.protected === "boolean",
        )
      );
    default:
      return (
        isRecord(value) &&
        keys(value, ["value", "state"]) &&
        isWorkerState(value.state) &&
        (["createEntry", "createGroup", "duplicateEntry"].includes(command.kind)
          ? id(value.value)
          : value.value === null)
      );
  }
}
