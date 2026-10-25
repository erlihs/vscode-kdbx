import { describe, expect, it } from "vitest";
import { calibrateArgon2id, NEW_DATABASE_KDF } from "../dist/defaults.js";
import type { Argon2Parameters } from "../dist/defaults.js";
import { INPUT_LIMITS } from "../dist/preflight.js";

const MiB = 1024 * 1024;
/** Fake machine: each iteration costs `msPerIterationAt64MiB`, scaled linearly by memory. */
const machine = (msPerIterationAt64MiB: number) => {
  const calls: Argon2Parameters[] = [];
  const measure = async (parameters: Argon2Parameters) => {
    calls.push(parameters);
    return parameters.iterations * msPerIterationAt64MiB * (parameters.memoryBytes / (64 * MiB));
  };
  return { calls, measure };
};

describe("new-database Argon2id calibration", () => {
  it("rounds iterations up at the memory floor on a typical machine", async () => {
    const { measure } = machine(150);
    const result = await calibrateArgon2id(measure);
    expect(result.parameters).toEqual({ memoryBytes: 64 * MiB, iterations: 7, parallelism: 2 });
    expect(result.measuredMs).toBeGreaterThanOrEqual(NEW_DATABASE_KDF.targetMs);
  });

  it("raises memory instead of exceeding the iteration ceiling on fast machines", async () => {
    const { measure } = machine(70);
    const result = await calibrateArgon2id(measure);
    expect(result.parameters).toEqual({ memoryBytes: 128 * MiB, iterations: 8, parallelism: 2 });
  });

  it("stops at both ceilings on very fast machines", async () => {
    const { measure } = machine(1);
    const result = await calibrateArgon2id(measure);
    expect(result.parameters).toEqual({
      memoryBytes: INPUT_LIMITS.argonMemoryBytes,
      iterations: NEW_DATABASE_KDF.maxIterations,
      parallelism: 2,
    });
  });

  it("never goes below the floor on slow machines", async () => {
    const { measure } = machine(5_000);
    const result = await calibrateArgon2id(measure);
    expect(result.parameters).toEqual({
      memoryBytes: NEW_DATABASE_KDF.memoryBytes,
      iterations: NEW_DATABASE_KDF.minIterations,
      parallelism: 2,
    });
  });

  it("keeps every chosen value within the admission limits for reopening", async () => {
    for (const cost of [1, 20, 70, 150, 400, 5_000]) {
      const { calls, measure } = machine(cost);
      await calibrateArgon2id(measure);
      for (const parameters of calls) {
        expect(parameters.memoryBytes).toBeLessThanOrEqual(INPUT_LIMITS.argonMemoryBytes);
        expect(parameters.iterations).toBeLessThanOrEqual(INPUT_LIMITS.argonIterations);
        expect(parameters.parallelism).toBeLessThanOrEqual(INPUT_LIMITS.argonParallelism);
      }
    }
  });
});
