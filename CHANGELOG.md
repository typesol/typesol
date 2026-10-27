# Changelog

TypeSOL follows [semantic versioning](https://semver.org/) with the 0.x rules described in CONTRIBUTING.md:
until 1.0, a minor version may change the language, the IDL layout or error codes, and says so here.

## Unreleased

## 0.12.1 — 2026-10-27

No change to the compiler, the runtime or the generated code.

### Tooling
- Releases are published to npm through trusted publishing: the release workflow authenticates with GitHub's OIDC
  token, and no npm token is stored in the repository.

## 0.12.0 — 2026-10-27

Associated token accounts created in the instruction, PDA bumps without arguments, and the first npm release, as
`@typesol/cli`. Not externally audited (see SECURITY.md).

### Added
- `Ata<Init<TokenAccount>, "owner", "mint">` / `Ata<InitIfNeeded<TokenAccount>, "owner", "mint">` (Anchor `init` /
  `init_if_needed` with `associated_token::mint` and `associated_token::authority`): `acct.create(payer)` /
  `acct.createIfNeeded(payer)` create the associated token account in the instruction, after which it is a typed
  `TokenAccount` for the token CPIs. `createIfNeeded` skips the ATA program CPI when the account exists (checking its
  address, mint and owner instead) and returns whether it created it. SPL Token and Token-2022.
- `acct.pdaBump` on `Seeds<…>` accounts (Anchor `ctx.bumps`): the stored bump field when the constraint names one,
  otherwise the canonical bump the check found. Programs no longer need a bump argument to sign as a PDA they check.

### Changed
- Published on npm as **`@typesol/cli`** (npm refuses the unscoped name `typesol` as too similar to other packages).
  Programs still import from `"typesol"`: `typesol init` adds the package under that name
  (`"typesol": "npm:@typesol/cli@^…"`), and existing projects can do the same with
  `npm install -D typesol@npm:@typesol/cli`. The command stays `typesol`.

### Tooling
- Ports: escrow, token-2022/basics, token-fundraiser and pda-rent-payer are now PORTED (same interface as upstream);
  transfer-tokens, pda-mint-authority, nft-operations, token-swap, merkle-tree-token-claimer and
  external-delegate-token-master drop their hand-encoded token CPIs or bump arguments (test/ports/README.md).

## 0.11.0 — 2026-10-27

Pinocchio-level code generation, a typed TypeScript client, and the release process the organization uses from now
on. Not externally audited (see SECURITY.md).

### Breaking
- `invoke` takes at most 32 accounts; a longer list is a compile error.
- The project is spelled **TypeSOL** in docs, CLI help and runtime messages (`TypeSOL: arithmetic overflow (file.ts:12)`).
  Tools that match log text on the old spelling need updating. The npm package and command stay `typesol`.
- Generated code changed throughout (see Performance), so programs rebuilt with 0.11 have new binary hashes:
  `typesol verify` compares a deployment with a build by the same version.

### Added
- A typed TypeScript client per program: `typesol build` writes `<name>.client.ts` (on `@solana/kit` only) with
  instruction builders that fill in fixed addresses and PDAs, account decoders and fetchers, PDA helpers, error names,
  event parsing and return-data decoders. The file uses no TypeScript-only syntax, so it also runs under Node's type
  stripping. `typesol client <idl.json>` writes one from an Anchor IDL (0.30+), after validating it: an IDL whose names,
  bytes or codes could not be embedded safely is refused. See docs/client.md.

- Tests: 30 Anchor programs from solana-developers/program-examples rewritten in TypeSOL, with their original flows
  and failure paths, plus probes for the constructs that still block 9 programs (test/ports/README.md).

### Changed
- The CLI banner spells TypeSOL, in TypeScript blue and the Solana gradient on terminals with color (`NO_COLOR`
  turns it off).
- The README shows a benchmark chart and table generated from the benchmark results (`scripts/readme-bench.ts`).

### Performance
Same checks, error codes and account state; fewer compute units and smaller binaries. counter.increment 926 → 110 CU,
vault.withdraw 1,394 → 315, vault.shut 1,190 → 161, vault.deposit 2,436 → 1,314; counter / vault binaries
29.9 / 33.6 KB → 12.8 / 16.1 KB. The benchmarks now include an SPL Token escrow; TypeSOL is below Pinocchio on all
nine benchmarked instructions (see the README numbers).
- Accounts are read in place. Generated code works on `TsAccount`, the loader's serialized account record, so the
  entry point stores one pointer per account instead of filling a `SolAccountInfo` (about 14 CU per account), and
  lengths a CPI changes no longer need refreshing afterwards. CPIs build `SolAccountInfo` records only for the
  accounts they list (`ts_invoke`).
- Duplicate writable accounts (2040) are found by comparing account records, one instruction per pair: the loader
  passes repeats as duplicates of one record.
- PDA signer seeds that read account fields (`["offer", offer.maker, offer.seed, offer.bump]`) point at the account
  data instead of copying it, when no seed contains a call or a write.
- The entry point's account and CPI arrays live inside `TsParams`, so setting it up stores nothing.
- Pubkey, discriminator and other byte comparisons, copies and zeroing work 8 bytes at a time (`ts_key_eq`,
  `ts_mem_eq`, `ts_memcpy`, `ts_memzero`) instead of the SDK's byte loops.
- Instruction dispatch compares an 8-byte discriminator as one u64.
- The rent-exempt minimum uses integer math when the exemption threshold is a whole number (every cluster) and the
  product stays below 2^53, where it is bit-identical to the floating-point formula; other thresholds still take it.
- Checked u64 `+`, `-` and `*` compile to one compare; `*` skips the 128-bit multiply when both factors fit in 32 bits.
- Programs link with `--gc-sections` and `--strip-all` (clang `-ffunction-sections -fdata-sections`): unused
  compiler-builtins code and the symbol tables are dropped. Build manifests' binary hashes change accordingly.

### Security
- Development dependencies: `jayson` 5 and `toml` 5.0.1 (pnpm overrides) for advisories in packages that
  `@anchor-lang/core` pulls into the test toolchain; nothing in the published package changed.

### Tooling
- Releases follow the organization's versioning policy (typesol/.github VERSIONING.md). Tags and GitHub Releases never
  publish: publishing to npm is a separate workflow started by hand, which builds and tests the tag without caches.

## 0.10.0 — 2026-10-23

First release candidate. Not externally audited (see SECURITY.md).

### Breaking
- `verifySecp256k1(hash, …)`: `hash` must be `keccak256(...)` or the new `ethMessageHash(message)` written inline.
- `switchboardValue(feed, expectedFeed, maxStaleSlots, decimals)`: new `expectedFeed` argument.
- Pubkey, struct and data-enum helper arguments are copies (code that relied on seeing later writes through them changes).
- `log(integer)` prints decimal instead of `sol_log_64` hex words.
- IDL `relations` now follow Anchor (on the account a `has_one` names, listing its holders): IDL bytes change.
- `typesol verify` exits 3 on a mismatch (2 is now "usage error"); unknown CLI options are errors.
- `typesol.json` program entries become `{ "path", "address" }` objects on first build (plain paths still accepted).
- Node.js 22.12+ is required.

### Security fixes (internal audit)
- Event, `emitCpi`, `invoke` and Metaplex data buffers check bounds on every write after a variable-size field
  (previously a long string followed by fixed fields could write past the stack buffer).
- `realloc` never moves lamports out of the account: growth is paid by the payer (rent difference), shrinking
  refunds nothing, and it takes only `Mut<Struct>` accounts of this program.
- Optional program accounts are checked before their methods run; `loadForeign` validates bools, enums and text
  (3003); cached account lengths are refreshed after every CPI.
- A discriminator that collides with the `emitCpi` event tag is a compile error.
- Constraints may no longer depend on optional accounts (they could be skipped by leaving the account out).
- `verifySecp256k1` requires the hash to be computed in the program (`keccak256(...)` or `ethMessageHash(...)`).
- Token-2022 extension readers refuse multisig and non-mint accounts; `Ata<>` also checks the owner and mint fields;
  `switchboardValue` takes the expected feed; `rentExempt` overflow aborts.

### Correctness fixes
- `Vec.push`/`set` evaluate their value before the Vec changes; object literals and event fields evaluate in source
  order; builtin and helper arguments are read left to right; seeds are copied as they are evaluated.
- Pubkey, struct and data-enum helper arguments are values; a helper that may replace a struct while a reference
  into it is still used is a compile error.
- IDL `relations` follow Anchor's direction; nested event structs with Options are refused; reserved IDL type names,
  duplicate error names, duplicate data-enum cases, bad seed literals and bare `null` in CPI data are diagnostics.
- String arguments must be valid UTF-8 (102); empty Options in struct arguments must be zeroed.
- C string literals use octal escapes (non-ASCII text followed by hex-digit letters was mis-encoded).
- `log(integer)` prints decimal.
- A local may not shadow an instruction or helper parameter (lookups resolved to the account).
- `a.equals(f())`, `place = f()` (the target is chosen first), `requirePda`, `pythPrice`, `verifyEd25519` and
  `merkleVerify` evaluate left to right; assigning a helper result into a Vec element the helper may change is an error.
- u128/i128 constant seeds are 16 bytes in the IDL (as in the program).
- Struct helper arguments in loops reuse one buffer per call site instead of taking heap on every pass.
- Generated CPI bindings accept enum arguments; helper parameter names reserve `__` and `$`; file names with quotes,
  self-comparisons and 256-variant enums compile.

### Tooling
- Strict per-command options (`typesol <command> --help`), exit code 2 for usage errors, 3 for `verify` mismatches.
- Project builds honour `--sbpf`/`--profile`; program addresses are recorded in `typesol.json` and checked against
  the keypair; a program's `.ts` builds as that program.
- Clearer errors (missing toolchain, `solana` not on PATH, invalid `typesol.json`, missing files).
- Toolchain discovery next to `cargo-build-sbf` on PATH; `.d.ts` for every subpath export; one version number.
- The code generator is split into layered modules under `src/compiler/emit/` (generated C is byte-identical).

### Earlier (0.1 – 0.9, development)
Compiler, runtime and CLI built up to: accounts and Anchor-style constraints, PDAs, CPIs (System, SPL Token,
Token-2022, ATA, Metaplex Token Metadata / Core / Bubblegum, generic `invoke`, typed helpers from IDLs), events
and `emitCpi`, data enums, Options, Vecs, 128-bit integers, oracles (Pyth, Switchboard), signature checks,
optional accounts, realloc, transfer hooks, Anchor-compatible IDLs and error codes, on-chain IDL publishing,
profiling, SBPF v0–v2, reproducible builds.
