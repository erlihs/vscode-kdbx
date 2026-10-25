import { Kdbx, KdbxContext, KdbxError, ProtectedValue, XmlUtils } from "@keenext/kdbxweb";
import type { KdbxCredentials } from "@keenext/kdbxweb";
import "./candidate.js";
import { DatabaseError } from "./errors.js";
import { inspectHeader } from "./preflight.js";
import type { HeaderInfo } from "./preflight.js";

// Worker-internal: real-database open/save is not exported until the gate passes.

export interface LoadedDatabase {
  readonly db: Kdbx;
  readonly header: HeaderInfo;
  /** Non-empty when saving would lose data; such databases are read-only. */
  readonly readOnlyReasons: readonly string[];
}

export async function loadDatabase(
  bytes: Uint8Array,
  credentials: KdbxCredentials,
): Promise<LoadedDatabase> {
  const header = inspectHeader(bytes);
  let db: Kdbx;
  try {
    db = await Kdbx.load(bytes.slice().buffer, credentials, { preserveXml: true });
  } catch (error) {
    throw toDatabaseError(error);
  }
  const reasons: string[] = [];
  try {
    if (db.header.droppedFieldIds?.length) {
      reasons.push("The file contains header fields this version cannot save.");
    }
    if (!xmlIsModeled(db)) {
      reasons.push("The file contains XML data this version cannot save.");
    }
  } finally {
    db.xml = undefined;
  }
  return { db, header, readOnlyReasons: Object.freeze(reasons) };
}

export async function saveDatabase(loaded: LoadedDatabase): Promise<ArrayBuffer> {
  if (loaded.readOnlyReasons.length) {
    throw new DatabaseError(
      "READ_ONLY",
      "This database contains data that would be lost on save, so it is open read-only.",
    );
  }
  try {
    return await loaded.db.save();
  } catch (error) {
    throw toDatabaseError(error);
  }
}

function toDatabaseError(error: unknown): DatabaseError {
  if (error instanceof DatabaseError) return error;
  if (error instanceof KdbxError && error.code === "InvalidKey") {
    return new DatabaseError(
      "AUTHENTICATION_OR_INTEGRITY",
      "Wrong credentials, or the database was modified or damaged.",
    );
  }
  if (error instanceof KdbxError) {
    return new DatabaseError("FORMAT", "The database is damaged or not a supported KDBX file.");
  }
  return new DatabaseError("FORMAT", "The database could not be read.");
}

/**
 * Proves the loaded model can reproduce every element, attribute and value of the
 * original XML. Anything the model would drop or alter makes the database read-only.
 */
function xmlIsModeled(db: Kdbx): boolean {
  const original = db.xml;
  if (!original) throw new DatabaseError("COMPATIBILITY", "Original XML was not retained.");
  const ids = new WeakMap<ProtectedValue, number>();
  const counter = { next: 0 };
  const before = signature(original.documentElement, ids, counter);
  db.buildXml(new KdbxContext({ kdbx: db }));
  const rebuilt = db.xml as Document | undefined;
  if (!rebuilt) throw new DatabaseError("COMPATIBILITY", "Candidate did not rebuild XML.");
  const after = signature(rebuilt.documentElement, ids, counter);
  for (const [key, count] of before) {
    if ((after.get(key) ?? 0) < count) return false;
  }
  return true;
}

function signature(
  root: Element,
  ids: WeakMap<ProtectedValue, number>,
  counter: { next: number },
): Map<string, number> {
  const result = new Map<string, number>();
  const visit = (node: Element, parentPath: string): void => {
    const path = `${parentPath}/${node.tagName}`;
    const attributes: string[] = [];
    for (let index = 0; index < node.attributes.length; index++) {
      const attribute = node.attributes[index]!;
      // Binary reference numbers are reassigned on save; the referenced bytes are not XML.
      attributes.push(attribute.name === "Ref" ? "Ref" : `${attribute.name}=${attribute.value}`);
    }
    const children: Element[] = [];
    for (let index = 0; index < node.childNodes.length; index++) {
      const child = node.childNodes[index]!;
      if (child.nodeType === 1) children.push(child as Element);
    }
    let value = "";
    if (!children.length) {
      // Compare protected values by identity so plaintext never enters the signature.
      const protectedValue = XmlUtils.getNodeProtectedValue(node);
      if (protectedValue) {
        let id = ids.get(protectedValue);
        if (id === undefined) ids.set(protectedValue, (id = counter.next++));
        value = `#protected:${id}`;
      } else {
        value = node.textContent ?? "";
      }
    }
    const key = `${path}[${attributes.sort().join(",")}]${value}`;
    result.set(key, (result.get(key) ?? 0) + 1);
    for (const child of children) visit(child, path);
  };
  visit(root, "");
  return result;
}
