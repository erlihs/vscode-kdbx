import { describe, expect, it } from "vitest";
import type { EntrySummary, GroupSummary } from "@vscode-kdbx/core";
import { changedFields, entryMatchesSearch } from "../src/webview.js";

const groups: GroupSummary[] = [
  { id: "root", parentId: null, name: "Personal", recycleBin: false },
  { id: "child", parentId: "root", name: "Accounts", recycleBin: false },
];
const entry: EntrySummary = {
  id: "entry",
  groupId: "child",
  title: "Example account",
  username: "alice",
  url: "https://example.invalid",
  tags: ["work", "important"],
};

describe("webview safe summary search", () => {
  it.each([
    "",
    "example",
    "ALICE",
    "example.invalid",
    "important",
    "personal/accounts",
    "work alice",
  ])("matches approved summary metadata: %s", (query) => {
    expect(entryMatchesSearch(entry, query, groups)).toBe(true);
  });

  it("does not search entry IDs, group IDs or unrelated field data", () => {
    const data = { ...entry, password: "private-secret", notes: "private-note" };
    for (const query of ["entry", "child", "private-secret", "private-note"]) {
      expect(entryMatchesSearch(data, query, groups)).toBe(false);
    }
  });

  it("handles missing and cyclic group ancestry without looping", () => {
    expect(entryMatchesSearch(entry, "example", [])).toBe(true);
    const cyclic = groups.map((group) => ({
      ...group,
      parentId: group.id === "root" ? "child" : "root",
    }));
    expect(entryMatchesSearch(entry, "accounts", cyclic)).toBe(true);
  });
});

describe("explicit field edits", () => {
  it("does not send unchanged protected placeholders as blank values", () => {
    const edits = changedFields(
      new Map([
        ["Password", { value: "", protected: true, changed: false }],
        ["Title", { value: "New title", protected: false, changed: true }],
        ["hidden custom", { value: "", protected: true, changed: false }],
      ]),
    );
    expect(Object.keys(edits)).toEqual(["Title"]);
    expect(edits.Title).toEqual({ value: "New title", protected: false });
    expect(edits.Password).toBeUndefined();
  });

  it("submits deliberately modified secrets, including intentional empty replacements", () => {
    const edits = changedFields(
      new Map([
        ["Password", { value: "generated-secret", protected: true, changed: true }],
        ["custom", { value: "", protected: true, changed: true }],
      ]),
    );
    expect(edits.Password).toEqual({ value: "generated-secret", protected: true });
    expect(edits.custom).toEqual({ value: "", protected: true });
  });

  it("preserves arbitrary custom field names as own data without prototype mutation", () => {
    const edits = changedFields(
      new Map([["__proto__", { value: "ordinary text", protected: false, changed: true }]]),
    );
    expect(Object.getPrototypeOf(edits)).toBeNull();
    expect(Object.hasOwn(edits, "__proto__")).toBe(true);
    expect(edits["__proto__"]).toEqual({ value: "ordinary text", protected: false });
  });
});
