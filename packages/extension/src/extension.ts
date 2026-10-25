import * as vscode from "vscode";
import { runSelfTest } from "./self-test.js";
import { DATABASE_EDITOR, LockedEditorProvider } from "./locked-editor.js";

export function activate(context: vscode.ExtensionContext): void {
  const editor = new LockedEditorProvider(context.extension);
  context.subscriptions.push(
    editor,
    vscode.window.registerCustomEditorProvider(DATABASE_EDITOR, editor, {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: false },
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

export function deactivate(): void {}
