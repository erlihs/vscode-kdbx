export { DatabaseError } from "./errors.js";
export type { ErrorCode } from "./errors.js";
export { inspectHeader, INPUT_LIMITS } from "./preflight.js";
export type { Cipher, Kdf, HeaderInfo } from "./preflight.js";
export { runCompatibilityProbe } from "./probe.js";
export type { CompatibilityReport, ProbeOptions } from "./probe.js";
