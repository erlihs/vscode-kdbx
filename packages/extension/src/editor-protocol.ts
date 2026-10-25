import type { EntryDetails, EntryFieldEdit, EntrySummary, GroupSummary } from "@vscode-kdbx/core";

export type EditorAction =
  | {
      kind:
        | "ready"
        | "refresh"
        | "activity"
        | "cancelUnlock"
        | "lock"
        | "save"
        | "saveAs"
        | "revert"
        | "undo"
        | "redo"
        | "createDatabase";
    }
  | { kind: "unlock"; password: string }
  | { kind: "createGroup"; parentId: string; name: string }
  | { kind: "renameGroup"; id: string; name: string }
  | { kind: "moveGroup"; id: string; parentId: string }
  | { kind: "deleteGroup"; id: string; permanent: boolean }
  | { kind: "createEntry"; groupId: string; title: string }
  | { kind: "details" | "duplicateEntry" | "history" | "importAttachment"; id: string }
  | {
      kind: "updateEntry";
      id: string;
      fields: Record<string, EntryFieldEdit>;
      removeFields: string[];
      tags: string[];
      groupId: string;
    }
  | { kind: "deleteEntry"; id: string; permanent: boolean }
  | { kind: "reveal" | "copy"; id: string; name: string }
  | { kind: "restoreHistory"; id: string; index: number }
  | { kind: "exportAttachment" | "removeAttachment"; id: string; name: string }
  | { kind: "renameAttachment"; id: string; name: string; newName: string }
  | { kind: "changePassword"; password: string; confirmation: string }
  | {
      kind: "generate";
      length: number;
      lower: boolean;
      upper: boolean;
      digits: boolean;
      symbols: boolean;
    };

export interface EditorRequest {
  channel: string;
  id: number;
  action: EditorAction;
}

export interface UiState {
  filename: string;
  locked: boolean;
  dirty: boolean;
  readOnly: boolean;
  conflict: boolean;
  credentialsChanged: boolean;
  canUndo: boolean;
  canRedo: boolean;
  busy: boolean;
  recoveryPasswordChanged: boolean;
  groups: readonly GroupSummary[];
  entries: readonly EntrySummary[];
  error?: string;
}

export interface EditorReply {
  channel: string;
  id: number;
  ok: boolean;
  result?: unknown;
  state: UiState;
  conceal?: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function text(value: unknown, max = 128): value is string {
  return typeof value === "string" && value.length <= max;
}

function strings(value: unknown, count: number, max: number): value is string[] {
  return (
    Array.isArray(value) && value.length <= count && value.every((item: unknown) => text(item, max))
  );
}

export function isEditorRequest(value: unknown, channel: string): value is EditorRequest {
  if (
    !isRecord(value) ||
    !keys(value, ["channel", "id", "action"]) ||
    value.channel !== channel ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    value.id <= 0 ||
    !isRecord(value.action)
  )
    return false;
  const action = value.action;
  switch (action.kind) {
    case "ready":
    case "refresh":
    case "activity":
    case "cancelUnlock":
    case "lock":
    case "save":
    case "saveAs":
    case "revert":
    case "undo":
    case "redo":
    case "createDatabase":
      return keys(action, ["kind"]);
    case "unlock":
      return keys(action, ["kind", "password"]) && text(action.password, 16_384);
    case "createGroup":
      return (
        keys(action, ["kind", "parentId", "name"]) &&
        text(action.parentId) &&
        text(action.name, 4096)
      );
    case "renameGroup":
      return keys(action, ["kind", "id", "name"]) && text(action.id) && text(action.name, 4096);
    case "moveGroup":
      return keys(action, ["kind", "id", "parentId"]) && text(action.id) && text(action.parentId);
    case "deleteGroup":
    case "deleteEntry":
      return (
        keys(action, ["kind", "id", "permanent"]) &&
        text(action.id) &&
        typeof action.permanent === "boolean"
      );
    case "createEntry":
      return (
        keys(action, ["kind", "groupId", "title"]) &&
        text(action.groupId) &&
        text(action.title, 4096)
      );
    case "details":
    case "duplicateEntry":
    case "history":
    case "importAttachment":
      return keys(action, ["kind", "id"]) && text(action.id);
    case "updateEntry":
      return (
        keys(action, ["kind", "id", "fields", "removeFields", "tags", "groupId"]) &&
        text(action.id) &&
        text(action.groupId) &&
        isRecord(action.fields) &&
        Object.keys(action.fields).length <= 64 &&
        Object.entries(action.fields).every(
          ([name, field]) =>
            name.length > 0 &&
            name.length <= 256 &&
            isRecord(field) &&
            keys(field, ["value", "protected"]) &&
            text(field.value, 32_768) &&
            typeof field.protected === "boolean",
        ) &&
        strings(action.removeFields, 64, 256) &&
        strings(action.tags, 64, 256)
      );
    case "reveal":
    case "copy":
    case "exportAttachment":
    case "removeAttachment":
      return keys(action, ["kind", "id", "name"]) && text(action.id) && text(action.name, 256);
    case "restoreHistory":
      return (
        keys(action, ["kind", "id", "index"]) &&
        text(action.id) &&
        typeof action.index === "number" &&
        Number.isSafeInteger(action.index) &&
        action.index >= 0
      );
    case "renameAttachment":
      return (
        keys(action, ["kind", "id", "name", "newName"]) &&
        text(action.id) &&
        text(action.name, 256) &&
        text(action.newName, 256)
      );
    case "changePassword":
      return (
        keys(action, ["kind", "password", "confirmation"]) &&
        text(action.password, 16_384) &&
        text(action.confirmation, 16_384)
      );
    case "generate":
      return (
        keys(action, ["kind", "length", "lower", "upper", "digits", "symbols"]) &&
        typeof action.length === "number" &&
        Number.isSafeInteger(action.length) &&
        action.length >= 8 &&
        action.length <= 128 &&
        ["lower", "upper", "digits", "symbols"].every((key) => typeof action[key] === "boolean")
      );
    default:
      return false;
  }
}

export function isUiState(value: unknown): value is UiState {
  return (
    isRecord(value) &&
    text(value.filename, 32768) &&
    [
      "locked",
      "dirty",
      "readOnly",
      "conflict",
      "credentialsChanged",
      "canUndo",
      "canRedo",
      "busy",
      "recoveryPasswordChanged",
    ].every((key) => typeof value[key] === "boolean") &&
    (value.error === undefined || text(value.error, 32768)) &&
    Array.isArray(value.groups) &&
    value.groups.every(
      (group: unknown) =>
        isRecord(group) &&
        text(group.id) &&
        (group.parentId === null || text(group.parentId)) &&
        text(group.name, 33_554_432) &&
        typeof group.recycleBin === "boolean",
    ) &&
    Array.isArray(value.entries) &&
    value.entries.every(
      (entry: unknown) =>
        isRecord(entry) &&
        text(entry.id) &&
        text(entry.title, 33_554_432) &&
        text(entry.groupId) &&
        text(entry.username, 33_554_432) &&
        text(entry.url, 33_554_432) &&
        strings(entry.tags, 500_000, 33_554_432),
    )
  );
}

export function isEntryDetails(value: unknown): value is EntryDetails {
  return (
    isRecord(value) &&
    text(value.id) &&
    text(value.groupId) &&
    isRecord(value.fields) &&
    Object.values(value.fields).every(
      (field: unknown) =>
        isRecord(field) &&
        typeof field.protected === "boolean" &&
        (field.value === undefined || text(field.value, 33_554_432)),
    ) &&
    strings(value.tags, 500_000, 33_554_432) &&
    (value.created === undefined || text(value.created)) &&
    (value.modified === undefined || text(value.modified)) &&
    typeof value.historyCount === "number" &&
    Number.isSafeInteger(value.historyCount) &&
    value.historyCount >= 0 &&
    Array.isArray(value.attachments) &&
    value.attachments.every(
      (attachment: unknown) =>
        isRecord(attachment) &&
        text(attachment.name, 33_554_432) &&
        typeof attachment.size === "number" &&
        Number.isSafeInteger(attachment.size) &&
        attachment.size >= 0 &&
        typeof attachment.protected === "boolean",
    )
  );
}
