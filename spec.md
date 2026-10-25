# KeePass Database Manager for VS Code

## 1. Purpose and status

Build and publish a UI-only VS Code extension that provides a KeePass-style desktop app experience inside the editor, so users do not need to install a separate password-manager app. Clicking a database in the Explorer opens a dedicated editor for unlocking the database and managing passwords, notes, and attached files such as certificates.

This document is the proposed product specification and implementation plan, not a claim that these capabilities already exist. The repository currently contains only a license. Product names, package names, and release defaults below are provisional.

### Key terminology

- **Unlock / decrypt:** authenticate with the master password and decrypt the database into process memory. The original file remains encrypted.
- **Lock:** remove access to decrypted data and release sensitive session state.
- **Save / encrypt:** serialize and encrypt the current database back to a KDBX file.
- **Change master password:** re-encrypt the database using new credentials; this does not revoke access to older copies or backups.

There is no routine "decrypt file to disk" action. Plaintext database export is outside the first release.

## 2. Goals and boundaries

### First-release goals

1. Create, open, modify, and save KDBX 4.1 databases compatible with KeePass.
2. Provide a usable custom editor when a user opens a `.kdbx` file from Explorer.
3. Support master-password authentication, explicit locking, and automatic locking.
4. Manage groups, password entries, small notes, custom fields, and binary attachments.
5. Support safe saving, encrypted recovery, and detection of conflicting external writes.
6. Keep database operations in a separate, UI-independent `core` package.
7. Publish a tested VS Code Marketplace package.

### Initial platform scope

- VS Code desktop on Windows, macOS, and Linux; Node.js extension host.
- Local filesystem databases only. Database creation requires a local destination.
- Remote extension hosts, virtual filesystems, browser-hosted VS Code, and remote database URIs are unsupported initially. Explain this restriction rather than failing silently.
- An installed local extension may open a local database while a remote workspace is active only if extension placement and local file access are verified to work correctly.

### Explicitly out of scope for the first release

- Cloud synchronization, automatic database merging, collaboration, and shared unlock sessions.
- Browser integration, auto-type, SSH-agent integration, and executing attached files.
- Hardware tokens, challenge-response authentication, OS-account keys, and key-file authentication.
- TOTP generation, password breach checks, and external password services.
- KeePass 1.x `.kdb`, KDBX 3.x, and conversion of older databases.
- Plaintext database import/export, attachment preview, and rich-text/HTML notes.

Preserve unsupported entry metadata when round-tripping supported databases. A database requiring an unsupported authentication component must be rejected with an actionable explanation.

## 3. Primary user journeys

### Open an existing database

1. The user opens a `.kdbx` file from Explorer.
2. A locked custom editor displays the database filename and a master-password form, not the binary contents.
3. The user submits the password. A cancellable busy state is displayed while authentication and key derivation run.
4. Success displays the group tree and entries; failure leaves the database locked and reports an authentication, format, resource-limit, or integrity error as appropriate.
5. Passwords remain masked until individually revealed or copied.

Do not promise to distinguish an incorrect password from all forms of authenticated-data corruption. Error messages must reflect what the underlying library can establish.

### Create and maintain secrets

1. Run `KeePass: Create Database`, choose a destination, enter and confirm a master password.
2. Create a group, then add a password entry, note, or entry with attachments.
3. Save with the normal VS Code Save command. The editor shows a dirty indicator before successful persistence.
4. Close and reopen the database, then verify the saved content after unlocking.

## 4. Functional requirements

### 4.1 Database lifecycle

- Register a custom editor for `*.kdbx`, while retaining VS Code's "Reopen Editor With" escape hatch.
- Validate the signature, version, supported algorithms, and input/resource limits before expensive processing where possible.
- Create new databases explicitly as KDBX 4.1, with AES-256 and Argon2id as the proposed defaults.
- Support reading and writing KDBX 4.1 using AES-256 or ChaCha20 and Argon2id, Argon2d, or AES-KDF, subject to the compatibility gate in section 5.
- Preserve existing cipher, KDF parameters, compression, and supported metadata when saving. Never silently weaken security settings or downgrade the file format.
- Reject other format versions in the first release with a clear message; do not silently convert them.
- Change the master password with confirmation, saving the result through the same safe-write path.
- Provide `Lock Database` and `Lock All Databases` actions.
- Do not persist the master password, derived keys, or an automatic-unlock token.

### 4.2 Groups, entries, and notes

- Create, rename, move, and delete groups; support a hierarchical group tree.
- Create, view, edit, move, duplicate, and delete entries.
- Standard fields: title, username, password, URL, and multiline notes.
- Support named custom string fields, including a protected/masked flag.
- Model notes and file-oriented records as ordinary KeePass entries, not a proprietary schema.
- Show creation/modification times and support tags.
- Search unlocked data by title, username, URL, tags, and group path. Passwords, protected custom values, attachments, and notes are not indexed by default.
- Use stable UUIDs internally; duplicate titles are valid.
- Record entry history before edits and provide history viewing/restoration.
- Use the KeePass recycle bin for normal deletion. Support restore and explicitly confirmed permanent deletion, including applicable group descendants.
- Explain that history, recycle-bin contents, and old database copies can retain previous secrets.
- Support undo/redo for entry and group edits while unlocked. History restoration is a new edit, not removal of previous history.

### 4.3 Password actions

- Mask passwords by default; revealing a password requires an explicit action.
- Hide revealed values on lock, editor deactivation, or after a proposed 15-second reveal timeout.
- Generate passwords using a cryptographically secure random source; proposed default: 24 characters with configurable character classes.
- Validate generator settings and prevent empty or unsatisfiable configurations.
- Copy usernames, passwords, and explicitly selected protected fields without routing values through logs or notifications.
- Attempt clipboard clearing after a proposed 30 seconds, only if the clipboard still contains the copied value. Cancel pending secret-bearing timers on lock/disposal.
- Clearly document clipboard limitations: history managers and other applications may retain copies, and clearing is best effort.

### 4.4 Attachments

- Add binary files to entries; list attachment names and sizes, replace, rename, remove, and export them.
- Preserve original bytes, including zero-byte files and non-text certificates.
- Treat attachment names as labels, not trusted filesystem paths. Export through an explicit destination picker and confirm overwrites.
- Export only the selected attachment, with a warning that the exported file is decrypted.
- Never preview, execute, automatically open, or automatically extract an attachment.
- Proposed initial limits: 10 MiB per attachment and 100 MiB encrypted database input. Validate decompressed data, attachment totals, XML complexity, history, and KDF resource usage as well.
- Select concrete decoded-size and KDF limits during the compatibility spike. Exceeding a limit must produce a clear error; never truncate content or silently reduce a database's KDF settings.

### 4.5 Saving, recovery, and conflicts

- Integrate dirty state, Save, Save As, Revert, close prompts, and undo/redo with the VS Code custom-document lifecycle.
- Save As creates an independently encrypted copy and follows VS Code's destination-switch behavior; the original remains unchanged.
- Encrypt completely before replacing a destination. For local files, use an adjacent temporary file, restrictive permissions where supported, flush/close, and a tested atomic-replacement strategy.
- Preserve existing access permissions where possible and avoid leaving a more permissive replacement.
- On save failure, retain the dirty document, report the error, and leave the previous valid database usable.
- Track the loaded file's identity/content fingerprint and watch for external modification or deletion.
- Refuse a conflicting write rather than silently overwriting. Offer reload/discard or Save As; do not auto-merge.
- Serialize mutations and saves for each database within an extension host, using the shared document/session. Recheck the source fingerprint immediately before replacement.
- Treat writes from other VS Code windows, extension hosts, or password-manager applications as external changes. Fingerprint checks detect conflicts but do not guarantee protection against simultaneous cross-process writes.
- Document the remaining check-to-replacement race and filesystem limitations, advise against editing the same database in multiple applications or windows at once, and verify external-change behavior against KeePass.
- Implement encrypted custom-editor backups for VS Code hot exit. Never put plaintext in backups, global/workspace state, logs, or temporary files.
- Recovery backups require the master password after restart. Credential-changing edits require an explicit recovery design so users know which password opens the backup.
- Never discard dirty changes silently on manual lock, automatic lock, close, cancellation, or backup failure.

Proposed lock policy: before locking a dirty database, persist an encrypted recovery snapshot, then release decrypted state. If recovery cannot be written, keep the dirty session available, show a prominent error, and require Save, Retry, or explicit Discard. Define and test undo-state recovery without persisting plaintext.

### 4.6 Session and user experience

- Proposed idle-lock timeout: 5 minutes, configurable or disabled explicitly.
- Only interactions with the unlocked database reset its activity timer; unrelated editor activity does not.
- Attempt to lock on system suspend when the host exposes a reliable signal. Otherwise enforce elapsed idle time on resume/focus before displaying secrets.
- One document/session per canonical database path in an extension host. Multiple views share changes and lock state.
- Separate databases have independent credentials and lock state.
- Honor VS Code themes, high contrast, keyboard navigation, screen readers, and focus management.
- Use clear empty, loading, locked, dirty, conflict, and error states.
- Respect Workspace Trust: disable workspace database access in Restricted Mode for the initial release, without offering an implicit bypass.

## 5. Architecture and KDBX compatibility

### Proposed implementation

Use a TypeScript workspace with two packages:

- `core`: KDBX adapter, database operations, validation, session lifecycle, safe persistence, and typed errors.
- `extension`: VS Code commands, custom editor provider, webview UI, clipboard integration, and encrypted recovery.

Keep VS Code APIs and UI concerns out of the core. The extension uses the core's mutation, validation, and persistence rules.

Use a mature KDBX library rather than implementing cryptographic primitives or the file format from scratch. `kdbxweb` is the initial candidate, not a confirmed dependency. Its documentation requires an externally supplied Argon2 implementation; "supports KDBX 4" alone is not proof of complete KDBX 4.1 round-trip support.

Before committing to a library, demonstrate:

1. Explicit KDBX 4.1 creation and preservation of the version on save.
2. AES-256/ChaCha20 and Argon2id/Argon2d/AES-KDF compatibility with KeePass-generated fixtures.
3. Correct authentication/integrity checks, secure per-save randomness, compression, protected strings, binary attachments, and entry history.
4. Preservation of UUIDs, timestamps, tags, deleted-object records, recycle-bin references, custom fields, custom data, and supported 4.1 metadata.
5. A documented policy for unknown data: preserve it safely, or refuse an unsafe writable round trip. Never silently drop uneditable data.
6. Packaged Argon2 support on all target systems, acceptable cancellation/resource controls, licensing suitability, and dependency maintenance.

If the candidate fails this gate, evaluate another maintained library before implementing product features. Do not compensate with ad hoc cryptography.

### Extension execution model

- Use `CustomEditorProvider` with a binary `CustomDocument`, not a text editor.
- Own decrypted sessions in the extension-side service, never in persisted webview state.
- Run expensive KDF/parse/serialize work in an isolated worker where feasible; keep the extension host responsive and support cancellation.
- Send only the currently needed view data to the webview. Protected values cross the boundary only for explicit reveal/edit actions.
- Prefer host-side clipboard operations so copying does not require exposing a password to the webview.
- Validate every message against a typed runtime schema and verify document/session identity. Ignore stale results after lock/disposal.
- Use a restrictive Content Security Policy, packaged local assets, escaped text rendering, no remote scripts, and no HTML/Markdown rendering of notes.
- Do not fetch entry URLs or attachment content over the network. Opening a URL is an explicit, scheme-validated user action.

## 6. Security and privacy requirements

- Database content and credentials remain local. No telemetry, analytics, network calls, or third-party secret services in the first release.
- No password retention in VS Code SecretStorage in the first release; users unlock after restart.
- Never log database content, credentials, protected fields, attachment contents, or raw parsed database objects.
- Treat entry titles, paths, usernames, notes, and attachment names as potentially sensitive too.
- Minimize plaintext lifetimes and zero owned mutable buffers where feasible. JavaScript strings, garbage collection, crash dumps, the OS, and clipboard history prevent a guarantee of complete memory erasure.
- Locking releases references, clears views/reveal state, invalidates pending requests, and discards decrypted undo/redo state after safe recovery.
- Do not persist decrypted UI state through webview `getState`/`setState`, editor backups, or crash recovery.
- Apply bounded parsing/decompression and KDF resource checks to malicious or damaged files.
- Never weaken existing KDF parameters to meet performance targets. Offer actionable guidance for databases exceeding local resource limits.
- Ensure dependency/license review and a release-time security review before public publication.
- Document the trust boundary: this is not a defense against malicious extensions, a compromised machine, keyloggers, or users who can inspect the process.
- Explain that encrypted databases committed to Git still expose file history and may retain old secrets indefinitely; discourage committing sensitive databases without an explicit organizational policy.

## 7. Verification and release acceptance

### Required automated coverage

- Core CRUD, group moves, duplicate titles, history/recycle-bin behavior, protected fields, and credential changes.
- Open/create/save/reopen with an explicit assertion of KDBX version `4.1`.
- Wrong credentials, header/block tampering, truncated input, unsupported versions/algorithms, oversized inputs, and excessive KDF/decompression work.
- Attachment byte-for-byte round trips, deduplication where provided by the library, unusual names, path traversal attempts, zero-byte files, and size boundaries.
- Cancellation, lock during pending work, stale webview messages, backup failures, and absence of plaintext persistence.
- Fault-injected interrupted saves, permission errors, full-disk errors, external edits/deletion, serialized same-host saves, and detectable conflicts from other windows or applications.
- VS Code integration tests for Explorer association, save/save-as/revert, close prompts, undo/redo, auto-lock, encrypted hot exit, and recovery.
- Windows, macOS, and Linux package smoke tests using synthetic credentials only.

### Interoperability acceptance

- Open fixtures produced by KeePass, edit them through the extension UI, and reopen them in KeePass without loss of supported data.
- Open a newly created database in KeePass, modify it there, and reopen it in the extension.
- Test both supported ciphers and all supported KDFs, not just the default combination.
- Verify metadata preservation using fixtures that contain fields the UI does not edit.
- Check representative KeePassXC files as an additional compatibility signal; KeePass and the official specification remain the primary reference.

### Proposed measurable UX targets

- On a documented reference machine, the UI remains responsive during KDF work and shows progress/busy feedback within 250 ms.
- For a synthetic database of 1,000 ordinary entries, local search completes within 200 ms after unlock.
- Calibrate new-database Argon2id settings toward roughly 1 second on the reference machine with a documented memory floor and parameter bounds; obtain release approval for actual defaults.
- Unlock duration for existing files depends on their stored KDF settings; do not promise a universal time limit.
- Test configured attachment/database limits at the exact boundary and immediately above it.

The first release is accepted only when compatibility, persistence/recovery, security, accessibility, and packaging checks pass. A successful editor demonstration alone is insufficient.

## 8. Step-by-step implementation plan

### Phase 1: Confirm compatibility and product defaults

1. Build synthetic KeePass 4.1 fixtures covering the cipher/KDF matrix, attachments, history, and metadata.
2. Prototype library loading, mutation, saving, explicit 4.1 creation, and cross-application round trips.
3. Select and validate an Argon2 implementation, worker approach, packaging strategy, and licenses.
4. Measure memory/KDF costs and finalize safe resource limits, supported VS Code/Node versions, and default security settings.
5. Record final session-lock/recovery semantics, same-host write coordination, external-conflict limitations, and unknown-data handling.

**Exit criterion:** verified compatibility matrix and no unresolved data-loss or cryptographic dependency blocker.

### Phase 2: Establish the project foundation

1. Create the TypeScript workspace and core/extension packages.
2. Configure the existing package manager choice, strict type checking, linting, unit tests, builds, and CI.
3. Add extension activation, `.kdbx` custom-editor registration, command contributions, and supported-environment checks.
4. Add typed operation errors, message schemas, and synthetic test-fixture management.

**Exit criterion:** all packages build and test, and a development extension opens a locked database editor.

### Phase 3: Implement the core database service

1. Add format validation, bounded authentication/loading, creation, and explicit session locking.
2. Implement groups, entries, custom fields, search, generation, attachments, history, and recycle-bin operations.
3. Add credential changes and preservation checks for unedited metadata.
4. Add per-database same-host write serialization, fingerprint checks, safe save/save-as, and encrypted recovery primitives.
5. Test failure injection and cross-application round trips before relying on this service from the extension.

**Exit criterion:** core operations satisfy the compatibility and persistence tests without UI dependencies.

### Phase 4: Deliver the VS Code editor

1. Implement unlock/create flows, group navigation, entry lists, and detail forms.
2. Wire create/edit/delete/move/restore, attachment dialogs, history, and generation.
3. Integrate dirty tracking, undo/redo, save/save-as/revert, close behavior, and encrypted backup/restore.
4. Implement reveal/copy timers, auto-lock, multiple views, and stale-request invalidation.
5. Add conflict resolution, actionable errors, theme support, accessibility, and environment/trust restrictions.

**Exit criterion:** a user can complete the primary journeys entirely within VS Code, including recovery after restart.

### Phase 5: Harden and validate

1. Run the complete cipher/KDF/metadata interoperability matrix.
2. Exercise corruption, resource exhaustion, filesystem failures, external edits, and recovery scenarios.
3. Review webview boundaries, logs, buffers, dependencies, and all persistent artifacts for secret exposure.
4. Validate performance targets and keyboard/screen-reader behavior.
5. Smoke-test the packaged extension on all three operating systems.

**Exit criterion:** release acceptance checks pass and known limitations are documented.

### Phase 6: Publish and maintain

1. Finalize name, icon, publisher identity, repository metadata, and Marketplace categories.
2. Write installation/usage documentation, supported-format matrix, privacy/security notes, limitations, and recovery instructions.
3. Add changelog, contribution guidance, security-reporting instructions, and release checklist.
4. Package a minimal VSIX with only required runtime assets, including Argon2/WASM resources if selected.
5. Publish a pre-release build for interoperability feedback; fix release-blocking issues before stable publication.
6. Publish the stable Marketplace extension through an approved release workflow with protected publishing credentials.
7. Maintain dependency updates, regression fixtures, compatibility testing, and documented release/versioning practices.

**Exit criterion:** users can install the published extension and complete a verified create/edit/save/reopen workflow entirely within VS Code.

## 9. Decisions to finalize during Phase 1

The following are proposals rather than implicit promises:

- Final product name, publisher, and Marketplace distribution details.
- Exact UI technology, KDBX library, Argon2 provider, minimum VS Code version, and extension placement.
- New-database KDF parameters, maximum decoded sizes, KDF work limits, and attachment limits.
- Recovery behavior for master-password changes, retention/cleanup policy, and recoverable undo state.
- Whether optional inactivity-lock disabling and other security settings are appropriate for the target audience.
- Later support for key files, older database formats, remote environments, or additional KeePass features.

## 10. References

- [Official KDBX 4.1 format specification](https://keepass.info/help/kb/kdbx.html).
- [KeePass documentation](https://keepass.info/help/base/index.html).
- [kdbxweb candidate library and Argon2 integration requirements](https://github.com/keeweb/kdbxweb).
- [VS Code custom editor API](https://code.visualstudio.com/api/extension-guides/custom-editors).
- [VS Code webview security guidance](https://code.visualstudio.com/api/extension-guides/webview#security).
- [VS Code Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust).
- [Publishing a VS Code extension](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
