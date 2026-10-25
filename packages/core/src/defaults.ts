import { INPUT_LIMITS } from "./preflight.js";

/**
 * New-database key derivation policy. Existing databases always keep their stored
 * settings; these values are never used to weaken them.
 */
export const NEW_DATABASE_KDF = Object.freeze({
  kdf: "argon2id" as const,
  /** Memory floor, matching the KeePass and KeePassXC defaults. */
  memoryBytes: 64 * 1024 * 1024,
  maxMemoryBytes: INPUT_LIMITS.argonMemoryBytes,
  parallelism: 2,
  minIterations: 2,
  maxIterations: INPUT_LIMITS.argonIterations,
  targetMs: 1000,
});

export interface Argon2Parameters {
  memoryBytes: number;
  iterations: number;
  parallelism: number;
}

export interface Argon2Calibration {
  parameters: Argon2Parameters;
  /** Measured duration of one derivation with the chosen parameters. */
  measuredMs: number;
}

/** Returns the duration in milliseconds of one Argon2id derivation. */
export type Argon2Measure = (parameters: Argon2Parameters) => Promise<number>;

/**
 * Chooses Argon2id parameters for a new database that take roughly `targetMs` on this
 * machine. Starts at the memory floor and rounds iterations up; if the iteration
 * ceiling is still too fast, memory doubles up to its ceiling. Never goes below the
 * floor, so slow machines get the floor settings and a longer unlock.
 */
export async function calibrateArgon2id(
  measure: Argon2Measure,
  policy: typeof NEW_DATABASE_KDF = NEW_DATABASE_KDF,
): Promise<Argon2Calibration> {
  let memoryBytes = policy.memoryBytes;
  while (true) {
    const single = await measure({ memoryBytes, iterations: 1, parallelism: policy.parallelism });
    const wanted = Math.ceil(policy.targetMs / Math.max(single, 1));
    if (wanted <= policy.maxIterations || memoryBytes * 2 > policy.maxMemoryBytes) {
      const parameters = {
        memoryBytes,
        iterations: Math.min(Math.max(wanted, policy.minIterations), policy.maxIterations),
        parallelism: policy.parallelism,
      };
      return { parameters, measuredMs: await measure(parameters) };
    }
    memoryBytes *= 2;
  }
}

/**
 * Resource limits for workers that load databases. Exceeding a worker heap limit can
 * abort the whole process rather than only the worker, so the XML ceilings keep a
 * database at both ceilings below 75% of this heap. Verified by `pnpm calibrate`.
 */
export const WORKER_RESOURCE_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 2048,
  maxYoungGenerationSizeMb: 64,
  stackSizeMb: 4,
});
