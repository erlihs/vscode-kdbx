// Cross-application round trip with KeePass 2.x or KeePassXC (synthetic data only).
//   pnpm interop -- --app keepassxc   keepassxc-cli on PATH or $KEEPASSXC_CLI
//   pnpm interop -- --app keepass     KPScript (next to KeePass.exe) on PATH or $KPSCRIPT
//   add --write-fixtures to refresh the committed fixtures written by that application
import { execFileSync, spawnSync } from "node:child_process";
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

const argv = process.argv.slice(2);
const appName = argv[argv.indexOf("--app") + 1] ?? "keepassxc";
const writeFixtures = argv.includes("--write-fixtures");
const work = mkdtempSync(join(tmpdir(), "kdbx-interop-"));
const password = () => credentials(SYNTHETIC_PASSWORD);

function keepassxc() {
  const cli = process.env.KEEPASSXC_CLI || "keepassxc-cli";
  const run = (args, input = `${SYNTHETIC_PASSWORD}\n`) =>
    execFileSync(cli, args, { input, stdio: ["pipe", "pipe", "pipe"] }).toString("utf8");
  const cipherNames = { aes256: "AES 256-bit", chacha20: "ChaCha20 256-bit" };
  const kdfNames = { aes: "AES (", argon2d: "Argon2d (", argon2id: "Argon2id (" };
  // The fixture entry is created before its duplicate-titled sibling, so KeePassXC finds it first.
  const fixtureEntry = "/Duplicate title/Duplicate title";
  return {
    version: run(["--version"], "").trim(),
    fixtures: "keepassxc",
    addEntry: (file) =>
      run(
        ["add", "-q", "-u", INTEROP_ENTRY.userName, "-p", file, INTEROP_ENTRY.path],
        `${SYNTHETIC_PASSWORD}\n${INTEROP_ENTRY.password}\n`,
      ),
    readField: (file, path, field) => run(["show", "-q", "-s", "-a", field, file, path]).trim(),
    checkHeader(file, settings) {
      const info = run(["db-info", "-q", file]);
      if (!info.includes(`Cipher: ${cipherNames[settings.cipher]}`)) throw new Error(info);
      if (!info.includes(`KDF: ${kdfNames[settings.kdf]}`)) throw new Error(info);
    },
    // KeePassXC XML exports omit attachment contents; export each attachment instead.
    checkAttachments(file) {
      const exported = join(work, "attachment.bin");
      for (const [name, hex] of FIXTURE_ATTACHMENTS) {
        // --stdout re-encodes binary data as text on Windows; a file export is byte-exact.
        run(["attachment-export", "-q", file, fixtureEntry, name, exported]);
        if (readFileSync(exported).toString("hex") !== hex) {
          throw new Error(`KeePassXC read attachment ${name} wrong`);
        }
        rmSync(exported);
      }
    },
    xmlHasAttachments: false,
    exportXml: (file) => run(["export", "-q", "-f", "xml", file]),
    importXml: (xml, file) =>
      run(["import", "-q", "-p", xml, file], `${SYNTHETIC_PASSWORD}\n${SYNTHETIC_PASSWORD}\n`),
  };
}

function keepass() {
  const cli = process.env.KPSCRIPT || "KPScript";
  const run = (command, file, ...args) => {
    const output = execFileSync(cli, [`-c:${command}`, file, `-pw:${SYNTHETIC_PASSWORD}`, ...args])
      .toString("utf8")
      .trim()
      .split(/\r?\n/);
    if (!output.at(-1)?.startsWith("OK:")) throw new Error(`KPScript ${command} failed`);
    return output.slice(0, -1);
  };
  const banner = spawnSync(cli, [], { encoding: "utf8" }).stdout;
  return {
    version: `KeePass ${/KeePass Runtime: (\S+)/.exec(banner)?.[1] ?? "unknown"}`,
    fixtures: "keepass",
    addEntry: (file) =>
      run(
        "AddEntry",
        file,
        `-Title:${INTEROP_ENTRY.title}`,
        `-UserName:${INTEROP_ENTRY.userName}`,
        `-Password:${INTEROP_ENTRY.password}`,
      ),
    readField: (file, path, field) =>
      run(
        "GetEntryString",
        file,
        `-Field:${field}`,
        `-ref-Title:${path.slice(1)}`,
        "-FailIfNotExists",
        "-FailIfNoEntry",
      ).join("\n"),
    xmlHasAttachments: true,
    exportXml(file) {
      const out = join(work, "export.xml");
      run("Export", file, "-Format:KeePass XML (2.x)", `-OutFile:${out}`);
      const xml = readFileSync(out, "utf8");
      rmSync(out);
      return xml;
    },
  };
}

const app = appName === "keepass" ? keepass() : keepassxc();
const fixtures = new URL(`../packages/core/test/fixtures/${app.fixtures}/`, import.meta.url);

/** Adapter edit, then the other application must decrypt the adapter-written file. */
async function adapterWriteThenAppRead(loaded, file, settings, interopEntry) {
  applyAdapterEdit(loaded.db);
  writeFileSync(file, new Uint8Array(await saveDatabase(loaded)));
  if (settings) app.checkHeader?.(file, settings);
  if (app.readField(file, ADAPTER_EDIT.path, ADAPTER_EDIT.field) !== ADAPTER_EDIT.value) {
    throw new Error("Application did not read the adapter edit.");
  }
  app.checkAttachments?.(file);
  // The application's own decryption and XML export, re-checked by the shared oracle.
  const problems = await exportedXmlProblems(app.exportXml(file), {
    interopEntry,
    publicCustomData: false,
    attachments: app.xmlHasAttachments,
  });
  if (problems.length) throw new Error(`read back: ${problems.join("; ")}`);
}

async function viaAppRewrite(settings) {
  const name = `${settings.cipher}-${settings.kdf}-${settings.compression}.kdbx`;
  const file = join(work, name);
  const db = await createFixture(settings);
  writeFileSync(file, new Uint8Array(await db.save()));
  app.addEntry(file);
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
    if (loaded.header[key] !== settings[key]) problems.push(`application changed ${key}`);
  }
  if (problems.length) throw new Error(problems.join("; "));
  await adapterWriteThenAppRead(loaded, file, settings, true);
}

async function viaAppImport() {
  const name = `${app.fixtures}-import.kdbx`;
  const xml = join(work, "fixture.xml");
  const file = join(work, name);
  const db = await createFixture({ cipher: "aes256", kdf: "argon2id", compression: "gzip" });
  writeFileSync(xml, await db.saveXml());
  app.importXml(xml, file);
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
  await adapterWriteThenAppRead(loaded, file, undefined, false);
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
          viaAppRewrite({ cipher, kdf, compression }),
        );
      }
    }
  }
  if (app.importXml) await run("native import", viaAppImport);
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`Synthetic data only | ${app.version}`);
console.table(rows);
if (failed) process.exitCode = 1;
