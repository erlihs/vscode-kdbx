// Runs inside VS Code's extension host. The extension under test was installed from
// the packaged VSIX into an isolated extensions directory; this harness only calls it.
const { writeFileSync } = require("node:fs");
const { relative, isAbsolute } = require("node:path");
const vscode = require("vscode");

exports.activate = () => {};

async function checkEditor(extension) {
  const trusted = process.env.KDBX_EXPECT_TRUST === "true";
  if (vscode.workspace.isTrusted !== trusted) {
    throw new Error(`Expected workspace trusted=${trusted}, got ${vscode.workspace.isTrusted}.`);
  }
  if (extension.extensionKind !== vscode.ExtensionKind.UI) {
    throw new Error("The database editor did not run in the local UI extension host.");
  }
  const uri = vscode.Uri.file(process.env.KDBX_EDITOR_FIXTURE);
  const tabs = () => vscode.window.tabGroups.all.flatMap((group) => [...group.tabs]);
  const customTabs = () =>
    tabs().filter(
      (tab) =>
        tab.input instanceof vscode.TabInputCustom &&
        tab.input.uri.toString() === uri.toString() &&
        tab.input.viewType === "kdbx.database",
    );
  const waitFor = async (check, message) => {
    const until = Date.now() + 10_000;
    while (!check()) {
      if (Date.now() > until) throw new Error(message);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  await vscode.commands.executeCommand("vscode.open", uri, { preview: false });
  await waitFor(
    () => customTabs().length === 1,
    "Default .kdbx association did not open the custom editor.",
  );
  await vscode.commands.executeCommand("vscode.openWith", uri, "kdbx.database", {
    viewColumn: vscode.ViewColumn.Beside,
    preview: false,
  });
  await waitFor(() => customTabs().length === 2, "A second custom-editor view did not open.");
  if (customTabs().some((tab) => tab.isDirty)) throw new Error("The locked editor became dirty.");
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await waitFor(() => customTabs().length === 0, "Locked editors did not close.");

  await vscode.commands.executeCommand("vscode.openWith", uri, "default");
  await waitFor(
    () =>
      tabs().some(
        (tab) =>
          tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString(),
      ),
    "The Reopen Editor With default-editor escape hatch failed.",
  );
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await vscode.commands.executeCommand("vscode.open", uri);
  await waitFor(() => customTabs().length === 1, "The database custom editor did not reopen.");
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  return {
    ok: true,
    trusted,
    defaultAssociation: true,
    multipleViews: true,
    reopenWithDefault: true,
  };
}

exports.run = async () => {
  const extension = vscode.extensions.getExtension("erlihs.kdbx");
  if (!extension) throw new Error("The packaged extension is not installed.");
  const fromInstall = relative(process.env.KDBX_EXTENSIONS_DIR, extension.extensionPath);
  if (fromInstall.startsWith("..") || isAbsolute(fromInstall)) {
    throw new Error(`Extension loaded from ${extension.extensionPath}, not the installed VSIX.`);
  }
  // Let VS Code finish starting up so its own work does not count as ours.
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  const editor = await checkEditor(extension);
  const report = await vscode.commands.executeCommand("kdbx.compatibilitySelfTest", {
    quiet: true,
  });
  writeFileSync(
    process.env.KDBX_REPORT,
    JSON.stringify({ ...report, editor, extensionPath: extension.extensionPath }, null, 2),
  );
};
