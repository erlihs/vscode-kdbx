import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { vi } from "vitest";
import type * as VSCode from "vscode";

export class EventEmitter<T> {
  private readonly listeners = new Set<(event: T) => unknown>();
  readonly event: VSCode.Event<T> = (listener, thisArg, disposables) => {
    const wrapped = (event: T): unknown => listener.call(thisArg, event);
    this.listeners.add(wrapped);
    const subscription = {
      dispose: () => {
        this.listeners.delete(wrapped);
      },
    };
    disposables?.push(subscription);
    return subscription;
  };
  fire(event: T): void {
    for (const listener of this.listeners) listener(event);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly fsPath: string,
  ) {}
  static file(path: string): VSCode.Uri {
    return Uri.parse(pathToFileURL(resolve(path)).href);
  }
  static parse(value: string): VSCode.Uri {
    const url = new URL(value);
    return new Uri(
      url.protocol.slice(0, -1),
      url.hostname,
      url.protocol === "file:" ? fileURLToPath(url) : url.pathname,
    );
  }
  static joinPath(base: VSCode.Uri, ...segments: string[]): VSCode.Uri {
    return Uri.file(join(base.fsPath, ...segments));
  }
  get path(): string {
    return this.fsPath.replaceAll("\\", "/");
  }
  get query(): string {
    return "";
  }
  get fragment(): string {
    return "";
  }
  with(): VSCode.Uri {
    return this;
  }
  toJSON(): object {
    return { scheme: this.scheme, authority: this.authority, path: this.path };
  }
  toString(): string {
    return this.scheme === "file"
      ? pathToFileURL(this.fsPath).href
      : `${this.scheme}://${this.authority}${this.path}`;
  }
}

export class CancellationError extends Error {
  constructor() {
    super("Cancelled");
  }
}
export const ExtensionKind = { UI: 1, Workspace: 2 };
export const UIKind = { Desktop: 1, Web: 2 };
export const ProgressLocation = { Notification: 15 };
export class RelativePattern {
  constructor(
    readonly baseUri: VSCode.Uri,
    readonly pattern: string,
  ) {}
}

const trust = new EventEmitter<void>();
const focus = new EventEmitter<VSCode.WindowState>();
const configuration = new EventEmitter<VSCode.ConfigurationChangeEvent>();
const cancellation = new EventEmitter<unknown>();
export const token: VSCode.CancellationToken = {
  isCancellationRequested: false,
  onCancellationRequested: cancellation.event,
};

export function watcher() {
  const changed = new EventEmitter<VSCode.Uri>();
  const deleted = new EventEmitter<VSCode.Uri>();
  const created = new EventEmitter<VSCode.Uri>();
  return {
    onDidChange: changed.event,
    onDidDelete: deleted.event,
    onDidCreate: created.event,
    ignoreCreateEvents: false,
    ignoreChangeEvents: false,
    ignoreDeleteEvents: false,
    dispose: vi.fn(),
    changed,
    deleted,
    created,
  };
}

export const controls = {
  trust,
  focus,
  configuration,
  settings: { idleLockMinutes: 5 as unknown },
  watchers: [] as ReturnType<typeof watcher>[],
  clipboard: "",
};

export const env = {
  uiKind: UIKind.Desktop,
  remoteName: undefined as string | undefined,
  clipboard: {
    writeText: vi.fn(async (text: string) => {
      controls.clipboard = text;
    }),
    readText: vi.fn(async () => controls.clipboard),
  },
};
export const workspace = {
  isTrusted: true,
  workspaceFolders: [] as { uri: VSCode.Uri }[],
  onDidGrantWorkspaceTrust: trust.event,
  onDidChangeConfiguration: configuration.event,
  getConfiguration: () => ({ get: () => controls.settings.idleLockMinutes }),
  createFileSystemWatcher: vi.fn(() => {
    const result = watcher();
    controls.watchers.push(result);
    return result;
  }),
};
export const window = {
  onDidChangeWindowState: focus.event,
  showWarningMessage: vi.fn(async (..._args: unknown[]): Promise<string | undefined> => undefined),
  showErrorMessage: vi.fn(async (..._args: unknown[]): Promise<string | undefined> => undefined),
  showInformationMessage: vi.fn(
    async (..._args: unknown[]): Promise<string | undefined> => undefined,
  ),
  showQuickPick: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
  showInputBox: vi.fn(async (..._args: unknown[]): Promise<string | undefined> => undefined),
  showOpenDialog: vi.fn(
    async (..._args: unknown[]): Promise<VSCode.Uri[] | undefined> => undefined,
  ),
  showSaveDialog: vi.fn(async (..._args: unknown[]): Promise<VSCode.Uri | undefined> => undefined),
  withProgress: async <T>(
    _options: unknown,
    task: (progress: unknown, cancellation: VSCode.CancellationToken) => Promise<T>,
  ): Promise<T> => task({}, token),
};
export const commands = {
  executeCommand: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
};

export function createPanel() {
  const received = new EventEmitter<unknown>();
  const disposed = new EventEmitter<void>();
  const changed = new EventEmitter<VSCode.WebviewPanelOnDidChangeViewStateEvent>();
  const messages: unknown[] = [];
  const panel: VSCode.WebviewPanel = {
    viewType: "kdbx.database",
    title: "Synthetic",
    options: {},
    active: true,
    visible: true,
    viewColumn: 1,
    webview: {
      html: "",
      options: {},
      cspSource: "https://webview.invalid",
      onDidReceiveMessage: received.event,
      asWebviewUri: (uri) => Uri.parse(`https://webview.invalid/${encodeURIComponent(uri.fsPath)}`),
      postMessage: async (message: unknown) => {
        messages.push(message);
        return true;
      },
    },
    onDidDispose: disposed.event,
    onDidChangeViewState: changed.event,
    reveal: () => {},
    dispose: () => {
      disposed.fire();
    },
  };
  return { panel, received, messages, changed };
}
