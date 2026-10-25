import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Kdbx, ProtectedValue } from "@keenext/kdbxweb";
import { credentials } from "../dist/candidate.js";
import { createFixture, SYNTHETIC_PASSWORD } from "../dist/fixture.js";
import { DatabaseError, DatabaseSessions, INPUT_LIMITS, inspectHeader } from "../dist/index.js";
import type { DatabaseSession } from "../dist/index.js";

let root: string;
let path: string;
let registry: DatabaseSessions;
let original: Uint8Array<ArrayBuffer>;
const sessions = new Set<DatabaseSession>();

async function open(): Promise<DatabaseSession> {
  const session = await registry.open(path);
  sessions.add(session);
  await session.unlock(SYNTHETIC_PASSWORD);
  return session;
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "kdbx-sessions-"));
  path = join(root, "synthetic.kdbx");
  const db = await createFixture({ cipher: "chacha20", kdf: "argon2id", compression: "gzip" });
  original = new Uint8Array(await db.save());
  await fs.writeFile(path, original);
  registry = await DatabaseSessions.create(join(root, "recovery"));
});

afterEach(async () => {
  for (const session of sessions) {
    try {
      await session.discardAndLock();
    } catch (error) {
      if (!(error instanceof DatabaseError) || error.code !== "LOCKED") throw error;
    }
  }
  sessions.clear();
  await fs.rm(root, { recursive: true, force: true });
});

describe("shared worker sessions and encrypted persistence", () => {
  it("deduplicates concurrent opens and canonical directory aliases", async () => {
    const alias = join(root, "alias");
    await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    const [first, second] = await Promise.all([
      registry.open(path),
      registry.open(join(alias, "synthetic.kdbx")),
    ]);
    sessions.add(first);
    expect(first).toBe(second);
    expect(first.state.locked).toBe(true);
  });

  it("queues edits and save, preserves history/protection and existing cryptographic settings", async () => {
    const session = await open();
    const entries = await session.listEntries();
    const id = entries[0]!.id;
    await Promise.all([
      session.editEntry(id, { Title: { value: "edited synthetic title", protected: false } }),
      session.editEntry(id, { Password: { value: "synthetic-new-secret", protected: true } }),
      session.save(),
    ]);
    expect(session.state).toMatchObject({ dirty: false, locked: false, conflict: false });
    const bytes = new Uint8Array(await fs.readFile(path));
    expect(inspectHeader(bytes)).toEqual(inspectHeader(original));
    const db = await Kdbx.load(bytes.buffer, credentials(SYNTHETIC_PASSWORD));
    const entry = [...db.getDefaultGroup().allEntries()].find(
      (candidate) => candidate.uuid.toString() === id,
    )!;
    expect(entry.fields.get("Title")).toBe("edited synthetic title");
    expect(entry.fields.get("Password")).toBeInstanceOf(ProtectedValue);
    expect((entry.fields.get("Password") as ProtectedValue).getText()).toBe("synthetic-new-secret");
    expect(entry.history.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects wrong credentials and invalid edits without changing state, then allows retry", async () => {
    const session = await registry.open(path);
    sessions.add(session);
    await expect(session.unlock("wrong")).rejects.toMatchObject({
      code: "AUTHENTICATION_OR_INTEGRITY",
    });
    expect(session.state).toMatchObject({ locked: true, dirty: false });
    await session.unlock(SYNTHETIC_PASSWORD);
    await expect(session.changeMasterPassword("new", "different")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(session.createEntry("x".repeat(4097))).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(session.createEntry("invalid\u0000XML")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(session.state.dirty).toBe(false);
    expect(await session.createEntry("valid after failures")).toBeTypeOf("string");
  });

  it("round-trips carriage returns, whitespace and XML metacharacters in edited fields", async () => {
    const session = await open();
    const id = (await session.listEntries())[0]!.id;
    const text = "\r\none\rtwo\t<&> \u{1f512}\n";
    await session.editEntry(id, {
      Notes: { value: text, protected: false },
      Password: { value: text, protected: true },
    });
    await session.save();
    const db = await Kdbx.load(
      new Uint8Array(await fs.readFile(path)).buffer,
      credentials(SYNTHETIC_PASSWORD),
    );
    const entry = [...db.getDefaultGroup().allEntries()].find(
      (item) => item.uuid.toString() === id,
    )!;
    expect(entry.fields.get("Notes")).toBe(text);
    const password = entry.fields.get("Password");
    expect(password).toBeInstanceOf(ProtectedValue);
    if (!(password instanceof ProtectedValue)) throw new Error("Protected password missing.");
    expect(password.getText()).toBe(text);
  });

  it("cancels a queued unlock when lock is requested", async () => {
    const session = await registry.open(path);
    sessions.add(session);
    const unlocking = session.unlock(SYNTHETIC_PASSWORD);
    const locking = session.lock();
    await expect(unlocking).rejects.toMatchObject({ code: "CANCELLED" });
    await locking;
    expect(session.state.locked).toBe(true);
    await session.unlock(SYNTHETIC_PASSWORD);
  });

  it("keeps separate databases independent", async () => {
    const first = await open();
    const otherPath = join(root, "other.kdbx");
    await fs.writeFile(otherPath, original);
    const other = await registry.open(otherPath);
    sessions.add(other);
    await other.unlock(SYNTHETIC_PASSWORD);
    await first.createEntry("first only");
    expect((await other.listEntries()).some((entry) => entry.title === "first only")).toBe(false);
    expect(other.state.dirty).toBe(false);
  });

  it("refuses external changes, retains dirty state, and saves a fresh independent copy", async () => {
    const session = await open();
    await session.createEntry("unsaved synthetic edit");
    const external = await createFixture({ cipher: "aes256", kdf: "aes", compression: "none" });
    const externalBytes = new Uint8Array(await external.save());
    await fs.writeFile(path, externalBytes);
    await expect(session.save()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(session.state).toMatchObject({ dirty: true, conflict: true });
    const copy = join(root, "copy.kdbx");
    await session.saveAs(copy);
    expect(session.path).toBe(await fs.realpath(copy));
    expect(await registry.open(copy)).toBe(session);
    expect(await fs.readFile(path)).toEqual(Buffer.from(externalBytes));
    expect(session.state).toMatchObject({ dirty: false, conflict: false });
    const reopened = await Kdbx.load(
      new Uint8Array(await fs.readFile(copy)).buffer,
      credentials(SYNTHETIC_PASSWORD),
    );
    expect(
      [...reopened.getDefaultGroup().allEntries()].some(
        (entry) => entry.fields.get("Title") === "unsaved synthetic edit",
      ),
    ).toBe(true);
    await expect(session.saveAs(path)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("enforces read-only preservation in the session API", async () => {
    const db = await createFixture({ cipher: "aes256", kdf: "aes", compression: "none" });
    const build = db.buildXml.bind(db);
    db.buildXml = (context) => {
      build(context);
      db.xml!.getElementsByTagName("Meta")[0]!.setAttribute("UnknownFuture", "opaque");
    };
    await fs.writeFile(path, new Uint8Array(await db.save()));
    const session = await open();
    expect(session.state.readOnly).toBe(true);
    await expect(session.createEntry("must fail")).rejects.toMatchObject({ code: "READ_ONLY" });
    await expect(session.save()).rejects.toMatchObject({ code: "READ_ONLY" });
  });

  it.each([
    { kind: "escaped text", character: "&", protected: false, accepted: 3 },
    { kind: "protected ciphertext", character: "x", protected: true, accepted: 11 },
  ])("rolls back $kind exceeding the actual XML ceiling including history", async (scenario) => {
    const session = await open();
    const id = (await session.listEntries())[0]!.id;
    const fields = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [
        `bounded-${index}`,
        { value: scenario.character.repeat(32_768), protected: scenario.protected },
      ]),
    );
    for (let index = 0; index < scenario.accepted; index++) await session.editEntry(id, fields);
    await expect(session.editEntry(id, fields)).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
    await session.save();
    expect(session.state).toMatchObject({ dirty: false, locked: false });
    await session.lock();
    await session.unlock(SYNTHETIC_PASSWORD);
  });
});

describe("encrypted recovery and changed master passwords", () => {
  it("locks dirty data to encrypted snapshots and restores after restart with the new password", async () => {
    const session = await open();
    await session.createEntry("recover this synthetic entry");
    await session.changeMasterPassword("new synthetic password", "new synthetic password");
    const first = await session.backup();
    const reference = await registry.close(session);
    expect(reference?.credentialsChanged).toBe(true);
    expect(reference?.id).not.toBe(first?.id);
    expect(await fs.readFile(path)).toEqual(Buffer.from(original));
    const snapshot = await fs.readFile(join(registry.recoveryDirectory, reference!.id));
    expect(snapshot.includes(Buffer.from("recover this synthetic entry"))).toBe(false);
    expect(snapshot.includes(Buffer.from("new synthetic password"))).toBe(false);
    await expect(registry.open(path)).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    const restarted = await DatabaseSessions.create(registry.recoveryDirectory);
    expect(await restarted.findRecovery(path)).toContainEqual(reference);
    const recovered = await restarted.open(path, reference);
    sessions.add(recovered);
    await expect(recovered.unlock(SYNTHETIC_PASSWORD)).rejects.toMatchObject({
      code: "AUTHENTICATION_OR_INTEGRITY",
    });
    await recovered.unlock("new synthetic password");
    expect(
      (await recovered.listEntries()).some(
        (entry) => entry.title === "recover this synthetic entry",
      ),
    ).toBe(true);
    expect(recovered.state).toMatchObject({
      dirty: true,
      credentialsChanged: true,
      conflict: false,
    });
    await recovered.save();
    await recovered.lock();
    await expect(recovered.unlock(SYNTHETIC_PASSWORD)).rejects.toMatchObject({
      code: "AUTHENTICATION_OR_INTEGRITY",
    });
    await recovered.unlock("new synthetic password");
    // Older snapshots are not overwritten or silently removed by a restarted registry.
    expect(await restarted.findRecovery(path)).toEqual([first]);
    await restarted.close(recovered);
    await restarted.discardRecovery(path, first!);
    await restarted.discardRecovery(path, first!);
    expect(await restarted.findRecovery(path)).toEqual([]);
  });

  it("retains the dirty unlocked worker if recovery fails", async () => {
    const session = await open();
    await session.createEntry("survive failed recovery");
    await fs.rmdir(registry.recoveryDirectory);
    await fs.writeFile(registry.recoveryDirectory, "storage unavailable");
    await expect(session.lock()).rejects.toMatchObject({ code: "IO" });
    expect(session.state).toMatchObject({ dirty: true, locked: false });
    expect(
      (await session.listEntries()).some((entry) => entry.title === "survive failed recovery"),
    ).toBe(true);
    await fs.unlink(registry.recoveryDirectory);
    await fs.mkdir(registry.recoveryDirectory);
    expect(await session.lock()).toBeDefined();
    expect(session.state.locked).toBe(true);
  });

  it("blocks overwriting a source that changed while recovery was locked", async () => {
    const session = await open();
    await session.createEntry("recover despite conflict");
    const reference = await registry.close(session);
    const external = await createFixture({ cipher: "aes256", kdf: "aes", compression: "none" });
    await fs.writeFile(path, new Uint8Array(await external.save()));
    const recovered = await registry.open(path, reference);
    sessions.add(recovered);
    await recovered.unlock(SYNTHETIC_PASSWORD);
    expect(recovered.state.conflict).toBe(true);
    await expect(recovered.save()).rejects.toMatchObject({ code: "CONFLICT" });
    await recovered.saveAs(join(root, "recovered-copy.kdbx"));
    expect(recovered.state.dirty).toBe(false);
  });

  it.each(["deleted", "corrupt"])(
    "restores encrypted recovery even when the source was %s",
    async (kind) => {
      const session = await open();
      await session.createEntry("survive a missing or corrupt source");
      const reference = await registry.close(session);
      if (kind === "deleted") await fs.unlink(path);
      else await fs.writeFile(path, "no longer a database");
      const recovered = await registry.open(path, reference);
      sessions.add(recovered);
      await recovered.unlock(SYNTHETIC_PASSWORD);
      expect(recovered.state.conflict).toBe(true);
      await expect(recovered.save()).rejects.toMatchObject({ code: "CONFLICT" });
      await recovered.saveAs(join(root, "safe-recovered.kdbx"));
      expect(recovered.state.dirty).toBe(false);
    },
  );

  it("does not delete a recovery snapshot replaced externally after backup", async () => {
    const session = await open();
    await session.createEntry("synthetic");
    const reference = await session.backup();
    const file = join(registry.recoveryDirectory, reference!.id);
    await fs.writeFile(file, original);
    await expect(session.save()).rejects.toMatchObject({ code: "RECOVERY_CLEANUP" });
    expect(session.state).toMatchObject({ dirty: false, locked: false });
    expect(await fs.readFile(file)).toEqual(Buffer.from(original));
    await expect(session.discardAndLock()).rejects.toMatchObject({ code: "RECOVERY_CLEANUP" });
    await expect(session.lock()).rejects.toMatchObject({ code: "RECOVERY_CLEANUP" });
    expect(session.state.locked).toBe(true);
    await session.unlock(SYNTHETIC_PASSWORD);
    await fs.unlink(file);
    await session.discardAndLock();
  });

  it.each(["oversized", "directory"])(
    "recovers with an explicit source issue after %s replacement",
    async (kind) => {
      const session = await open();
      await session.createEntry("recover without reading a hostile source");
      const reference = await registry.close(session);
      if (kind === "oversized") {
        const handle = await fs.open(path, "w");
        try {
          await handle.truncate(INPUT_LIMITS.encryptedBytes + 1);
        } finally {
          await handle.close();
        }
      } else {
        await fs.unlink(path);
        await fs.mkdir(path);
      }
      const recovered = await registry.open(path, reference);
      sessions.add(recovered);
      expect(recovered.state.sourceIssue).toBeDefined();
      expect(recovered.state.sourceIssue!.message).not.toContain(root);
      await recovered.unlock(SYNTHETIC_PASSWORD);
      expect(recovered.state).toMatchObject({ dirty: true, conflict: true, locked: false });
      await expect(recovered.save()).rejects.toMatchObject({ code: "CONFLICT" });
      await recovered.saveAs(join(root, "safe-copy.kdbx"));
      expect(recovered.state.sourceIssue).toBeUndefined();
    },
  );
});
