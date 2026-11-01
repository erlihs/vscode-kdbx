# Technical reference

Current implementation, compatibility, development and troubleshooting for
KDBX for VS Code. User workflows are in the [README](../README.md); threat
boundaries and vulnerability reporting are in [SECURITY.md](../SECURITY.md).

## Implementation

- Writable `.kdbx` custom editor: create/unlock, save/Save As/revert, encrypted
  backup, undo/redo and shared split views.
- Groups and entries: CRUD, moves, duplication, protected custom fields, notes,
  tags, entry history, recycle bin and search. Search excludes protected values and notes.
- Password generation, explicit reveal/copy, master-password changes, manual
  locking and configurable idle locking (five minutes by default).
- Native attachment import/export, rename and removal. Export requires confirmation
  and writes plaintext; attachments are not previewed, executed or opened automatically.

## Components

| Component                                                 | Responsibility                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [Core](../packages/core/src/)                             | UI-independent database API, typed errors, validation and serialized sessions   |
| [Session worker](../packages/core/src/session-worker.ts)  | Decrypted model, credentials, KDF, edits, history, undo/redo and encryption     |
| [Adapter](../packages/core/src/adapter.ts)                | Load/save and unknown-data preservation checks                                  |
| [Local files](../packages/core/src/local-files.ts)        | Encrypted staging, permission preservation, conflict detection and replacement  |
| [Extension](../packages/extension/src/database-editor.ts) | VS Code custom documents, commands, dialogs, clipboard and recovery integration |
| [Webview](../packages/extension/src/webview.ts)           | Framework-free UI with nonce CSP and validated per-panel messages               |

Canonical local paths share one worker per session registry. Operations are
serialized; the core has no VS Code dependency. Ordinary detail replies omit
protected plaintext; explicit reveal/edit/copy requests retrieve it. Workers are
threads, not a security sandbox; passwords and requested values also pass through
host/webview memory.

Runtime dependencies are the pinned, [locally patched KDBX library](../patches/),
`@keenext/kdbxweb` 2.2.0-keenext.2, `@xmldom/xmldom` 0.9.12,
`hash-wasm` 4.12.0 and transitive `fflate` 0.8.3, all MIT licensed.
esbuild bundles the host, session/probe workers, webview and embedded Argon2 WASM;
there are no native addons or runtime downloads.

## Format and preservation

- Read/write KDBX **4.0 and 4.1**; create **4.1**. AES-256/ChaCha20,
  Argon2id/Argon2d (version 1.3 only), AES-KDF and GZIP/no compression.
- Master-password authentication only. KDBX 3.x, KeePass 1.x `.kdb`, key files
  and hardware authentication are unsupported.
- Saves preserve cipher, compression and KDF settings with fresh randomness.
  Ordinary edits preserve 4.0; edits requiring newer metadata, including moves, upgrade to 4.1.
- XML elements, attributes and values are compared against the rebuilt model.
  Unpreservable data makes the database read-only; unsupported outer-header
  fields/KDF parameters are rejected. Only writer-owned `Meta/Generator` text
  is exempt from comparison.
- The local patch preserves empty protected fields and empty XML-pool attachments,
  records dropped header fields, and bounds streaming decompression per load.
  XML is scanned for size, element count, depth and DTDs before DOM allocation.

## Persistence and recovery

- Save encrypts before staging beside the destination, preserves permissions,
  flushes/closes, rechecks the source fingerprint and verifies replacement.
  POSIX also flushes the directory; Windows has no portable Node equivalent.
- External changes block saving and retain dirty edits. Fingerprint checks do not
  eliminate cross-process races: concurrent applications/windows are unsupported.
  Save As requires a new destination and leaves the original unchanged.
- Dirty backup/lock/close writes ordinary encrypted KDBX snapshots to the extension's
  global storage `encrypted-recovery` directory. Failed recovery keeps the dirty
  worker available and reports an error. Successful locking waits for termination.
- Recovery uses the current master password. After a password change, recovery needs
  the new password; the source needs the old password until saved. Old copies
  remain unlockable with their original passwords.
- Recovery preserves finished edits and KeePass history, not drafts or editor undo.
  Drafts disappear on hiding, deactivation or lock. Undo/redo ends at lock/recovery
  and is bounded to 100 edits / 64 MiB of accounted edit data.
- Cleanup removes only owned, unchanged snapshots. Older snapshots require explicit
  selection/discard; crash or cleanup failure can leave encrypted recovery/staging files.
- Same-URI split views share edits. Other aliases of the same canonical file are
  read-only except the primary URI.

## Defaults and limits

New databases use AES-256 and Argon2id calibrated locally toward one second:
64-256 MiB memory, 2-10 passes, two lanes. Existing KDF settings are never weakened.
The recorded Ryzen 5 7530U / Windows reference result was 128 MiB, seven passes,
about 0.96 seconds; this is not a universal unlock-time promise.

| Resource                          | Ceiling               |
| --------------------------------- | --------------------- |
| Encrypted database / outer header | 100 MiB / 64 KiB      |
| Argon2 memory / passes / lanes    | 256 MiB / 100 / 4     |
| AES-KDF rounds                    | 10,000,000            |
| Aggregate decoded bytes per load  | 256 MiB               |
| XML characters / elements / depth | 32 Mi / 500,000 / 256 |
| New attachment import             | 10 MiB                |
| Worker old/young heap / stack     | 2,048 / 64 / 4 MiB    |
| Unlock safety deadline            | 30 seconds            |

These are admission ceilings, not security-strength defaults. Calibration checks
XML loads against a 75% heap threshold. Worker heap limits do not bound WASM or
ArrayBuffer memory and can abort the host on exhaustion; explicit resource checks
are the primary guard.

## Development and validation

Requires Node.js 22.12+ and pnpm 10.28.0. Install with
`pnpm install --frozen-lockfile` from the repository root.

| Command                           | Purpose                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| `pnpm check`                      | Type-check, lint, formatting and Vitest tests                                             |
| `pnpm build` / `pnpm typecheck`   | Compile core / check core, extension and tests                                            |
| `pnpm test`                       | Build and run tests                                                                       |
| `pnpm compatibility`              | Twelve cipher/KDF/compression cases; failure returns a nonzero exit code                  |
| `pnpm interop -- --app keepass`   | KeePass round trips; requires KPScript on PATH or `KPSCRIPT`                              |
| `pnpm interop -- --app keepassxc` | KeePassXC round trips; requires its CLI on PATH or `KEEPASSXC_CLI`                        |
| `pnpm calibrate`                  | KDF/heap measurements; `-- --kdf` or `-- --heap` selects one                              |
| `pnpm audit --prod`               | Point-in-time runtime dependency advisory check                                           |
| `pnpm package`                    | Build `packages/extension/dist/kdbx.vsix`                                                 |
| `pnpm smoke`                      | Download VS Code and test the installed VSIX in isolated trusted/Restricted Mode profiles |

Use `--write-fixtures` with interop to refresh application-written fixtures.
`VSCODE_VERSION` selects the smoke-test version (default `stable`). Tests use
synthetic data; interop/calibration write temporary fixtures, and smoke downloads
VS Code. Install the built VSIX with **Extensions: Install from VSIX** for manual testing.

Automated coverage includes format preservation, tampering/wrong passwords,
exact resource boundaries, cancellation, attachment bytes, history, conflicts,
fault-injected writes, password-change recovery, native callbacks, clipboard
ownership, secret concealment and trust restrictions. Application-written
[fixtures](../packages/core/test/fixtures/) cover KeePass 2.61.1 and KeePassXC
2.7.6/2.8.0 round trips; independent fixtures establish 4.1 interoperability,
while 4.0 matrix coverage is synthetic.

CI is configured for Windows/macOS/Linux, Node 22/24, and VS Code 1.101.0/stable.
The interactive package has recorded local Windows smoke passes in both trust
modes; current cross-platform acceptance remains incomplete. Installed smoke
covers editor lifecycle and packaged workers, not every webview/native-dialog flow.

The root README, security policy, license and `docs/images/*.png` are canonical;
the build copies them into the extension. The VSIX excludes source, tests,
fixtures, sourcemaps and development dependencies. Packaging neither publishes
the extension nor establishes release/security approval.

## Troubleshooting

- **Access unavailable:** use a trusted local desktop window and a local file.
  Restricted Mode, remote/virtual workspaces, browser hosts and network/mapped
  filesystems are unsupported.
- **Unlock rejected:** check the password, supported format/authentication and limits.
  A wrong password cannot always be distinguished from authenticated-data corruption.
  Convert unsupported formats using KeePass on a separate copy.
- **Read-only database:** unsupported metadata cannot be safely rewritten. Keep the
  original and use KeePass/KeePassXC rather than discarding data to enable editing.
- **Save conflict/uncertainty:** stop concurrent writers. Preserve edits with Save As
  to a new file, or explicitly Revert to discard them and reload the source.
- **Lock/recovery failure:** the dirty session may still be unlocked. Fix disk space
  or permissions, then save/retry. After a password change, try the new password for recovery.
- **Clipboard not cleared:** manually clear it and its history. Cleanup cannot
  control clipboard managers or survive every crash.
- **Attachment export failed:** a partial plaintext file can remain; inspect/remove it.
- **Windows ACL failure:** use the bundled Windows PowerShell security module.
  ACL subprocesses isolate `PSModulePath`; do not bypass permission checks.
- **Smoke timeout/download failure:** inspect the named operation and uploaded VS Code
  logs; verify connectivity and pinned archive hashes. Hosted macOS minimum-version
  smoke still needs a successful rerun.

## Remaining improvements

Installed interactive acceptance (Save As, hot exit, dialogs and cancellation),
current cross-platform CI verification, accessibility and independent security
review, broader real-world compatibility/performance testing, and publication
approval. Cloud sync, browser integration, auto-type and TOTP are not implemented.

Format reference: [official KDBX specification](https://keepass.info/help/kb/kdbx.html).
