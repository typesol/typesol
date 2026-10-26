# Troubleshooting

**"Solana SBF SDK not found"** — install the Agave CLI (https://docs.anza.xyz/cli/install) and run
`cargo-build-sbf --version` once. TypeSol looks in `~/.local/share/solana/install/active_release/bin/platform-tools-sdk/sbf`
and next to `cargo-build-sbf` on PATH; set `TYPESOL_SBF_SDK` to a `platform-tools-sdk/sbf` directory otherwise.

**"platform-tools missing" / "no SBPF v2 libraries"** — `cargo-build-sbf --force-tools-install`.

**Windows** — not tested; use WSL2 with the Linux Agave CLI.

**Node errors such as `ERR_UNKNOWN_FILE_EXTENSION` or `ERR_REQUIRE_ESM`** — use Node.js 22.12 or newer.

**"`solana` was not found on PATH"** (deploy) — install the Agave CLI, or use `typesol deploy --dry-run` and run the
printed commands yourself.

**"… is missing, but typesol.json records …"** — the program keypair under `target/deploy/` was deleted or replaced.
Restore it from your backup. Without it you cannot upgrade the deployed program; removing `"address"` from
`typesol.json` gives the program a new address.

**A transaction fails with a custom error** — see [errors.md](errors.md). Failures raised by the
compiler's checks log their TypeScript location, e.g. `TypeSol: arithmetic overflow (vault.ts:42)`.

**Heap errors (5110) building strings** — strings are allocated on a 32 KiB heap and never freed. Build less text,
or declare `const HEAP_SIZE_KIB = 64n` and add a ComputeBudget `requestHeapFrame` instruction to the transaction.

**`typesol idl publish` fails on a local validator with "invalid instruction data"** — older validators reject a
System instruction the current Program Metadata program uses; it works on clusters with current Agave versions.
