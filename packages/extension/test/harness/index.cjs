// Runs inside VS Code's extension host. The extension under test was installed from
// the packaged VSIX into an isolated extensions directory; this harness only calls it.
const { writeFileSync } = require("node:fs");
const { relative, isAbsolute } = require("node:path");
const vscode = require("vscode");

exports.activate = () => {};

exports.run = async () => {
  const extension = vscode.extensions.getExtension("erlihs.kdbx");
  if (!extension) throw new Error("The packaged extension is not installed.");
  const fromInstall = relative(process.env.KDBX_EXTENSIONS_DIR, extension.extensionPath);
  if (fromInstall.startsWith("..") || isAbsolute(fromInstall)) {
    throw new Error(`Extension loaded from ${extension.extensionPath}, not the installed VSIX.`);
  }
  const report = await vscode.commands.executeCommand("kdbx.compatibilitySelfTest", {
    quiet: true,
  });
  writeFileSync(
    process.env.KDBX_REPORT,
    JSON.stringify({ ...report, extensionPath: extension.extensionPath }, null, 2),
  );
};
