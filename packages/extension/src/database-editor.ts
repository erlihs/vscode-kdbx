import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import * as vscode from "vscode";
import { DatabaseError, DatabaseSessions, SerialQueue } from "@vscode-kdbx/core";
import type {
  DatabaseSession,
  EntrySummary,
  GroupSummary,
  RecoveryReference,
} from "@vscode-kdbx/core";
import { databaseEditorHtml, editorRestriction, lockedEditorHtml } from "./editor-view.js";
import { isEditorRequest } from "./editor-protocol.js";
import type { EditorAction, EditorReply, UiState } from "./editor-protocol.js";
import {
  attachmentSuggestion,
  decodeBackup,
  encodeBackup,
  errorMessage,
  generatePassword,
} from "./editor-services.js";

export const DATABASE_EDITOR = "kdbx.database";

interface Model {
  session: DatabaseSession;
  documents: Set<DatabaseDocument>;
  primary: vscode.Uri;
  queue: SerialQueue;
  epoch: number;
  groups: readonly GroupSummary[];
  entries: readonly EntrySummary[];
  busy: boolean;
  error: string | undefined;
  lastActivity: number;
  unlock: AbortController | undefined;
  watcher: vscode.FileSystemWatcher;
  locking: Promise<void> | undefined;
  retryLockAfter: number;
}

interface Panel {
  document: DatabaseDocument;
  channel: string;
  sequence: number;
  ready: boolean;
}

export interface EditorContext {
  readonly extension: Pick<vscode.Extension<unknown>, "extensionKind">;
  readonly extensionUri: vscode.Uri;
  readonly globalStorageUri: vscode.Uri;
}

export class DatabaseDocument implements vscode.CustomDocument {
  model: Model | undefined;
  error: string | undefined;
  disposed = false;
  recoveryBoundary = false;
  readonly initialization = new SerialQueue();

  constructor(
    readonly uri: vscode.Uri,
    readonly backupId: string | undefined,
    private readonly owner: DatabaseEditorProvider,
  ) {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.owner.release(this);
  }
}

async function withCancellation<T>(
  token: vscode.CancellationToken,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (token.isCancellationRequested) throw new vscode.CancellationError();
  const controller = new AbortController();
  const subscription = token.onCancellationRequested(() => controller.abort());
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    throw error;
  } finally {
    subscription.dispose();
  }
}

export class DatabaseEditorProvider
  implements vscode.CustomEditorProvider<DatabaseDocument>, vscode.Disposable
{
  private readonly changes = new vscode.EventEmitter<
    vscode.CustomDocumentEditEvent<DatabaseDocument>
  >();
  readonly onDidChangeCustomDocument = this.changes.event;
  private readonly documents = new Set<DatabaseDocument>();
  private readonly models = new Map<DatabaseSession, Model>();
  private readonly panels = new Map<vscode.WebviewPanel, Panel>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly pending = new Set<Promise<unknown>>();
  private registry: Promise<DatabaseSessions> | undefined;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;
  private clipboard: { value: string; timer: ReturnType<typeof setTimeout> } | undefined;
  private readonly clipboardQueue = new SerialQueue();
  private readonly idleTimer: ReturnType<typeof setInterval>;
  private idleTimeout = 5 * 60_000;

  constructor(private readonly context: EditorContext) {
    this.readIdleConfiguration();
    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("kdbx.idleLockMinutes")) this.readIdleConfiguration();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        for (const [panel, binding] of this.panels) this.render(binding.document, panel);
      }),
      vscode.window.onDidChangeWindowState((state) => {
        this.track(this.onFocus(state.focused));
      }),
    );
    this.idleTimer = setInterval(() => {
      for (const model of this.models.values()) {
        if (this.expired(model)) this.track(this.lockModel(model));
      }
    }, 1000);
  }

  restriction(uri: vscode.Uri): string | undefined {
    return editorRestriction(uri, {
      trusted: vscode.workspace.isTrusted,
      desktop: vscode.env.uiKind === vscode.UIKind.Desktop,
      localHost: this.context.extension.extensionKind === vscode.ExtensionKind.UI,
      remoteWorkspace: vscode.env.remoteName !== undefined,
      virtualWorkspace:
        vscode.workspace.workspaceFolders?.some((folder) => folder.uri.scheme !== "file") ?? false,
    });
  }

  private admit(uri: vscode.Uri): void {
    const reason = this.restriction(uri);
    if (reason) throw new DatabaseError("UNSUPPORTED", reason);
  }

  private sessions(): Promise<DatabaseSessions> {
    if (!this.registry) {
      const creating = DatabaseSessions.create(
        join(this.context.globalStorageUri.fsPath, "encrypted-recovery"),
      );
      this.registry = creating;
      void creating.catch(() => {
        if (this.registry === creating) this.registry = undefined;
      });
    }
    return this.registry;
  }

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
    token: vscode.CancellationToken,
  ): Promise<DatabaseDocument> {
    if (this.shuttingDown)
      throw new DatabaseError("LOCKED", "The database editor is shutting down.");
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const document = new DatabaseDocument(uri, openContext.backupId, this);
    this.documents.add(document);
    // Restricted/unsupported pages do not inspect the file, backup or recovery storage.
    if (!this.restriction(uri)) {
      try {
        await this.initialize(document);
      } catch (error) {
        document.error = errorMessage(error);
      }
    }
    if (token.isCancellationRequested) {
      document.dispose();
      throw new vscode.CancellationError();
    }
    return document;
  }

  private initialize(document: DatabaseDocument): Promise<Model> {
    return document.initialization.run(async () => {
      this.admit(document.uri);
      if (document.disposed) throw new DatabaseError("LOCKED", "The database document is closed.");
      if (document.model) return document.model;
      const registry = await this.sessions();
      let recovery: RecoveryReference | undefined;
      let session: DatabaseSession | undefined;
      if (document.backupId) recovery = decodeBackup(document.backupId);
      else {
        try {
          session = await registry.open(document.uri.fsPath);
        } catch (error) {
          if (!(error instanceof DatabaseError) || error.code !== "RECOVERY_REQUIRED") throw error;
          const snapshots = await registry.findRecovery(document.uri.fsPath);
          const dated = await Promise.all(
            snapshots.map(async (reference) => {
              try {
                const stat = await fs.stat(join(registry.recoveryDirectory, reference.id));
                return { reference, modified: stat.mtimeMs };
              } catch {
                throw new DatabaseError(
                  "IO",
                  "Encrypted recovery metadata changed or could not be read. Retry recovery selection.",
                );
              }
            }),
          );
          dated.sort((first, second) => second.modified - first.modified);
          type Choice = vscode.QuickPickItem & { reference?: RecoveryReference; discard?: boolean };
          const choices: Choice[] = dated.map(({ reference, modified }, index) => ({
            label: `${index === 0 ? "Latest encrypted recovery" : "Older encrypted recovery"} - ${new Date(modified).toLocaleString()}`,
            description: reference.credentialsChanged
              ? "Requires the changed/new master password"
              : "Requires the snapshot's master password",
            detail: `Snapshot ${reference.id.slice(-41, -5)}. Older copies retain their original passwords.`,
            reference,
          }));
          choices.push({
            label: "Discard the listed encrypted recoveries",
            description:
              "Permanently delete these snapshots and open the saved file; confirmation required.",
            discard: true,
          });
          const selected = await vscode.window.showQuickPick<Choice>(choices, {
            title: "Recover KeePass database",
            placeHolder:
              "Select encrypted recovery. Cancel keeps the database locked; no changes are discarded.",
            ignoreFocusOut: true,
          });
          if (!selected)
            throw new DatabaseError(
              "RECOVERY_REQUIRED",
              "Recovery selection was cancelled. Reopen or retry to choose encrypted recovery; nothing was discarded.",
            );
          if (selected.discard) {
            if (
              !(await this.confirm(
                "Permanently discard all listed encrypted recovery snapshots? Unsaved changes will be lost, and the saved source may be missing or damaged. This cannot be undone.",
              ))
            ) {
              throw new DatabaseError(
                "RECOVERY_REQUIRED",
                "Recovery discard was cancelled. Nothing was discarded.",
              );
            }
            for (const reference of snapshots)
              await registry.discardRecovery(document.uri.fsPath, reference);
          } else recovery = selected.reference;
        }
      }
      session ??= await registry.open(document.uri.fsPath, recovery);
      if (document.disposed) {
        if (!this.models.has(session)) await session.close();
        throw new DatabaseError("LOCKED", "The database document is closed.");
      }
      let model = this.models.get(session);
      if (!model) {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(
            vscode.Uri.file(dirname(session.path)),
            basename(session.path),
          ),
        );
        model = {
          session,
          documents: new Set(),
          primary: document.uri,
          queue: new SerialQueue(),
          epoch: 0,
          groups: [],
          entries: [],
          busy: false,
          error: undefined,
          lastActivity: Date.now(),
          unlock: undefined,
          watcher,
          locking: undefined,
          retryLockAfter: 0,
        };
        this.models.set(session, model);
        const observed = model;
        const changed = (): void => {
          this.track(this.observeExternal(observed));
        };
        watcher.onDidChange(changed);
        watcher.onDidDelete(changed);
        watcher.onDidCreate(changed);
      }
      model.documents.add(document);
      document.model = model;
      document.error = undefined;
      if (
        session.state.dirty &&
        !document.backupId &&
        document.uri.toString() === model.primary.toString()
      ) {
        document.recoveryBoundary = true;
      }
      return model;
    });
  }

  resolveCustomEditor(
    document: DatabaseDocument,
    panel: vscode.WebviewPanel,
    token: vscode.CancellationToken,
  ): void {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    panel.onDidDispose(() => this.panels.delete(panel));
    panel.onDidChangeViewState(() => {
      const model = document.model;
      if (!panel.active && model) {
        this.track(this.clearClipboard());
        this.post(panel, 0, true, undefined, true);
      } else if (panel.active && model) this.track(this.enforceIdle(model));
    });
    panel.webview.onDidReceiveMessage((value: unknown) => {
      this.track(this.receive(document, panel, value));
    });
    this.render(document, panel);
  }

  private render(document: DatabaseDocument, panel: vscode.WebviewPanel): void {
    const restriction = this.restriction(document.uri);
    const channel = randomUUID();
    this.panels.set(panel, { document, channel, sequence: 0, ready: false });
    panel.webview.options = {
      enableScripts: !restriction,
      localResourceRoots: restriction
        ? []
        : [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
    };
    panel.webview.html = restriction
      ? lockedEditorHtml(basename(document.uri.fsPath), restriction)
      : databaseEditorHtml(
          basename(document.uri.fsPath),
          channel,
          panel.webview
            .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"))
            .toString(),
        );
  }

  private state(document: DatabaseDocument): UiState {
    const model = document.model;
    const state = model?.session.state;
    const alias = model !== undefined && model.primary.toString() !== document.uri.toString();
    return {
      filename: basename(model?.session.path ?? document.uri.fsPath),
      locked: state?.locked ?? true,
      dirty: state?.dirty ?? false,
      readOnly: (state?.readOnly ?? false) || alias,
      conflict: state?.conflict ?? false,
      credentialsChanged: state?.credentialsChanged ?? false,
      canUndo: !alias && (state?.canUndo ?? false),
      canRedo: !alias && (state?.canRedo ?? false),
      busy: (model?.busy ?? false) || model?.locking !== undefined,
      recoveryPasswordChanged: state?.recovery?.credentialsChanged ?? false,
      groups: state?.locked === false ? (model?.groups ?? []) : [],
      entries: state?.locked === false ? (model?.entries ?? []) : [],
      ...(document.error || model?.error || state?.sourceIssue?.message || alias
        ? {
            error:
              document.error ??
              model?.error ??
              state?.sourceIssue?.message ??
              "This database is already open through another path. Use the original view for editing and undo/redo.",
          }
        : {}),
    };
  }

  private post(
    panel: vscode.WebviewPanel,
    id: number,
    ok: boolean,
    result?: unknown,
    conceal = false,
  ): void {
    const binding = this.panels.get(panel);
    if (!binding?.ready || binding.document.disposed) return;
    const reply: EditorReply = {
      channel: binding.channel,
      id,
      ok,
      state: this.state(binding.document),
      ...(result === undefined ? {} : { result }),
      ...(conceal ? { conceal: true } : {}),
    };
    this.track(Promise.resolve(panel.webview.postMessage(reply)));
  }

  private publish(model: Model, conceal = false): void {
    for (const [panel, binding] of this.panels) {
      if (binding.document.model === model) this.post(panel, 0, true, undefined, conceal);
    }
  }

  private writable(document: DatabaseDocument, model: Model): void {
    this.admit(document.uri);
    if (document.uri.toString() !== model.primary.toString()) {
      throw new DatabaseError(
        "READ_ONLY",
        "Use the original database view to edit this shared session.",
      );
    }
    if (model.session.state.readOnly)
      throw new DatabaseError(
        "READ_ONLY",
        "Unsupported database data makes this session read-only.",
      );
  }

  private async refresh(model: Model): Promise<void> {
    if (model.session.state.locked) {
      model.groups = [];
      model.entries = [];
    } else {
      model.groups = await model.session.listGroups();
      model.entries = await model.session.listEntries();
    }
  }

  private edit(model: Model, label: string): void {
    const epoch = model.epoch;
    for (const document of model.documents) {
      if (document.uri.toString() !== model.primary.toString()) continue;
      this.changes.fire({
        document,
        label,
        undo: () => this.replay(document, model, epoch, false),
        redo: () => this.replay(document, model, epoch, true),
      });
    }
  }

  private boundary(document: DatabaseDocument, model: Model): void {
    this.changes.fire({
      document,
      label: "Recovered database changes",
      undo: () => {
        throw new DatabaseError(
          "LOCKED",
          "Undo ends at recovery. Use Revert to explicitly discard recovered changes.",
        );
      },
      redo: () => {
        throw new DatabaseError("LOCKED", "Recovery is an undo boundary.");
      },
    });
    this.publish(model);
  }

  private replay(
    document: DatabaseDocument,
    model: Model,
    epoch: number,
    redo: boolean,
  ): Promise<void> {
    return model.queue.run(async () => {
      this.writable(document, model);
      if (model.epoch !== epoch || model.session.state.locked) {
        throw new DatabaseError(
          "LOCKED",
          "Undo/redo ended at lock or recovery. Only edits made after unlocking can be undone.",
        );
      }
      if (redo) await model.session.redo();
      else await model.session.undo();
      model.lastActivity = Date.now();
      await this.refresh(model);
      this.publish(model);
    });
  }

  private async receive(
    document: DatabaseDocument,
    panel: vscode.WebviewPanel,
    value: unknown,
  ): Promise<void> {
    if (this.shuttingDown)
      throw new DatabaseError("LOCKED", "The database editor is shutting down.");
    this.admit(document.uri);
    const binding = this.panels.get(panel);
    if (!binding || !isEditorRequest(value, binding.channel)) {
      throw new DatabaseError("INVALID_INPUT", "An invalid database editor message was rejected.");
    }
    if (value.id <= binding.sequence) return;
    binding.sequence = value.id;
    binding.ready = true;
    const channel = binding.channel;
    const action = value.action;
    if (action.kind === "cancelUnlock" || action.kind === "lock") document.model?.unlock?.abort();
    try {
      if (action.kind === "createDatabase") {
        await this.createDatabase();
        this.post(panel, value.id, true);
        return;
      }
      const model = await this.initialize(document);
      if (document.recoveryBoundary) {
        document.recoveryBoundary = false;
        this.boundary(document, model);
      }
      await this.enforceIdle(model);
      if (model.locking) await model.locking;
      if (action.kind !== "ready" && action.kind !== "refresh") model.lastActivity = Date.now();
      let result: unknown;
      if (action.kind === "undo" || action.kind === "redo") {
        this.writable(document, model);
        await vscode.commands.executeCommand(action.kind);
      } else if (action.kind === "save" || action.kind === "saveAs" || action.kind === "revert") {
        this.writable(document, model);
        if (
          action.kind === "revert" &&
          !(await this.confirm("Discard all unsaved database changes and reload the saved file?"))
        ) {
          this.post(panel, value.id, true);
          return;
        }
        await vscode.commands.executeCommand(
          action.kind === "save"
            ? "workbench.action.files.save"
            : action.kind === "saveAs"
              ? "workbench.action.files.saveAs"
              : "workbench.action.files.revert",
        );
      } else if (action.kind === "lock") await this.lockModel(model);
      else
        result = await model.queue.run(async () => {
          model.error = undefined;
          model.busy = true;
          this.publish(model);
          try {
            return await this.perform(document, model, action);
          } finally {
            model.busy = false;
            await this.refresh(model);
            this.publish(model);
          }
        });
      if (this.panels.get(panel)?.channel === channel && !document.disposed)
        this.post(panel, value.id, true, result);
    } catch (error) {
      const message =
        error instanceof vscode.CancellationError ? "Operation cancelled." : errorMessage(error);
      if (document.model) document.model.error = message;
      else document.error = message;
      if (this.panels.get(panel)?.channel === channel) this.post(panel, value.id, false);
      if (
        !(error instanceof vscode.CancellationError) &&
        !(error instanceof DatabaseError && error.code === "CANCELLED")
      ) {
        await vscode.window.showErrorMessage(message);
      }
    }
  }

  private async perform(
    document: DatabaseDocument,
    model: Model,
    action: EditorAction,
  ): Promise<unknown> {
    const session = model.session;
    switch (action.kind) {
      case "ready":
      case "refresh":
      case "activity":
      case "cancelUnlock":
        return;
      case "unlock": {
        model.unlock = new AbortController();
        try {
          await session.unlock(action.password, model.unlock.signal);
        } finally {
          action.password = "";
          model.unlock = undefined;
        }
        return;
      }
      case "details":
        return session.getEntry(action.id);
      case "history":
        return session.listHistory(action.id);
      case "reveal":
        return session.readField(action.id, action.name);
      case "copy":
        await this.copy(await session.readField(action.id, action.name));
        return;
      case "openUrl": {
        const value = await session.readField(action.id, "URL");
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          throw new DatabaseError(
            "INVALID_INPUT",
            "This entry does not contain a valid website URL.",
          );
        }
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
          throw new DatabaseError(
            "INVALID_INPUT",
            "Only HTTP and HTTPS websites without embedded credentials can be opened.",
          );
        if (!(await this.confirm(`Open this website in your browser?\n${url.href}`))) return;
        if (!(await vscode.env.openExternal(vscode.Uri.parse(url.href))))
          throw new DatabaseError("INVALID_INPUT", "The website could not be opened.");
        return;
      }
      case "generate":
        return generatePassword(action);
      case "exportAttachment":
        return this.exportAttachment(session, action.id, action.name);
      default:
        break;
    }
    this.writable(document, model);
    let result: unknown;
    switch (action.kind) {
      case "createGroup":
        result = await session.createGroup(action.parentId, action.name);
        break;
      case "renameGroup":
        await session.renameGroup(action.id, action.name);
        break;
      case "moveGroup":
        await session.moveGroup(action.id, action.parentId);
        break;
      case "deleteGroup":
        if (
          !(await this.confirm(
            action.permanent
              ? "Permanently delete this group and its descendants?"
              : "Move this group and its descendants to the recycle bin?",
          ))
        )
          return;
        await session.deleteGroup(action.id, action.permanent);
        break;
      case "createEntry":
        result = await session.createEntry(action.title, action.groupId);
        break;
      case "updateEntry":
        await session.updateEntry(action.id, {
          fields: action.fields,
          removeFields: action.removeFields,
          tags: action.tags,
          groupId: action.groupId,
        });
        break;
      case "duplicateEntry":
        result = await session.duplicateEntry(action.id);
        break;
      case "deleteEntry":
        if (
          !(await this.confirm(
            action.permanent
              ? "Permanently delete this entry and its history?"
              : "Move this entry to the recycle bin?",
          ))
        )
          return;
        await session.deleteEntry(action.id, action.permanent);
        break;
      case "restoreHistory":
        if (
          !(await this.confirm(
            "Restore this entry history state as a new edit? The current state will be retained in history.",
          ))
        )
          return;
        await session.restoreHistory(action.id, action.index);
        break;
      case "importAttachment": {
        const selected = await vscode.window.showOpenDialog({
          canSelectMany: false,
          canSelectFiles: true,
          canSelectFolders: false,
          title: "Import attachment (10 MiB maximum)",
        });
        if (!selected?.[0]) return;
        this.admit(selected[0]);
        const handle = await fs.open(selected[0].fsPath, "r");
        let bytes: Uint8Array<ArrayBuffer>;
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > 10 * 1024 * 1024)
            throw new DatabaseError(
              "RESOURCE_LIMIT",
              "Select a regular attachment no larger than 10 MiB.",
            );
          bytes = new Uint8Array(stat.size);
          let offset = 0;
          while (offset < bytes.byteLength) {
            const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
            if (!read.bytesRead)
              throw new DatabaseError("CONFLICT", "The attachment changed while being read.");
            offset += read.bytesRead;
          }
          const after = await handle.stat();
          if (
            after.size !== stat.size ||
            after.mtimeMs !== stat.mtimeMs ||
            after.ctimeMs !== stat.ctimeMs
          ) {
            throw new DatabaseError("CONFLICT", "The attachment changed while being read.");
          }
        } finally {
          await handle.close();
        }
        try {
          await session.importAttachment(action.id, basename(selected[0].fsPath), bytes.buffer);
        } finally {
          if (bytes.byteLength) bytes.fill(0);
        }
        break;
      }
      case "renameAttachment":
        await session.renameAttachment(action.id, action.name, action.newName);
        break;
      case "removeAttachment":
        if (
          !(await this.confirm(
            "Remove this attachment? Previous entry history may retain its contents.",
          ))
        )
          return;
        await session.removeAttachment(action.id, action.name);
        break;
      case "changePassword":
        try {
          await session.changeMasterPassword(action.password, action.confirmation);
        } finally {
          action.password = "";
          action.confirmation = "";
        }
        await vscode.window.showInformationMessage(
          "The master password changed in memory. Save to update the database. Encrypted recovery now requires the new password; older copies retain their old passwords.",
        );
        break;
      default:
        throw new DatabaseError("INVALID_INPUT", "This database action is not available here.");
    }
    this.edit(
      model,
      action.kind === "changePassword" ? "Change master password" : "Edit KeePass database",
    );
    return result;
  }

  private async confirm(message: string): Promise<boolean> {
    return (
      (await vscode.window.showWarningMessage(message, { modal: true }, "Continue")) === "Continue"
    );
  }

  async saveCustomDocument(
    document: DatabaseDocument,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const model = await this.initialize(document);
    return model.queue.run(async () => {
      this.writable(document, model);
      try {
        await withCancellation(token, (signal) => model.session.save(signal));
        model.error = undefined;
      } catch (error) {
        model.error = errorMessage(error);
        if (
          error instanceof DatabaseError &&
          !model.session.state.dirty &&
          error.code === "RECOVERY_CLEANUP"
        ) {
          await vscode.window.showWarningMessage(error.message);
        } else {
          if (
            error instanceof DatabaseError &&
            (error.code === "CONFLICT" || error.code === "PERSISTENCE_UNCERTAIN")
          ) {
            const choice = await vscode.window.showWarningMessage(
              error.message,
              "Save As",
              "Revert",
              "Keep changes",
            );
            if (choice === "Save As")
              setTimeout(
                () =>
                  this.track(
                    Promise.resolve(
                      vscode.commands.executeCommand("workbench.action.files.saveAs"),
                    ),
                  ),
                0,
              );
            if (choice === "Revert")
              setTimeout(
                () =>
                  this.track(
                    Promise.resolve(
                      vscode.commands.executeCommand("workbench.action.files.revert"),
                    ),
                  ),
                0,
              );
          }
          throw error;
        }
      } finally {
        await this.refresh(model);
        this.publish(model);
      }
    });
  }

  async saveCustomDocumentAs(
    document: DatabaseDocument,
    destination: vscode.Uri,
    token: vscode.CancellationToken,
  ): Promise<void> {
    this.admit(destination);
    const model = await this.initialize(document);
    return model.queue.run(async () => {
      this.writable(document, model);
      const previous = model.session.path;
      try {
        await withCancellation(token, (signal) => model.session.saveAs(destination.fsPath, signal));
      } catch (error) {
        if (
          !(
            error instanceof DatabaseError &&
            error.code === "RECOVERY_CLEANUP" &&
            model.session.path !== previous &&
            !model.session.state.dirty
          )
        )
          throw error;
        await vscode.window.showWarningMessage(error.message);
      }
      model.primary = destination;
      model.error = undefined;
      model.watcher.dispose();
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(
          vscode.Uri.file(dirname(model.session.path)),
          basename(model.session.path),
        ),
      );
      model.watcher = watcher;
      const changed = (): void => {
        this.track(this.observeExternal(model));
      };
      watcher.onDidChange(changed);
      watcher.onDidDelete(changed);
      watcher.onDidCreate(changed);
      await this.refresh(model);
      this.publish(model, true);
    });
  }

  async revertCustomDocument(
    document: DatabaseDocument,
    token: vscode.CancellationToken,
  ): Promise<void> {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const model = await this.initialize(document);
    model.unlock?.abort();
    return model.queue.run(async () => {
      this.admit(document.uri);
      if (document.uri.toString() !== model.primary.toString()) {
        throw new DatabaseError(
          "READ_ONLY",
          "Use the original database view to revert this shared session.",
        );
      }
      await model.session.discardAndLock();
      model.epoch++;
      model.error = undefined;
      await this.clearClipboard();
      await this.refresh(model);
      this.publish(model, true);
    });
  }

  async backupCustomDocument(
    document: DatabaseDocument,
    _context: vscode.CustomDocumentBackupContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.CustomDocumentBackup> {
    const model = await this.initialize(document);
    return model.queue
      .run(async () => {
        this.admit(document.uri);
        if (token.isCancellationRequested) throw new vscode.CancellationError();
        const reference = await model.session.backup();
        if (!reference)
          throw new DatabaseError(
            "RECOVERY_REQUIRED",
            "The document has no dirty contents to back up.",
          );
        return {
          id: encodeBackup(reference),
          delete: () => {
            this.track(model.session.deleteBackup(reference));
          },
        };
      })
      .catch((error: unknown) => {
        model.error = errorMessage(error);
        this.publish(model);
        throw error;
      });
  }

  private readIdleConfiguration(): void {
    const value = vscode.workspace.getConfiguration("kdbx").get<unknown>("idleLockMinutes", 5);
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 120) {
      this.idleTimeout = 5 * 60_000;
      void vscode.window.showWarningMessage(
        "Invalid KeePass idle-lock setting. Using the default 5 minutes until kdbx.idleLockMinutes is corrected (0 explicitly disables idle lock).",
      );
    } else this.idleTimeout = value * 60_000;
  }

  private expired(model: Model): boolean {
    return (
      !model.locking &&
      !model.session.state.locked &&
      this.idleTimeout > 0 &&
      Date.now() >= model.retryLockAfter &&
      Date.now() - model.lastActivity >= this.idleTimeout
    );
  }

  private async enforceIdle(model: Model): Promise<void> {
    if (this.expired(model)) await this.lockModel(model);
  }

  private async onFocus(focused: boolean): Promise<void> {
    if (!focused) {
      await this.clearClipboard();
      for (const model of this.models.values()) this.publish(model, true);
    } else for (const model of this.models.values()) await this.enforceIdle(model);
  }

  private lockModel(model: Model): Promise<void> {
    if (model.locking) return model.locking;
    model.unlock?.abort();
    // The core serializes data operations. Do not let an unanswered native dialog prevent locking.
    model.locking = (async () => {
      model.epoch++;
      this.publish(model, true);
      try {
        await model.session.lock();
        model.error = undefined;
      } catch (error) {
        model.error = errorMessage(error);
        model.retryLockAfter = Date.now() + 60_000;
        throw error;
      } finally {
        await this.clearClipboard();
        await this.refresh(model);
        this.publish(model, true);
      }
    })().finally(() => {
      model.locking = undefined;
      this.publish(model, true);
    });
    return model.locking;
  }

  async lockAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.models.values()].map((model) => this.lockModel(model)),
    );
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed)
      throw new DatabaseError(
        "IO",
        `${failed} database session(s) could not lock because recovery failed. Other sessions were locked; the failed dirty sessions remain available for Save or Retry.`,
      );
  }

  async lockActive(): Promise<void> {
    const panel = [...this.panels].find(([candidate]) => candidate.active)?.[1];
    if (panel?.document.model) await this.lockModel(panel.document.model);
    else await vscode.window.showInformationMessage("No active KeePass database is open.");
  }

  private async observeExternal(model: Model): Promise<void> {
    return model.queue.run(async () => {
      if (!this.models.has(model.session) || this.shuttingDown) return;
      if (await model.session.checkExternalChange()) {
        model.error =
          "The database changed externally. Save is blocked; use Save As or explicitly Revert to reload.";
        this.publish(model);
      }
    });
  }

  private copy(value: string): Promise<void> {
    return this.clipboardQueue.run(async () => {
      await vscode.env.clipboard.writeText(value);
      if (this.clipboard) clearTimeout(this.clipboard.timer);
      const timer = setTimeout(() => this.track(this.clearClipboard()), 30_000);
      this.clipboard = { value, timer };
    });
  }

  private clearClipboard(): Promise<void> {
    return this.clipboardQueue.run(async () => {
      const current = this.clipboard;
      if (!current) return;
      clearTimeout(current.timer);
      this.clipboard = undefined;
      try {
        if ((await vscode.env.clipboard.readText()) === current.value)
          await vscode.env.clipboard.writeText("");
      } catch {
        await vscode.window.showWarningMessage(
          "The clipboard could not be cleared. It may still contain the last copied value; clipboard history can retain older copies.",
        );
      }
    });
  }

  private async exportAttachment(
    session: DatabaseSession,
    id: string,
    name: string,
  ): Promise<void> {
    if (
      !(await this.confirm(
        "Export only the selected attachment as a decrypted file? Clipboard history, old copies and exported files are not protected by the database password.",
      ))
    )
      return;
    const destination = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(join(dirname(session.path), attachmentSuggestion(name))),
      title: "Export decrypted attachment",
    });
    if (!destination) return;
    this.admit(destination);
    const bytes = new Uint8Array(await session.exportAttachment(id, name));
    try {
      const parent = await fs.realpath(dirname(destination.fsPath));
      const target = join(parent, basename(destination.fsPath));
      const key = (path: string): string =>
        process.platform === "win32" ? path.toLowerCase() : path;
      if ([...this.models.values()].some((model) => key(model.session.path) === key(target))) {
        throw new DatabaseError(
          "INVALID_INPUT",
          "Attachment export cannot replace an open database.",
        );
      }
      let handle: fs.FileHandle;
      try {
        handle = await fs.open(target, "wx", 0o600);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
        if (
          !(await this.confirm(
            "Replace this existing file with the decrypted attachment? Its previous contents will be lost.",
          ))
        )
          return;
        const before = await fs.lstat(target);
        if (!before.isFile() || before.isSymbolicLink())
          throw new DatabaseError("IO", "Choose a regular file, not a symbolic link or directory.");
        handle = await fs.open(target, "r+");
        try {
          const current = await handle.stat();
          const atPath = await fs.lstat(target);
          if (
            current.dev !== before.dev ||
            current.ino !== before.ino ||
            atPath.dev !== before.dev ||
            atPath.ino !== before.ino ||
            atPath.isSymbolicLink()
          ) {
            throw new DatabaseError("CONFLICT", "The export destination changed. Choose it again.");
          }
          for (const model of this.models.values()) {
            let protectedFile;
            try {
              protectedFile = await fs.stat(model.session.path);
            } catch (inspection) {
              if (
                !(inspection instanceof Error) ||
                !("code" in inspection) ||
                inspection.code !== "ENOENT"
              )
                throw inspection;
            }
            if (
              protectedFile &&
              current.dev === protectedFile.dev &&
              current.ino === protectedFile.ino
            ) {
              throw new DatabaseError(
                "INVALID_INPUT",
                "Attachment export cannot replace an open database or its hard link.",
              );
            }
          }
        } catch (error) {
          await handle.close();
          throw error;
        }
      }
      try {
        await handle.writeFile(bytes);
        await handle.truncate(bytes.byteLength);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof DatabaseError) throw error;
      throw new DatabaseError(
        "IO",
        "Attachment export failed. Choose a regular writable file other than an open database; a partial exported file may remain. The database was not changed.",
      );
    } finally {
      bytes.fill(0);
    }
  }

  async createDatabase(): Promise<void> {
    if (this.shuttingDown)
      throw new DatabaseError("LOCKED", "The database editor is shutting down.");
    this.admit(vscode.Uri.file(this.context.globalStorageUri.fsPath));
    const destination = await vscode.window.showSaveDialog({
      title: "Create KeePass 4.1 database (new destination only)",
      filters: { "KeePass database": ["kdbx"] },
    });
    if (!destination) return;
    this.admit(destination);
    let password = await vscode.window.showInputBox({
      title: "New database master password",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.length > 0 && value.length <= 16_384
          ? undefined
          : "Enter a master password from 1 to 16,384 characters.",
    });
    if (password === undefined) return;
    let confirmation = await vscode.window.showInputBox({
      title: "Confirm new database master password",
      password: true,
      ignoreFocusOut: true,
    });
    if (confirmation === undefined) {
      password = "";
      return;
    }
    try {
      const registry = await this.sessions();
      const session = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Creating encrypted KeePass 4.1 database",
          cancellable: true,
        },
        (_progress, token) =>
          withCancellation(token, (signal) =>
            registry.createDatabase(destination.fsPath, password!, confirmation!, signal),
          ),
      );
      await session.lock();
      await registry.close(session);
      await vscode.commands.executeCommand("vscode.openWith", destination, DATABASE_EDITOR);
    } finally {
      password = "";
      confirmation = "";
    }
  }

  release(document: DatabaseDocument): void {
    this.documents.delete(document);
    const model = document.model;
    if (!model) return;
    model.documents.delete(document);
    if (!model.documents.size)
      this.track(
        model.queue.run(async () => {
          if (model.documents.size || !this.models.has(model.session)) return;
          model.unlock?.abort();
          await model.session.lock();
          await model.session.close();
          model.watcher.dispose();
          this.models.delete(model.session);
          await this.clearClipboard();
        }),
      );
  }

  private track(operation: Promise<unknown>): void {
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      (error: unknown) => {
        this.pending.delete(operation);
        void vscode.window.showErrorMessage(errorMessage(error));
      },
    );
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.finishShutdown();
    return this.shutdownPromise;
  }

  private async finishShutdown(): Promise<void> {
    this.shuttingDown = true;
    clearInterval(this.idleTimer);
    await Promise.allSettled(this.pending);
    const results = await Promise.allSettled(
      [...this.models.values()].map(async (model) => {
        model.unlock?.abort();
        await model.queue.run(async () => {
          if (!this.models.has(model.session)) return;
          await model.session.lock();
          await model.session.close();
          model.watcher.dispose();
          this.models.delete(model.session);
        });
      }),
    );
    await this.clearClipboard();
    if (results.some((result) => result.status === "rejected")) {
      throw new DatabaseError(
        "IO",
        "Some encrypted recovery could not be completed during shutdown. Reopen the database and retry saving; do not assume unsaved changes reached disk.",
      );
    }
  }

  dispose(): void {
    clearInterval(this.idleTimer);
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changes.dispose();
    this.panels.clear();
    void this.shutdown().catch((error: unknown) => {
      void vscode.window.showErrorMessage(errorMessage(error));
    });
  }
}
