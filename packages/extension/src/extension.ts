import * as vscode from "vscode";
import { runSelfTest } from "./self-test.js";
import { DATABASE_EDITOR, DatabaseEditorProvider } from "./database-editor.js";
import { errorMessage } from "./editor-services.js";

let activeEditor: DatabaseEditorProvider | undefined;
export function activate(context: vscode.ExtensionContext): void {
  const editor = new DatabaseEditorProvider(context);
  activeEditor = editor;
  context.subscriptions.push(
    editor,
    vscode.window.registerCustomEditorProvider(DATABASE_EDITOR, editor, {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: false },
    }),
    vscode.commands.registerCommand("kdbx.createDatabase", async () => {
      try {
        await editor.createDatabase();
      } catch (error) {
        await vscode.window.showErrorMessage(errorMessage(error));
      }
    }),
    vscode.commands.registerCommand("kdbx.lockDatabase", async () => {
      try {
        await editor.lockActive();
      } catch (error) {
        await vscode.window.showErrorMessage(errorMessage(error));
      }
    }),
    vscode.commands.registerCommand("kdbx.lockAllDatabases", async () => {
      try {
        await editor.lockAll();
      } catch (error) {
        await vscode.window.showErrorMessage(errorMessage(error));
      }
    }),
    vscode.commands.registerCommand("kdbx.compatibilitySelfTest", async (options?: unknown) => {
      // Programmatic callers (the packaging smoke test) receive the report directly.
      const quiet = typeof options === "object" && options !== null && "quiet" in options;
      const report = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "KeePass compatibility self-test (synthetic data)",
        },
        () => runSelfTest(vscode.version),
      );
      if (!quiet) {
        const failed = report.cases.filter((item) => !item.ok).length;
        void vscode.window.showInformationMessage(
          failed
            ? `Compatibility self-test: ${failed} of ${report.cases.length} cases failed.`
            : `Compatibility self-test passed ${report.cases.length} cases; ` +
                `max extension-host lag ${report.maxEventLoopLagMs} ms.`,
        );
      }
      return report;
    }),
  );
}

export async function deactivate(): Promise<void> {
  await activeEditor?.shutdown();
  activeEditor = undefined;
}
