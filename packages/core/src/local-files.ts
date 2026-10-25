import * as fs from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { DatabaseError } from "./errors.js";
import { INPUT_LIMITS, inspectHeader } from "./preflight.js";
import { SerialQueue } from "./serial-queue.js";

export interface FileRevision {
  hash: string;
  device: string;
  inode: string;
  size: number;
  modified: string;
  changed: string;
}

export interface EncryptedFile {
  bytes: Uint8Array<ArrayBuffer>;
  revision: FileRevision;
}

const writeQueues = new Map<string, { queue: SerialQueue; users: number }>();
const execute = promisify(execFile);

function localPath(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
    throw new DatabaseError("UNSUPPORTED", "An absolute local filesystem path is required.");
  }
  const resolved = resolve(path);
  if (resolved.startsWith("\\\\") || path.startsWith("//")) {
    throw new DatabaseError("UNSUPPORTED", "Network filesystem paths are unsupported.");
  }
  return resolved;
}

export function pathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function revision(bytes: Uint8Array, stat: BigIntStats): FileRevision {
  return {
    hash: createHash("sha256").update(bytes).digest("hex"),
    device: String(stat.dev),
    inode: String(stat.ino),
    size: Number(stat.size),
    modified: String(stat.mtimeNs),
    changed: String(stat.ctimeNs),
  };
}

function sameStat(first: BigIntStats, second: BigIntStats): boolean {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.size === second.size &&
    first.mtimeNs === second.mtimeNs &&
    first.ctimeNs === second.ctimeNs
  );
}

function sameRevision(first: FileRevision, second: FileRevision): boolean {
  return (
    first.hash === second.hash &&
    first.device === second.device &&
    first.inode === second.inode &&
    first.size === second.size &&
    first.modified === second.modified &&
    first.changed === second.changed
  );
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DatabaseError("CANCELLED", "Database operation cancelled.");
}

async function closeReadHandle(handle: fs.FileHandle | undefined): Promise<void> {
  try {
    if (handle) await handle.close();
  } catch {
    throw new DatabaseError("IO", "The encrypted database file could not be closed.");
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await fs.open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function cleanupStaging(
  handle: fs.FileHandle | undefined,
  temporary: string | undefined,
  committed: boolean,
): Promise<void> {
  let failed = false;
  try {
    if (handle) await handle.close();
  } catch {
    failed = true;
  }
  try {
    if (temporary) await fs.unlink(temporary);
  } catch {
    failed = true;
  }
  if (failed) {
    throw new DatabaseError(
      committed ? "PERSISTENCE_UNCERTAIN" : "IO",
      "Encrypted staging cleanup failed. Keep the session; the destination may already have been replaced.",
    );
  }
}

/** No raw filesystem exceptions (which may contain sensitive paths) escape this boundary. */
export async function canonicalFile(path: string): Promise<string> {
  try {
    return localPath(await fs.realpath(localPath(path)));
  } catch (error) {
    if (error instanceof DatabaseError) throw error;
    throw new DatabaseError("IO", "The local database could not be located or accessed.");
  }
}

export async function canonicalDestination(path: string): Promise<string> {
  path = localPath(path);
  try {
    return localPath(await fs.realpath(path));
  } catch (error) {
    if (error instanceof DatabaseError) throw error;
    if (!hasCode(error, "ENOENT"))
      throw new DatabaseError("IO", "The local destination could not be resolved.");
    return join(await canonicalFile(dirname(path)), basename(path));
  }
}

export async function readOptionalEncryptedFile(path: string): Promise<EncryptedFile | null> {
  try {
    await fs.lstat(localPath(path));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    if (error instanceof DatabaseError) throw error;
    throw new DatabaseError("IO", "The local database could not be inspected.");
  }
  return readEncryptedFile(path);
}

export async function readEncryptedFile(path: string): Promise<EncryptedFile> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(localPath(path), "r");
    const before = await handle.stat({ bigint: true });
    if (!before.isFile())
      throw new DatabaseError("UNSUPPORTED", "A regular database file is required.");
    if (before.size > BigInt(INPUT_LIMITS.encryptedBytes)) {
      throw new DatabaseError("RESOURCE_LIMIT", "Encrypted database exceeds the 100 MiB limit.");
    }
    const bytes = new Uint8Array(Number(before.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0)
        throw new DatabaseError("CONFLICT", "The database changed while being read.");
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await fs.lstat(path, { bigint: true });
    if (!sameStat(before, after) || !sameStat(after, current)) {
      throw new DatabaseError("CONFLICT", "The database changed while being read.");
    }
    return { bytes, revision: revision(bytes, after) };
  } catch (error) {
    if (error instanceof DatabaseError) throw error;
    throw new DatabaseError("IO", "The encrypted database could not be read.");
  } finally {
    await closeReadHandle(handle);
  }
}

export async function optionalRevision(path: string): Promise<FileRevision | null> {
  try {
    await fs.lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw new DatabaseError("IO", "The destination could not be inspected.");
  }
  return (await readEncryptedFile(path)).revision;
}

async function assertRevision(path: string, expected: FileRevision | null): Promise<void> {
  const stat = await fs.lstat(path).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  });
  if (stat?.isSymbolicLink()) {
    throw new DatabaseError("CONFLICT", "The destination was replaced by a symbolic link.");
  }
  if (stat && !stat.isFile()) {
    throw new DatabaseError("CONFLICT", "The destination is no longer a regular file.");
  }
  if (!stat) {
    if (expected) throw new DatabaseError("CONFLICT", "The database was deleted externally.");
    return;
  }
  if (!expected || !sameRevision((await readEncryptedFile(path)).revision, expected)) {
    throw new DatabaseError(
      "CONFLICT",
      "The destination changed externally. Reload or save a new copy.",
    );
  }
}

async function windowsPermissions(source: string | undefined, destination: string): Promise<void> {
  const root = process.env.SystemRoot;
  if (!root) throw new DatabaseError("IO", "Windows permission services are unavailable.");
  const home = join(root, "System32", "WindowsPowerShell", "v1.0");
  // PowerShell 7's inherited module paths are incompatible with this Windows PowerShell 5.1 host.
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PSMODULEPATH"),
  );
  const script = source
    ? "$acl = Get-Acl -LiteralPath $env:KDBX_ACL_SOURCE; Set-Acl -LiteralPath $env:KDBX_ACL_DESTINATION -AclObject $acl"
    : "$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; " +
      "$acl = New-Object System.Security.AccessControl.FileSecurity; " +
      "$acl.SetOwner($user); $acl.SetAccessRuleProtection($true, $false); " +
      "$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($user, 'FullControl', 'Allow'); " +
      "$acl.AddAccessRule($rule); Set-Acl -LiteralPath $env:KDBX_ACL_DESTINATION -AclObject $acl";
  await execute(
    join(home, "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; ${script}`],
    {
      env: {
        ...environment,
        PSModulePath: join(home, "Modules"),
        KDBX_ACL_SOURCE: source ?? "",
        KDBX_ACL_DESTINATION: destination,
      },
      windowsHide: true,
      timeout: 30_000,
    },
  );
}

async function preservePermissions(
  temporary: string,
  handle: fs.FileHandle,
  destination: string,
  exists: boolean,
): Promise<void> {
  if (process.platform === "win32") {
    await windowsPermissions(exists ? destination : undefined, temporary);
  } else if (exists) {
    const stat = await fs.stat(destination);
    const own = await handle.stat();
    if (own.uid !== stat.uid || own.gid !== stat.gid) await handle.chown(stat.uid, stat.gid);
    await handle.chmod(stat.mode & 0o777);
  }
}

async function runQueued<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const key = pathKey(path);
  let entry = writeQueues.get(key);
  if (!entry) {
    entry = { queue: new SerialQueue(), users: 0 };
    writeQueues.set(key, entry);
  }
  entry.users++;
  try {
    return await entry.queue.run(operation);
  } finally {
    if (--entry.users === 0) writeQueues.delete(key);
  }
}

/**
 * Encrypt first, then stage adjacent to the destination. Revision checks detect
 * external writes, but cannot close the cross-process check-to-replacement race.
 */
export async function writeEncryptedFile(
  path: string,
  bytes: Uint8Array,
  expected: FileRevision | null,
  signal?: AbortSignal,
): Promise<FileRevision> {
  path = localPath(path);
  inspectHeader(bytes);
  return runQueued(path, async () => {
    let temporary: string | undefined;
    let handle: fs.FileHandle | undefined;
    let committed = false;
    try {
      throwIfCancelled(signal);
      await assertRevision(path, expected);
      temporary = join(dirname(path), `.kdbx-${randomUUID()}.tmp`);
      handle = await fs.open(temporary, "wx", 0o600);
      await preservePermissions(temporary, handle, path, expected !== null);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      throwIfCancelled(signal);
      await assertRevision(path, expected);
      if (expected) {
        await fs.rename(temporary, path);
        temporary = undefined;
      } else {
        // Unlike rename, link cannot overwrite a destination created after the check.
        await fs.link(temporary, path);
      }
      committed = true;
      if (temporary) {
        await fs.unlink(temporary);
        temporary = undefined;
      }
      await syncDirectory(dirname(path));
      const saved = await readEncryptedFile(path);
      if (saved.revision.hash !== createHash("sha256").update(bytes).digest("hex")) {
        throw new DatabaseError(
          "PERSISTENCE_UNCERTAIN",
          "The destination changed immediately after saving.",
        );
      }
      return saved.revision;
    } catch (error) {
      if (committed) {
        throw new DatabaseError(
          "PERSISTENCE_UNCERTAIN",
          "Replacement completed, but persistence could not be verified. Keep the session and save a new copy.",
        );
      }
      if (error instanceof DatabaseError) throw error;
      if (hasCode(error, "EEXIST")) {
        throw new DatabaseError(
          "CONFLICT",
          "The destination was created externally. Choose a new destination.",
        );
      }
      throw new DatabaseError(
        "IO",
        "The encrypted database could not be saved. The previous file was not replaced.",
      );
    } finally {
      await cleanupStaging(handle, temporary, committed);
    }
  });
}

export async function removeEncryptedFile(path: string, expected: FileRevision): Promise<void> {
  return runQueued(localPath(path), async () => {
    try {
      // Removal is idempotent after an explicit external cleanup, never for a replaced file.
      if ((await optionalRevision(path)) === null) return;
      await assertRevision(path, expected);
      await fs.unlink(path);
      await syncDirectory(dirname(path));
    } catch (error) {
      if (error instanceof DatabaseError) throw error;
      throw new DatabaseError("IO", "The encrypted recovery snapshot could not be removed.");
    }
  });
}

export async function prepareRecoveryDirectory(path: string): Promise<string> {
  try {
    const firstCreated = await fs.mkdir(localPath(path), { recursive: true, mode: 0o700 });
    const canonical = localPath(await fs.realpath(path));
    if (firstCreated && process.platform !== "win32") {
      const ancestor = dirname(await fs.realpath(firstCreated));
      let current = dirname(canonical);
      // Persist every newly created directory entry, not just the snapshot inside the leaf.
      for (;;) {
        await syncDirectory(current);
        if (current === ancestor) break;
        const parent = dirname(current);
        if (parent === current)
          throw new DatabaseError("IO", "Recovery storage changed during preparation.");
        current = parent;
      }
    }
    return canonical;
  } catch (error) {
    if (error instanceof DatabaseError) throw error;
    throw new DatabaseError("IO", "Encrypted recovery storage could not be prepared.");
  }
}
