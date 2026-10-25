import { randomBytes } from "node:crypto";

export interface EditorEnvironment {
  trusted: boolean;
  desktop: boolean;
  localHost: boolean;
  remoteWorkspace: boolean;
  virtualWorkspace: boolean;
}

export function editorRestriction(
  uri: { scheme: string; authority: string },
  environment: EditorEnvironment,
): string | undefined {
  if (!environment.trusted) {
    return "Database access is disabled in Restricted Mode. Trust the workspace through VS Code only if you trust its contents.";
  }
  if (!environment.desktop || !environment.localHost) {
    return "KeePass databases require the local VS Code desktop extension host. Browser and remote extension hosts are not supported.";
  }
  if (environment.remoteWorkspace || environment.virtualWorkspace) {
    return "Remote and virtual workspaces are not supported yet. Open the database in a local desktop window.";
  }
  if (uri.scheme !== "file" || uri.authority) {
    return "Only local filesystem databases are supported. Remote URIs and network-share authorities are not supported.";
  }
  return undefined;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function lockedEditorHtml(filename: string, restriction: string | undefined): string {
  const nonce = randomBytes(16).toString("base64");
  const heading = restriction ? "Database access unavailable" : "Database locked";
  const detail =
    restriction ??
    "This preview provides a locked, read-only database editor. Unlocking and editing are not available yet; no password is requested or stored.";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';">
  <title>${escapeHtml(heading)}</title>
  <style nonce="${nonce}">
    body { margin: 0; padding: 2rem; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.6; }
    main { max-width: 44rem; margin: 2rem auto; padding: 1.5rem; border: 1px solid var(--vscode-contrastBorder, var(--vscode-panel-border)); border-radius: 4px; }
    main:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 4px; }
    h1 { font-size: 1.5rem; margin-top: 0; }
    .filename { overflow-wrap: anywhere; font-weight: bold; }
  </style>
</head>
<body>
  <main aria-labelledby="heading" tabindex="0">
    <h1 id="heading">${escapeHtml(heading)}</h1>
    <p class="filename">${escapeHtml(filename)}</p>
    <p role="status">${escapeHtml(detail)}</p>
    <p>The database has not been read, decrypted, or modified.</p>
    <p>Use VS Code's <strong>Reopen Editor With</strong> action to choose another editor.</p>
  </main>
</body>
</html>`;
}

export function databaseEditorHtml(filename: string, channel: string, scriptUri: string): string {
  const nonce = randomBytes(24).toString("base64");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';">
  <title>${escapeHtml(filename)} — KeePass</title>
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 1rem; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family, sans-serif); font-size: var(--vscode-font-size, 13px); line-height: 1.5; }
    h1 { font-size: 1.4rem; overflow-wrap: anywhere; } h2 { font-size: 1.15rem; } h3 { font-size: 1rem; }
    button, input, select, textarea { font: inherit; }
    button { cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 1px solid var(--vscode-contrastBorder, transparent); padding: .35rem .65rem; border-radius: 2px; }
    button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: .55; cursor: default; }
    input:not([type=checkbox]), select, textarea { width: 100%; min-width: 0; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-contrastBorder, transparent)); padding: .35rem; }
    input[type=checkbox] { accent-color: var(--vscode-checkbox-background); }
    textarea { min-height: 7rem; resize: vertical; }
    :focus-visible { outline: 2px solid var(--vscode-focusBorder, Highlight); outline-offset: 2px; }
    [hidden] { display: none !important; }
    .toolbar, .actions { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; margin: .6rem 0; }
    .layout { display: grid; grid-template-columns: minmax(12rem, 1fr) minmax(18rem, 2fr) minmax(20rem, 2fr); gap: 1rem; align-items: start; }
    section, aside { min-width: 0; }
    .panel { padding: .8rem; border: 1px solid var(--vscode-contrastBorder, var(--vscode-panel-border, currentColor)); border-radius: 3px; }
    .notice { padding: .6rem; margin: .6rem 0; border-left: 3px solid var(--vscode-focusBorder, currentColor); white-space: pre-wrap; overflow-wrap: anywhere; }
    .error { color: var(--vscode-errorForeground, var(--vscode-editor-foreground)); border-color: var(--vscode-errorForeground, currentColor); }
    label { display: block; margin: .6rem 0 .2rem; } label.inline { display: inline-flex; align-items: center; gap: .3rem; margin: .3rem; }
    fieldset { margin: .8rem 0; border: 1px solid var(--vscode-contrastBorder, var(--vscode-panel-border, currentColor)); min-width: 0; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { text-align: left; padding: .35rem; overflow-wrap: anywhere; border-bottom: 1px solid var(--vscode-panel-border, currentColor); }
    th { font-weight: 600; } td button { max-width: 100%; overflow-wrap: anywhere; text-align: left; }
    tr[aria-selected=true] { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    ul { padding-left: 1.2rem; } .group-list { list-style: none; padding: 0; } .group-list ul { list-style: none; }
    .group-list button { margin: .15rem 0; text-align: left; max-width: 100%; overflow-wrap: anywhere; }
    button[aria-pressed=true] { outline: 2px solid var(--vscode-focusBorder, Highlight); }
    .muted { color: var(--vscode-descriptionForeground, var(--vscode-editor-foreground)); }
    .secret { font-family: var(--vscode-editor-font-family, monospace); }
    .locked { max-width: 34rem; margin: 2rem auto; }
    @media (max-width: 1100px) { .layout { grid-template-columns: minmax(12rem, 1fr) minmax(20rem, 2fr); } #details { grid-column: 1 / -1; } }
    @media (max-width: 650px) { .layout { display: block; } .layout > * { margin-bottom: 1rem; } }
    @media (forced-colors: active) { button, input, select, textarea, .panel { border: 1px solid ButtonText; } }
  </style>
</head>
<body data-channel="${escapeHtml(channel)}">
  <main id="app" aria-label="KeePass database editor">
    <h1>${escapeHtml(filename)}</h1>
    <p role="status">Connecting to the database editor…</p>
  </main>
  <script nonce="${nonce}" src="${escapeHtml(scriptUri)}"></script>
</body>
</html>`;
}
