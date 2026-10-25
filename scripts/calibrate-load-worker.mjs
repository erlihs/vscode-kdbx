// Loads one database through the real adapter path in a worker with the given heap.
// Run as a separate process per attempt (worker OOM can abort the whole process):
//   node calibrate-load-worker.mjs <database file> <heap MiB>
import { readFileSync } from "node:fs";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { loadDatabase } from "../packages/core/dist/adapter.js";
import { credentials } from "../packages/core/dist/candidate.js";
import { WORKER_RESOURCE_LIMITS } from "../packages/core/dist/defaults.js";
import { SYNTHETIC_PASSWORD } from "../packages/core/dist/fixture.js";

if (isMainThread) {
  const [file, heap] = process.argv.slice(2);
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { bytes: readFileSync(file) },
    resourceLimits: { ...WORKER_RESOURCE_LIMITS, maxOldGenerationSizeMb: Number(heap) },
  });
  worker.once("message", (message) => {
    console.log(JSON.stringify(message));
    void worker.terminate();
  });
  worker.once("error", (error) => console.log(JSON.stringify({ ok: false, code: error.code })));
} else {
  const start = performance.now();
  try {
    const loaded = await loadDatabase(
      new Uint8Array(workerData.bytes),
      credentials(SYNTHETIC_PASSWORD),
    );
    parentPort.postMessage({
      ok: true,
      ms: Math.round(performance.now() - start),
      readOnly: loaded.readOnlyReasons.length > 0,
    });
  } catch (error) {
    parentPort.postMessage({ ok: false, code: error?.code ?? String(error) });
  }
}
