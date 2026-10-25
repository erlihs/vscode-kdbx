import { randomInt } from "node:crypto";
import { DatabaseError } from "@vscode-kdbx/core";
import type { RecoveryReference } from "@vscode-kdbx/core";
import { isRecord } from "./editor-protocol.js";
import type { EditorAction } from "./editor-protocol.js";

export function errorMessage(error: unknown): string {
  return error instanceof DatabaseError
    ? error.message
    : "The database operation failed. No database contents were logged.";
}

export function encodeBackup(reference: RecoveryReference): string {
  return JSON.stringify({
    version: 1,
    id: reference.id,
    sourceHash: reference.sourceHash,
    snapshotHash: reference.snapshotHash,
    credentialsChanged: reference.credentialsChanged,
  });
}

export function decodeBackup(id: string): RecoveryReference {
  let value: unknown;
  try {
    if (id.length > 2048) throw new Error();
    value = JSON.parse(id);
  } catch {
    throw new DatabaseError("INVALID_INPUT", "The encrypted editor backup identifier is invalid.");
  }
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 5 ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    !/^[a-zA-Z0-9_.-]{1,240}$/.test(value.id) ||
    typeof value.sourceHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sourceHash) ||
    typeof value.snapshotHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.snapshotHash) ||
    typeof value.credentialsChanged !== "boolean"
  ) {
    throw new DatabaseError("INVALID_INPUT", "The encrypted editor backup identifier is invalid.");
  }
  return Object.freeze({
    id: value.id,
    sourceHash: value.sourceHash,
    snapshotHash: value.snapshotHash,
    credentialsChanged: value.credentialsChanged,
  });
}

export function generatePassword(options: Extract<EditorAction, { kind: "generate" }>): string {
  const classes = [
    options.lower ? "abcdefghijklmnopqrstuvwxyz" : "",
    options.upper ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ" : "",
    options.digits ? "0123456789" : "",
    options.symbols ? "!@#$%^&*()-_=+[]{};:,.?" : "",
  ].filter(Boolean);
  if (
    !Number.isSafeInteger(options.length) ||
    options.length < 8 ||
    options.length > 128 ||
    classes.length === 0 ||
    options.length < classes.length
  ) {
    throw new DatabaseError(
      "INVALID_INPUT",
      "Choose a password length from 8 to 128 and at least one character class.",
    );
  }
  const alphabet = classes.join("");
  const characters = classes.map((group) => group[randomInt(group.length)]!);
  while (characters.length < options.length) characters.push(alphabet[randomInt(alphabet.length)]!);
  for (let index = characters.length - 1; index > 0; index--) {
    const other = randomInt(index + 1);
    [characters[index], characters[other]] = [characters[other]!, characters[index]!];
  }
  return characters.join("");
}

export function attachmentSuggestion(name: string): string {
  const leaf = name.replaceAll("\\", "/").split("/").at(-1) ?? "";
  // Filenames cannot contain control characters or Windows-reserved punctuation.
  // eslint-disable-next-line no-control-regex
  const points = Array.from(leaf.replace(/[\x00-\x1f<>:"/\\|?*]/g, "_").replace(/[ .]+$/g, ""));
  while (Buffer.byteLength(points.join(""), "utf8") > 200) points.pop();
  const safe = points.join("") || "attachment.bin";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe) ? `_${safe}` : safe;
}
