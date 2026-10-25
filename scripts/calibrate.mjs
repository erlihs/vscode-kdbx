// Calibrates new-database KDF settings and worker heap sizing on this machine.
// Synthetic data only. Run with `pnpm calibrate`; `--kdf` or `--heap` runs one part.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { measureArgon2id } from "../packages/core/dist/candidate.js";
import {
  calibrateArgon2id,
  NEW_DATABASE_KDF,
  WORKER_RESOURCE_LIMITS,
} from "../packages/core/dist/defaults.js";
import { addSyntheticEntries, createFixture } from "../packages/core/dist/fixture.js";
import { INPUT_LIMITS } from "../packages/core/dist/preflight.js";

const only = process.argv.find((arg) => arg === "--kdf" || arg === "--heap");
const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MiB`;
console.log(`Synthetic data only | Node ${process.version} | ${platform()} ${release()}`);
console.log(`Reference CPU: ${cpus()[0]?.model.trim()} x${cpus().length}, RAM ${mib(totalmem())}`);

if (only !== "--heap") {
  const runs = [];
  for (let run = 0; run < 3; run++) runs.push(await calibrateArgon2id(measureArgon2id));
  console.log(`\nNew-database Argon2id policy: ${JSON.stringify(NEW_DATABASE_KDF)}`);
  console.table(
    runs.map(({ parameters, measuredMs }) => ({
      memory: mib(parameters.memoryBytes),
      iterations: parameters.iterations,
      parallelism: parameters.parallelism,
      ms: Math.round(measuredMs),
    })),
  );
}

if (only !== "--kdf") {
  // KeePass-shaped synthetic databases just under each XML ceiling: standard fields,
  // a protected password, tags and two history states per entry; the size scenario
  // adds long notes so the character ceiling is reached before the element ceiling.
  const countXml = async (database) => {
    const xml = await database.saveXml();
    let elements = 0;
    for (let index = xml.indexOf("<"); index !== -1; index = xml.indexOf("<", index + 1)) {
      const next = xml[index + 1];
      if (next !== "/" && next !== "!" && next !== "?") elements++;
    }
    return { elements, chars: xml.length };
  };
  const elementsPerEntry = async (notes) => {
    const db = await createFixture({ cipher: "aes256", kdf: "argon2id", compression: "gzip" });
    const before = await countXml(db);
    addSyntheticEntries(db, 100, 0, notes);
    const after = await countXml(db);
    return {
      elements: (after.elements - before.elements) / 100,
      chars: (after.chars - before.chars) / 100,
    };
  };
  // Notes length that reaches both ceilings together (notes repeat in each history state).
  const plain = await elementsPerEntry(0);
  const noted = await elementsPerEntry(1000);
  const entriesAtCeiling = (INPUT_LIMITS.xmlElements * 0.99) / plain.elements;
  const bothNotes = Math.floor(
    ((INPUT_LIMITS.xmlChars * 0.99) / entriesAtCeiling - plain.chars) /
      ((noted.chars - plain.chars) / 1000),
  );
  const scenarios = [
    { name: "element ceiling", notes: 0, metric: "elements", limit: INPUT_LIMITS.xmlElements },
    { name: "size ceiling", notes: 4096, metric: "chars", limit: INPUT_LIMITS.xmlChars },
    {
      name: "both ceilings",
      notes: bothNotes,
      metric: "elements",
      limit: INPUT_LIMITS.xmlElements,
    },
  ];
  const rows = [];
  for (const scenario of scenarios) {
    const db = await createFixture({ cipher: "aes256", kdf: "argon2id", compression: "gzip" });
    const baseline = await countXml(db);
    addSyntheticEntries(db, 100, 0, scenario.notes);
    const sample = await countXml(db);
    const perEntry = (sample[scenario.metric] - baseline[scenario.metric]) / 100;
    const target = Math.floor((scenario.limit * 0.99 - sample[scenario.metric]) / perEntry);
    addSyntheticEntries(db, target, 100, scenario.notes);
    const size = await countXml(db);
    const file = join(mkdtempSync(join(tmpdir(), "kdbx-calibrate-")), "synthetic.kdbx");
    writeFileSync(file, new Uint8Array(await db.save()));
    // Smallest worker heap (MiB, within 5%) that loads it through the real adapter path.
    let low = 32;
    let high = 8192;
    let passing;
    while (high / low > 1.05) {
      const heap = Math.round(Math.sqrt(low * high));
      const result = loadInProcess(file, heap);
      if (result.ok) {
        high = heap;
        passing = result;
      } else {
        low = heap;
      }
    }
    rmSync(dirname(file), { recursive: true, force: true });
    rows.push({
      scenario: scenario.name,
      elements: size.elements,
      xmlMiChars: Number((size.chars / 1024 / 1024).toFixed(1)),
      entries: target + 102,
      minHeapMb: passing ? high : "> 8192",
      loadMs: passing?.ms,
      readOnly: passing?.readOnly,
    });
    console.table(rows.slice(-1));
  }
  console.log(`Configured worker heap: ${WORKER_RESOURCE_LIMITS.maxOldGenerationSizeMb} MiB`);
  console.table(rows);
  const budget = WORKER_RESOURCE_LIMITS.maxOldGenerationSizeMb * 0.75;
  const over = rows.filter((row) => typeof row.minHeapMb !== "number" || row.minHeapMb > budget);
  if (over.length) {
    console.log(`FAIL: ${over.map((row) => row.scenario).join(", ")} exceed 75% of the heap.`);
    process.exitCode = 1;
  } else {
    console.log(`OK: every ceiling scenario fits within 75% (${budget} MiB) of the worker heap.`);
  }
}

/** A worker OOM can abort its whole process, so every attempt gets its own. */
function loadInProcess(file, heap) {
  const worker = fileURLToPath(new URL("./calibrate-load-worker.mjs", import.meta.url));
  const child = spawnSync(process.execPath, [worker, file, String(heap)], { encoding: "utf8" });
  const line = child.stdout.trim().split(/\r?\n/).at(-1);
  try {
    return JSON.parse(line ?? "");
  } catch {
    return { ok: false, code: `process exited ${child.status ?? child.signal}` };
  }
}
