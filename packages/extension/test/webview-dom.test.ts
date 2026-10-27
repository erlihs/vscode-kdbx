// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntryDetails } from "@vscode-kdbx/core";
import type { EditorRequest, UiState } from "../src/editor-protocol.js";

let requests: EditorRequest[];
let state: UiState;
let entry: EntryDetails;
let respond: (request: EditorRequest) => void;
let cleanup: () => void;

function reply(request: EditorRequest, result?: unknown, ok = true): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { channel: "test", id: request.id, ok, result, state },
    }),
  );
}

function buttons(label: string): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter(
    (node) => (node.getAttribute("aria-label") ?? node.textContent) === label,
  );
}

function click(label: string): void {
  const node = buttons(label)[0];
  if (!node) throw new Error(`Missing button: ${label}`);
  node.click();
}

function field(label: string): HTMLInputElement {
  const caption = [...document.querySelectorAll("label")].find(
    (node) => node.textContent === label,
  );
  const input = caption && document.getElementById(caption.htmlFor);
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input: ${label}`);
  return input;
}

function fill(label: string, value: string): void {
  const node = field(label);
  node.value = value;
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

function key(key: string, options: KeyboardEventInit = {}): void {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }),
  );
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function select(): Promise<void> {
  click("Examplealice");
  await settle();
}

beforeEach(async () => {
  vi.resetModules();
  requests = [];
  state = {
    filename: "synthetic.kdbx",
    locked: false,
    dirty: false,
    readOnly: false,
    conflict: false,
    credentialsChanged: false,
    canUndo: false,
    canRedo: false,
    busy: false,
    recoveryPasswordChanged: false,
    groups: [
      { id: "root", name: "Personal", parentId: null, recycleBin: false },
      { id: "work", name: "Work", parentId: "root", recycleBin: false },
    ],
    entries: [
      {
        id: "one",
        groupId: "root",
        title: "Example",
        username: "alice",
        url: "https://example.invalid",
        tags: [],
      },
      { id: "two", groupId: "work", title: "Other", username: "bob", url: "", tags: [] },
    ],
  };
  entry = {
    id: "one",
    groupId: "root",
    tags: [],
    historyCount: 0,
    attachments: [],
    created: undefined,
    modified: undefined,
    fields: {
      Title: { value: "Example", protected: false },
      UserName: { value: "alice", protected: false },
      Password: { protected: true },
      URL: { value: "https://example.invalid", protected: false },
      Notes: { value: "Synthetic notes", protected: false },
    },
  };
  respond = (request) => {
    switch (request.action.kind) {
      case "details":
        reply(request, { ...entry, id: request.action.id });
        break;
      case "reveal":
        reply(request, "synthetic-secret");
        break;
      case "generate":
        reply(request, "generated-synthetic-secret");
        break;
      case "createEntry":
        state = {
          ...state,
          dirty: true,
          entries: [
            ...state.entries,
            {
              id: "created",
              groupId: request.action.groupId,
              title: request.action.title,
              username: "",
              url: "",
              tags: [],
            },
          ],
        };
        reply(request, "created");
        break;
      case "updateEntry":
        entry = {
          ...entry,
          fields: { ...entry.fields, ...request.action.fields },
          tags: request.action.tags,
          groupId: request.action.groupId,
        };
        state = { ...state, dirty: true };
        reply(request, entry);
        break;
      case "save":
        state = { ...state, dirty: false };
        reply(request);
        break;
      default:
        reply(request);
    }
  };
  document.body.innerHTML = '<main id="app"></main>';
  document.body.dataset.channel = "test";
  vi.stubGlobal("acquireVsCodeApi", () => ({
    postMessage: (request: EditorRequest) => {
      requests.push(structuredClone(request));
      queueMicrotask(() => respond(request));
    },
  }));
  const windowListeners = vi.spyOn(window, "addEventListener");
  const documentListeners = vi.spyOn(document, "addEventListener");
  cleanup = () => {
    for (const [type, listener, options] of windowListeners.mock.calls)
      window.removeEventListener(type, listener, options);
    for (const [type, listener, options] of documentListeners.mock.calls)
      document.removeEventListener(type, listener, options);
    windowListeners.mockRestore();
    documentListeners.mockRestore();
  };
  await import("../src/webview.js");
  await settle();
});

afterEach(() => {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { channel: "test", id: 0, ok: true, state, conceal: true },
    }),
  );
  cleanup();
  vi.unstubAllGlobals();
});

describe("unlock screen", () => {
  function lock(busy = false): void {
    state = { ...state, locked: true, busy, groups: [], entries: [] };
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { channel: "test", id: 0, ok: true, state },
      }),
    );
  }

  it("shows a focused unlock card with the filename and quiet secondary actions", () => {
    lock();
    const card = document.querySelector<HTMLElement>('[aria-label="Unlock database"]')!;
    expect(card.hidden).toBe(false);
    expect(card.querySelector(".unlock-badge")?.textContent).toBe("KeePass for VSCode");
    expect(card.querySelector("h2")?.textContent).toBe("Unlock your database");
    expect(card.querySelector(".unlock-filename")?.textContent).toBe("synthetic.kdbx");
    expect(document.querySelector("h1")?.hidden).toBe(true);
    expect(field("Master password").type).toBe("password");
    expect(document.activeElement).toBe(field("Master password"));
    expect(buttons("Cancel unlock")[0]?.hidden).toBe(true);
    expect(buttons("Create a new database…")[0]?.className).toBe("secondary-button");
  });

  it("submits and immediately clears the password; busy unlock exposes cancellation", async () => {
    lock();
    fill("Master password", "synthetic-master-password");
    document.querySelector<HTMLFormElement>(".unlock-form")!.requestSubmit();
    expect(field("Master password").value).toBe("");
    await settle();
    expect(requests.at(-1)?.action).toEqual({
      kind: "unlock",
      password: "synthetic-master-password",
    });
    lock(true);
    expect(field("Master password").disabled).toBe(true);
    expect(buttons("Unlocking…")[0]?.disabled).toBe(true);
    expect(buttons("Create a new database…")[0]?.disabled).toBe(true);
    expect(buttons("Cancel unlock")[0]?.hidden).toBe(false);
    click("Cancel unlock");
    await settle();
    expect(requests.at(-1)?.action).toEqual({ kind: "cancelUnlock" });
  });

  it("keeps unlock failures visible and allows another attempt", async () => {
    lock();
    const normal = respond;
    respond = (request) => {
      if (request.action.kind === "unlock") {
        state = { ...state, busy: false, error: "The master password is incorrect." };
        reply(request, undefined, false);
      } else normal(request);
    };
    fill("Master password", "wrong");
    document.querySelector<HTMLFormElement>(".unlock-form")!.requestSubmit();
    await settle();
    expect(document.querySelector<HTMLElement>('[role="alert"]')?.hidden).toBe(false);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("incorrect");
    expect(field("Master password").disabled).toBe(false);
    expect(field("Master password").value).toBe("");
  });
});

describe("browsing-first vault workflow", () => {
  it("starts in display mode and copies without revealing protected plaintext", async () => {
    await select();
    expect(document.querySelector("#details form")).toBeNull();
    expect(buttons("Edit")).toHaveLength(1);
    expect(document.querySelector("#details")?.textContent).toContain("••••");
    expect(document.body.textContent).not.toContain("synthetic-secret");
    click("Copy Password");
    await settle();
    expect(requests.at(-1)?.action).toEqual({ kind: "copy", id: "one", name: "Password" });
    expect(document.body.textContent).not.toContain("synthetic-secret");
    expect(document.querySelectorAll(".secondary-section[open]")).toHaveLength(0);
  });

  it("creates entries with + and opens editing even when a previous search hides the new title", async () => {
    const search = document.querySelector<HTMLInputElement>("[data-entry-search]")!;
    search.value = "missing";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    click("New entry");
    await settle();
    expect(requests.find((request) => request.action.kind === "createEntry")?.action).toEqual({
      kind: "createEntry",
      groupId: "root",
      title: "New entry",
    });
    expect(document.querySelector("#details form")).not.toBeNull();
    expect(document.querySelector<HTMLInputElement>("[data-entry-search]")?.value).toBe("");
  });

  it("reveals explicitly, conceals, and clears revealed text on selection change", async () => {
    await select();
    click("Reveal Password");
    await settle();
    expect(document.body.textContent).toContain("synthetic-secret");
    click("Conceal Password");
    expect(document.body.textContent).not.toContain("synthetic-secret");
    click("Reveal Password");
    await settle();
    click("Otherbob");
    await settle();
    expect(document.body.textContent).not.toContain("synthetic-secret");
  });

  it("automatically conceals revealed credentials after 15 seconds", async () => {
    await select();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      click("Reveal Password");
      await vi.advanceTimersByTimeAsync(0);
      expect(document.body.textContent).toContain("synthetic-secret");
      await vi.advanceTimersByTimeAsync(15_000);
      expect(document.body.textContent).not.toContain("synthetic-secret");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a reveal that returns after a different entry is selected", async () => {
    await select();
    const normal = respond;
    let delayed: EditorRequest | undefined;
    respond = (request) => {
      if (request.action.kind === "reveal") delayed = request;
      else normal(request);
    };
    click("Reveal Password");
    await settle();
    click("Otherbob");
    await settle();
    if (!delayed) throw new Error("Missing delayed reveal");
    reply(delayed, "late-secret");
    await settle();
    expect(document.body.textContent).not.toContain("late-secret");
  });

  it("cancels without mutation and never sends unchanged protected placeholders", async () => {
    await select();
    click("Edit");
    fill("Title value", "Changed");
    click("Cancel");
    expect(requests.some((item) => item.action.kind === "updateEntry")).toBe(false);
    click("Edit");
    fill("Title value", "Changed");
    document.querySelector<HTMLFormElement>("#details form")!.requestSubmit();
    await settle();
    const update = requests.find((item) => item.action.kind === "updateEntry");
    expect(update?.action).toMatchObject({
      fields: { Title: { value: "Changed", protected: false } },
    });
    if (update?.action.kind !== "updateEntry") throw new Error("Missing update");
    expect(Object.keys(update.action.fields)).toEqual(["Title"]);
    expect(document.querySelector("#details form")).toBeNull();
    expect(state.dirty).toBe(true);
  });

  it("Ctrl+S finishes the edit before requesting encrypted persistence", async () => {
    await select();
    click("Edit");
    fill("Password value", "replacement");
    key("s", { ctrlKey: true });
    await settle();
    expect(
      requests
        .filter((item) => ["updateEntry", "save"].includes(item.action.kind))
        .map((item) => item.action.kind),
    ).toEqual(["updateEntry", "save"]);
    expect(document.querySelector("#details form")).toBeNull();
    expect(state.dirty).toBe(false);
  });

  it("keeps a failed edit visible and does not save after an update failure", async () => {
    await select();
    click("Edit");
    fill("Title value", "Changed");
    const normal = respond;
    respond = (request) => {
      if (request.action.kind === "updateEntry") {
        state = { ...state, error: "Edit refused" };
        reply(request, undefined, false);
      } else normal(request);
    };
    key("s", { metaKey: true });
    await settle();
    expect(requests.some((item) => item.action.kind === "save")).toBe(false);
    expect(field("Title value").value).toBe("Changed");
    expect(field("Title value").disabled).toBe(false);
    expect(buttons("Cancel")[0]?.disabled).toBe(false);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Edit refused");
  });

  it("guards navigation and supports keeping or discarding an edit", async () => {
    await select();
    click("Edit");
    fill("Title value", "Changed");
    click("Otherbob");
    expect(document.querySelector('[aria-label="Finish editing"]')?.hasAttribute("hidden")).toBe(
      false,
    );
    click("Keep editing");
    expect(field("Title value").value).toBe("Changed");
    click("Otherbob");
    click("Discard edit and continue");
    await settle();
    expect(requests.some((item) => item.action.kind === "updateEntry")).toBe(false);
    expect(document.querySelector("#details form")).toBeNull();
  });

  it("finishes a changed edit before navigating without silently saving to disk", async () => {
    await select();
    click("Edit");
    fill("Title value", "Changed");
    click("Otherbob");
    click("Done and continue");
    await settle();
    const updateIndex = requests.findIndex((request) => request.action.kind === "updateEntry");
    const detailsIndex = requests.findIndex(
      (request) => request.action.kind === "details" && request.action.id === "two",
    );
    expect(updateIndex).toBeGreaterThan(-1);
    expect(detailsIndex).toBeGreaterThan(updateIndex);
    expect(requests.some((request) => request.action.kind === "save")).toBe(false);
  });

  it("keeps generator output masked and commits it only when finishing the edit", async () => {
    await select();
    click("Edit");
    click("Generate password");
    await settle();
    expect(field("Password value").type).toBe("password");
    expect(field("Password value").value).toBe("generated-synthetic-secret");
    expect(requests.some((request) => request.action.kind === "updateEntry")).toBe(false);
    key("s", { ctrlKey: true });
    await settle();
    expect(requests.find((request) => request.action.kind === "updateEntry")?.action).toMatchObject(
      {
        fields: { Password: { value: "generated-synthetic-secret", protected: true } },
      },
    );
  });

  it("opens group operations on demand and can collapse the hierarchy", async () => {
    expect(document.querySelector("input[maxlength='4096']")).toBeNull();
    click("Toggle Personal");
    const childrenId = buttons("Toggle Personal")[0]?.getAttribute("aria-controls");
    expect(childrenId && document.getElementById(childrenId)?.hidden).toBe(true);
    click("New group");
    expect(field("Group name")).toBeDefined();
    expect(buttons("Cancel")).toHaveLength(1);
    click("Cancel");
    expect(document.querySelector("#details form")).toBeNull();
    expect(requests.some((request) => request.action.kind === "createGroup")).toBe(false);
  });

  it("lets a busy read-only view disable and re-enable reveal and history", async () => {
    await select();
    for (const busy of [true, false]) {
      state = { ...state, readOnly: true, busy };
      window.dispatchEvent(
        new MessageEvent("message", { data: { channel: "test", id: 0, ok: true, state } }),
      );
      expect(buttons("Reveal Password")[0]?.disabled).toBe(busy);
      expect(buttons("Copy Password")[0]?.disabled).toBe(busy);
      expect(buttons("Load history")[0]?.disabled).toBe(busy);
      expect(buttons("Edit")[0]?.disabled).toBe(true);
    }
  });

  it("searches across groups and retains search focus on Ctrl+F", async () => {
    click("Personal");
    expect(buttons("Otherbob")).toHaveLength(0);
    key("f", { ctrlKey: true });
    const search = document.querySelector<HTMLInputElement>("[data-entry-search]")!;
    expect(document.activeElement).toBe(search);
    search.value = "bob";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(buttons("Otherbob")).toHaveLength(1);
    expect(document.activeElement).toBe(search);
    search.setSelectionRange(1, 2);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { channel: "test", id: 0, ok: true, state },
      }),
    );
    const refreshed = document.querySelector<HTMLInputElement>("[data-entry-search]")!;
    expect(document.activeElement).toBe(refreshed);
    expect(refreshed.value).toBe("bob");
    expect([refreshed.selectionStart, refreshed.selectionEnd]).toEqual([1, 2]);
  });

  it("allows reveal/copy but disables edits in read-only databases", async () => {
    state = { ...state, readOnly: true };
    window.dispatchEvent(
      new MessageEvent("message", { data: { channel: "test", id: 0, ok: true, state } }),
    );
    await select();
    expect(buttons("Edit")[0]?.disabled).toBe(true);
    expect(buttons("Copy Password")[0]?.disabled).toBe(false);
    expect(buttons("Reveal Password")[0]?.disabled).toBe(false);
  });

  it("erases unfinished secrets when the host deactivates the view", async () => {
    await select();
    click("Edit");
    fill("Password value", "unfinished-secret");
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { channel: "test", id: 0, ok: true, state, conceal: true },
      }),
    );
    expect(document.querySelector("#details form")).toBeNull();
    expect(document.body.innerHTML).not.toContain("unfinished-secret");
    expect(requests.some((item) => item.action.kind === "updateEntry")).toBe(false);
  });
});
