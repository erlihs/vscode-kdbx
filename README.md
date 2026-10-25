# KeePass Database Manager for VS Code

**Phase 1 was approved on 2026-10-25**, following compatibility, calibration and
installed-VSIX verification. Implementation of [the product specification](spec.md)
has moved to **Phase 2: the locked editor and core session/persistence foundation**.

The preview now opens `.kdbx` files in a dedicated, locked, read-only editor.
It does not read or decrypt database bytes, request credentials, edit, or save.
This is **not yet a usable password manager**; continue using synthetic data only.

## Development

Requires Node.js 22.12 or newer and pnpm 10.28.0 (pinned in
`package.json`). With Corepack installed, `corepack enable` makes the pinned
pnpm available.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm compatibility
```

- `pnpm build`: compile the UI-independent core with native TypeScript (`tsgo`).
- `pnpm typecheck`: check source, tests, Vitest configuration and the extension.
- `pnpm test`: build and run Vitest.
- `pnpm lint`: run Oxlint.
- `pnpm format` / `pnpm format:check`: write / check formatting with Oxfmt.
- `pnpm compatibility`: run the synthetic cipher/KDF/compression matrix in
  isolated Node workers and print a non-secret summary; exits unsuccessfully if
  any case fails (`-- --require-gate` is accepted for compatibility).
- `pnpm interop -- --app keepass|keepassxc`: cross-application round trip with
  KeePass 2.x (`KPScript` on `PATH` or `$KPSCRIPT`) or KeePassXC (`keepassxc-cli`
  on `PATH` or `$KEEPASSXC_CLI`); add `--write-fixtures` to refresh the committed
  fixtures that application wrote.
- `pnpm calibrate`: measure new-database Argon2id settings and the worker heap
  needed at the XML ceilings on this machine (`-- --kdf` or `-- --heap` for one
  part; the heap part takes several minutes and fails above 75% of the heap).
- `pnpm package`: bundle the smoke-test extension and build
  `packages/extension/dist/kdbx.vsix`.
- `pnpm smoke`: package, download VS Code (`VSCODE_VERSION`, default `stable`),
  install the VSIX and test the locked editor and worker in trusted and Restricted
  Mode windows.

CI runs on Windows, macOS and Linux with Node 22 and 24. Separate jobs run the
round trip against KeePass 2.61.1 (Windows) and the distribution's KeePassXC
(Ubuntu), and the VSIX smoke test on all three systems with VS Code 1.101.0 and
stable. Line endings are pinned to LF by `.gitattributes`.
Vite is supplied transitively by Vitest; a dedicated webview build will be
introduced with the editor rather than adding an unused frontend now.

## Current implementation

- A binary, read-only custom editor associated with `.kdbx` files. Multiple views,
  clean close/reopen and VS Code's **Reopen Editor With** escape hatch are supported.
- A script-free, theme-aware locked page with escaped filename rendering and a
  restrictive Content Security Policy. No credentials or decrypted state enter
  the webview.
- Database-access restrictions for Restricted Mode, browser/remote extension
  hosts, remote/virtual workspaces, non-file URIs and network-share authorities.
  The extension requests local UI-host placement. Granting workspace trust refreshes
  an open restriction page; it does not unlock anything.
- pnpm workspace, strict TypeScript, native type checking, Ox tools and CI.
- Bounded, unauthenticated KDBX 4.1 header inspection, with explicit unsupported
  version/cipher/KDF errors and resource admission ceilings.
- Evaluation of a maintained KdbxWeb fork with an explicitly supplied XML parser
  and WASM Argon2d/Argon2id implementation.
- Synthetic AES-256/ChaCha20 × Argon2id/Argon2d/AES-KDF × compressed/uncompressed
  creation, edit, save and reopen checks.
- Preservation checks for protected fields, history, binary/empty attachments,
  UUIDs, tags, timestamps, recycle-bin references, deletion records and custom
  metadata, plus tampering, cancellation and exact header/KDF limit boundaries.
- A worker-internal load/save adapter that opens databases read-only when saving
  would drop unmodeled XML or header data, plus a reviewed local patch of the
  candidate (`patches/`). Only the writer-name text of `Meta/Generator` is exempt
  from that check; unknown attributes or children there still force read-only.
- A UI-independent shared-session service: canonical local paths share a persistent
  worker, with serialized edits, password changes, saves and locks. Decrypted
  databases and credentials remain in that worker.
- Conflict-aware encrypted persistence: an adjacent exclusive staging file,
  permission preservation, flush/close, fingerprint recheck and verified replacement.
  Save As creates a new encrypted destination without changing the source.
- Encrypted KDBX recovery before dirty lock/close. Failed backup retains the dirty
  worker; recovered contents and KeePass entry history survive restart. Password
  changes make recovery require the **new** password while the saved original
  still requires the old password until Save succeeds.
- Bounded decoded loading: streaming decompression against a per-load budget
  (captured when the load starts, shared by the payload and every compressed XML
  binary, never shared between concurrent loads) and an XML pre-scan (size,
  elements, depth, no DTDs) before any DOM is built.
- Cross-application round trips with KeePass 2.x and KeePassXC, with the files
  they wrote committed as independent fixtures.
- Calibrated defaults: new databases get Argon2id tuned to about one second above
  a 64 MiB floor (128 MiB × 7 iterations on the reference machine), and the XML
  ceilings (500,000 elements, 32 Mi characters) are measured to fit within 55% of
  the 2 GiB worker heap.
- A preview extension (`packages/extension`) bundled into a VSIX whose
  self-test runs the probe inside the VS Code extension host. Minimum VS Code
  version: 1.101.0.

## Phase 1 gate: approved

Every Phase 1 gate requirement is met with recorded evidence:

- **Interoperability:** independent round trips with KeePass 2.61.1 and KeePassXC
  2.7/2.8 pass in both directions for every cipher/KDF/compression case.
- **No silent data loss:** databases with data the candidate cannot save (unknown
  XML or header fields) open read-only; empty protected fields keep their flag.
- **Cryptographic dependencies:** Argon2 1.0 files (never written by KeePass or
  KeePassXC) are refused before key derivation.
- **Resource limits:** decoded data is admitted against per-load ceilings before
  allocation, including under concurrent loads.
- **Defaults and performance:** new-database KDF settings, XML ceilings and the
  worker heap are calibrated on a documented reference machine; real-cost key
  derivation leaves the VS Code extension host at its idle responsiveness.
- **Packaging:** the packaged VSIX passes its self-test in the extension host of
  VS Code 1.101.0 and stable on Windows, macOS and Linux.

See [the compatibility assessment](docs/compatibility.md) for the evidence.

## Trying the locked-editor preview

1. Run `pnpm package`.
2. Use **Extensions: Install from VSIX** and select
   `packages/extension/dist/kdbx.vsix`.
3. Open a synthetic `.kdbx` file from Explorer. It should open in **KeePass Database**,
   displaying its filename and the locked/read-only explanation, not binary text.
4. Use **Reopen Editor With** to select another editor if needed.

This stage intentionally uses a read-only custom-document provider, not a
writable provider with placeholder save methods. It performs no database I/O and
offers no password form or unlock action until a safe session and recovery path
exists. Restricted Mode displays an explanation rather than offering a trust bypass.
Remote and virtual workspaces are not supported, including local databases opened
from those windows.

The installed-editor smoke now verifies association, multiple views, clean
close/reopen, the default-editor escape hatch and unchanged fixture bytes in both
trusted and genuinely untrusted workspaces. It passes locally on Windows with
VS Code 1.143.1 and 1.101.0; the expanded smoke is configured for all CI platforms,
but its new cross-platform results are not claimed until CI runs.

## Core session/persistence API

This foundation is **not connected to the read-only editor yet**. A future local,
trusted custom-document provider should own one `DatabaseSessions` registry per
host, rooted in private application recovery storage, not the workspace:

```ts
import { DatabaseSessions } from "@vscode-kdbx/core";

const sessions = await DatabaseSessions.create(privateRecoveryDirectory);
const snapshots = await sessions.findRecovery(databasePath);
// Existing snapshots require explicit selection or discard; never silently ignore them.
const document = await sessions.open(databasePath, selectedRecovery);
await document.unlock(password, abortSignal);
await document.createEntry("Example");
await document.save();
await sessions.close(document);
```

`state` exposes locked/dirty/read-only/conflict/credential-change status, explicit
source-access/admission issues and an opaque recovery reference. `listEntries()`
returns only explicit UUID/title
summaries; no model or password is returned. Other operations are `editEntry()`,
`changeMasterPassword(newPassword, confirmation)`, `saveAs()`, `backup()`, `lock()`
and explicit `discardAndLock()`. Invalid XML field characters and edits exceeding
the actual escaped XML/decoded-size limits (including entry history and protected
ciphertext) are refused without retaining the failed edit. Valid carriage returns,
line endings, Unicode and XML metacharacters survive save/reopen unchanged.

- Unlock accepts cancellation and has a 30-second safety deadline. Lock cancels
  an unfinished unlock. Already-dirty operations are serialized, not terminated
  mid-save or mid-edit. Worker termination is awaited before a successful lock.
- Save refuses an externally modified/deleted source and retains dirty changes.
  Save As currently accepts **new destinations only**, re-encrypts with fresh
  randomness and switches the shared session to the new path.
- Recovery snapshots are ordinary encrypted KDBX files with unique opaque IDs.
  They never overwrite a previously returned snapshot, even after a password
  change. Restore with a selected reference from `findRecovery()`; changed,
  corrupt, deleted, unreadable or oversized sources cause a conflict and require
  Save As. Source-access failures are exposed in `state.sourceIssue`, not hidden.
- Save/discard removes only owned, revision-checked snapshots. Older snapshots
  from another session/restart remain discoverable and need explicit
  `discardRecovery()` after that session closes. Cleanup failures are reported
  separately from a successful save; clean lock still releases the worker.
- Recovery preserves database contents and KeePass entry history, **not an editor
  undo/redo stack**. Undo/redo ends at lock/recovery, as agreed; editable UI and its
  undo integration remain future work.

Fingerprint checks cannot eliminate the cross-process check-to-replacement race.
Do not edit the same file in multiple applications/windows concurrently. UNC
paths are refused; network/mapped mounts are unsupported. Directory flush is
performed on POSIX; Windows flushes the file and verifies replacement but has no
portable Node directory-flush equivalent. Persistence uncertainty is an explicit
error requiring reconciliation or Save As, not a success result. A crash or
cleanup failure can leave encrypted staging/recovery files; changing a password
cannot revoke those older copies.

Local Windows validation for this increment: **197 tests pass**, with one
POSIX-only permission test skipped; type/lint/format checks, all 12 compatibility
cases and the production dependency audit pass. The final VSIX passes on
VS Code **1.101.0 and 1.143.1**, in both trusted and genuinely Restricted Mode
windows, including the packaged persistent-worker round trip. Linux/macOS
validation of the new persistence paths still requires CI.

## Remaining product gates

The next milestone is a trusted, writable custom-document lifecycle and unlock
UI wired to this core: backup IDs, dirty-state events, save/conflict prompts,
explicit recovery selection/discard, undo boundaries and close/deactivation
handling. New-database creation, full group/entry/attachment UI, auto-lock,
accessibility/security review and Marketplace publishing remain unimplemented.
Phase 1 approval does not approve those later functional or release gates.

## Privacy and safety

Runtime probes use only generated synthetic data, stay in memory, make no
network requests and do not write databases or plaintext snapshots to disk.
`pnpm test`, `pnpm interop` and `pnpm calibrate` are the exceptions: they write synthetic
databases to a temporary directory and delete them afterwards. `pnpm smoke`
downloads VS Code into `packages/extension/.vscode-test/` and uses temporary
synthetic fixtures and isolated profiles for its editor tests, and verifies the
installed persistent worker can edit, change a password, encrypt and reopen.
The core session API writes only encrypted KDBX data and non-secret recovery
identifiers/fingerprints, never passwords or plaintext snapshots. Old copies
and snapshots can still be unlocked with their original passwords; a password
change does not revoke them.
Package installation and dependency auditing do use the package registry.
Worker cancellation waits for termination. Node's worker heap limits **do not**
bound WASM or ArrayBuffer memory, and exceeding one can abort the whole process
rather than only the worker, so decoded data is bounded by explicit admission
ceilings measured to stay well below the heap limit.
Header inspection verifies only a public checksum, not authenticity or the
encrypted payload. A passing probe is not a security review or release approval.

The eventual extension cannot protect against malicious extensions, a
compromised host, process inspection, keyloggers or clipboard history.

## License

[MIT](LICENSE). Candidate dependency versions and license considerations are
documented in [the compatibility assessment](docs/compatibility.md).
