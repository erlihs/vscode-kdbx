# Security policy

## Private vulnerability reporting

Use [GitHub private vulnerability reporting](https://github.com/erlihs/vscode-kdbx/security/advisories/new)
for this repository (sign in, then **Security → Report a vulnerability**).
Do not disclose vulnerability details in public issues or discussions.
If that option is unavailable, ask the maintainer in a public issue to enable a
private reporting channel, without including vulnerability details.

Include the extension and VS Code versions, operating system, affected workflow,
expected and actual behavior, impact, and minimal reproduction steps. Use a
synthetic database with a disposable password. Never send a real database, master
password, credentials, recovery file or unsanitized memory dump.
Coordinate public disclosure with the maintainer after a fix is available.
There is no guaranteed response time or security service-level agreement.

## Supported versions

Security fixes target the latest published extension version only; older versions
are not maintained with backported fixes. If no release is published, reports
against the current default branch are welcome. The extension requires VS Code
1.101.0 or newer on local Windows, macOS or Linux desktop hosts; use a current
VS Code release for host security fixes.

The interactive editor is an early preview. Independent security review and
release acceptance remain outstanding. Compatibility tests and a packaged VSIX
are not security certification; evaluate with synthetic data until those checks
are complete. See [remaining improvements](https://github.com/erlihs/vscode-kdbx/blob/HEAD/docs/technical.md#remaining-improvements).

## Plaintext and trust boundaries

- The original database, saved databases and recovery snapshots are encrypted
  KDBX files. No automatic plaintext database export is implemented.
- While unlocked, the complete decrypted model, protected values, credentials,
  derived keys, entry history and editor undo state reside in a local Node worker.
  Cryptography uses the bundled KDBX library, local XML parser and embedded
  WebAssembly Argon2 implementation.
- Workers are threads in the extension-host process, **not an OS sandbox**.
  Master passwords pass through the webview and extension host to the worker.
  Creation and password-change dialogs also temporarily hold passwords in the host.
- Browsing exposes unprotected fields, notes, titles, usernames, URLs, tags and
  attachment metadata to the host and webview. Protected values are omitted from
  ordinary detail replies, but explicitly revealing or editing them returns
  plaintext. Generated passwords also exist in host/webview memory.
- Copying exposes a selected value to the host and OS clipboard. Attachment
  import/export handles plaintext bytes in host memory; confirmed export writes
  a decrypted attachment to the user-selected file.
- There is no saved master password or automatic-unlock token. Some mutable
  buffers are cleared, but JavaScript strings, garbage collection, WASM memory,
  OS paging and crash dumps prevent a guarantee of complete memory erasure.

The webview loads a bundled script with a nonce-based content security policy:
default sources, connections, form submission and base URLs are blocked.
Host/webview messages are validated with per-panel channels and request IDs;
worker messages are validated separately. Restricted Mode shows a script-free
explanation without reading the database or accepting a password.

Successful locking waits for worker termination. Hiding a view or losing window
focus conceals secrets and removes drafts; it does not itself lock the database.
Idle lock defaults to five minutes and can be disabled with
`kdbx.idleLockMinutes = 0`. If encrypted recovery fails, a dirty session remains
available for save/retry and the failure is reported rather than claiming it locked.

This model assumes a trusted OS, VS Code installation, workspace and extensions.
It cannot defend against malicious extensions, debuggers, process inspection,
keyloggers, clipboard history or a compromised host.

## Clipboard behavior

An explicit copy uses VS Code's OS clipboard API. After 30 seconds the extension
clears the clipboard only if it still matches the last value it copied. Cleanup
is also attempted on locking and shutdown; failures are reported to the user.
Other software can read or retain a copy before cleanup. Clipboard history and
clipboard synchronization are not controlled or erased by the extension, and
a crash can prevent cleanup.

## Recovery files and disk persistence

Dirty backup, lock and close serialize the current database to encrypted KDBX
recovery under the extension's VS Code global storage directory,
`encrypted-recovery`, not the workspace. Recovery metadata contains opaque
identifiers, file fingerprints and a password-change flag, not credentials.
Recovery preserves finished edits and KeePass entry history, not unfinished
webview drafts or the editor undo/redo stack.

Recovery uses the session's current master password. After a password change,
new recovery needs the new password while the original database needs the old
password until saved. Older files, recovery snapshots and backups retain their
original passwords; changing a password cannot revoke them.

Saves use encrypted staging files beside the destination, check external changes
and verify replacement. Crashes or cleanup failures can leave encrypted staging
or recovery files. Cleanup errors are reported; snapshots from earlier sessions
can require explicit selection or discard. Filesystem permissions are applied
where supported, but encryption is not a substitute for protecting your OS account.
Do not concurrently edit a database in multiple applications/windows. Network
shares and mapped network filesystems are unsupported. User-selected folders,
OS backup tools or sync clients may copy files independently of the extension.

## Network behavior and telemetry

**KDBX for VS Code does not transmit your database, master password, or credentials
to a server. Database operations are performed locally.**

The current application runtime and its bundled runtime dependencies contain no
automatic network-request or telemetry path. There are no analytics, crash-report
uploads, cloud accounts, password-breach lookups or remote KDF services.
Argon2 WASM is embedded in the bundle, not fetched at unlock time.

The explicit **open website** action accepts only HTTP(S) URLs without embedded
username/password components, asks for confirmation, then hands the entry URL to
the external browser through VS Code. The browser can transmit the URL, including
any sensitive path or query parameters. The extension does not append database
contents, a master password or credentials.

VS Code, other extensions, browsers and clipboard/backup/sync tools have separate
network and telemetry policies. Installing/updating the extension, downloading
development dependencies, auditing dependencies and smoke-testing downloaded
VS Code builds can use the network. The offline-runtime statement does not cover
those activities.

## Dependency policy

Runtime dependencies are declared in the core manifest and resolved by the
committed pnpm lockfile: a locally patched `@keenext/kdbxweb`, `@xmldom/xmldom`,
`hash-wasm`, and the KDBX library's `fflate` compression dependency. Builds bundle
runtime code and WASM; development dependencies are excluded from the VSIX.
Local patches are versioned in the repository and bundled legal notices are retained.

Dependency changes should receive review for advisories, network/telemetry paths,
crypto and parser behavior, preservation compatibility and license obligations.
Use frozen-lockfile installs, `pnpm audit --prod`, the repository checks,
compatibility/interop tests and packaged smoke tests as applicable before release.
An audit result is point-in-time evidence, not a guarantee of security. Recheck
the privacy claims whenever dependencies or runtime features change.

## Further documentation

- [Technical reference: architecture, compatibility, validation and troubleshooting](https://github.com/erlihs/vscode-kdbx/blob/HEAD/docs/technical.md)
