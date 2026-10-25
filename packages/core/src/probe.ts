import { Worker } from "node:worker_threads";
import { WORKER_RESOURCE_LIMITS } from "./defaults.js";
import { DatabaseError } from "./errors.js";
import type { ErrorCode } from "./errors.js";
import type { FixtureOptions } from "./fixture.js";
import { INPUT_LIMITS } from "./preflight.js";
import type { HeaderInfo } from "./preflight.js";

export interface CompatibilityReport {
  header: HeaderInfo;
  encryptedBytes: number;
  elapsedMs: number;
  preserved: true;
  freshRandomness: true;
  unknownDataRefused: true;
}

export type WorkerReply =
  | { ok: true; report: CompatibilityReport }
  | { ok: false; code: ErrorCode; message: string };

export interface ProbeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function runCompatibilityProbe(
  fixture: FixtureOptions,
  options: ProbeOptions = {},
): Promise<CompatibilityReport> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new DatabaseError("RESOURCE_LIMIT", "Probe timeout must be 1 to 120000 milliseconds.");
  }
  if (
    (fixture.version !== undefined && !["4.0", "4.1"].includes(fixture.version)) ||
    !["aes256", "chacha20"].includes(fixture.cipher) ||
    !["aes", "argon2d", "argon2id"].includes(fixture.kdf) ||
    !["none", "gzip"].includes(fixture.compression)
  ) {
    throw new DatabaseError("UNSUPPORTED", "Unsupported compatibility fixture settings.");
  }
  const argon2 = fixture.argon2;
  if (
    argon2 &&
    (fixture.kdf === "aes" ||
      !Number.isSafeInteger(argon2.memoryBytes) ||
      argon2.memoryBytes % 1024 !== 0 ||
      argon2.memoryBytes < 8192 * argon2.parallelism ||
      argon2.memoryBytes > INPUT_LIMITS.argonMemoryBytes ||
      !Number.isSafeInteger(argon2.iterations) ||
      argon2.iterations < 1 ||
      argon2.iterations > INPUT_LIMITS.argonIterations ||
      !Number.isSafeInteger(argon2.parallelism) ||
      argon2.parallelism < 1 ||
      argon2.parallelism > INPUT_LIMITS.argonParallelism)
  ) {
    throw new DatabaseError("RESOURCE_LIMIT", "Argon2 fixture settings exceed the limits.");
  }
  if (options.signal?.aborted) {
    throw new DatabaseError("CANCELLED", "Compatibility probe cancelled.");
  }
  const worker = new Worker(new URL("./probe-worker.js", import.meta.url), {
    workerData: fixture,
    resourceLimits: WORKER_RESOURCE_LIMITS,
  });
  return new Promise<CompatibilityReport>((resolve, reject) => {
    let settled = false;
    const finish = (error?: DatabaseError, report?: CompatibilityReport): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      // Do not resolve cancellation while a secret-bearing worker is still alive.
      void worker.terminate().then(
        () => {
          if (error) reject(error);
          else if (report) resolve(report);
          else reject(new DatabaseError("WORKER", "Compatibility worker returned no report."));
        },
        () => reject(new DatabaseError("WORKER", "Could not stop the compatibility worker.")),
      );
    };
    const abort = (): void =>
      finish(new DatabaseError("CANCELLED", "Compatibility probe cancelled."));
    const timer = setTimeout(
      () =>
        finish(
          new DatabaseError("RESOURCE_LIMIT", "Compatibility probe exceeded its time budget."),
        ),
      timeoutMs,
    );
    worker.once("message", (reply: WorkerReply) => {
      if (reply.ok) finish(undefined, reply.report);
      else finish(new DatabaseError(reply.code, reply.message));
    });
    worker.once("error", () =>
      finish(new DatabaseError("WORKER", "Compatibility worker failed; no database was written.")),
    );
    worker.once("exit", () => {
      if (!settled)
        finish(new DatabaseError("WORKER", "Compatibility worker exited without a report."));
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
