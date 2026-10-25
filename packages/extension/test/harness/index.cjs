// Runs inside VS Code's extension host. The extension under test was installed from
// the packaged VSIX into an isolated extensions directory; this harness only calls it.
const { readFileSync, writeFileSync } = require("node:fs");
const { relative, isAbsolute, join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { Worker } = require("node:worker_threads");
const vscode = require("vscode");

exports.activate = () => {};

async function step(label, operation, timeout = 30_000) {
  console.log(`[kdbx smoke] Starting: ${label}`);
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Smoke step timed out: ${label}`)), timeout);
      }),
    ]);
    console.log(`[kdbx smoke] Passed: ${label}`);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function withSessionWorker(extension, run) {
  const session = randomUUID();
  const worker = new Worker(join(extension.extensionPath, "dist", "session-worker.js"), {
    workerData: session,
  });
  let sequence = 0;
  let pending;
  const failure = new Promise((_, reject) => {
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (pending)
        reject(new Error(`The packaged session worker exited during ${pending.kind} (${code}).`));
    });
  });
  worker.on("message", (reply) => {
    if (!pending || reply.session !== session || reply.id !== pending.id) {
      throw new Error("The packaged session worker returned an invalid response.");
    }
    const { resolve, reject } = pending;
    pending = undefined;
    if (reply.ok) resolve(reply.result);
    else reject(new Error(`Session worker failed: ${reply.code}`));
  });
  const request = (command) =>
    step(`session worker ${command.kind}`, () =>
      Promise.race([
        new Promise((resolve, reject) => {
          const id = ++sequence;
          pending = { id, kind: command.kind, resolve, reject };
          worker.postMessage({ id, session, command });
        }),
        failure,
      ]),
    );
  try {
    return await run(request);
  } finally {
    await worker.terminate();
  }
}

async function checkSessionWorker(extension) {
  const { encrypted, id } = await withSessionWorker(extension, async (request) => {
    const bytes = new Uint8Array(readFileSync(process.env.KDBX_EDITOR_FIXTURE)).buffer;
    const result = await request({
      kind: "unlock",
      bytes,
      password: "synthetic-compatibility-only",
    });
    if (result.readOnlyReasons.length)
      throw new Error("The packaged session worker refused a modeled fixture.");
    const { value: id } = await request({ kind: "createEntry", title: "packaged synthetic edit" });
    await request({
      kind: "editEntry",
      entryId: id,
      fields: { Password: { value: "packaged synthetic secret", protected: true } },
    });
    await request({ kind: "undo" });
    await request({ kind: "redo" });
    await request({ kind: "changePassword", password: "new packaged synthetic password" });
    const encrypted = await request({ kind: "serialize" });
    if (!(encrypted instanceof ArrayBuffer) || encrypted.byteLength < 100) {
      throw new Error("The packaged session worker did not produce encrypted bytes.");
    }
    const entries = await request({ kind: "list" });
    if (!entries.some((entry) => entry.id === id && entry.title === "packaged synthetic edit")) {
      throw new Error("The packaged session worker did not retain the edit.");
    }
    return { encrypted, id };
  });
  await withSessionWorker(extension, async (request) => {
    await request({
      kind: "unlock",
      bytes: encrypted,
      password: "new packaged synthetic password",
    });
    const entries = await request({ kind: "list" });
    if (!entries.some((entry) => entry.id === id && entry.title === "packaged synthetic edit")) {
      throw new Error("The packaged session worker did not reopen the encrypted edits.");
    }
  });
  return {
    ok: true,
    unlock: true,
    edit: true,
    undoRedo: true,
    changePassword: true,
    serialize: true,
    reopen: true,
  };
}

async function checkEditor(extension) {
  const trusted = process.env.KDBX_EXPECT_TRUST === "true";
  if (vscode.workspace.isTrusted !== trusted) {
    throw new Error(`Expected workspace trusted=${trusted}, got ${vscode.workspace.isTrusted}.`);
  }
  if (extension.extensionKind !== vscode.ExtensionKind.UI) {
    throw new Error("The database editor did not run in the local UI extension host.");
  }
  await step("activate installed extension", () => extension.activate());
  const commands = await vscode.commands.getCommands(true);
  for (const command of ["kdbx.createDatabase", "kdbx.lockDatabase", "kdbx.lockAllDatabases"]) {
    if (!commands.includes(command))
      throw new Error(`The installed UI command is missing: ${command}.`);
  }
  if (readFileSync(join(extension.extensionPath, "dist", "webview.js")).length < 1000) {
    throw new Error("The installed VSIX is missing the interactive webview bundle.");
  }
  const command = (id, ...args) => step(id, () => vscode.commands.executeCommand(id, ...args));
  await command("kdbx.lockAllDatabases");
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

  await command("vscode.open", uri, { preview: false });
  await waitFor(
    () => customTabs().length === 1,
    "Default .kdbx association did not open the custom editor.",
  );
  await command("vscode.openWith", uri, "kdbx.database", {
    viewColumn: vscode.ViewColumn.Beside,
    preview: false,
  });
  await waitFor(() => customTabs().length === 2, "A second custom-editor view did not open.");
  if (customTabs().some((tab) => tab.isDirty)) throw new Error("The locked editor became dirty.");
  await command("workbench.action.closeAllEditors");
  await waitFor(() => customTabs().length === 0, "Locked editors did not close.");

  await step("default-editor escape hatch", () => command("vscode.openWith", uri, "default"));
  await waitFor(
    () =>
      tabs().some(
        (tab) =>
          tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString(),
      ),
    "The Reopen Editor With default-editor escape hatch failed.",
  );
  await command("workbench.action.closeAllEditors");
  await command("vscode.open", uri);
  await waitFor(() => customTabs().length === 1, "The database custom editor did not reopen.");
  await command("workbench.action.closeAllEditors");
  return {
    ok: true,
    trusted,
    defaultAssociation: true,
    multipleViews: true,
    reopenWithDefault: true,
    uiBundle: true,
    lifecycleCommands: true,
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
  const editor = await step("editor lifecycle", () => checkEditor(extension), 90_000);
  const sessionWorker = await step(
    "packaged session round trip",
    () => checkSessionWorker(extension),
    60_000,
  );
  const report = await step(
    "compatibility self-test",
    () =>
      vscode.commands.executeCommand("kdbx.compatibilitySelfTest", {
        quiet: true,
      }),
    60_000,
  );
  writeFileSync(
    process.env.KDBX_REPORT,
    JSON.stringify(
      { ...report, editor, sessionWorker, extensionPath: extension.extensionPath },
      null,
      2,
    ),
  );
};
