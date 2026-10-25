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
