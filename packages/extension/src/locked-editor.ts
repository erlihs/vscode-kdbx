import { basename } from "node:path";
import * as vscode from "vscode";
import { editorRestriction, lockedEditorHtml } from "./editor-view.js";

export const DATABASE_EDITOR = "kdbx.database";

class LockedDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {}

  dispose(): void {}
}

/** Read-only until safe persistence and recovery are available. */
export class LockedEditorProvider
  implements vscode.CustomReadonlyEditorProvider<LockedDocument>, vscode.Disposable
{
  private readonly panels = new Map<vscode.WebviewPanel, LockedDocument>();
  private readonly trustSubscription: vscode.Disposable;

  constructor(private readonly extension: vscode.Extension<unknown>) {
    this.trustSubscription = vscode.workspace.onDidGrantWorkspaceTrust(() => {
      for (const [panel, document] of this.panels) this.render(document, panel);
    });
  }

  openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    token: vscode.CancellationToken,
  ): LockedDocument {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    return new LockedDocument(uri);
  }

  resolveCustomEditor(
    document: LockedDocument,
    panel: vscode.WebviewPanel,
    token: vscode.CancellationToken,
  ): void {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    panel.webview.options = { enableScripts: false, localResourceRoots: [] };
    this.panels.set(panel, document);
    panel.onDidDispose(() => this.panels.delete(panel));
    this.render(document, panel);
  }

  private render(document: LockedDocument, panel: vscode.WebviewPanel): void {
    const restriction = editorRestriction(document.uri, {
      trusted: vscode.workspace.isTrusted,
      desktop: vscode.env.uiKind === vscode.UIKind.Desktop,
      localHost: this.extension.extensionKind === vscode.ExtensionKind.UI,
      remoteWorkspace: vscode.env.remoteName !== undefined,
      virtualWorkspace:
        vscode.workspace.workspaceFolders?.some((folder) => folder.uri.scheme !== "file") ?? false,
    });
    panel.webview.html = lockedEditorHtml(basename(document.uri.fsPath), restriction);
  }

  dispose(): void {
    this.trustSubscription.dispose();
    this.panels.clear();
  }
}
