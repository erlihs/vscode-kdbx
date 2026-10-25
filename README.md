# KeePass Database Manager for VS Code

Implementation of [the product specification](spec.md) has started with its
**Phase 1 compatibility gate**. This is an experimental, synthetic-data-only
research harness, **not an installable password manager**. Do not use it with
real credentials or databases.

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
- `pnpm typecheck`: check source, tests and Vitest configuration.
- `pnpm test`: build and run Vitest.
- `pnpm lint`: run Oxlint.
- `pnpm format` / `pnpm format:check`: write / check formatting with Oxfmt.
- `pnpm compatibility`: run the synthetic cipher/KDF/compression matrix in
  isolated Node workers and print a non-secret summary.
- `pnpm compatibility -- --require-gate`: same probe, but exit unsuccessfully
  while release-gate blockers remain.
- `pnpm interop -- --app keepass|keepassxc`: cross-application round trip with
  KeePass 2.x (`KPScript` on `PATH` or `$KPSCRIPT`) or KeePassXC (`keepassxc-cli`
  on `PATH` or `$KEEPASSXC_CLI`); add `--write-fixtures` to refresh the committed
  fixtures that application wrote.

CI runs on Windows, macOS and Linux with Node 22 and 24 and has passed on all six.
Separate jobs run the round trip against KeePass 2.61.1 (Windows) and the
distribution's KeePassXC (Ubuntu). Line endings are pinned to LF by `.gitattributes`.
Vite is supplied transitively by Vitest; a dedicated webview build will be
introduced with the editor rather than adding an unused frontend now.

## Current implementation

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
  candidate (`patches/`).
- Bounded decoded loading: streaming, budgeted decompression and an XML pre-scan
  (size, elements, depth, no DTDs) before any DOM is built.
- Cross-application round trips with KeePass 2.x and KeePassXC, with the files
  they wrote committed as independent fixtures.

## Gate status: blocked

Every data-loss and library blocker is resolved. Independent round trips with
KeePass 2.61.1 and KeePassXC 2.7/2.8 pass in both directions for every
cipher/KDF/compression case. Databases with data the candidate cannot save
(unknown XML or header fields) open read-only, Argon2 1.0 files (never written by
KeePass or KeePassXC) are refused, and decoded data is admitted against ceilings
before allocation.

The gate stays closed until two remaining items are done: calibrating defaults and
performance (new-database KDF settings, a reference machine, worker heap sizing for
the XML ceilings) and a VS Code-host/VSIX packaging check of the worker and WASM.
See [the compatibility assessment](docs/compatibility.md).

The VS Code editor, user-facing database operations, persistence/recovery and
Marketplace packaging have **not** been implemented. The specification forbids
building product features on an unverified writable adapter; this harness does
not export an open/save API for real databases.

## Privacy and safety

Runtime probes use only generated synthetic data, stay in memory, make no
network requests and do not write databases or plaintext snapshots to disk.
`pnpm interop` is the exception: it writes synthetic databases to a temporary
directory for the external application and deletes them afterwards.
Package installation and dependency auditing do use the package registry.
Worker cancellation waits for termination; Node's worker heap limits **do not**
bound WASM or ArrayBuffer memory, so decoded data is bounded by explicit
admission ceilings instead.
Header inspection verifies only a public checksum, not authenticity or the
encrypted payload. A passing probe is not a security review or release approval.

The eventual extension cannot protect against malicious extensions, a
compromised host, process inspection, keyloggers or clipboard history.

## License

[MIT](LICENSE). Candidate dependency versions and license considerations are
documented in [the compatibility assessment](docs/compatibility.md).
