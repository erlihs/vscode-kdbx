import { describe, expect, it } from "vitest";
import { SessionClient } from "../dist/session-client.js";
import { isSessionCommand, isSessionRequest } from "../dist/session-protocol.js";
import { createFixture, SYNTHETIC_PASSWORD } from "../dist/fixture.js";

describe("persistent worker protocol", () => {
  it("validates exact command shapes, bounds and XML characters", () => {
    expect(isSessionCommand({ kind: "list", password: "unexpected" })).toBe(false);
    expect(isSessionCommand({ kind: "editEntry", entryId: "x", fields: {} })).toBe(false);
    expect(
      isSessionCommand({
        kind: "editEntry",
        entryId: "x",
        fields: { Notes: { value: "\ud800", protected: false } },
      }),
    ).toBe(false);
    expect(isSessionCommand({ kind: "createEntry", title: "Valid \u{1f512}\n& <text>" })).toBe(
      true,
    );
    expect(isSessionCommand({ kind: "changePassword", password: "\u0000" })).toBe(true);
    expect(isSessionRequest({ id: 0, session: "x", command: { kind: "list" } })).toBe(false);
    expect(isSessionRequest({ id: 1, session: "x", command: { kind: "list" }, extra: true })).toBe(
      false,
    );
  });

  it("clears pending transport state after synchronous transfer errors", async () => {
    const client = new SessionClient();
    try {
      const bytes = new ArrayBuffer(10);
      structuredClone(bytes, { transfer: [bytes] });
      await expect(client.request({ kind: "unlock", bytes, password: "" })).rejects.toMatchObject({
        code: "WORKER",
      });
      await expect(client.request({ kind: "list" })).rejects.toMatchObject({ code: "LOCKED" });
    } finally {
      await client.stop();
    }
  });

  it("terminates in-flight unlock before cancellation resolves, then refuses more operations", async () => {
    const db = await createFixture({ cipher: "aes256", kdf: "argon2id", compression: "gzip" });
    const client = new SessionClient();
    const request = client.request({
      kind: "unlock",
      bytes: await db.save(),
      password: SYNTHETIC_PASSWORD,
    });
    const stopped = client.stop();
    await expect(request).rejects.toMatchObject({ code: "CANCELLED" });
    await stopped;
    await expect(client.request({ kind: "list" })).rejects.toMatchObject({ code: "WORKER" });
  });
});
