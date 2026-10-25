import { describe, expect, it } from "vitest";
import { databaseEditorHtml, editorRestriction, lockedEditorHtml } from "../src/editor-view.js";
import type { EditorEnvironment } from "../src/editor-view.js";

const local = { scheme: "file", authority: "" };
const supported: EditorEnvironment = {
  trusted: true,
  desktop: true,
  localHost: true,
  remoteWorkspace: false,
  virtualWorkspace: false,
};

describe("database editor environment admission", () => {
  it("allows trusted local desktop windows", () => {
    expect(editorRestriction(local, supported)).toBeUndefined();
  });

  it.each([
    [{ trusted: false }, "Restricted Mode"],
    [{ desktop: false }, "desktop extension host"],
    [{ localHost: false }, "remote extension hosts"],
    [{ remoteWorkspace: true }, "Remote and virtual workspaces"],
    [{ virtualWorkspace: true }, "Remote and virtual workspaces"],
  ])("explains unsupported environment %j", (changes, explanation) => {
    expect(editorRestriction(local, { ...supported, ...changes })).toContain(explanation);
  });

  it.each([
    { scheme: "vscode-remote", authority: "ssh-remote+example" },
    { scheme: "memfs", authority: "" },
    { scheme: "https", authority: "example.invalid" },
    { scheme: "file", authority: "network-server" },
  ])("refuses nonlocal database URI %j", (uri) => {
    expect(editorRestriction(uri, supported)).toContain("Only local filesystem databases");
  });
});

describe("locked database view", () => {
  it("shows the filename and honest locked/read-only state without credential controls", () => {
    const html = lockedEditorHtml("synthetic.kdbx", undefined);
    expect(html).toContain("Database locked");
    expect(html).toContain("synthetic.kdbx");
    expect(html).toContain("no password is requested or stored");
    expect(html).toContain("has not been read, decrypted, or modified");
    expect(html).toContain("Reopen Editor With");
    expect(html).not.toMatch(/<(input|form|script|iframe)\b/i);
  });

  describe("interactive database view", () => {
    it("loads only the nonce-authorized local browser entry", () => {
      const first = databaseEditorHtml(
        "vault.kdbx",
        "opaque-channel",
        "vscode-webview://editor/webview.js",
      );
      const nonce = /<style nonce="([^"]+)">/.exec(first)?.[1];
      expect(nonce).toBeTruthy();
      expect(first).toContain("default-src 'none'");
      expect(first).toContain(`script-src 'nonce-${nonce}'`);
      expect(first).toContain(`style-src 'nonce-${nonce}'`);
      expect(first).toContain("base-uri 'none'; form-action 'none'");
      expect(first).toContain(
        `<script nonce="${nonce}" src="vscode-webview://editor/webview.js"></script>`,
      );
      expect(first).toContain('data-channel="opaque-channel"');
      expect(databaseEditorHtml("vault.kdbx", "other", "local.js")).not.toContain(
        `nonce="${nonce}"`,
      );
      expect(first).not.toMatch(/\bon\w+=|unsafe-inline|https?:\/\/|<iframe/i);
    });

    it("escapes every host-provided interpolation without creating executable markup", () => {
      const html = databaseEditorHtml(
        '<img src=x onerror="bad">',
        '"><script>bad</script>',
        'x" onerror="bad',
      );
      expect(html).not.toContain("<img");
      expect(html).not.toContain("<script>bad");
      expect(html).toContain("&lt;img src=x onerror=&quot;bad&quot;&gt;");
      expect(html).toContain('data-channel="&quot;&gt;&lt;script&gt;bad&lt;/script&gt;"');
      expect(html).toContain('src="x&quot; onerror=&quot;bad"');
      expect(html.match(/<script\b/g)).toHaveLength(1);
    });

    it("provides themed responsive high-contrast and accessible initial content", () => {
      const html = databaseEditorHtml("vault.kdbx", "channel", "webview.js");
      expect(html).toContain('lang="en"');
      expect(html).toContain('role="status"');
      expect(html).toContain('aria-label="KeePass database editor"');
      expect(html).toContain("--vscode-editor-background");
      expect(html).toContain(":focus-visible");
      expect(html).toContain("forced-colors: active");
      expect(html).toContain("@media (max-width:");
    });
  });

  it("escapes filenames and restriction messages as text", () => {
    const html = lockedEditorHtml('<img src=x onerror="bad">&\'.kdbx', "<script>bad</script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&quot;bad&quot;&gt;&amp;&#39;.kdbx");
    expect(html).toContain("&lt;script&gt;bad&lt;/script&gt;");
    expect(html).toContain("Database access unavailable");
    expect(html).not.toContain("Database locked");
  });

  it("uses a fresh style nonce and a no-network, no-script CSP", () => {
    const first = lockedEditorHtml("synthetic.kdbx", undefined);
    const second = lockedEditorHtml("synthetic.kdbx", undefined);
    const nonce = /<style nonce="([^"]+)">/.exec(first)?.[1];
    expect(nonce).toBeTruthy();
    expect(first).toContain(`style-src 'nonce-${nonce}'`);
    expect(first).toContain("default-src 'none'");
    expect(first).toContain("base-uri 'none'; form-action 'none'");
    expect(second).not.toContain(`nonce="${nonce}"`);
  });
});
