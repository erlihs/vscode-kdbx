import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { WORKER_RESOURCE_LIMITS } from "./defaults.js";
import { DatabaseError } from "./errors.js";
import { isRecord, isSessionCommand } from "./session-protocol.js";
import type { SessionCommand } from "./session-protocol.js";

const ERROR_CODES = new Set([
  "FORMAT",
  "UNSUPPORTED",
  "RESOURCE_LIMIT",
  "AUTHENTICATION_OR_INTEGRITY",
  "CANCELLED",
  "COMPATIBILITY",
  "READ_ONLY",
  "WORKER",
  "IO",
  "CONFLICT",
  "INVALID_INPUT",
  "LOCKED",
  "RECOVERY_REQUIRED",
  "RECOVERY_CLEANUP",
  "PERSISTENCE_UNCERTAIN",
]);

export class SessionClient {
  private readonly session = randomUUID();
  private readonly worker = new Worker(new URL("./session-worker.js", import.meta.url), {
    workerData: this.session,
    resourceLimits: WORKER_RESOURCE_LIMITS,
  });
  private sequence = 0;
  private closed = false;
  private failure: DatabaseError | undefined;
  private stopping: Promise<void> | undefined;
  private pending:
    | { id: number; resolve(value: unknown): void; reject(error: DatabaseError): void }
    | undefined;

  constructor() {
    this.worker.on("message", (reply: unknown) => {
      if (this.closed) return;
      const pending = this.pending;
      if (
        !pending ||
        !isRecord(reply) ||
        reply.session !== this.session ||
        reply.id !== pending.id ||
        typeof reply.ok !== "boolean"
      ) {
        void this.stop(
          new DatabaseError("WORKER", "The database worker returned an invalid response."),
        );
        return;
      }
      if (reply.ok) {
        this.pending = undefined;
        pending.resolve(reply.result);
      } else if (
        typeof reply.code === "string" &&
        ERROR_CODES.has(reply.code) &&
        typeof reply.message === "string"
      ) {
        this.pending = undefined;
        // Error codes originate in our worker, but are runtime-checked at the boundary.
        pending.reject(new DatabaseError(reply.code as DatabaseError["code"], reply.message));
      } else {
        void this.stop(
          new DatabaseError("WORKER", "The database worker returned an invalid error."),
        );
      }
    });
    this.worker.on("error", () => {
      // An uncaught worker exception is followed by exit. Reject only once it has exited.
      this.failure = new DatabaseError(
        "WORKER",
        "The database worker failed. Unsaved in-memory data may be unavailable.",
      );
    });
    this.worker.on("exit", () => {
      if (!this.closed) {
        this.closed = true;
        this.pending?.reject(
          this.failure ?? new DatabaseError("WORKER", "The database worker exited unexpectedly."),
        );
        this.pending = undefined;
      }
    });
  }

  request(command: SessionCommand): Promise<unknown> {
    if (!isSessionCommand(command)) {
      return Promise.reject(
        new DatabaseError("INVALID_INPUT", "Invalid database operation settings."),
      );
    }
    if (this.closed)
      return Promise.reject(
        this.failure ?? new DatabaseError("WORKER", "The database worker is unavailable."),
      );
    if (this.pending)
      return Promise.reject(new DatabaseError("WORKER", "Database operations must be serialized."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject };
      try {
        this.worker.postMessage(
          { id, session: this.session, command },
          command.kind === "unlock" ? [command.bytes] : [],
        );
      } catch {
        this.pending = undefined;
        reject(
          new DatabaseError("WORKER", "The database operation could not be sent to the worker."),
        );
      }
    });
  }

  stop(reason = new DatabaseError("CANCELLED", "Database operation cancelled.")): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.closed) return Promise.resolve();
    this.closed = true;
    const pending = this.pending;
    this.pending = undefined;
    this.stopping = this.worker.terminate().then(
      () => {
        pending?.reject(reason);
      },
      () => {
        this.failure = new DatabaseError("WORKER", "The database worker could not be terminated.");
        pending?.reject(this.failure);
        throw this.failure;
      },
    );
    // Event callbacks cannot await termination; callers can observe failure through stop/request.
    void this.stopping.catch((error: unknown) => {
      this.failure =
        error instanceof DatabaseError
          ? error
          : new DatabaseError("WORKER", "Worker termination failed.");
    });
    return this.stopping;
  }
}
