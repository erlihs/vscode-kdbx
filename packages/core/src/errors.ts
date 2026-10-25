export type ErrorCode =
  | "FORMAT"
  | "UNSUPPORTED"
  | "RESOURCE_LIMIT"
  | "AUTHENTICATION_OR_INTEGRITY"
  | "CANCELLED"
  | "COMPATIBILITY"
  | "WORKER";

export class DatabaseError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DatabaseError";
  }
}
