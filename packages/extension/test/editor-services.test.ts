import { describe, expect, it } from "vitest";
import {
  attachmentSuggestion,
  decodeBackup,
  encodeBackup,
  generatePassword,
} from "../src/editor-services.js";
import { isEditorRequest, isUiState } from "../src/editor-protocol.js";

describe("editor boundary services", () => {
  it("round trips nonsecret backup metadata and refuses traversal/malformed IDs", () => {
    const reference = {
      id: "opaque.kdbx",
      sourceHash: "a".repeat(64),
      snapshotHash: "b".repeat(64),
      credentialsChanged: true,
    };
    expect(decodeBackup(encodeBackup(reference))).toEqual(reference);
    expect(() => decodeBackup("not JSON")).toThrow("invalid");
    expect(() => decodeBackup(encodeBackup({ ...reference, id: "..\\elsewhere.kdbx" }))).toThrow(
      "invalid",
    );
    expect(() =>
      decodeBackup(JSON.stringify({ ...reference, version: 1, password: "never persist" })),
    ).toThrow("invalid");
  });
  it("uses secure generation with every selected class and validates settings", () => {
    const options = {
      kind: "generate",
      length: 24,
      lower: true,
      upper: true,
      digits: true,
      symbols: true,
    } as const;
    const values = new Set(Array.from({ length: 100 }, () => generatePassword(options)));
    expect(values.size).toBe(100);
    for (const value of values) {
      expect(value).toHaveLength(24);
      expect(value).toMatch(/[a-z]/);
      expect(value).toMatch(/[A-Z]/);
      expect(value).toMatch(/[0-9]/);
      expect(value).toMatch(/[!@#$%^&*()\-_=+[\]{};:,.?]/);
    }
    expect(() => generatePassword({ ...options, length: 0 })).toThrow();
    expect(() =>
      generatePassword({ ...options, lower: false, upper: false, digits: false, symbols: false }),
    ).toThrow();
  });
  it("never treats attachment labels as destination paths", () => {
    expect(attachmentSuggestion("..\\..\\private\\certificate.cer")).toBe("certificate.cer");
    expect(attachmentSuggestion("../../CON")).toBe("_CON");
    expect(attachmentSuggestion("")).toBe("attachment.bin");
    expect(
      Buffer.byteLength(attachmentSuggestion("\u{1f512}".repeat(300)), "utf8"),
    ).toBeLessThanOrEqual(200);
  });
  it("checks message identity, exact keys, bounds and unsafe payload shapes", () => {
    const valid = { channel: "own", id: 1, action: { kind: "unlock", password: "synthetic" } };
    expect(isEditorRequest(valid, "own")).toBe(true);
    expect(isEditorRequest(valid, "another")).toBe(false);
    expect(isEditorRequest({ ...valid, id: 0 }, "own")).toBe(false);
    expect(
      isEditorRequest(
        { ...valid, action: { kind: "unlock", password: "", command: "execute" } },
        "own",
      ),
    ).toBe(false);
    expect(
      isEditorRequest(
        {
          ...valid,
          action: {
            kind: "updateEntry",
            id: "x",
            fields: {},
            removeFields: [],
            tags: [],
            groupId: "x",
          },
        },
        "own",
      ),
    ).toBe(true);
    expect(
      isEditorRequest(
        {
          ...valid,
          action: {
            kind: "generate",
            length: 129,
            lower: true,
            upper: true,
            digits: true,
            symbols: true,
          },
        },
        "own",
      ),
    ).toBe(false);
    expect(isUiState({ locked: true, password: "invalid state" })).toBe(false);
  });
});
