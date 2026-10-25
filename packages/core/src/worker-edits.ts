import { KdbxEntry, KdbxGroup, KdbxUuid, ProtectedValue } from "@keenext/kdbxweb";
import type { Kdbx } from "@keenext/kdbxweb";
import { DatabaseError } from "./errors.js";
import type { WorkerState } from "./session-protocol.js";

const MAX_UNDO_BYTES = 64 * 1024 * 1024;
const MAX_UNDO_COUNT = 100;
type State = Record<string, unknown>;
type Change = { target: object; before: State; after: State };
type Edit = { changes: Change[]; before: number; after: number; bytes: number };

// Model values and binary payloads are immutable in this editor. Retain protected
// objects, never turn them into plaintext or structured-clone away their prototype.
function clone<T>(value: T): T {
  if (
    !value ||
    typeof value !== "object" ||
    value instanceof ProtectedValue ||
    value instanceof ArrayBuffer ||
    value instanceof KdbxUuid
  )
    return value;
  if (value instanceof Date) return new Date(value) as T;
  if (value instanceof Map)
    return new Map([...value].map(([key, item]) => [key, clone(item)])) as T;
  if (Array.isArray(value)) return value.map(clone) as T;
  const result = Object.create(Object.getPrototypeOf(value)) as State;
  for (const [key, item] of Object.entries(value)) {
    result[key] =
      key === "parentGroup" || key === "credentials"
        ? item
        : key === "groups" || key === "entries"
          ? [...(item as unknown[])]
          : clone(item);
  }
  return result as T;
}

function snapshot(target: object, keys = Object.keys(target)): State {
  const source = target as State;
  return clone(Object.fromEntries(keys.map((key) => [key, source[key]])));
}

function restore(target: object, state: State): void {
  Object.assign(target, clone(state));
}

function size(value: unknown, seen = new Set<object>()): number {
  if (typeof value === "string") return value.length * 2 + 16;
  if (!value || typeof value !== "object") return 8;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (value instanceof ArrayBuffer || value instanceof ProtectedValue) return value.byteLength + 64;
  if (value instanceof KdbxUuid || value instanceof Date) return 64;
  if (value instanceof Map)
    return [...value].reduce(
      (sum, [key, item]) => sum + size(key, seen) + size(item, seen) + 32,
      64,
    );
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + size(item, seen), 32);
  return Object.entries(value).reduce(
    (sum, [key, item]) =>
      sum +
      key.length * 2 +
      (key === "parentGroup" || key === "credentials"
        ? 8
        : (key === "groups" || key === "entries") && Array.isArray(item)
          ? item.length * 8
          : size(item, seen)),
    64,
  );
}

/** Object-local journal: no serialized or full-database undo snapshots. */
export class WorkerEdits {
  private undoStack: Edit[] = [];
  private redoStack: Edit[] = [];
  private revision = 0;
  private nextRevision = 0;
  private savedRevision = 0;
  private savedCredentials: Kdbx["credentials"] | undefined;
  private bytes = 0;

  constructor(private readonly db: Kdbx) {
    this.savedCredentials = db.credentials;
  }

  state(): WorkerState {
    return {
      revision: this.revision,
      dirty: this.revision !== this.savedRevision,
      credentialsChanged: this.db.credentials !== this.savedCredentials,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    };
  }

  recover(credentialsChanged: boolean): WorkerState {
    this.savedRevision = -1;
    if (credentialsChanged) this.savedCredentials = undefined;
    return this.state();
  }

  markSaved(): WorkerState {
    this.savedRevision = this.revision;
    this.savedCredentials = this.db.credentials;
    return this.state();
  }

  async run<T>(
    operation: (touch: (target: object, keys?: string[]) => void) => Promise<T> | T,
    validate: () => void,
  ): Promise<{ value: T; state: WorkerState }> {
    const changes: Change[] = [];
    const touch = (target: object, keys?: string[]): void => {
      if (changes.some((change) => change.target === target)) return;
      changes.push({ target, before: snapshot(target, keys), after: {} });
    };
    try {
      const value = await operation(touch);
      validate();
      for (const change of changes)
        change.after = snapshot(change.target, Object.keys(change.before));
      let bytes = size(changes.map((change) => [change.before, change.after]));
      // Deleted/created subtrees stay alive by reference; include their retained data.
      for (const change of changes) {
        if (change.target instanceof KdbxGroup) {
          const before = change.before;
          const after = change.after;
          for (const key of ["groups", "entries"]) {
            const oldItems = before[key] as (KdbxGroup | KdbxEntry)[] | undefined;
            const newItems = after[key] as (KdbxGroup | KdbxEntry)[] | undefined;
            const oldSet = new Set(oldItems);
            const newSet = new Set(newItems);
            for (const item of new Set([...oldSet, ...newSet])) {
              if (!oldSet.has(item) || !newSet.has(item)) {
                const items = item instanceof KdbxGroup ? [...item.allGroupsAndEntries()] : [item];
                bytes += items.reduce((total, object) => total + size(object), 0);
              }
            }
          }
        }
      }
      if (bytes > MAX_UNDO_BYTES)
        throw new DatabaseError("RESOURCE_LIMIT", "This edit exceeds the local undo-memory limit.");
      this.bytes -= this.redoStack.reduce((sum, edit) => sum + edit.bytes, 0);
      this.redoStack = [];
      const after = ++this.nextRevision;
      this.undoStack.push({ changes, before: this.revision, after, bytes });
      this.revision = after;
      this.bytes += bytes;
      while (this.bytes > MAX_UNDO_BYTES || this.undoStack.length > MAX_UNDO_COUNT) {
        this.bytes -= this.undoStack.shift()!.bytes;
      }
      return { value, state: this.state() };
    } catch (error) {
      for (const change of changes.reverse()) restore(change.target, change.before);
      throw error;
    }
  }

  travel(redo: boolean, validate: () => void): { value: null; state: WorkerState } {
    const from = redo ? this.redoStack : this.undoStack;
    const to = redo ? this.undoStack : this.redoStack;
    const edit = from.at(-1);
    if (!edit)
      throw new DatabaseError("INVALID_INPUT", redo ? "Nothing to redo." : "Nothing to undo.");
    const changes = redo ? edit.changes : [...edit.changes].reverse();
    for (const change of changes) restore(change.target, redo ? change.after : change.before);
    try {
      validate();
    } catch (error) {
      for (const change of [...changes].reverse())
        restore(change.target, redo ? change.before : change.after);
      throw error;
    }
    from.pop();
    to.push(edit);
    this.revision = redo ? edit.after : edit.before;
    return { value: null, state: this.state() };
  }
}
