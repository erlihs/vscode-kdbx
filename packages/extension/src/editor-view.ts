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
    h1 { font-size: 1.2rem; margin: 0; overflow-wrap: anywhere; } h2 { font-size: 1.1rem; } h3 { font-size: 1rem; }
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
    .toolbar { justify-content: flex-end; border-bottom: 1px solid var(--vscode-panel-border, transparent); padding-bottom: .6rem; }
    .toolbar > .muted { margin-right: auto; }
    .layout { display: grid; grid-template-columns: minmax(10rem, .8fr) minmax(14rem, 1.2fr) minmax(20rem, 2fr); gap: 0; align-items: start; }
    section, aside { min-width: 0; }
    .panel { padding: 1rem; min-width: 0; border: 1px solid var(--vscode-contrastBorder, transparent); }
    .groups-panel, .entries-panel { border-right: 1px solid var(--vscode-panel-border, currentColor); min-height: 65vh; }
    .groups-panel { background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
    .pane-heading { display: flex; align-items: center; justify-content: space-between; gap: .5rem; min-width: 0; }
    .pane-heading h2, .pane-heading h3 { margin: .4rem 0; overflow-wrap: anywhere; }
    .pane-heading .actions { margin: 0; flex-shrink: 0; }
    .icon-button { padding: .25rem .4rem; background: transparent; color: inherit; }
    .icon-button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
    .notice { padding: .6rem; margin: .6rem 0; border-left: 3px solid var(--vscode-focusBorder, currentColor); white-space: pre-wrap; overflow-wrap: anywhere; }
    .error { color: var(--vscode-errorForeground, var(--vscode-editor-foreground)); border-color: var(--vscode-errorForeground, currentColor); }
    label { display: block; margin: .6rem 0 .2rem; } label.inline { display: inline-flex; align-items: center; gap: .3rem; margin: .3rem; }
    fieldset { margin: .8rem 0; border: 1px solid var(--vscode-contrastBorder, var(--vscode-panel-border, currentColor)); min-width: 0; }
    ul { padding-left: 1.2rem; } .group-list { list-style: none; padding: 0; } .group-list ul { list-style: none; }
    .group-row, .entry-row { display: flex; align-items: center; position: relative; min-width: 0; }
    .group-item, .entry-item { flex: 1; min-width: 0; text-align: left; background: transparent; color: inherit; overflow-wrap: anywhere; border: 1px solid var(--vscode-contrastBorder, transparent); }
    .entry-item { padding: .65rem .5rem; display: flex; flex-direction: column; gap: .15rem; }
    .entry-item span { font-size: .9em; opacity: .8; }
    .group-item:hover:not(:disabled), .entry-item:hover:not(:disabled) { background: var(--vscode-list-hoverBackground); }
    .group-item[aria-pressed=true], .entry-item[aria-pressed=true] { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); outline: 1px solid var(--vscode-contrastActiveBorder, transparent); }
    .action-menu { position: relative; flex-shrink: 0; }
    .action-menu > summary { cursor: pointer; list-style: none; padding: .3rem .5rem; border: 1px solid var(--vscode-contrastBorder, transparent); border-radius: 2px; }
    .action-menu > summary::-webkit-details-marker { display: none; }
    .action-menu[open] { z-index: 5; }
    .action-menu[open] > summary { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
    .menu-items { position: absolute; top: 100%; right: 0; width: min(15rem, 80vw); background: var(--vscode-menu-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border, transparent)); box-shadow: 0 2px 8px var(--vscode-widget-shadow, transparent); padding: .25rem; }
    .menu-items > button { display: block; width: 100%; text-align: left; border: 0; border-radius: 0; background: transparent; color: var(--vscode-menu-foreground, var(--vscode-editor-foreground)); }
    .menu-items > button:hover:not(:disabled) { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground, inherit); }
    .credential { padding: .6rem 0; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
    .credential h3 { font-size: .9rem; font-weight: normal; color: var(--vscode-descriptionForeground); }
    .credential-value { white-space: pre-wrap; overflow-wrap: anywhere; margin: .25rem 0 .4rem; user-select: text; }
    .secondary-section { margin: 1rem 0; border-top: 1px solid var(--vscode-panel-border, transparent); padding-top: .6rem; }
    .secondary-section > summary { cursor: pointer; font-weight: 600; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
    .muted { color: var(--vscode-descriptionForeground, var(--vscode-editor-foreground)); }
    .secret { font-family: var(--vscode-editor-font-family, monospace); }
    .locked { max-width: 28rem; margin: clamp(1rem, 8vh, 5rem) auto; padding: 2rem; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, transparent)); border-radius: 6px; }
    .unlock-badge { display: inline-block; font-size: .85em; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
    .locked h2 { font-size: 1.5rem; font-weight: 600; margin: .6rem 0 .35rem; }
    .unlock-filename { margin: 0 0 1.25rem; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family, monospace); }
    .unlock-form { margin-top: 1.5rem; }
    .unlock-form label { font-weight: 600; margin-bottom: .5rem; }
    .unlock-form input { padding: .65rem; }
    .unlock-hint { font-size: .9em; margin: .65rem 0 1.25rem; }
    .unlock-actions { display: flex; flex-direction: column; gap: .5rem; }
    .unlock-submit { width: 100%; padding: .6rem 1rem; }
    .secondary-button { color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground)); background: var(--vscode-button-secondaryBackground, transparent); }
    .secondary-button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground)); }
    .unlock-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: .5rem; border-top: 1px solid var(--vscode-panel-border, transparent); margin-top: 1.5rem; padding-top: 1rem; font-size: .9em; color: var(--vscode-descriptionForeground); }
    @media (max-width: 950px) { .layout { grid-template-columns: minmax(10rem, 1fr) minmax(14rem, 2fr); } #details { grid-column: 1 / -1; border-top: 1px solid var(--vscode-panel-border, currentColor); } .groups-panel, .entries-panel { min-height: 0; } }
    @media (max-width: 550px) { body { padding: .5rem; } .locked { padding: 1.25rem; } .layout { display: block; } .layout > * { margin-bottom: .5rem; } .groups-panel, .entries-panel { border-right: 0; } .pane-heading { flex-wrap: wrap; } }
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
