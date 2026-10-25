# Compatibility assessment

## Status and reproducibility

Phase 1's compatibility gate is **passed**: every row in [Gate blockers](#gate-blockers)
is resolved with recorded evidence, and `pnpm compatibility -- --require-gate`
succeeds. This document records that evidence, not a production compatibility
promise; the persistence/recovery constraints below remain design requirements for
the editor.

Run `pnpm check`, `pnpm compatibility`, `pnpm audit --prod`, `pnpm calibrate`,
`pnpm smoke` and, with KeePass or KeePassXC available,
`pnpm interop -- --app keepass|keepassxc`.
The probe prints OS, Node version, CPU, output size and elapsed time for each
synthetic case. It never prints a decrypted snapshot or credentials.
All fixtures are generated in memory from fixed synthetic values; only UUIDs,
ordinary default timestamps and cryptographic randomness vary.

The initial local validation environment is Windows x64, Node 22.19.0,
pnpm 10.28.0. Measurements concern cheap fixtures and multiple load/save
operations, not a calibrated production unlock time. The CI matrix covers
Windows/macOS/Linux and Node 22/24; all six combinations passed `pnpm check`,
`pnpm compatibility` and `pnpm audit --prod` in
[run 2](https://github.com/erlihs/vscode-kdbx/actions/runs/40194006537).
`.gitattributes` pins LF line endings so Windows checkouts match the formatter.

## Candidate evaluation

| Candidate                          | Assessment                                                                                                                                                                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kdbxweb@2.1.1`                    | Rejected as a product dependency. The published package dates to 2021; its `@xmldom/xmldom@0.7.13` resolution has registry advisories. Source inspection also showed unbounded synchronous GZIP loading. It is not retained in the dependency graph.  |
| `@keenext/kdbxweb@2.2.0-keenext.2` | Evaluated maintained fork, pinned exactly. Ships ESM, externalizes the DOM implementation, uses fflate 0.8 and fixes several upstream integrity/metadata defects. The synthetic matrix exercises this candidate. Still fails the complete gate below. |
| `kdbx-wasm@0.3.1`                  | Additional registry/readme evaluation only, not adopted or executed. Advertises both ciphers and all three KDFs but that is not evidence of complete KDBX 4.1 metadata preservation or bounded loading.                                               |

The selected spike supplies `@xmldom/xmldom@0.9.12` and `hash-wasm@4.12.0`
explicitly. All are MIT licensed; the fork transitively uses MIT-licensed
`fflate@0.8.3`. The native TypeScript preview and Ox/Vitest dependencies are
development tools, not intended VSIX runtime dependencies. The initial
production-only dependency audit reports no known advisories; this does not
replace source, maintenance, transitive-license or release-time review.

The fork's type declarations contain extensionless ESM imports. Type checking
uses bundler resolution with full declaration checking, not `skipLibCheck`.
Our emitted runtime imports have explicit `.js` extensions and execute directly
in Node, including the worker. A future VSIX bundle must separately verify all
worker, DOM and embedded WASM assets.

## Automated evidence

For **each** of the twelve cipher/KDF/compression combinations:

1. Create a database, explicitly set version 4.1, and assert the on-disk header.
2. Load it through the worker-internal adapter, confirm it is writable and compare
   a semantic synthetic snapshot.
3. Edit a protected password, push history, save and reopen; compare again.
4. Confirm fresh save randomness and that unknown XML makes the database read-only.

Snapshot checks include cipher/KDF settings, compression, stable UUIDs, duplicate
titles, tabs, tags, creation/modification times, previous-parent references,
disabled quality checks, standard/custom protected strings, history, binary bytes,
empty attachments, custom data with modification dates, custom icons, public
custom header data, recycle-bin references and deletion records.
Empty and absent group notes are compared as semantically equivalent; timestamps
explicitly set by fixtures use the format's whole-second precision.
This is representative coverage, **not a proof that all unedited metadata survives**.

Separate tests cover:

- Wrong passwords, altered encrypted blocks, final-empty-block authentication,
  truncated streams and independent freshness of the serialized master seed,
  encryption IV and KDF salt for all six cipher/KDF combinations.
- Zero-byte and non-text attachments, duplicate binary content, untrusted
  path-shaped names treated only as labels, history and both empty and nonempty
  protection flags (the shared fixture includes an empty protected field).
- Unknown cipher/header fields, KDBX 3.x/4.0/future versions, malformed/truncated
  headers, bad public checksums and enormous declared header fields.
- Exact admission boundaries and immediately-above rejection for encrypted
  input size, header size, Argon2 memory/iterations/parallelism and AES rounds,
  including full-width UInt64 work values without costly KDF execution.
- Cancellation before/after worker creation and worker deadline termination.

An input-size test may pad an otherwise valid header to the admission boundary.
It tests header inspection only; it does not claim such a payload authenticates.
End-of-header marker contents are not assumed to match the recommended CRLF
bytes; the candidate uses a different marker. Independent interoperability must
confirm acceptance of its complete files.

## Unknown-data policy

The candidate rebuilds XML from its model on save, so anything it does not model
would be silently dropped. The worker-internal adapter (`packages/core/src/adapter.ts`)
therefore **refuses a writable round trip** instead of preserving opaque data:

- It loads with the original XML retained, rebuilds XML from the loaded model and
  requires every original element path, attribute and leaf value to reappear.
  Protected values are compared by object identity, so no plaintext enters the check.
  Binary `Ref` numbers are excluded because the referenced bytes live in the inner header.
  Only the writer-owned text of `Meta/Generator` is exempt, not its attributes or children.
- Outer/inner header fields the candidate would not write (unknown IDs and `Comment`)
  are recorded by a local patch and also make the database read-only.
- Unknown outer header fields and KDF parameters are still rejected by preflight.
- `saveDatabase` throws `READ_ONLY` for such databases; reading remains possible.

A false positive only costs writability, never data. Real KeePass/KeePassXC fixtures
must confirm the check does not flag ordinary files.

## Local candidate patch

`patches/@keenext__kdbxweb@2.2.0-keenext.2.patch` is applied by pnpm
(`patchedDependencies` in `pnpm-workspace.yaml`). It must be reviewed whenever the
candidate is upgraded and proposed upstream:

- `KdbxHeader.droppedFieldIds` records unknown and `Comment` header fields.
- Empty protected values (`Protected="True"` with no text) load as empty
  `ProtectedValue`s instead of unprotected strings, so the flag survives a save.
  KeePass reads them the same way; the inner random stream advances by zero bytes.
- Empty binaries in XML binary pools (`<Binary ID="1" Compressed="True" />`, as
  KeePass exports them) load as empty attachments instead of being dropped.
- Every decompression (KDBX 4 payload, KDBX 3 payload, `Compressed` XML binaries)
  streams through fflate's `Gunzip` in 4 KiB input steps against a per-load budget,
  `KdbxFormat.maxDecompressedBytes`, failing with the new `ResourceLimit` error code.
  Each load captures the configured ceiling before awaiting credentials and carries
  its own accounting object through `KdbxContext` to payload and XML-binary decoding.
  Concurrent loads do not share counters, and changing the configured ceiling only
  affects subsequently started loads.
- `KdbxError`s thrown by the supplied `DOMParser` propagate instead of being rewrapped
  as "bad xml", so XML limits stay distinguishable from corruption.

## Bounded decoded loading

All decoded data is admitted against ceilings **before** it is allocated in full:

- **Decompression:** the patched candidate aborts once one load has decompressed
  more than 256 MiB in total, covering inner-header attachments (so aggregate
  attachment size), XML and compressed XML binaries. Each 4 KiB input step can
  expand by at most ~1032:1, so the overshoot is a few MiB. Measured with a 1 GiB
  zero bomb (1 MB compressed) and a 16 MiB ceiling: rejected in 125 ms with a
  45 MiB peak, where unpatched `gunzipSync` allocated 1025 MiB. Uncompressed
  payloads are already bounded by the 100 MiB encrypted-input ceiling.
  Regression tests cover concurrent binary loads and XML imports, mixed successful/
  over-limit loads, recovery after failure, and aggregate payload/XML-binary accounting.
- **XML:** the `DOMParser` supplied to the candidate first runs a linear,
  allocation-free scan (`packages/core/src/xml-limits.ts`) that enforces size,
  element-count and nesting-depth ceilings and rejects any DTD, so entities can
  never expand. History and entry counts are bounded through the element ceiling.
- Limit failures surface as `RESOURCE_LIMIT`, never as truncated or partial data.
  Tests cover exact boundaries, markup-like text in attributes/comments/CDATA,
  gzip bombs in the payload and in XML binary pools, and over-deep group nesting.

Loading costs about 2.2 KiB of worker heap per XML element (the original DOM, the
rebuilt DOM of the unknown-data check and the model), measured by `pnpm calibrate`.
The XML ceilings are sized from that measurement; see
[Defaults and performance](#defaults-and-performance). Exceeding a worker's heap
limit does **not** reliably terminate only the worker: a large allocation can abort
the whole process (observed with Node 22), which in VS Code would be the extension
host. The ceilings therefore keep the worst case well below the heap limit; the heap
limit is a backstop, not the boundary.

## Independent interoperability

`pnpm interop -- --app keepass|keepassxc` (`scripts/interop.mjs`) drives the real
applications with synthetic data only, for all twelve cipher/KDF/compression cases:

1. The candidate creates the fixture; the application adds an entry, which makes it
   rewrite the **whole file** with its own header/XML writer while keeping the
   cipher, KDF and compression.
2. The adapter must open that file **writable**, with every synthetic value intact
   (fields and protection flags, attachments, history, tags, custom data, icons,
   deletion records, recycle bin, public custom data) and the application's entry.
3. The adapter creates and edits entries and saves. The application must decrypt the
   result, report the same cipher/KDF (KeePassXC), return the edited protected value,
   export the exact attachment bytes, and produce an XML export that passes the same
   checks.

KeePassXC additionally imports the fixture's XML into a KeePassXC-native database.

| Application     | Where                                   | Result                |
| --------------- | --------------------------------------- | --------------------- |
| KeePass 2.61.1  | Windows, local and `keepass-interop` CI | 12/12 both directions |
| KeePassXC 2.8.0 | Windows, local                          | 13/13 both directions |
| KeePassXC 2.7.6 | Ubuntu `keepassxc-interop` CI           | 13/13 both directions |

The files the applications wrote are committed under `packages/core/test/fixtures/`
and re-verified by `pnpm test` everywhere, without the applications installed.
Downloads are pinned by SHA-256 (KeePass: the officially published hash).

Findings that shaped the adapter:

- Equivalent spellings are not data changes: booleans (`False`/`false`, `Null`),
  tag separators (`;`, `,`) and empty known elements such as `<DefaultSequence/>`.
  Tags are only split on `;`/`,`; a tag the candidate would re-split (`a:b`) still
  makes the database read-only. Only the text of `Meta/Generator` is the writer's
  own stamp; unknown attributes and child elements still participate in the
  preservation check and force read-only mode if they would be lost.
- KeePassXC drops `LastModificationTime` from group custom data and adds its own
  `_LAST_MODIFIED`/`KPXC_RANDOM_SLUG` items; this is KeePassXC behaviour, not ours.
- KeePassXC XML exports omit attachment contents, and `attachment-export --stdout`
  re-encodes binary data on Windows; the harness exports attachments to files.
- The candidate dropped empty attachments from XML binary pools (as KeePass exports
  them); fixed in the local patch.
- KeePass and KeePassXC write KDBX 4.0 (KeePassXC's CLI even 3.1) unless 4.1 features
  are used. The specification's 4.1-only scope therefore refuses many real databases;
  whether to read/write 4.0 is an open product question, not a gate blocker.

## Gate blockers

| Requirement              | Evidence / remaining work                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KeePass interoperability | **Resolved** for the core: KeePass 2.61.1 and KeePassXC 2.7.6/2.8.0 round trips in both directions; see [Independent interoperability](#independent-interoperability). Editing through the extension UI is verified when the UI exists.                                                                                                                                                                                                                                                           |
| Bounded decoded loading  | **Resolved** by streaming, budgeted decompression in the local patch and an XML pre-scan; see [Bounded decoded loading](#bounded-decoded-loading).                                                                                                                                                                                                                                                                                                                                                |
| Unknown-data policy      | **Resolved** by refusing writes; see [Unknown-data policy](#unknown-data-policy). There is still deliberately no public real-database open/save API.                                                                                                                                                                                                                                                                                                                                              |
| Protected empty values   | **Resolved** by the [local candidate patch](#local-candidate-patch); every matrix case round-trips an empty protected field.                                                                                                                                                                                                                                                                                                                                                                      |
| Argon2 versions          | **Resolved by policy.** KeePass always writes Argon2 1.3 and KeePassXC defaults to it ([source](https://github.com/keepassxreboot/keepassxc/blob/develop/src/crypto/kdf/Argon2Kdf.cpp)); neither UI exposes the version, so 1.0 files come only from third-party tools. Version 1.0 is refused as `UNSUPPORTED` during preflight, before any key derivation, and the provider adapter independently refuses to derive with the wrong version. `hash-wasm` (1.3 only) is accepted as the provider. |
| Resource limits          | **Resolved** as enforceable admission ceilings: encrypted input, header, KDF work, decoded bytes (including aggregate attachments), XML size, elements and depth (bounding history). Values remain experimental; see below.                                                                                                                                                                                                                                                                       |
| Defaults/performance     | **Resolved**; see [Defaults and performance](#defaults-and-performance). New-database Argon2id is calibrated to about one second above a 64 MiB floor, worker heap and XML ceilings are measured together, and real-cost key derivation leaves the VS Code extension host responsive (≤ 15 ms lag).                                                                                                                                                                                               |
| Platform/packaging       | **Resolved**; see [VS Code host and VSIX packaging](#vs-code-host-and-vsix-packaging). The packaged VSIX passes in the extension host of VS Code 1.101.0 (the declared minimum) and stable, on Windows, macOS and Linux.                                                                                                                                                                                                                                                                          |

Passing characterization tests means a limitation is reproducible, **not** that a
blocker has been waived. `pnpm compatibility -- --require-gate` fails whenever a
probe case fails. No automatic CI or release task publishes anything.

## Defaults and performance

`pnpm calibrate` measures on the current machine; `packages/core/src/defaults.ts`
holds the resulting policy.

**Reference machine:** AMD Ryzen 5 7530U (6 cores/12 threads), 14 GiB RAM,
Windows 11, Node 22.19.0. The specification's targets are judged on this machine.

**New-database key derivation** (`NEW_DATABASE_KDF`, `calibrateArgon2id`). Applies
only when creating a database; existing databases keep their stored settings and
are never weakened. Calibration runs on the user's machine at creation time, like
KeePass's one-second delay:

- Argon2id, parallelism 2, memory floor 64 MiB (the KeePass and KeePassXC default).
- Iterations are rounded **up** to reach about 1 second; if more than 10 would be
  needed, memory doubles (up to 256 MiB) instead. Slow machines get the floor
  settings and a longer unlock, never weaker ones.
- Every result stays inside the admission limits, so the database always reopens.
- Reference machine result, three runs: **128 MiB, 7 iterations, parallelism 2,
  952–969 ms**.

**Worker heap and XML ceilings** (`WORKER_RESOURCE_LIMITS`, `INPUT_LIMITS`).
Synthetic KeePass-shaped databases (fields, protected password, tags, two history
states per entry) at each ceiling were loaded through the real adapter path, each
in its own process, bisecting the smallest worker heap that succeeds:

| Scenario        | Elements | XML chars | Entries | Smallest heap | Load time |
| --------------- | -------- | --------- | ------- | ------------- | --------- |
| Element ceiling | 494,966  | 13.9 Mi   | 4,949   | 1,117 MiB     | 6.0 s     |
| Size ceiling    | 220,266  | 31.7 Mi   | 2,202   | 535 MiB       | 4.2 s     |
| Both ceilings   | 494,966  | 31.9 Mi   | 4,949   | 1,117 MiB     | 7.5 s     |

The worker heap is 2,048 MiB, so the worst case uses 55%; `pnpm calibrate` fails if
any scenario needs more than 75%. The earlier 1,000,000-element/64 Mi ceilings
needed more than 2 GiB and were lowered. Ceiling-sized loads finish well inside the
30-second worker deadline.

**Responsiveness.** All key derivation, parsing and serialization run in a worker.
The VS Code self-test waits for startup to settle, measures the extension host's
idle event-loop delay as a baseline, then measures it per case. With the reference
Argon2id cost (seven derivations, 6–10 s), the host stayed at its idle baseline:
2–14 ms on Windows, Linux and macOS stable, and 76 ms on macOS with VS Code 1.101.0,
whose idle baseline was 77 ms, so that delay is VS Code's own. The specification's
busy-feedback target is 250 ms, and the smoke test fails above it. A first CI run
without the settle period showed up to 210 ms on macOS, caused by VS Code startup
work overlapping the first cases. Cancellation and deadlines terminate the worker
before resolving (tested).

## VS Code host and VSIX packaging

`packages/extension` is a minimal, non-product extension with one command,
**KeePass: Run Compatibility Self-Test (synthetic data)**, which runs the full
probe matrix plus a reference-cost case in the extension host. esbuild bundles it
as CommonJS: `extension.js` and `probe-worker.js`, with the patched candidate,
xmldom, fflate and hash-wasm's embedded WASM inlined; the VSIX contains only those
files and the manifest, with no native addons and no runtime dependencies.

`pnpm smoke` packages the VSIX, downloads VS Code, installs the VSIX into an
isolated extensions directory, runs the self-test through a separate harness
extension, verifies the extension was loaded from the installed VSIX, and requires
all 13 cases to pass with at most 250 ms of extension-host lag while they run.

Results from CI's `vscode-smoke` job
([run 11](https://github.com/erlihs/vscode-kdbx/actions/runs/40202491157)); all
13 cases passed everywhere. Lag is shown as idle baseline / maximum while the
self-test workers ran:

| VS Code (Electron, Node)         | Windows x64 | Linux x64 (Xvfb) | macOS arm64 |
| -------------------------------- | ----------- | ---------------- | ----------- |
| 1.101.0 (35.5.1, 22.15.1)        | 2 / 2 ms    | 1 / 2 ms         | 77 / 77 ms  |
| 1.143.1 stable (43.7.7, 24.21.0) | 22 / 2 ms   | 2 / 11 ms        | 27 / 14 ms  |

**Minimum VS Code version: 1.101.0**, the first release whose bundled Node (22)
matches the core's Node 22 requirement.

## Experimental limits

These are upper admission ceilings, **not security-strength defaults**. They are
measured against the worker heap (see above) and may be revisited with real-world
database statistics:

| Item                      | Current ceiling                                       |
| ------------------------- | ----------------------------------------------------- |
| Encrypted input           | 100 MiB                                               |
| Outer header              | 64 KiB                                                |
| Argon2 memory             | 256 MiB                                               |
| Argon2 passes             | 10                                                    |
| Argon2 parallelism        | 4                                                     |
| AES-KDF rounds            | 10,000,000                                            |
| Decoded bytes per load    | 256 MiB (payload, attachments and XML binaries)       |
| Decrypted XML             | 32 Mi characters                                      |
| XML elements              | 500,000 (about 5,000 entries with history)            |
| XML nesting depth         | 256                                                   |
| Worker heap               | 2,048 MiB old generation, 64 MiB young, 4 MiB stack   |
| Synthetic worker deadline | 30 seconds, explicitly configurable up to 120 seconds |

Argon2 memory must be an integer number of KiB and at least 8 KiB per lane.
Fixture-only parameters are **1 MiB, 2 passes, 1 lane** for Argon2 and **1,000
rounds** for AES-KDF. They are deliberately weak to keep regression tests fast
and are never creation defaults; new databases use `calibrateArgon2id`.

The spec's proposed 10 MiB per-attachment ceiling applies to importing attachments
and is not implemented; no attachment import or export API is exposed. Existing
attachments are bounded in aggregate by the decoded-bytes ceiling. The public
header inspector neither authenticates
the database nor validates decrypted data. It must not be treated as an unlock
authorization or whole-file validator.

## Persistence and recovery constraints for subsequent implementation

No save, safe-replacement or recovery-to-disk path exists yet. The following
specification constraints remain mandatory:

- Serialize mutation and persistence per canonical local path. Encrypt completely,
  flush/close a restrictive adjacent temporary file, preserve destination
  permissions and recheck the source fingerprint just before tested replacement.
- Fingerprint checks are not cross-process transactions. A check-to-replacement
  race remains; never advise editing the same file in multiple applications or
  windows concurrently.
- Dirty lock must persist encrypted recovery before releasing plaintext. Recovery
  failure keeps the dirty session and requires Save, Retry or explicit Discard.
- Recovery after credential changes must clearly identify which password unlocks
  a backup, without persisting that password. The exact recovery UX and retention
  policy are not finalized.
- Decrypted undo state must not reach backup files. Whether to encrypt undo state
  in an independent recovery envelope or explicitly end undo at a recovery
  boundary needs a tested design before the custom-document implementation.
- No secrets, titles, paths, raw library exceptions or decrypted snapshots belong
  in logs, persisted webview state or extension state.

## References

- [Product specification](../spec.md)
- [Official KDBX format](https://keepass.info/help/kb/kdbx.html)
- [Original candidate](https://github.com/keeweb/kdbxweb)
- [Maintained fork and change log](https://github.com/keenext/kdbxweb/blob/master/FORK.md)
- [hash-wasm](https://github.com/Daninet/hash-wasm)
- [xmldom](https://github.com/xmldom/xmldom)
