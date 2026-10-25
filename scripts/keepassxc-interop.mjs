// Cross-application round trip with KeePassXC (synthetic data only).
//   pnpm interop                      verify with keepassxc-cli on PATH or $KEEPASSXC_CLI
//   pnpm interop -- --write-fixtures  also refresh the committed KeePassXC-written fixtures
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDatabase, saveDatabase } from "../packages/core/dist/adapter.js";
import { credentials } from "../packages/core/dist/candidate.js";
import { createFixture, SYNTHETIC_PASSWORD } from "../packages/core/dist/fixture.js";
import {
  ADAPTER_EDIT,
  applyAdapterEdit,
  exportedXmlProblems,
  FIXTURE_ATTACHMENTS,
  INTEROP_ENTRY,
  interopProblems,
} from "../packages/core/dist/interop.js";

const cli = process.env.KEEPASSXC_CLI || "keepassxc-cli";
const fixtures = new URL("../packages/core/test/fixtures/keepassxc/", import.meta.url);
const writeFixtures = process.argv.includes("--write-fixtures");
const work = mkdtempSync(join(tmpdir(), "kdbx-interop-"));
const password = () => credentials(SYNTHETIC_PASSWORD);

function kpxc(args, input = `${SYNTHETIC_PASSWORD}\n`) {
  return execFileSync(cli, args, { input, stdio: ["pipe", "pipe", "pipe"] }).toString("utf8");
}

const version = kpxc(["--version"], "").trim();
const cipherNames = { aes256: "AES 256-bit", chacha20: "ChaCha20 256-bit" };
const kdfNames = { aes: "AES (", argon2d: "Argon2d (", argon2id: "Argon2id (" };
// The fixture entry is created before its duplicate-titled sibling, so KeePassXC finds it first.
const FIXTURE_ENTRY_PATH = "/Duplicate title/Duplicate title";

/** Adapter edit, then KeePassXC must decrypt the adapter-written file and see everything. */
async function adapterWriteThenKeePassXcRead(loaded, file, settings, interopEntry) {
  applyAdapterEdit(loaded.db);
  writeFileSync(file, new Uint8Array(await saveDatabase(loaded)));

  const info = kpxc(["db-info", "-q", file]);
  if (settings) {
    if (!info.includes(`Cipher: ${cipherNames[settings.cipher]}`)) throw new Error(info);
    if (!info.includes(`KDF: ${kdfNames[settings.kdf]}`)) throw new Error(info);
  }
  const shown = kpxc(["show", "-q", "-s", "-a", ADAPTER_EDIT.field, file, ADAPTER_EDIT.path]);
  if (shown.trim() !== ADAPTER_EDIT.value) throw new Error("KeePassXC did not read the edit.");
  for (const [name, hex] of FIXTURE_ATTACHMENTS) {
    // --stdout re-encodes binary data as text on Windows; a file export is byte-exact.
    const exported = join(work, "attachment.bin");
    kpxc(["attachment-export", "-q", file, FIXTURE_ENTRY_PATH, name, exported]);
    if (readFileSync(exported).toString("hex") !== hex) {
      throw new Error(`KeePassXC read attachment ${name} wrong`);
    }
    rmSync(exported);
  }
  // KeePassXC's own decryption and XML export, re-checked by the shared oracle.
  const xml = kpxc(["export", "-q", "-f", "xml", file]);
  const problems = await exportedXmlProblems(xml, {
    interopEntry,
    publicCustomData: false,
    attachments: false,
  });
  if (problems.length) throw new Error(`KeePassXC read back: ${problems.join("; ")}`);
}

async function viaKeePassXcRewrite(settings) {
  const name = `${settings.cipher}-${settings.kdf}-${settings.compression}.kdbx`;
  const file = join(work, name);
  const db = await createFixture(settings);
  writeFileSync(file, new Uint8Array(await db.save()));
  kpxc(
    ["add", "-q", "-u", INTEROP_ENTRY.userName, "-p", file, INTEROP_ENTRY.path],
    `${SYNTHETIC_PASSWORD}\n${INTEROP_ENTRY.password}\n`,
  );
  if (writeFixtures) writeFileSync(new URL(name, fixtures), readFileSync(file));
  const loaded = await loadDatabase(new Uint8Array(readFileSync(file)), password());
  const problems = [
    ...loaded.readOnlyReasons,
    ...interopProblems(loaded.db, {
      interopEntry: true,
      publicCustomData: true,
      attachments: true,
    }),
  ];
  for (const key of ["cipher", "kdf", "compression"]) {
    if (loaded.header[key] !== settings[key]) problems.push(`KeePassXC changed ${key}`);
  }
  if (problems.length) throw new Error(problems.join("; "));
  await adapterWriteThenKeePassXcRead(loaded, file, settings, true);
}

async function viaKeePassXcImport() {
  const name = "keepassxc-import.kdbx";
  const xml = join(work, "fixture.xml");
  const file = join(work, name);
  const db = await createFixture({ cipher: "aes256", kdf: "argon2id", compression: "gzip" });
  writeFileSync(xml, await db.saveXml());
  kpxc(["import", "-q", "-p", xml, file], `${SYNTHETIC_PASSWORD}\n${SYNTHETIC_PASSWORD}\n`);
  if (writeFixtures) writeFileSync(new URL(name, fixtures), readFileSync(file));
  const loaded = await loadDatabase(new Uint8Array(readFileSync(file)), password());
  const problems = [
    ...loaded.readOnlyReasons,
    ...interopProblems(loaded.db, {
      interopEntry: false,
      publicCustomData: false,
      attachments: true,
    }),
  ];
  if (problems.length) throw new Error(problems.join("; "));
  await adapterWriteThenKeePassXcRead(loaded, file, undefined, false);
}

const rows = [];
let failed = false;
const run = async (label, action) => {
  try {
    await action();
    rows.push({ case: label, result: "ok" });
  } catch (error) {
    failed = true;
    rows.push({ case: label, result: error instanceof Error ? error.message : String(error) });
  }
};

try {
  if (writeFixtures) mkdirSync(fixtures, { recursive: true });
  for (const cipher of ["aes256", "chacha20"]) {
    for (const kdf of ["argon2id", "argon2d", "aes"]) {
      for (const compression of ["gzip", "none"]) {
        await run(`rewrite ${cipher}/${kdf}/${compression}`, () =>
          viaKeePassXcRewrite({ cipher, kdf, compression }),
        );
      }
    }
  }
  await run("KeePassXC-native import", viaKeePassXcImport);
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`Synthetic data only | ${version}`);
console.table(rows);
if (failed) process.exitCode = 1;
