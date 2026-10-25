# KeePass Database Manager for VS Code

Implementation of [the product specification](spec.md) has completed its
**Phase 1 compatibility gate**. This is still an experimental, synthetic-data-only
research harness, **not an installable password manager**: the only extension is
a packaging smoke test. Do not use it with real credentials or databases.

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
  install the VSIX and run its self-test in the extension host.

CI runs on Windows, macOS and Linux with Node 22 and 24. Separate jobs run the
round trip against KeePass 2.61.1 (Windows) and the distribution's KeePassXC
(Ubuntu), and the VSIX smoke test on all three systems with VS Code 1.101.0 and
stable. Line endings are pinned to LF by `.gitattributes`.
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
  candidate (`patches/`). Only the writer-name text of `Meta/Generator` is exempt
  from that check; unknown attributes or children there still force read-only.
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
- A minimal smoke-test extension (`packages/extension`) bundled into a VSIX whose
  self-test runs the probe inside the VS Code extension host. Minimum VS Code
  version: 1.101.0.

## Gate status: passed

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

The VS Code editor, user-facing database operations, persistence/recovery and
Marketplace publishing have **not** been implemented; they are the next phase.
The persistence and recovery constraints in the assessment remain design
requirements for that work. This harness does not export an open/save API for
real databases.

## Privacy and safety

Runtime probes use only generated synthetic data, stay in memory, make no
network requests and do not write databases or plaintext snapshots to disk.
`pnpm interop` and `pnpm calibrate` are the exceptions: they write synthetic
databases to a temporary directory and delete them afterwards. `pnpm smoke`
downloads VS Code into `packages/extension/.vscode-test/`.
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
