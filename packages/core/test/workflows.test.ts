import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { Kdbx, ProtectedValue } from "@keenext/kdbxweb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentials } from "../dist/candidate.js";
import { createFixture, SYNTHETIC_PASSWORD } from "../dist/fixture.js";
import { DatabaseError, DatabaseSessions, inspectHeader } from "../dist/index.js";
import type { DatabaseSession } from "../dist/index.js";
import { isSessionCommand, isSessionResult } from "../dist/session-protocol.js";

let root: string;
let path: string;
let registry: DatabaseSessions;
const active = new Set<DatabaseSession>();

async function open(): Promise<DatabaseSession> {
  const session = await registry.open(path);
  active.add(session);
  await session.unlock(SYNTHETIC_PASSWORD);
  return session;
}

async function saved(password = SYNTHETIC_PASSWORD): Promise<Kdbx> {
  const bytes = await fs.readFile(path);
  return Kdbx.load(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    credentials(password),
  );
}

beforeEach(async () => {
  root = resolve(".core-test-work", randomUUID());
  await fs.mkdir(root, { recursive: true });
  path = join(root, "workflows.kdbx");
  const db = await createFixture({ cipher: "chacha20", kdf: "argon2id", compression: "gzip" });
  const item = [...db.getDefaultGroup().allEntries()][0]!;
  item.binaries.set(
    "protected.bin",
    await db.createBinary(ProtectedValue.fromBinary(new Uint8Array([0, 255, 8]).buffer)),
  );
  await fs.writeFile(path, new Uint8Array(await db.save()));
  registry = await DatabaseSessions.create(join(root, "recovery"));
});

afterEach(async () => {
  for (const session of active) {
    try {
      await session.discardAndLock();
    } catch (error) {
      if (!(error instanceof DatabaseError) || error.code !== "LOCKED") throw error;
    }
  }
  active.clear();
  await fs.rm(root, { recursive: true, force: true });
});

describe("UI worker workflows", () => {
  it("unlocks, edits and saves KDBX 4.0 without changing its version or KDF", async () => {
    const db = await createFixture({
      version: "4.0",
      cipher: "chacha20",
      kdf: "argon2id",
      compression: "gzip",
    });
    await fs.writeFile(path, new Uint8Array(await db.save()));
    const before = inspectHeader(await fs.readFile(path));
    expect(before.version).toBe("4.0");
    const session = await open();
    const id = (await session.listEntries())[0]!.id;
    await session.updateEntry(id, {
      fields: { Password: { value: "edited 4.0 password", protected: true } },
    });
    await session.save();
    expect(inspectHeader(await fs.readFile(path))).toEqual(before);
    await session.lock();
    await session.unlock(SYNTHETIC_PASSWORD);
    expect(await session.readField(id, "Password")).toBe("edited 4.0 password");
  });

  it("upgrades KDBX 4.0 to 4.1 when moving an entry requires newer metadata", async () => {
    const db = await createFixture({
      version: "4.0",
      cipher: "aes256",
      kdf: "aes",
      compression: "none",
    });
    await fs.writeFile(path, new Uint8Array(await db.save()));
    const before = inspectHeader(await fs.readFile(path));
    expect(before.version).toBe("4.0");
    const session = await open();
    const id = (await session.listEntries())[0]!.id;
    const destination = (await session.listGroups()).find((group) => group.parentId === null)!.id;
    await session.updateEntry(id, { groupId: destination });
    await session.save();
    expect(inspectHeader(await fs.readFile(path))).toEqual({ ...before, version: "4.1" });
    await session.lock();
    await session.unlock(SYNTHETIC_PASSWORD);
    expect((await session.getEntry(id)).groupId).toBe(destination);
    expect(
      [...(await saved()).getDefaultGroup().allEntries()].find(
        (entry) => entry.uuid.toString() === id,
      )?.previousParentGroup,
    ).toBeDefined();
  });

  it("creates a KeePass recycle bin even when disabled, and undo restores the original bin metadata", async () => {
    const db = await saved();
    const bin = db.meta.recycleBinUuid && db.getGroup(db.meta.recycleBinUuid);
    if (bin) db.move(bin, null);
    db.meta.recycleBinEnabled = false;
    db.meta.recycleBinUuid = undefined;
    await fs.writeFile(path, new Uint8Array(await db.save()));
    const session = await open();
    const id = (await session.listEntries())[0]!.id;
    const groups = await session.listGroups();
    await session.deleteEntry(id);
    const createdBin = (await session.listGroups()).find((group) => group.recycleBin)!;
    expect((await session.getEntry(id)).groupId).toBe(createdBin.id);
    await expect(session.deleteGroup(createdBin.id, true)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await session.undo();
    expect(await session.listGroups()).toEqual(groups);
    expect(session.state.dirty).toBe(false);
    await session.save();
    expect((await saved()).meta.recycleBinEnabled).toBe(false);
  });

  it("masks all protected summaries and details until an explicit field read", async () => {
    const session = await open();
    const id = (await session.listEntries())[0]!.id;
    await session.updateEntry(id, {
      fields: {
        Title: { value: "private title", protected: true },
        UserName: { value: "private user", protected: true },
        URL: { value: "private URL", protected: true },
      },
    });
    expect((await session.listEntries()).find((item) => item.id === id)).toMatchObject({
      title: "",
      username: "",
      url: "",
      tags: ["one", "two"],
    });
    const details = await session.getEntry(id);
    expect(details.fields.Password).toEqual({ protected: true });
    expect(details.fields["protected-custom"]).toEqual({ protected: true });
    expect(details.fields.Notes).toMatchObject({ protected: false, value: expect.any(String) });
    expect(JSON.stringify(details)).not.toContain("synthetic-new-secret");
    expect(await session.readField(id, "Password")).toBe("synthetic-new-secret");
    expect(await session.readField(id, "empty-protected")).toBe("");
    await expect(session.readField(id, "missing")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(details.attachments).toContainEqual({ name: "protected.bin", size: 3, protected: true });
    expect(new Uint8Array(await session.exportAttachment(id, "protected.bin"))).toEqual(
      new Uint8Array([0, 255, 8]),
    );
    await session.importAttachment(id, "same-bytes.bin", new Uint8Array([0, 255, 8]).buffer);
    await session.save();
    await session.lock();
    await session.unlock(SYNTHETIC_PASSWORD);
    expect((await session.getEntry(id)).attachments).toContainEqual({
      name: "protected.bin",
      size: 3,
      protected: true,
    });
    expect((await session.getEntry(id)).attachments).toContainEqual({
      name: "same-bytes.bin",
      size: 3,
      protected: true,
    });
  });

  it("creates, renames and moves groups, rejects cycles/root deletion, and undoes whole recycled subtrees", async () => {
    const session = await open();
    const rootId = (await session.listGroups()).find((item) => item.parentId === null)!.id;
    const parent = await session.createGroup(rootId, "Parent");
    const child = await session.createGroup(parent, "Child");
    const id = await session.createEntry("Nested", child);
    await session.renameGroup(parent, "Renamed");
    const before = await session.listGroups();
    await expect(session.moveGroup(parent, child)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(session.moveGroup(parent, parent)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(session.moveGroup(rootId, child)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(session.deleteGroup(rootId, true)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(await session.listGroups()).toEqual(before);
    await session.moveGroup(child, rootId);
    await session.undo();
    expect((await session.listGroups()).find((item) => item.id === child)?.parentId).toBe(parent);
    await session.deleteGroup(parent);
    const bin = (await session.listGroups()).find((item) => item.recycleBin)!;
    expect((await session.listGroups()).find((item) => item.id === parent)?.parentId).toBe(bin.id);
    expect((await session.getEntry(id)).groupId).toBe(child);
    await session.undo();
    expect((await session.listGroups()).find((item) => item.id === parent)).toMatchObject({
      parentId: rootId,
      name: "Renamed",
    });
    await session.redo();
    await session.moveGroup(parent, rootId);
    await session.deleteGroup(parent, true);
    expect((await session.listGroups()).some((item) => item.id === child)).toBe(false);
    await expect(session.getEntry(id)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await session.save();
    expect((await saved()).deletedObjects.some((item) => item.uuid?.toString() === id)).toBe(true);
    await session.undo();
    expect((await session.getEntry(id)).fields.Title?.value).toBe("Nested");
    await session.save();
    expect((await saved()).deletedObjects.some((item) => item.uuid?.toString() === id)).toBe(false);
  });

  it("preserves complete metadata/history through entry updates, duplicates, recycle and permanent delete", async () => {
    const session = await open();
    const id = (await session.listEntries())[0]!.id;
    const before = await session.getEntry(id);
    const rootId = (await session.listGroups()).find((item) => item.parentId === null)!.id;
    await session.updateEntry(id, {
      fields: { Notes: { value: "Edited notes", protected: false } },
      removeFields: ["custom"],
      tags: ["edited"],
      groupId: rootId,
    });
    const after = await session.getEntry(id);
    expect(after).toMatchObject({
      groupId: rootId,
      tags: ["edited"],
      historyCount: before.historyCount + 1,
    });
    expect(after.fields.custom).toBeUndefined();
    await session.undo();
    expect(await session.getEntry(id)).toEqual(before);
    await session.redo();
    expect(await session.getEntry(id)).toEqual(after);
    const duplicate = await session.duplicateEntry(id);
    expect(await session.readField(duplicate, "Password")).toBe(
      await session.readField(id, "Password"),
    );
    expect(await session.getEntry(duplicate)).toMatchObject({
      groupId: rootId,
      tags: ["edited"],
      historyCount: after.historyCount,
      attachments: after.attachments,
    });
    await session.deleteEntry(duplicate);
    const bin = (await session.listGroups()).find((item) => item.recycleBin)!;
    expect((await session.getEntry(duplicate)).groupId).toBe(bin.id);
    await session.updateEntry(duplicate, { groupId: rootId });
    await session.deleteEntry(duplicate, true);
    await expect(session.getEntry(duplicate)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await session.undo();
    expect((await session.getEntry(duplicate)).groupId).toBe(rootId);
    await session.save();
    const db = await saved();
    const item = [...db.getDefaultGroup().allEntries()].find(
      (item) => item.uuid.toString() === id,
    )!;
    expect(item.autoType.items[0]?.window).toBe("synthetic window");
    expect(item.customData?.get("plugin-entry")?.value).toBe("opaque entry data");
    expect(item.qualityCheck).toBe(false);
  });

  it("restores history while preserving a new history state and undoes the restoration exactly", async () => {
    const session = await open();
    const id = (await session.listEntries())[0]!.id;
    const history = await session.listHistory(id);
    expect(history).toEqual([{ index: 0, modified: expect.any(String) }]);
    const before = await session.getEntry(id);
    await session.restoreHistory(id, 0);
    expect(await session.readField(id, "Password")).toBe("synthetic-secret");
    expect((await session.listHistory(id)).length).toBe(2);
    await session.undo();
    expect(await session.getEntry(id)).toEqual(before);
    expect(await session.readField(id, "Password")).toBe("synthetic-new-secret");
    await session.redo();
    await session.save();
    await session.lock();
    await session.unlock(SYNTHETIC_PASSWORD);
    expect(await session.readField(id, "Password")).toBe("synthetic-secret");
    await expect(session.restoreHistory(id, 99)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("imports exact selected bytes, renames/removes attachments and undoes binaries/history", async () => {
    const session = await open();
    const id = (await session.listEntries())[0]!.id;
    const before = await session.getEntry(id);
    const bytes = new Uint8Array([0, 255, 128, 13, 10, 0, 1]);
    await session.importAttachment(id, "exact.bin", bytes.buffer);
    bytes.fill(42);
    expect(new Uint8Array(await session.exportAttachment(id, "exact.bin"))).toEqual(
      new Uint8Array([0, 255, 128, 13, 10, 0, 1]),
    );
    await session.renameAttachment(id, "exact.bin", "renamed.bin");
    await expect(session.renameAttachment(id, "renamed.bin", "empty")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await session.removeAttachment(id, "renamed.bin");
    await expect(session.exportAttachment(id, "renamed.bin")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await session.undo();
    expect(new Uint8Array(await session.exportAttachment(id, "renamed.bin"))).toEqual(
      new Uint8Array([0, 255, 128, 13, 10, 0, 1]),
    );
    await session.undo();
    await session.undo();
    expect(await session.getEntry(id)).toEqual(before);
    await session.redo();
    await session.save();
    await session.lock();
    await session.unlock(SYNTHETIC_PASSWORD);
    expect(new Uint8Array(await session.exportAttachment(id, "exact.bin"))).toEqual(
      new Uint8Array([0, 255, 128, 13, 10, 0, 1]),
    );
    await expect(
      session.importAttachment(id, "large", new ArrayBuffer(10 * 1024 * 1024 + 1)),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(session.state.dirty).toBe(false);
    const maximum = new Uint8Array(10 * 1024 * 1024);
    maximum[0] = 255;
    maximum[maximum.length - 1] = 128;
    await session.importAttachment(id, "maximum.bin", maximum.buffer);
    const exported = await session.exportAttachment(id, "maximum.bin");
    expect(exported.byteLength).toBe(maximum.byteLength);
    expect(Buffer.compare(Buffer.from(exported), Buffer.from(maximum))).toBe(0);
    await session.undo();
    expect(session.state.dirty).toBe(false);
    await session.redo();
    await session.save();
    await session.lock();
    await session.unlock(SYNTHETIC_PASSWORD);
    expect(
      Buffer.compare(
        Buffer.from(await session.exportAttachment(id, "maximum.bin")),
        Buffer.from(maximum),
      ),
    ).toBe(0);
  });

  it("tracks save and credential baselines across undo/redo and drops redo after a new edit", async () => {
    const session = await open();
    expect(session.state).toMatchObject({
      dirty: false,
      canUndo: false,
      canRedo: false,
      credentialsChanged: false,
    });
    const id = await session.createEntry("Created");
    await session.undo();
    expect(session.state).toMatchObject({ dirty: false, canRedo: true });
    await expect(session.getEntry(id)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await session.redo();
    await session.save();
    expect(session.state).toMatchObject({ dirty: false, canUndo: true });
    await session.undo();
    expect(session.state.dirty).toBe(true);
    await session.redo();
    expect(session.state.dirty).toBe(false);
    await session.changeMasterPassword("changed", "changed");
    expect(session.state.credentialsChanged).toBe(true);
    await session.undo();
    expect(session.state).toMatchObject({ dirty: false, credentialsChanged: false });
    await session.redo();
    await session.save();
    expect(session.state).toMatchObject({ dirty: false, credentialsChanged: false });
    await session.undo();
    expect(session.state).toMatchObject({ dirty: true, credentialsChanged: true });
    await session.redo();
    expect(session.state).toMatchObject({ dirty: false, credentialsChanged: false });
    await session.createEntry("Discarded redo");
    await session.undo();
    await session.createEntry("New branch");
    expect(session.state.canRedo).toBe(false);
    await session.lock();
    await session.unlock("changed");
    expect(session.state).toMatchObject({ dirty: true, canUndo: false, canRedo: false });
    await expect(session.undo()).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("bounds the undo count and rolls back invalid edits without changing history/state", async () => {
    const session = await open();
    const id = (await session.listEntries())[0]!.id;
    const before = await session.getEntry(id);
    await expect(
      session.updateEntry(id, { groupId: "missing", tags: ["changed"] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      session.updateEntry(id, { fields: { Notes: { value: "\u0000", protected: false } } }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(session.updateEntry(id, { tags: ["would;split"] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(await session.getEntry(id)).toEqual(before);
    expect(session.state).toMatchObject({ dirty: false, canUndo: false });
    for (let count = 0; count < 102; count++) await session.createEntry(`Undo ${count}`);
    for (let count = 0; count < 100; count++) await session.undo();
    expect(session.state.canUndo).toBe(false);
    expect(
      (await session.listEntries()).filter((item) => item.title.startsWith("Undo ")).length,
    ).toBe(2);
  });
});

describe("creation, external changes and active backup disposal", () => {
  it("creates a new AES256 KDBX4.1 database with calibrated Argon2id defaults, never overwrites", async () => {
    const destination = join(root, "new.kdbx");
    const session = await registry.createDatabase(destination, "new password", "new password");
    active.add(session);
    expect(session.state).toMatchObject({ locked: false, dirty: false, canUndo: false });
    const bytes = new Uint8Array(await fs.readFile(destination));
    expect(inspectHeader(bytes)).toMatchObject({
      version: "4.1",
      cipher: "aes256",
      kdf: "argon2id",
      iterations: expect.any(Number),
    });
    expect(inspectHeader(bytes).memoryBytes).toBeGreaterThanOrEqual(64 * 1024 * 1024);
    expect(inspectHeader(bytes).iterations).toBeGreaterThanOrEqual(2);
    await session.createEntry("New workflow");
    await session.save();
    await session.lock();
    await session.unlock("new password");
    expect((await session.listEntries())[0]?.title).toBe("New workflow");
    await expect(registry.createDatabase(destination, "x", "x")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(
      registry.createDatabase(join(root, "mismatch.kdbx"), "x", "y"),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const controller = new AbortController();
    controller.abort();
    const cancelled = join(root, "cancelled.kdbx");
    await expect(
      registry.createDatabase(cancelled, "x", "x", controller.signal),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(fs.stat(cancelled)).rejects.toMatchObject({ code: "ENOENT" });
    const independent = await DatabaseSessions.create(join(root, "independent-recovery"));
    await expect(independent.createDatabase(destination, "x", "x")).rejects.toMatchObject({
      code: "CONFLICT",
    });
  }, 30_000);

  it("reuses a verified backup on lock and never deletes the last dirty-locked snapshot", async () => {
    const session = await open();
    await session.createEntry("Backed up");
    const reference = (await session.backup())!;
    expect(await session.lock()).toEqual(reference);
    await expect(session.deleteBackup(reference)).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    await expect(fs.stat(join(registry.recoveryDirectory, reference.id))).resolves.toBeDefined();
    await session.unlock(SYNTHETIC_PASSWORD);
    await session.deleteBackup(reference);
    await session.deleteBackup(reference);
    const replacement = await session.lock();
    expect(replacement?.id).not.toBe(reference.id);
    await session.unlock(SYNTHETIC_PASSWORD);
    await session.save();
    await session.deleteBackup(replacement!);
  });

  it("deletes only known revision-checked snapshots and allows superseded locked backup disposal", async () => {
    const session = await open();
    await session.createEntry("First");
    const first = (await session.backup())!;
    await session.createEntry("Second");
    const second = (await session.lock())!;
    await session.deleteBackup(first);
    await session.deleteBackup(first);
    await expect(session.deleteBackup({ ...second, id: first.id })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(
      session.deleteBackup({ ...second, sourceHash: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await session.unlock(SYNTHETIC_PASSWORD);
    await fs.appendFile(join(registry.recoveryDirectory, second.id), new Uint8Array([1]));
    await expect(session.deleteBackup(second)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(session.lock()).rejects.toMatchObject({ code: "CONFLICT" });
    // Restore the exact encrypted revision via a new valid backup, not by suppressing errors.
    await session.backup();
    await fs.unlink(join(registry.recoveryDirectory, second.id));
  });

  it("handles idempotent backup deletion after Save As cleanup", async () => {
    const session = await open();
    await session.createEntry("Save As");
    const reference = (await session.backup())!;
    await session.saveAs(join(root, "saved-as.kdbx"));
    await session.deleteBackup(reference);
    await session.deleteBackup(reference);
    expect(session.state).toMatchObject({ dirty: false, recovery: undefined });
    await session.close();
    await session.deleteBackup(reference);
  });

  it("marks changed/deleted originals as conflicts without replacing the model", async () => {
    const session = await open();
    const before = await session.listEntries();
    expect(await session.checkExternalChange()).toBe(false);
    await fs.appendFile(path, new Uint8Array([1]));
    expect(await session.checkExternalChange()).toBe(true);
    expect(await session.listEntries()).toEqual(before);
    await expect(session.save()).rejects.toMatchObject({ code: "CONFLICT" });
    await fs.unlink(path);
    expect(await session.checkExternalChange()).toBe(true);
    expect(session.state.sourceIssue?.code).toBe("CONFLICT");
  });

  it("rejects protocol extras, malformed updates and protected plaintext DTO results", () => {
    expect(
      isSessionCommand({ kind: "updateEntry", entryId: "x", update: { fields: {}, extra: true } }),
    ).toBe(false);
    expect(isSessionCommand({ kind: "deleteEntry", entryId: "x", permanent: "yes" })).toBe(false);
    expect(
      isSessionCommand({
        kind: "importAttachment",
        entryId: "x",
        name: "name",
        bytes: new ArrayBuffer(10 * 1024 * 1024 + 1),
      }),
    ).toBe(false);
    expect(
      isSessionResult(
        { kind: "getEntry", entryId: "x" },
        {
          id: "x",
          groupId: "group",
          fields: { Password: { value: "must not cross", protected: true } },
          tags: [],
          created: undefined,
          modified: undefined,
          historyCount: 0,
          attachments: [],
        },
      ),
    ).toBe(false);
  });
});
