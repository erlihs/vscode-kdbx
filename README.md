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

CI runs on Windows, macOS and Linux with Node 22 and 24 and has passed on all six.
Line endings are pinned to LF by `.gitattributes`.
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

## Gate status: blocked

Tests characterize rather than conceal candidate limitations: empty protected
fields lose their protection flag and decoded loading is not bounded.
Independent KeePass-generated fixtures and cross-application verification are
still required. Databases with data the candidate cannot save (unknown XML or
header fields) open read-only, and Argon2 1.0 files (never written by KeePass or
KeePassXC) are refused. See [the compatibility assessment](docs/compatibility.md).

The VS Code editor, user-facing database operations, persistence/recovery and
Marketplace packaging have **not** been implemented. The specification forbids
building product features on an unverified writable adapter; this harness does
not export an open/save API for real databases.

## Privacy and safety

Runtime probes use only generated synthetic data, stay in memory, make no
network requests and do not write databases or plaintext snapshots to disk.
Package installation and dependency auditing do use the package registry.
Worker cancellation waits for termination; Node's worker heap limits **do not**
bound WASM or ArrayBuffer memory and are not a complete hostile-input boundary.
Header inspection verifies only a public checksum, not authenticity or the
encrypted payload. A passing probe is not a security review or release approval.

The eventual extension cannot protect against malicious extensions, a
compromised host, process inspection, keyloggers or clipboard history.

## License

[MIT](LICENSE). Candidate dependency versions and license considerations are
documented in [the compatibility assessment](docs/compatibility.md).
