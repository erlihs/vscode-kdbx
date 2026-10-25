import type { ErrorCode } from "./errors.js";

export interface EntryFieldEdit {
  value: string;
  protected: boolean;
}

export type SessionCommand =
  | { kind: "unlock"; bytes: ArrayBuffer; password: string }
  | { kind: "list" }
  | { kind: "createEntry"; title: string }
  | { kind: "editEntry"; entryId: string; fields: Record<string, EntryFieldEdit> }
  | { kind: "changePassword"; password: string }
  | { kind: "serialize" };

export interface SessionRequest {
  id: number;
  session: string;
  command: SessionCommand;
}

export type SessionReply =
  | { id: number; session: string; ok: true; result: unknown }
  | { id: number; session: string; ok: false; code: ErrorCode; message: string };

export interface EntrySummary {
  id: string;
  title: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
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

export function isSessionCommand(value: unknown): value is SessionCommand {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "unlock":
      return (
        keys(value, ["kind", "bytes", "password"]) &&
        value.bytes instanceof ArrayBuffer &&
        text(value.password, 16_384)
      );
    case "list":
    case "serialize":
      return keys(value, ["kind"]);
    case "createEntry":
      return keys(value, ["kind", "title"]) && xmlText(value.title, 4096);
    case "changePassword":
      return (
        keys(value, ["kind", "password"]) &&
        text(value.password, 16_384) &&
        value.password.length > 0
      );
    case "editEntry":
      return (
        keys(value, ["kind", "entryId", "fields"]) &&
        text(value.entryId, 128) &&
        isRecord(value.fields) &&
        Object.keys(value.fields).length > 0 &&
        Object.keys(value.fields).length <= 64 &&
        Object.entries(value.fields).every(
          ([name, field]) =>
            name.length > 0 &&
            xmlText(name, 256) &&
            isRecord(field) &&
            keys(field, ["value", "protected"]) &&
            xmlText(field.value, 32_768) &&
            typeof field.protected === "boolean",
        )
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
