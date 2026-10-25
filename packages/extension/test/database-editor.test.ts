import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { loadDatabase } from "../../core/dist/adapter.js";
import { credentials } from "../../core/dist/candidate.js";
import { createFixture, SYNTHETIC_PASSWORD } from "../../core/dist/fixture.js";
import { DatabaseEditorProvider } from "../src/database-editor.js";
import type { DatabaseDocument } from "../src/database-editor.js";
import { isRecord, isUiState } from "../src/editor-protocol.js";
import type { EditorAction, EditorReply } from "../src/editor-protocol.js";
import {
  commands,
  controls,
  createPanel,
  env,
  token,
  Uri,
  window,
  workspace,
} from "./vscode-mock.js";

let root: string;
let path: string;
let provider: DatabaseEditorProvider;
let document: DatabaseDocument;
const edits: vscode.CustomDocumentEditEvent<DatabaseDocument>[] = [];
type TestPanel = ReturnType<typeof createPanel>;
const sequences = new Map<TestPanel, number>();

function bind(doc: DatabaseDocument): TestPanel {
  const view = createPanel();
  provider.resolveCustomEditor(doc, view.panel, token);
  return view;
}

async function request(view: TestPanel, action: EditorAction): Promise<EditorReply> {
  const channel = /data-channel="([^"]+)"/.exec(view.panel.webview.html)?.[1];
  if (!channel) throw new Error("Interactive channel missing.");
  const id = (sequences.get(view) ?? 0) + 1;
  sequences.set(view, id);
  view.received.fire({ channel, id, action });
  let reply: EditorReply | undefined;
  await vi.waitFor(
    () => {
      const candidate = view.messages.find((message) => isRecord(message) && message.id === id);
      if (
        isRecord(candidate) &&
        candidate.channel === channel &&
        typeof candidate.ok === "boolean" &&
        isUiState(candidate.state)
      ) {
        reply = { channel, id, ok: candidate.ok, state: candidate.state, result: candidate.result };
      }
      expect(reply).toBeDefined();
    },
    { timeout: 10_000 },
  );
  if (!reply) throw new Error("No reply.");
  return reply;
}

beforeEach(async () => {
  vi.clearAllMocks();
  window.showWarningMessage.mockReset().mockResolvedValue(undefined);
  window.showSaveDialog.mockReset().mockResolvedValue(undefined);
  window.showOpenDialog.mockReset().mockResolvedValue(undefined);
  window.showInputBox.mockReset().mockResolvedValue(undefined);
  window.showQuickPick.mockReset().mockResolvedValue(undefined);
  commands.executeCommand.mockReset().mockResolvedValue(undefined);
  workspace.isTrusted = true;
  env.uiKind = 1;
  env.remoteName = undefined;
  controls.settings.idleLockMinutes = 5;
  controls.watchers.length = 0;
  controls.clipboard = "";
  edits.length = 0;
  root = await fs.mkdtemp(join(tmpdir(), "kdbx-editor-"));
  path = join(root, "synthetic.kdbx");
  const db = await createFixture({ cipher: "aes256", kdf: "aes", compression: "gzip" });
  await fs.writeFile(path, new Uint8Array(await db.save()));
  provider = new DatabaseEditorProvider({
    extension: { extensionKind: 1 },
    extensionUri: Uri.file(join(process.cwd(), "packages", "extension")),
    globalStorageUri: Uri.file(join(root, "application")),
  });
  provider.onDidChangeCustomDocument((edit) => edits.push(edit));
  document = await provider.openCustomDocument(
    Uri.file(path),
    { backupId: undefined, untitledDocumentData: undefined },
    token,
  );
});

afterEach(async () => {
  vi.useRealTimers();
  await provider.shutdown();
  provider.dispose();
  sequences.clear();
  await fs.rm(root, { recursive: true, force: true });
});

describe("writable database custom document", () => {
  it("unlocks two shared views, edits, undoes/redoes and saves encrypted data", async () => {
    const first = bind(document);
    const second = bind(document);
    expect((await request(first, { kind: "ready" })).state.locked).toBe(true);
    expect((await request(first, { kind: "unlock", password: SYNTHETIC_PASSWORD })).ok).toBe(true);
    const state = (await request(second, { kind: "ready" })).state;
    expect(state.locked).toBe(false);
    const groupId = state.groups[0]!.id;
    const created = await request(first, {
      kind: "createEntry",
      title: "host workflow entry",
      groupId,
    });
    expect(created.ok).toBe(true);
    expect(created.state.dirty).toBe(true);
    expect(edits).toHaveLength(1);
    await edits[0]!.undo();
    expect(
      (await request(second, { kind: "refresh" })).state.entries.some(
        (entry) => entry.title === "host workflow entry",
      ),
    ).toBe(false);
    await edits[0]!.redo();
    await provider.saveCustomDocument(document, token);
    expect((await request(second, { kind: "refresh" })).state.dirty).toBe(false);
    const { db } = await loadDatabase(
      new Uint8Array(await fs.readFile(path)),
      credentials(SYNTHETIC_PASSWORD),
    );
    expect(
      [...db.getDefaultGroup().allEntries()].some(
        (entry) => entry.fields.get("Title") === "host workflow entry",
      ),
    ).toBe(true);
  });

  it("backs up dirty content, locks, rejects old undo callbacks and restores using the new password", async () => {
    const view = bind(document);
    await request(view, { kind: "unlock", password: SYNTHETIC_PASSWORD });
    const changed = await request(view, {
      kind: "changePassword",
      password: "new synthetic password",
      confirmation: "new synthetic password",
    });
    expect(changed.ok).toBe(true);
    const backup = await provider.backupCustomDocument(
      document,
      { destination: Uri.file(join(root, "suggested-backup")) },
      token,
    );
    expect(backup.id).not.toContain("new synthetic password");
    expect((await request(view, { kind: "lock" })).state.locked).toBe(true);
    await expect(edits[0]!.undo()).rejects.toThrow("Undo/redo ended");
    expect((await request(view, { kind: "unlock", password: SYNTHETIC_PASSWORD })).ok).toBe(false);
    expect((await request(view, { kind: "unlock", password: "new synthetic password" })).ok).toBe(
      true,
    );
    await provider.saveCustomDocument(document, token);
    backup.delete();
  });

  it("keeps dirty edits after a source conflict and switches destination with Save As", async () => {
    const view = bind(document);
    const unlocked = await request(view, { kind: "unlock", password: SYNTHETIC_PASSWORD });
    await request(view, {
      kind: "createEntry",
      title: "copy survives",
      groupId: unlocked.state.groups[0]!.id,
    });
    const external = await createFixture({ cipher: "chacha20", kdf: "aes", compression: "none" });
    const externalBytes = new Uint8Array(await external.save());
    await fs.writeFile(path, externalBytes);
    await expect(provider.saveCustomDocument(document, token)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect((await request(view, { kind: "refresh" })).state.dirty).toBe(true);
    const target = Uri.file(join(root, "copy.kdbx"));
    await provider.saveCustomDocumentAs(document, target, token);
    const next = await provider.openCustomDocument(
      target,
      { backupId: undefined, untitledDocumentData: undefined },
      token,
    );
    const nextView = bind(next);
    document.dispose();
    expect((await request(nextView, { kind: "ready" })).state.locked).toBe(false);
    expect(await fs.readFile(path)).toEqual(Buffer.from(externalBytes));
    expect(controls.watchers.length).toBeGreaterThanOrEqual(2);
  });

  it("reverts explicitly without writing the original or retaining dirty changes", async () => {
    const view = bind(document);
    const before = await fs.readFile(path);
    const opened = await request(view, { kind: "unlock", password: SYNTHETIC_PASSWORD });
    await request(view, {
      kind: "createEntry",
      title: "discarded",
      groupId: opened.state.groups[0]!.id,
    });
    await provider.revertCustomDocument(document, token);
    const state = (await request(view, { kind: "refresh" })).state;
    expect(state).toMatchObject({ locked: true, dirty: false });
    expect(await fs.readFile(path)).toEqual(before);
  });

  it("rejects wrong-channel messages without performing a mutation", async () => {
    const view = bind(document);
    await request(view, { kind: "unlock", password: SYNTHETIC_PASSWORD });
    view.received.fire({ channel: "other document", id: 500, action: { kind: "lock" } });
    await vi.waitFor(() => expect(window.showErrorMessage).toHaveBeenCalled());
    expect((await request(view, { kind: "refresh" })).state.locked).toBe(false);
  });

  it("does no database/recovery I/O in Restricted Mode and refreshes after trust", async () => {
    workspace.isTrusted = false;
    const restricted = await provider.openCustomDocument(
      Uri.file(join(root, "does-not-exist.kdbx")),
      { backupId: "untrusted", untitledDocumentData: undefined },
      token,
    );
    const view = bind(restricted);
    expect(view.panel.webview.options.enableScripts).toBe(false);
    expect(view.panel.webview.html).toContain("Restricted Mode");
    expect(view.panel.webview.html).not.toMatch(/<(input|script|form)\b/i);
    workspace.isTrusted = true;
    controls.trust.fire();
    expect(view.panel.webview.options.enableScripts).toBe(true);
  });

  it("copies an explicitly requested field and does not overwrite another application's clipboard", async () => {
    const view = bind(document);
    const opened = await request(view, { kind: "unlock", password: SYNTHETIC_PASSWORD });
    const id = opened.state.entries[0]!.id;
    const revealed = await request(view, { kind: "reveal", id, name: "Password" });
    expect(typeof revealed.result).toBe("string");
    expect((await request(view, { kind: "copy", id, name: "Password" })).ok).toBe(true);
    expect(controls.clipboard).toBe(revealed.result);
    controls.clipboard = "from another application";
    await request(view, { kind: "lock" });
    expect(controls.clipboard).toBe("from another application");
  });

  it("uses explicit native import/export and preserves exact binary attachment bytes", async () => {
    const view = bind(document);
    const opened = await request(view, { kind: "unlock", password: SYNTHETIC_PASSWORD });
    const id = opened.state.entries[0]!.id;
    const source = join(root, "selected.cer");
    const exported = join(root, "exported.cer");
    const bytes = new Uint8Array([0, 255, 16, 0, 129]);
    await fs.writeFile(source, bytes);
    window.showOpenDialog.mockResolvedValueOnce([Uri.file(source)]);
    expect((await request(view, { kind: "importAttachment", id })).ok).toBe(true);
    window.showWarningMessage.mockResolvedValueOnce("Continue");
    window.showSaveDialog.mockResolvedValueOnce(Uri.file(exported));
    expect((await request(view, { kind: "exportAttachment", id, name: "selected.cer" })).ok).toBe(
      true,
    );
    expect(await fs.readFile(exported)).toEqual(Buffer.from(bytes));
    expect(edits).toHaveLength(1);
  });

  it("requires confirmed attachment overwrite and refuses overwriting the open database", async () => {
    const view = bind(document);
    const opened = await request(view, { kind: "unlock", password: SYNTHETIC_PASSWORD });
    const id = opened.state.entries[0]!.id;
    const source = join(root, "short.bin");
    const exported = join(root, "existing.bin");
    const bytes = Buffer.from([0, 255, 3]);
    await fs.writeFile(source, bytes);
    await fs.writeFile(exported, "previous longer contents");
    window.showOpenDialog.mockResolvedValueOnce([Uri.file(source)]);
    await request(view, { kind: "importAttachment", id });
    window.showSaveDialog.mockResolvedValue(Uri.file(exported));
    window.showWarningMessage.mockResolvedValueOnce("Continue").mockResolvedValueOnce(undefined);
    expect((await request(view, { kind: "exportAttachment", id, name: "short.bin" })).ok).toBe(
      true,
    );
    expect(await fs.readFile(exported, "utf8")).toBe("previous longer contents");
    window.showWarningMessage.mockResolvedValueOnce("Continue").mockResolvedValueOnce("Continue");
    expect((await request(view, { kind: "exportAttachment", id, name: "short.bin" })).ok).toBe(
      true,
    );
    expect(await fs.readFile(exported)).toEqual(bytes);
    const original = await fs.readFile(path);
    window.showSaveDialog.mockResolvedValueOnce(Uri.file(path));
    window.showWarningMessage.mockResolvedValueOnce("Continue");
    expect((await request(view, { kind: "exportAttachment", id, name: "short.bin" })).ok).toBe(
      false,
    );
    expect(await fs.readFile(path)).toEqual(original);
    const alias = join(root, "database-hard-link.bin");
    await fs.link(path, alias);
    window.showSaveDialog.mockResolvedValueOnce(Uri.file(alias));
    window.showWarningMessage.mockResolvedValueOnce("Continue").mockResolvedValueOnce("Continue");
    expect((await request(view, { kind: "exportAttachment", id, name: "short.bin" })).ok).toBe(
      false,
    );
    expect(await fs.readFile(path)).toEqual(original);
  });

  it("routes webview Save and Undo through native callbacks without holding the model queue", async () => {
    const view = bind(document);
    const opened = await request(view, { kind: "unlock", password: SYNTHETIC_PASSWORD });
    await request(view, {
      kind: "createEntry",
      title: "native command routing",
      groupId: opened.state.groups[0]!.id,
    });
    commands.executeCommand.mockImplementation(async (command) => {
      if (command === "undo") await edits[0]!.undo();
      else if (command === "workbench.action.files.save")
        await provider.saveCustomDocument(document, token);
      else throw new Error("Unexpected native command.");
    });
    expect((await request(view, { kind: "undo" })).ok).toBe(true);
    expect((await request(view, { kind: "save" })).ok).toBe(true);
    expect((await request(view, { kind: "refresh" })).state.dirty).toBe(false);
  });

  it("retains dirty unlocked content when encrypted backup fails", async () => {
    const view = bind(document);
    const opened = await request(view, { kind: "unlock", password: SYNTHETIC_PASSWORD });
    await request(view, {
      kind: "createEntry",
      title: "must survive backup failure",
      groupId: opened.state.groups[0]!.id,
    });
    const recovery = join(root, "application", "encrypted-recovery");
    const held = join(root, "held-recovery");
    await fs.rename(recovery, held);
    await fs.writeFile(recovery, "not a directory");
    try {
      await expect(
        provider.backupCustomDocument(
          document,
          { destination: Uri.file(join(root, "suggested")) },
          token,
        ),
      ).rejects.toThrow();
      const failed = await request(view, { kind: "lock" });
      expect(failed.ok).toBe(false);
      expect(failed.state).toMatchObject({ locked: false, dirty: true });
      expect(
        failed.state.entries.some((entry) => entry.title === "must survive backup failure"),
      ).toBe(true);
      expect(failed.state.error).toBeTruthy();
    } finally {
      await fs.unlink(recovery);
      await fs.rename(held, recovery);
    }
  });

  it("auto-locks while a native confirmation is unanswered and rejects the resumed mutation", async () => {
    const view = bind(document);
    const opened = await request(view, { kind: "unlock", password: SYNTHETIC_PASSWORD });
    let answer: ((value: string | undefined) => void) | undefined;
    window.showWarningMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const deletion = request(view, {
      kind: "deleteEntry",
      id: opened.state.entries[0]!.id,
      permanent: false,
    });
    await vi.waitFor(() => expect(answer).toBeDefined());
    const beforeLock = view.messages.length;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    controls.focus.fire({ focused: true, active: true });
    await vi.waitFor(() =>
      expect(
        view.messages
          .slice(beforeLock)
          .some((message) => isRecord(message) && isUiState(message.state) && message.state.locked),
      ).toBe(true),
    );
    answer!("Continue");
    expect((await deletion).ok).toBe(false);
    expect((await request(view, { kind: "refresh" })).state.locked).toBe(true);
  });

  it.each(["recover", "discard"] as const)(
    "offers explicit orphan %s and avoids duplicate close snapshots",
    async (choice) => {
      const view = bind(document);
      const opened = await request(view, { kind: "unlock", password: SYNTHETIC_PASSWORD });
      await request(view, {
        kind: "createEntry",
        title: "orphan recovery entry",
        groupId: opened.state.groups[0]!.id,
      });
      await provider.backupCustomDocument(
        document,
        { destination: Uri.file(join(root, "suggested")) },
        token,
      );
      document.dispose();
      await provider.shutdown();
      provider.dispose();
      const recoveryDirectory = join(root, "application", "encrypted-recovery");
      expect(
        (await fs.readdir(recoveryDirectory)).filter((name) => name.endsWith(".kdbx")),
      ).toHaveLength(1);
      provider = new DatabaseEditorProvider({
        extension: { extensionKind: 1 },
        extensionUri: Uri.file(join(process.cwd(), "packages", "extension")),
        globalStorageUri: Uri.file(join(root, "application")),
      });
      window.showQuickPick.mockImplementationOnce(async (items) => {
        if (!Array.isArray(items)) throw new Error("Expected recovery choices.");
        return items.find(
          (item: unknown) =>
            isRecord(item) &&
            (choice === "discard" ? item.discard === true : isRecord(item.reference)),
        );
      });
      if (choice === "discard") window.showWarningMessage.mockResolvedValueOnce("Continue");
      const restored = await provider.openCustomDocument(
        Uri.file(path),
        { backupId: undefined, untitledDocumentData: undefined },
        token,
      );
      const restoredView = bind(restored);
      expect((await request(restoredView, { kind: "ready" })).state).toMatchObject({
        locked: true,
        dirty: choice === "recover",
      });
      const unlocked = await request(restoredView, {
        kind: "unlock",
        password: SYNTHETIC_PASSWORD,
      });
      expect(unlocked.state.entries.some((entry) => entry.title === "orphan recovery entry")).toBe(
        choice === "recover",
      );
    },
  );

  it("restores an opaque hot-exit backup into a fresh provider without automatic unlock", async () => {
    const view = bind(document);
    const opened = await request(view, { kind: "unlock", password: SYNTHETIC_PASSWORD });
    await request(view, {
      kind: "createEntry",
      title: "hot-exit edit",
      groupId: opened.state.groups[0]!.id,
    });
    const backup = await provider.backupCustomDocument(
      document,
      { destination: Uri.file(join(root, "suggested")) },
      token,
    );
    await provider.shutdown();
    provider.dispose();
    provider = new DatabaseEditorProvider({
      extension: { extensionKind: 1 },
      extensionUri: Uri.file(join(process.cwd(), "packages", "extension")),
      globalStorageUri: Uri.file(join(root, "application")),
    });
    const restored = await provider.openCustomDocument(
      Uri.file(path),
      { backupId: backup.id, untitledDocumentData: undefined },
      token,
    );
    const restoredView = bind(restored);
    expect((await request(restoredView, { kind: "ready" })).state).toMatchObject({
      locked: true,
      dirty: true,
    });
    const unlocked = await request(restoredView, { kind: "unlock", password: SYNTHETIC_PASSWORD });
    expect(unlocked.state.entries.some((entry) => entry.title === "hot-exit edit")).toBe(true);
  });

  it("enforces elapsed idle time on refocus and clears only its own clipboard value", async () => {
    const view = bind(document);
    const opened = await request(view, { kind: "unlock", password: SYNTHETIC_PASSWORD });
    await request(view, { kind: "copy", id: opened.state.entries[0]!.id, name: "Password" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    controls.focus.fire({ focused: true, active: true });
    const refreshed = await request(view, { kind: "refresh" });
    expect(refreshed.state.locked).toBe(true);
    expect(controls.clipboard).toBe("");
  });

  it("creates a calibrated KDBX 4.1 database through native password/destination prompts", async () => {
    const target = join(root, "created.kdbx");
    window.showSaveDialog.mockResolvedValueOnce(Uri.file(target));
    window.showInputBox
      .mockResolvedValueOnce("new synthetic master")
      .mockResolvedValueOnce("new synthetic master");
    await provider.createDatabase();
    const { db } = await loadDatabase(
      new Uint8Array(await fs.readFile(target)),
      credentials("new synthetic master"),
    );
    expect(db.header.versionMajor).toBe(4);
    expect(db.header.versionMinor).toBe(1);
  });
});
