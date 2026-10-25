# Compatibility assessment

## Status and reproducibility

Phase 1 is **not passed**. This document records implemented evidence and open
blockers, not a production compatibility promise.

Run `pnpm check`, `pnpm compatibility` and `pnpm audit --prod`.
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
  path-shaped names treated only as labels, history and nonempty protection flags.
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

## Gate blockers

| Requirement              | Evidence / remaining work                                                                                                                                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KeePass interoperability | No KeePass or KeePassXC executable was present locally. No independently generated fixtures have been imported, and no cross-application round trip has been run. Library self-round-trips are not independent interoperability evidence.                                           |
| Bounded decoded loading  | Both inspected JS candidates call synchronous `gunzipSync` without an output ceiling, then build an XML DOM without complexity ceilings. Post-load size checks and worker old-generation limits would not fix this. A bounded library path or another verified adapter is required. |
| Unknown-data policy      | **Resolved** by refusing writes; see [Unknown-data policy](#unknown-data-policy). There is still deliberately no public real-database open/save API.                                                                                                                                |
| Protected empty values   | An empty protected custom string reloads as an unprotected empty string. This is a characterized protection-flag fidelity defect; it is not hidden by the nonempty fixture matrix.                                                                                                  |
| Argon2 versions          | `hash-wasm` implements Argon2 1.3 only. The adapter explicitly rejects 1.0 rather than hashing with the wrong version. Compatibility policy/provider selection remains unresolved for existing 1.0 files.                                                                           |
| Resource limits          | Only encrypted/header/KDF admission ceilings are implemented. Decoded bytes, XML nodes/depth, aggregate attachments and history need enforceable pre-allocation bounds, not silent truncation.                                                                                      |
| Defaults/performance     | Synthetic fixtures use low work factors. New-database memory floor, one-second calibration, reference-machine approval and responsive/cancellable production workflows remain unverified.                                                                                           |
| Platform/packaging       | Node/CI behaviour is verified on Windows/macOS/Linux (see above). Workers use Node ESM and embedded WASM without native addons, but VS Code-host and packaged VSIX checks remain unrun. The extension's minimum VS Code version is not selected.                                    |

Passing characterization tests means the limitation is reproducible, **not**
that a blocker has been waived. `pnpm compatibility -- --require-gate` deliberately
fails while this gate is blocked. No automatic CI or release task publishes
anything.

## Experimental limits

These are upper admission ceilings, **not security-strength defaults**, and can
only be finalized after compatibility/performance testing:

| Item                      | Current ceiling                                       |
| ------------------------- | ----------------------------------------------------- |
| Encrypted input           | 100 MiB                                               |
| Outer header              | 64 KiB                                                |
| Argon2 memory             | 256 MiB                                               |
| Argon2 passes             | 10                                                    |
| Argon2 parallelism        | 4                                                     |
| AES-KDF rounds            | 10,000,000                                            |
| Synthetic worker deadline | 30 seconds, explicitly configurable up to 120 seconds |

Argon2 memory must be an integer number of KiB and at least 8 KiB per lane.
Fixture-only parameters are **1 MiB, 2 passes, 1 lane** for Argon2 and **1,000
rounds** for AES-KDF. They are deliberately weak to keep regression tests fast
and must never become creation defaults.

The spec's proposed 10 MiB attachment ceiling is not implemented; no attachment
import or export API is exposed. The public header inspector neither authenticates
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
