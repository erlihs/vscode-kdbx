import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { DatabaseError } from "./errors.js";
import type { ErrorCode } from "./errors.js";
import {
  canonicalDestination,
  pathKey,
  prepareRecoveryDirectory,
  readEncryptedFile,
  readOptionalEncryptedFile,
  removeEncryptedFile,
  throwIfCancelled,
  writeEncryptedFile,
} from "./local-files.js";
import type { EncryptedFile, FileRevision } from "./local-files.js";
import { inspectHeader } from "./preflight.js";
import { SerialQueue } from "./serial-queue.js";
import { SessionClient } from "./session-client.js";
import { isRecord, isSessionCommand, isWorkerState } from "./session-protocol.js";
import type {
  EntryDetails,
  EntryFieldEdit,
  EntrySummary,
  EntryUpdate,
  GroupSummary,
  HistorySummary,
  SessionCommand,
  WorkerState,
} from "./session-protocol.js";

export interface RecoveryReference {
  /** Opaque filename within the registry's recovery directory; no database path or password. */
  readonly id: string;
  readonly sourceHash: string;
  readonly snapshotHash: string;
  /** The snapshot requires the new password, not the last saved file's password. */
  readonly credentialsChanged: boolean;
}

export interface DatabaseSessionState {
  readonly locked: boolean;
  readonly dirty: boolean;
  readonly readOnly: boolean;
  readonly conflict: boolean;
  readonly credentialsChanged: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly recovery: RecoveryReference | undefined;
  readonly sourceIssue: Readonly<{ code: ErrorCode; message: string }> | undefined;
}

async function recoverySource(path: string): Promise<{
  file: EncryptedFile | null;
  issue: DatabaseSessionState["sourceIssue"];
}> {
  try {
    const file = await readOptionalEncryptedFile(path);
    return {
      file,
      issue: file
        ? undefined
        : Object.freeze({
            code: "CONFLICT",
            message:
              "The original database no longer exists. Save recovered changes to a new destination.",
          }),
    };
  } catch (error) {
    if (
      !(error instanceof DatabaseError) ||
      !["IO", "RESOURCE_LIMIT", "CONFLICT", "UNSUPPORTED"].includes(error.code)
    )
      throw error;
    return { file: null, issue: Object.freeze({ code: error.code, message: error.message }) };
  }
}

function prefix(path: string): string {
  return createHash("sha256").update(pathKey(path)).digest("hex");
}

function sameRevision(first: FileRevision, second: FileRevision): boolean {
  return (Object.keys(first) as (keyof FileRevision)[]).every((key) => first[key] === second[key]);
}

function invalidRecovery(): never {
  throw new DatabaseError(
    "INVALID_INPUT",
    "The encrypted recovery reference does not belong to this database.",
  );
}

function recoveryPath(root: string, path: string, reference: RecoveryReference): string {
  const pattern = new RegExp(
    `^${prefix(path)}\\.([a-f0-9]{64})\\.([ns])\\.([a-f0-9-]{36})\\.kdbx$`,
  );
  const match = pattern.exec(reference.id);
  if (
    !match ||
    match[1] !== reference.sourceHash ||
    (match[2] === "n") !== reference.credentialsChanged ||
    !/^[a-f0-9]{64}$/.test(reference.snapshotHash)
  )
    invalidRecovery();
  return join(root, reference.id);
}

export class DatabaseSessions {
  private readonly sessions = new Map<string, Promise<DatabaseSession>>();

  private constructor(readonly recoveryDirectory: string) {}

  static async create(recoveryDirectory: string): Promise<DatabaseSessions> {
    return new DatabaseSessions(await prepareRecoveryDirectory(recoveryDirectory));
  }

  async findRecovery(path: string): Promise<readonly RecoveryReference[]> {
    path = await canonicalDestination(path);
    let names: string[];
    try {
      names = await fs.readdir(this.recoveryDirectory);
    } catch {
      throw new DatabaseError("IO", "Encrypted recovery storage could not be listed.");
    }
    const result: RecoveryReference[] = [];
    const pattern = new RegExp(
      `^${prefix(path)}\\.([a-f0-9]{64})\\.([ns])\\.([a-f0-9-]{36})\\.kdbx$`,
    );
    for (const id of names) {
      const match = pattern.exec(id);
      if (!match) continue;
      const file = await readEncryptedFile(join(this.recoveryDirectory, id));
      result.push(
        Object.freeze({
          id,
          sourceHash: match[1]!,
          snapshotHash: file.revision.hash,
          credentialsChanged: match[2] === "n",
        }),
      );
    }
    return result;
  }

  async open(path: string, recovery?: RecoveryReference): Promise<DatabaseSession> {
    path = await canonicalDestination(path);
    const key = pathKey(path);
    const existing = this.sessions.get(key);
    if (existing) {
      if (recovery)
        throw new DatabaseError(
          "INVALID_INPUT",
          "Close the shared session before selecting recovery.",
        );
      return existing;
    }
    const opening = this.createSession(path, recovery);
    this.sessions.set(key, opening);
    try {
      return await opening;
    } catch (error) {
      if (this.sessions.get(key) === opening) this.sessions.delete(key);
      throw error;
    }
  }

  /** Creates only a new destination, with worker-calibrated AES256/KDBX4.1/Argon2id defaults. */
  async createDatabase(
    path: string,
    password: string,
    confirmation: string,
    signal?: AbortSignal,
  ): Promise<DatabaseSession> {
    if (password !== confirmation || !isSessionCommand({ kind: "newDatabase", password })) {
      throw new DatabaseError(
        "INVALID_INPUT",
        "The new master password must be nonempty and match its confirmation.",
      );
    }
    path = await canonicalDestination(path);
    const key = pathKey(path);
    if (this.sessions.has(key))
      throw new DatabaseError("CONFLICT", "The destination already has a shared session.");
    const creating = (async () => {
      throwIfCancelled(signal);
      if (await readOptionalEncryptedFile(path))
        throw new DatabaseError("CONFLICT", "The destination already exists.");
      if ((await this.findRecovery(path)).length)
        throw new DatabaseError(
          "RECOVERY_REQUIRED",
          "Encrypted recovery exists for this destination.",
        );
      const client = new SessionClient();
      let stopping: Promise<void> | undefined;
      const abort = (): void => {
        stopping ??= client.stop();
      };
      const timeout = setTimeout(abort, 30_000);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        throwIfCancelled(signal);
        await client.request({ kind: "newDatabase", password });
        throwIfCancelled(signal);
        if (stopping) throw new DatabaseError("CANCELLED", "Database creation was cancelled.");
        const result = await client.request({ kind: "serialize" });
        if (!(result instanceof ArrayBuffer))
          throw new DatabaseError("WORKER", "Invalid encrypted database.");
        if (stopping) throw new DatabaseError("CANCELLED", "Database creation was cancelled.");
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        const revision = await writeEncryptedFile(path, new Uint8Array(result), null, signal);
        return new DatabaseSession(this, path, revision, undefined, undefined, client);
      } catch (error) {
        await (stopping ?? client.stop());
        throw error;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      }
    })();
    this.sessions.set(key, creating);
    try {
      return await creating;
    } catch (error) {
      if (this.sessions.get(key) === creating) this.sessions.delete(key);
      throw error;
    }
  }
  private async createSession(
    path: string,
    recovery?: RecoveryReference,
  ): Promise<DatabaseSession> {
    if (!recovery && (await this.findRecovery(path)).length) {
      throw new DatabaseError(
        "RECOVERY_REQUIRED",
        "Encrypted recovery exists. Select a snapshot or explicitly discard it before opening the saved file.",
      );
    }
    if (recovery) recoveryPath(this.recoveryDirectory, path, recovery);
    if (recovery) {
      const source = await recoverySource(path);
      return new DatabaseSession(this, path, source.file?.revision ?? null, recovery, source.issue);
    }
    const source = await readOptionalEncryptedFile(path);
    if (!source) throw new DatabaseError("IO", "The saved database does not exist.");
    inspectHeader(source.bytes);
    return new DatabaseSession(this, path, source.revision);
  }

  async discardRecovery(path: string, reference: RecoveryReference): Promise<void> {
    path = await canonicalDestination(path);
    if (this.sessions.has(pathKey(path))) {
      throw new DatabaseError(
        "INVALID_INPUT",
        "Close the shared session before discarding its recovery.",
      );
    }
    const file = recoveryPath(this.recoveryDirectory, path, reference);
    const current = await readOptionalEncryptedFile(file);
    if (!current) return;
    if (current.revision.hash !== reference.snapshotHash) {
      throw new DatabaseError("CONFLICT", "The encrypted recovery snapshot changed externally.");
    }
    await removeEncryptedFile(file, current.revision);
  }

  async close(session: DatabaseSession): Promise<RecoveryReference | undefined> {
    if ((await this.sessions.get(pathKey(session.path))) !== session) {
      throw new DatabaseError("INVALID_INPUT", "The session does not belong to this registry.");
    }
    return session.close();
  }

  async release(session: DatabaseSession): Promise<void> {
    const key = pathKey(session.path);
    if ((await this.sessions.get(key)) === session) this.sessions.delete(key);
  }

  async atDestination<T>(
    session: DatabaseSession,
    target: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = pathKey(target);
    if (this.sessions.has(key))
      throw new DatabaseError("CONFLICT", "The destination already has a shared session.");
    const old = pathKey(session.path);
    const reservation = Promise.resolve(session);
    this.sessions.set(key, reservation);
    try {
      const result = await operation();
      this.sessions.delete(old);
      return result;
    } catch (error) {
      if (this.sessions.get(key) === reservation) this.sessions.delete(key);
      throw error;
    }
  }
}

export class DatabaseSession {
  private readonly queue = new SerialQueue();
  private client: SessionClient | undefined;
  private dirty = false;
  private readOnly = false;
  private conflict = false;
  private credentialsChanged = false;
  private canUndo = false;
  private canRedo = false;
  private modelRevision = 0;
  private snapshotRevision: number | undefined;
  private recovery: RecoveryReference | undefined;
  private readonly ownedRecovery = new Map<string, FileRevision>();
  private readonly disposedRecovery = new Map<string, string>();
  private readonly knownRecovery = new Map<string, RecoveryReference>();
  private generation = 0;
  private cancelUnlock: (() => void) | undefined;
  private closed = false;
  private sourceHash: string;
  private sourceIssue: DatabaseSessionState["sourceIssue"];

  constructor(
    private readonly registry: DatabaseSessions,
    private currentPath: string,
    private revision: FileRevision | null,
    recovery?: RecoveryReference,
    sourceIssue?: DatabaseSessionState["sourceIssue"],
    client?: SessionClient,
  ) {
    const sourceHash = recovery?.sourceHash ?? revision?.hash;
    if (!sourceHash) throw new DatabaseError("IO", "The source revision is unavailable.");
    this.sourceHash = sourceHash;
    this.sourceIssue = sourceIssue;
    this.client = client;
    if (recovery) {
      this.recovery = Object.freeze({ ...recovery });
      this.knownRecovery.set(recovery.id, this.recovery);
      this.dirty = true;
      this.credentialsChanged = recovery.credentialsChanged;
      this.conflict = revision?.hash !== recovery.sourceHash;
    }
  }

  get path(): string {
    return this.currentPath;
  }

  get state(): DatabaseSessionState {
    return Object.freeze({
      locked: this.client === undefined,
      dirty: this.dirty,
      readOnly: this.readOnly,
      conflict: this.conflict,
      credentialsChanged: this.credentialsChanged,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      recovery: this.recovery,
      sourceIssue: this.sourceIssue,
    });
  }

  private applyWorkerState(value: unknown): void {
    if (!isWorkerState(value))
      throw new DatabaseError("WORKER", "The database worker returned invalid edit state.");
    const state: WorkerState = value;
    this.dirty = state.dirty;
    this.credentialsChanged = state.credentialsChanged;
    this.canUndo = state.canUndo;
    this.canRedo = state.canRedo;
    this.modelRevision = state.revision;
  }

  private active(): void {
    if (this.closed) throw new DatabaseError("LOCKED", "The database session is closed.");
  }

  private unlocked(writable = false): SessionClient {
    this.active();
    if (!this.client) throw new DatabaseError("LOCKED", "The database is locked.");
    if (writable && this.readOnly) {
      throw new DatabaseError("READ_ONLY", "This database is open read-only.");
    }
    return this.client;
  }

  unlock(password: string, signal?: AbortSignal): Promise<void> {
    const generation = this.generation;
    return this.queue.run(async () => {
      this.active();
      throwIfCancelled(signal);
      if (generation !== this.generation)
        throw new DatabaseError("CANCELLED", "Unlock was cancelled by locking.");
      if (this.client)
        throw new DatabaseError("INVALID_INPUT", "The database is already unlocked.");
      const recovery = this.dirty ? this.recovery : undefined;
      const inspection = recovery ? await recoverySource(this.path) : undefined;
      const source = inspection ? inspection.file : await readOptionalEncryptedFile(this.path);
      this.revision = source?.revision ?? null;
      this.sourceIssue = inspection?.issue;
      if (recovery) this.conflict = source?.revision.hash !== this.sourceHash;
      else if (source) {
        this.sourceHash = source.revision.hash;
        this.conflict = false;
      }
      const encrypted = recovery
        ? await readEncryptedFile(
            recoveryPath(this.registry.recoveryDirectory, this.path, recovery),
          )
        : source;
      if (!encrypted) throw new DatabaseError("IO", "The saved database no longer exists.");
      if (recovery && encrypted.revision.hash !== recovery.snapshotHash) {
        throw new DatabaseError("CONFLICT", "The encrypted recovery snapshot changed externally.");
      }
      const owned = recovery && this.ownedRecovery.get(recovery.id);
      if (owned && !sameRevision(owned, encrypted.revision)) {
        throw new DatabaseError("CONFLICT", "The encrypted recovery snapshot changed externally.");
      }
      if (generation !== this.generation)
        throw new DatabaseError("CANCELLED", "Unlock was cancelled by locking.");
      throwIfCancelled(signal);
      const client = new SessionClient();
      let stopping: Promise<void> | undefined;
      const abort = (): void => {
        stopping ??= client.stop();
      };
      const timeout = setTimeout(() => {
        stopping ??= client.stop(
          new DatabaseError("CANCELLED", "Unlock exceeded the 30-second safety deadline."),
        );
      }, 30_000);
      this.cancelUnlock = abort;
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const result = await client.request({
          kind: "unlock",
          password,
          bytes: encrypted.bytes.buffer,
        });
        if (
          !isRecord(result) ||
          !Array.isArray(result.readOnlyReasons) ||
          !result.readOnlyReasons.every((reason) => typeof reason === "string")
        ) {
          throw new DatabaseError("WORKER", "The database worker returned invalid unlock state.");
        }
        throwIfCancelled(signal);
        if (stopping || generation !== this.generation)
          throw new DatabaseError("CANCELLED", "Unlock was cancelled.");
        this.canUndo = false;
        this.canRedo = false;
        this.modelRevision = 0;
        if (recovery) {
          this.applyWorkerState(
            await client.request({
              kind: "recover",
              credentialsChanged: recovery.credentialsChanged,
            }),
          );
          this.ownedRecovery.set(recovery.id, encrypted.revision);
          this.knownRecovery.set(recovery.id, recovery);
          this.snapshotRevision = 0;
        } else this.snapshotRevision = undefined;
        this.client = client;
        this.readOnly = result.readOnlyReasons.length > 0;
      } catch (error) {
        await (stopping ?? client.stop());
        throw error;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        this.cancelUnlock = undefined;
      }
    });
  }

  listEntries(): Promise<readonly EntrySummary[]> {
    return this.read({ kind: "list" });
  }

  private read<T>(command: SessionCommand): Promise<T> {
    if (!isSessionCommand(command))
      return Promise.reject(new DatabaseError("INVALID_INPUT", "Invalid database operation."));
    const copy = structuredClone(command);
    return this.queue.run(async () => (await this.unlocked().request(copy)) as T);
  }

  /** Includes root and recycle-bin groups; filtering is the caller's responsibility. */
  listGroups(): Promise<readonly GroupSummary[]> {
    return this.read({ kind: "listGroups" });
  }
  /** Protected fields have no value property. No decrypted model leaves the worker. */
  getEntry(entryId: string): Promise<EntryDetails> {
    return this.read({ kind: "getEntry", entryId });
  }
  /** Explicit, selected-field disclosure; never cached by the session host. */
  readField(entryId: string, name: string): Promise<string> {
    return this.read({ kind: "readField", entryId, name });
  }
  listHistory(entryId: string): Promise<readonly HistorySummary[]> {
    return this.read({ kind: "listHistory", entryId });
  }
  exportAttachment(entryId: string, name: string): Promise<ArrayBuffer> {
    return this.read({ kind: "exportAttachment", entryId, name });
  }

  private mutate(command: SessionCommand): Promise<unknown> {
    if (!isSessionCommand(command))
      return Promise.reject(new DatabaseError("INVALID_INPUT", "Invalid database edit."));
    const copy = structuredClone(command);
    return this.queue.run(async () => {
      const result = await this.unlocked(true).request(copy);
      if (!isRecord(result)) throw new DatabaseError("WORKER", "Invalid database edit result.");
      this.applyWorkerState(result.state);
      return result.value;
    });
  }

  async createEntry(title: string, groupId?: string): Promise<string> {
    const result = await this.mutate({
      kind: "createEntry",
      title,
      ...(groupId === undefined ? {} : { groupId }),
    });
    if (typeof result !== "string")
      throw new DatabaseError(
        "WORKER",
        "The database worker returned an invalid entry identifier.",
      );
    return result;
  }

  async editEntry(entryId: string, fields: Record<string, EntryFieldEdit>): Promise<void> {
    await this.updateEntry(entryId, { fields });
  }

  async updateEntry(entryId: string, update: EntryUpdate): Promise<void> {
    await this.mutate({ kind: "updateEntry", entryId, update });
  }
  async createGroup(parentId: string, name: string): Promise<string> {
    return (await this.mutate({ kind: "createGroup", parentId, name })) as string;
  }
  async renameGroup(groupId: string, name: string): Promise<void> {
    await this.mutate({ kind: "renameGroup", groupId, name });
  }
  async moveGroup(groupId: string, parentId: string): Promise<void> {
    await this.mutate({ kind: "moveGroup", groupId, parentId });
  }
  async deleteGroup(groupId: string, permanent = false): Promise<void> {
    await this.mutate({ kind: "deleteGroup", groupId, permanent });
  }
  async duplicateEntry(entryId: string): Promise<string> {
    return (await this.mutate({ kind: "duplicateEntry", entryId })) as string;
  }
  async deleteEntry(entryId: string, permanent = false): Promise<void> {
    await this.mutate({ kind: "deleteEntry", entryId, permanent });
  }
  async restoreHistory(entryId: string, index: number): Promise<void> {
    await this.mutate({ kind: "restoreHistory", entryId, index });
  }
  /** Imports at most 10 MiB, subject also to the database's decoded/XML/undo limits. */
  async importAttachment(entryId: string, name: string, bytes: ArrayBuffer): Promise<void> {
    await this.mutate({ kind: "importAttachment", entryId, name, bytes });
  }
  async renameAttachment(entryId: string, name: string, newName: string): Promise<void> {
    await this.mutate({ kind: "renameAttachment", entryId, name, newName });
  }
  async removeAttachment(entryId: string, name: string): Promise<void> {
    await this.mutate({ kind: "removeAttachment", entryId, name });
  }
  /** Worker-only object journal: at most 100 edits/64 MiB accounted data; reset on lock. */
  async undo(): Promise<void> {
    await this.mutate({ kind: "undo" });
  }
  async redo(): Promise<void> {
    await this.mutate({ kind: "redo" });
  }

  async changeMasterPassword(password: string, confirmation: string): Promise<void> {
    if (password !== confirmation || !password.length) {
      throw new DatabaseError(
        "INVALID_INPUT",
        "The new master password must be nonempty and match its confirmation.",
      );
    }
    await this.mutate({ kind: "changePassword", password });
  }

  private async serialized(): Promise<Uint8Array<ArrayBuffer>> {
    const result = await this.unlocked(true).request({ kind: "serialize" });
    if (!(result instanceof ArrayBuffer))
      throw new DatabaseError("WORKER", "The database worker returned invalid encrypted data.");
    return new Uint8Array(result);
  }

  private async clearRecovery(): Promise<void> {
    for (const [id, revision] of this.ownedRecovery) {
      try {
        await removeEncryptedFile(join(this.registry.recoveryDirectory, id), revision);
      } catch {
        throw new DatabaseError(
          "RECOVERY_CLEANUP",
          "Encrypted recovery could not be removed. Saved data remains valid; retry cleanup before closing.",
        );
      }
      this.ownedRecovery.delete(id);
      this.disposedRecovery.set(id, revision.hash);
    }
    this.recovery = undefined;
    this.snapshotRevision = undefined;
  }

  save(signal?: AbortSignal): Promise<void> {
    return this.queue.run(async () => {
      this.unlocked(true);
      throwIfCancelled(signal);
      if (this.conflict)
        throw new DatabaseError(
          "CONFLICT",
          "The source changed externally. Reload/discard or save a new copy.",
        );
      const bytes = await this.serialized();
      try {
        this.revision = await writeEncryptedFile(this.path, bytes, this.revision, signal);
        this.sourceHash = this.revision.hash;
      } catch (error) {
        if (
          error instanceof DatabaseError &&
          (error.code === "CONFLICT" || error.code === "PERSISTENCE_UNCERTAIN")
        ) {
          this.conflict = true;
          this.sourceIssue = Object.freeze({ code: error.code, message: error.message });
        }
        throw error;
      }
      this.applyWorkerState(await this.unlocked().request({ kind: "markSaved" }));
      await this.clearRecovery();
    });
  }

  saveAs(destination: string, signal?: AbortSignal): Promise<void> {
    return this.queue.run(async () => {
      this.unlocked(true);
      throwIfCancelled(signal);
      // Resolve the parent rather than the absent file; symlinked directory aliases share one key.
      const target = await canonicalDestination(destination);
      const bytes = await this.serialized();
      await this.registry.atDestination(this, target, async () => {
        this.revision = await writeEncryptedFile(target, bytes, null, signal);
        this.sourceHash = this.revision.hash;
        this.currentPath = target;
        this.conflict = false;
        this.sourceIssue = undefined;
      });
      this.applyWorkerState(await this.unlocked().request({ kind: "markSaved" }));
      await this.clearRecovery();
    });
  }

  private async snapshot(reuse = false): Promise<RecoveryReference | undefined> {
    this.active();
    if (!this.dirty) return undefined;
    if (
      this.recovery &&
      (!this.client || (reuse && this.snapshotRevision === this.modelRevision))
    ) {
      const existing = await readEncryptedFile(
        recoveryPath(this.registry.recoveryDirectory, this.path, this.recovery),
      );
      if (existing.revision.hash !== this.recovery.snapshotHash) {
        throw new DatabaseError("CONFLICT", "The encrypted recovery snapshot changed externally.");
      }
      const owned = this.ownedRecovery.get(this.recovery.id);
      if (owned && !sameRevision(owned, existing.revision)) {
        throw new DatabaseError("CONFLICT", "The encrypted recovery snapshot changed externally.");
      }
      this.ownedRecovery.set(this.recovery.id, existing.revision);
      return this.recovery;
    }
    const bytes = await this.serialized();
    const sourceHash = this.sourceHash;
    const id = `${prefix(this.path)}.${sourceHash}.${this.credentialsChanged ? "n" : "s"}.${randomUUID()}.kdbx`;
    const revision = await writeEncryptedFile(
      join(this.registry.recoveryDirectory, id),
      bytes,
      null,
    );
    const reference = Object.freeze({
      id,
      sourceHash,
      snapshotHash: revision.hash,
      credentialsChanged: this.credentialsChanged,
    });
    this.ownedRecovery.set(id, revision);
    this.knownRecovery.set(id, reference);
    this.recovery = reference;
    this.snapshotRevision = this.modelRevision;
    return reference;
  }

  backup(): Promise<RecoveryReference | undefined> {
    return this.queue.run(() => this.snapshot());
  }

  /** Disposes only owned, unchanged snapshots; retains the last dirty-locked recovery. */
  deleteBackup(reference: RecoveryReference): Promise<void> {
    const copy = { ...reference };
    return this.queue.run(async () => {
      const known = this.knownRecovery.get(copy.id);
      if (
        !known ||
        known.sourceHash !== copy.sourceHash ||
        known.snapshotHash !== copy.snapshotHash ||
        known.credentialsChanged !== copy.credentialsChanged
      )
        invalidRecovery();
      if (this.dirty && !this.client && this.recovery?.id === copy.id) {
        throw new DatabaseError(
          "RECOVERY_REQUIRED",
          "The last current encrypted snapshot is required while dirty changes are locked.",
        );
      }
      const revision = this.ownedRecovery.get(copy.id);
      if (!revision) {
        if (this.disposedRecovery.get(copy.id) === copy.snapshotHash) return;
        invalidRecovery();
      }
      if (revision.hash !== copy.snapshotHash) invalidRecovery();
      const file = join(this.registry.recoveryDirectory, known.id);
      await removeEncryptedFile(file, revision);
      this.ownedRecovery.delete(copy.id);
      this.disposedRecovery.set(copy.id, copy.snapshotHash);
      if (this.recovery?.id === copy.id) {
        this.recovery = undefined;
        this.snapshotRevision = undefined;
      }
    });
  }

  checkExternalChange(): Promise<boolean> {
    return this.queue.run(async () => {
      this.active();
      const source = await recoverySource(this.path);
      if (
        !source.file ||
        source.file.revision.hash !== this.sourceHash ||
        (this.revision && !sameRevision(source.file.revision, this.revision))
      ) {
        this.conflict = true;
        this.sourceIssue =
          source.issue ??
          Object.freeze({ code: "CONFLICT", message: "The original database changed externally." });
      }
      return this.conflict;
    });
  }

  lock(): Promise<RecoveryReference | undefined> {
    this.generation++;
    this.cancelUnlock?.();
    return this.queue.run(async () => {
      this.active();
      const recovery = await this.snapshot(true);
      await this.client?.stop();
      this.client = undefined;
      this.readOnly = false;
      this.canUndo = false;
      this.canRedo = false;
      if (!this.dirty) await this.clearRecovery();
      return recovery;
    });
  }

  discardAndLock(): Promise<void> {
    this.generation++;
    this.cancelUnlock?.();
    return this.queue.run(async () => {
      this.active();
      await this.clearRecovery();
      await this.client?.stop();
      this.client = undefined;
      this.dirty = false;
      this.readOnly = false;
      this.conflict = false;
      this.sourceIssue = undefined;
      this.credentialsChanged = false;
      this.canUndo = false;
      this.canRedo = false;
    });
  }

  close(): Promise<RecoveryReference | undefined> {
    this.generation++;
    this.cancelUnlock?.();
    return this.queue.run(async () => {
      this.active();
      const recovery = await this.snapshot();
      await this.client?.stop();
      this.client = undefined;
      this.readOnly = false;
      this.canUndo = false;
      this.canRedo = false;
      if (!this.dirty) await this.clearRecovery();
      this.closed = true;
      await this.registry.release(this);
      return recovery;
    });
  }
}
