import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFixture } from "../dist/fixture.js";
import { readEncryptedFile, writeEncryptedFile } from "../dist/local-files.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    rename: vi.fn(actual.rename),
    link: vi.fn(actual.link),
  };
});

let root: string;
let path: string;
let original: Uint8Array<ArrayBuffer>;
let replacement: Uint8Array<ArrayBuffer>;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "kdbx-files-"));
  path = join(root, "synthetic.kdbx");
  const db = await createFixture({ cipher: "aes256", kdf: "argon2id", compression: "gzip" });
  original = new Uint8Array(await db.save());
  replacement = new Uint8Array(await db.save());
  await fs.writeFile(path, original, { mode: 0o600 });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(fs.open).mockReset();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.open).mockImplementation(actual.open);
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
  vi.mocked(fs.link).mockReset().mockImplementation(actual.link);
  await actual.rm(root, { recursive: true, force: true });
});

async function acl(path: string, checkOwnerOnly = false): Promise<string> {
  const system = process.env.SystemRoot;
  if (!system) throw new Error("Windows permission services unavailable in test.");
  const { stdout } = await promisify(execFile)(
    join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference = 'Stop'; $acl = Get-Acl -LiteralPath $env:KDBX_TEST_ACL; " +
        (checkOwnerOnly
          ? "$acl.AreAccessRulesProtected -and @($acl.Access | Where-Object { $_.IdentityReference -ne $acl.Owner }).Count -eq 0"
          : "$acl | Select-Object Owner,Group,AreAccessRulesProtected," +
            "@{Name='Rules';Expression={@($_.Access | Select-Object IdentityReference,FileSystemRights," +
            "AccessControlType,IsInherited,InheritanceFlags,PropagationFlags)}} | ConvertTo-Json -Depth 5 -Compress"),
    ],
    { env: { ...process.env, KDBX_TEST_ACL: path }, windowsHide: true },
  );
  return stdout.trim();
}

describe("encrypted filesystem transactions", () => {
  it.runIf(process.platform !== "win32")(
    "preserves a nondefault POSIX mode and owner",
    async () => {
      await fs.chmod(path, 0o640);
      const permissions = await fs.stat(path);
      const before = await readEncryptedFile(path);
      await writeEncryptedFile(path, replacement, before.revision);
      const saved = await fs.stat(path);
      expect(saved.mode & 0o777).toBe(0o640);
      expect([saved.uid, saved.gid]).toEqual([permissions.uid, permissions.gid]);
    },
  );

  it("replaces an existing file and returns its verified revision without staging leftovers", async () => {
    const before = await readEncryptedFile(path);
    const permissions = process.platform === "win32" ? await acl(path) : undefined;
    const revision = await writeEncryptedFile(path, replacement, before.revision);
    expect((await readEncryptedFile(path)).revision).toEqual(revision);
    expect(await fs.readFile(path)).toEqual(Buffer.from(replacement));
    expect(await fs.readdir(root)).toEqual(["synthetic.kdbx"]);
    if (process.platform !== "win32") expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    else expect((await acl(path)) === permissions).toBe(true);
  });

  it("creates new encrypted files with owner-only access", async () => {
    const destination = join(root, "private.kdbx");
    await writeEncryptedFile(destination, replacement, null);
    if (process.platform === "win32") expect(await acl(destination, true)).toBe("True");
    else expect((await fs.stat(destination)).mode & 0o777).toBe(0o600);
  });

  it("retains the original if permissions cannot be preserved", async () => {
    const before = await readEncryptedFile(path);
    if (process.platform === "win32") vi.stubEnv("SystemRoot", "");
    else {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      vi.mocked(fs.open).mockImplementation(async (...args) => {
        const handle = await actual.open(...args);
        if (args[1] === "wx")
          vi.spyOn(handle, "chmod").mockRejectedValueOnce(new Error("permission denied"));
        return handle;
      });
    }
    await expect(writeEncryptedFile(path, replacement, before.revision)).rejects.toMatchObject({
      code: "IO",
    });
    expect(await fs.readFile(path)).toEqual(Buffer.from(original));
    expect(await fs.readdir(root)).toEqual(["synthetic.kdbx"]);
  });

  it("never overwrites a new destination, including a concurrent creation at commit", async () => {
    const destination = join(root, "new.kdbx");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.link).mockImplementationOnce(async (from, to) => {
      await fs.writeFile(to, original);
      await actual.link(from, to);
    });
    await expect(writeEncryptedFile(destination, replacement, null)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await fs.readFile(destination)).toEqual(Buffer.from(original));
    expect((await fs.readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("serializes concurrent saves and rejects a stale revision", async () => {
    const before = await readEncryptedFile(path);
    const results = await Promise.allSettled([
      writeEncryptedFile(path, replacement, before.revision),
      writeEncryptedFile(path, original, before.revision),
    ]);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "CONFLICT" } });
    expect(await fs.readFile(path)).toEqual(Buffer.from(replacement));
  });

  it.each(["changed", "deleted"])("refuses an externally %s source", async (kind) => {
    const before = await readEncryptedFile(path);
    if (kind === "changed") await fs.writeFile(path, replacement);
    else await fs.unlink(path);
    await expect(writeEncryptedFile(path, original, before.revision)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    if (kind === "changed") expect(await fs.readFile(path)).toEqual(Buffer.from(replacement));
    else await expect(fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["write", "sync", "rename"])(
    "keeps the original intact after a %s failure",
    async (failure) => {
      const before = await readEncryptedFile(path);
      const error = Object.assign(new Error("secret-path-do-not-expose"), { code: "ENOSPC" });
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      if (failure === "rename") vi.mocked(fs.rename).mockRejectedValueOnce(error);
      else
        vi.mocked(fs.open).mockImplementation(async (...args) => {
          const handle = await actual.open(...args);
          if (args[1] === "wx") {
            if (failure === "write") vi.spyOn(handle, "writeFile").mockRejectedValueOnce(error);
            else vi.spyOn(handle, "sync").mockRejectedValueOnce(error);
          }
          return handle;
        });
      await expect(writeEncryptedFile(path, replacement, before.revision)).rejects.toMatchObject({
        code: "IO",
        message: "The encrypted database could not be saved. The previous file was not replaced.",
      });
      expect(await fs.readFile(path)).toEqual(Buffer.from(original));
      expect(await fs.readdir(root)).toEqual(["synthetic.kdbx"]);
    },
  );

  it("reports uncertainty rather than success when replacement cannot be verified", async () => {
    const before = await readEncryptedFile(path);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
      await actual.rename(from, to);
      await fs.writeFile(to, original);
    });
    await expect(writeEncryptedFile(path, replacement, before.revision)).rejects.toMatchObject({
      code: "PERSISTENCE_UNCERTAIN",
    });
  });

  it("sanitizes descriptor-close errors", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementationOnce(async () => {
        await close();
        throw new Error("secret-path-do-not-expose");
      });
      return handle;
    });
    await expect(readEncryptedFile(path)).rejects.toMatchObject({
      code: "IO",
      message: "The encrypted database file could not be closed.",
    });
  });

  it("cancels before replacement, leaving the original intact", async () => {
    const before = await readEncryptedFile(path);
    await expect(
      writeEncryptedFile(path, replacement, before.revision, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(await fs.readFile(path)).toEqual(Buffer.from(original));
  });
});
