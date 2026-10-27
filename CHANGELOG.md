# Changelog

TypeSOL follows [semantic versioning](https://semver.org/) with the 0.x rules described in CONTRIBUTING.md:
until 1.0, a minor version may change the language, the IDL layout or error codes, and says so here.

## Unreleased

### Added
- `typesol port <idl.json>`: a TypeSOL program skeleton from an Anchor IDL (structs, enums, errors, one function per
  instruction with its accounts and arguments). Discriminators, account names and error codes are kept, so existing
  clients keep working where layouts match; notes list where Anchor's Borsh layout differs. Round-trips every example
  (example → IDL → port → IDL) with the same instructions, accounts, layouts and error codes.
- Token-2022 extension initializers on `Token2022Program` / `TokenInterface` (refused on `TokenProgram`): transfer fee,
  mint close authority, non-transferable, permanent delegate, default account state, metadata / group / group-member
  pointers, transfer hook, interest-bearing, immutable owner. Byte layouts checked against the official
  @solana-program/token-2022 decoder on real mints.
- `typesol/ts-plugin`: a TypeScript language-service plugin that shows the compiler's own errors in the editor, for
  the unsaved text, once TypeScript has none. `typesol init` projects enable it in `programs/tsconfig.json` (the
  editor must use the workspace's TypeScript). `typesol check` gains `--json` and `--stdin`.
- `typesol/testing`: `testProgram(name, import.meta.url)` builds a project program into LiteSVM, with `wallet()`, `pda(…)`,
  `ix(name, args, accounts)` (accounts by name, flags, fixed addresses and PDAs from the IDL, plain argument values),
  `send`, `ok`, `errorCode`, `account` (decoded to bigints and address strings), `returned` and `balance`. The
  `typesol init` templates' tests use it (the counter test went from 70 lines to 20). See docs/test-your-program.md.
- `a ** b` on integers, every multiplication checked (5100 on overflow or a negative exponent, where JS throws). A
  literal exponent unrolls at compile time; otherwise a square-and-multiply loop runs.
- Object destructuring: `const { owner, pos: p } = acct` (`let` for scalars) from a name or a field path, read like
  `acct.owner` (scalars copied, nested structs referenced). Rest elements, defaults and nested patterns are refused.
- Instructions can return a fixed-size struct as return data (a literal, a stored struct or a helper's result), at
  most 1024 bytes. It goes out in its fixed layout, which the IDL describes under `returns`, so Anchor clients and the
  generated TypeScript client decode it.
- Helpers can return a fixed-size struct: `return { x, y }`, a stored struct or another helper's result. The caller
  gets its own copy to bind (`const p: Point = at(1n, 2n)`), store (`acct.home = at(…)`, `arr.set(i, at(…))`) or read
  (`at(…).x`). Structs with a Vec or variable-length strings cannot be returned.
- `a ?? b` on Options of integers, booleans and Pubkeys (b is evaluated only when a is empty; the result is an
  Option when b can be null), and `x!` on an Option (its value; an empty one aborts with 5108).
- `for (const x of list)` over a `Vec` (account field or argument) or a `FixedArray`: each `x` is what `list.get(i)`
  gives (a value, or a reference into account data for structs, with the same aliasing checks), the length is read
  again before every step as in JS, and `break` / `continue` work. Remaining accounts are still iterated by index.
- `typesol verify <program>` without a `.so` reads the deployed program from the cluster (`--address`, or the address
  in `typesol.json`; `--url`, cluster monikers or the Solana CLI config) under loader v2, v3 or v4, prints its upgrade
  authority or that it is immutable and its last deploy slot, and compares the IDL published on chain with the built
  one. A published IDL that differs is a mismatch (exit 3). No `solana program dump` step needed.
- `typesol idl publish --url` accepts the Solana CLI's cluster monikers (`mainnet-beta`, `devnet`, …).

### Fixed
- A function whose stack frame exceeds SBF's 4 KiB used to build and then corrupt memory at runtime (the toolchain
  only printed a note). The build now fails, naming the instruction or helper and its frame size.
- A struct returned by a helper and bound through a ternary (`const o = c ? mk(1n) : mk(2n)`) pointed at storage
  that ended with the branch, so the program read garbage (found in review, never released). The result now lives for
  the whole function.
- A struct reference used across `for … of` steps is checked like in other loops: replacing what it refers to later
  in the body is refused, as JS would keep the old object.
- `a ** b` reads `a` before evaluating `b` (a helper in the exponent that changes `a` no longer changes the result).
- A struct-returning helper that takes an account and a struct, bound without a type, no longer fails to build with
  a duplicate C declaration.
- `typesol verify --address` tells "no IDL published" apart from an IDL that cannot be read (now an error, exit 3).
- `typesol/testing`: Options and FixedStrings in decoded accounts and return data come back as plain values; passing
  an address where an account must sign is reported up front.

### Docs
- docs/migrate-from-anchor.md: Anchor constructs, account data, code and tooling mapped to TypeSOL, with the `typesol port`
  workflow and which account layouts differ.

## 0.15.0 — 2026-10-27

Project templates for `typesol init`, a mainnet deployment guide, and clearer `typesol idl publish` failures. No
language, IDL or error-code changes. Not externally audited (see SECURITY.md).

### Added
- `typesol init --template counter|vault|escrow`: start from a PDA counter (the default, as before), a SOL vault or an
  SPL token escrow. Each template is the matching `examples/` program with a LiteSVM test of its main flow and of a
  refused call; the escrow project also gets `@solana-program/token`.

### Fixed
- `typesol idl publish` names the reason a write failed (the transaction's error and its last log lines) instead of
  "The provided transaction plan failed to execute".

### Docs
- docs/mainnet.md: from `typesol init` to a verified program on mainnet-beta (wallet, cost, deploy, IDL, `verify`,
  freezing and closing).
- README: the official escrow on mainnet-beta in all four versions, with each transaction's compute units linked to
  Solscan; the TypeSOL program's IDL is published on chain.

## 0.14.0 — 2026-10-27

PDAs are derived without the PDA syscalls, so instructions that create, check or search for PDAs use up to a few
thousand fewer compute units. No language, IDL or error-code changes. Not externally audited (see SECURITY.md).

### Performance
- PDAs are derived with the `sol_sha256` and `sol_curve_validate_point` syscalls instead of
  `sol_try_find_program_address` / `sol_create_program_address` (1,500 CU per bump tried): the
  same addresses, bumps and limits (16 seeds to check, 15 to search, 32 bytes each). `init` with seeds, `Seeds<…>`,
  `create`, `signer` and `findProgramAddress` all use it. Benchmarks: counter.initialize 3,030 → 1,872 CU,
  escrow.make 5,974 → 3,638; in the official examples escrow take_offer 14,519 → 7,117 and close_user 1,728 → 586.
  Binaries grow 0.4–1.2 KB. New tests compare it with @solana/kit's derivation over random seeds, canonical bumps
  below 255 and on-curve bumps. Needs the curve25519 syscalls (active on mainnet-beta since epoch 637).

## 0.13.0 — 2026-10-27

Every program in solana-developers/program-examples now ports to TypeSOL: PDA seeds from account fields, remaining
accounts passed on in CPIs, transfer hooks with extra accounts, `findProgramAddress` and marker accounts. Not externally
audited (see SECURITY.md).

### Added
- Transfer hooks with extra accounts: `initExtraAccountMetas(payer, account, mint, systemProgram, extraAccounts)` writes
  an ExtraAccountMetaList (fixed addresses, PDAs of this program or of another program's account index, with literal,
  account-key, account-data and instruction-data seeds), byte for byte what spl-tlv-account-resolution writes; Token-2022
  checks the extra accounts against it on every transfer. `updateExtraAccountMetas(...)` rewrites and resizes a list.
- Remaining accounts in a CPI: spread them into `invoke`'s account list with the flags they were passed with
  (`...remainingAccounts()`, Rust's `extend_from_slice`) or all with one role (`...readonly(rest)`,
  `...writable(rest)`), and take part of them with `rest.slice(a, b)`. A CPI lists at most 32 accounts (5113); a slice
  out of range fails with 5104.
- `findProgramAddress(seeds, program)`: the canonical PDA of another program at runtime.
- PDA seeds from account fields: `Seeds<…, ["@pool.amm", "@mintA", "authority"]>` takes a Pubkey, integer or unit
  enum field of a struct account parameter, including the account's own (`Seeds<Mut<Offer>, ["offer", "@maker",
  "@offer.id"], "bump">`), like Anchor's `seeds = [pool.amm.as_ref(), …]`. Recorded in the IDL as account paths
  (`pool.amm`).
- Structs with no fields, for marker accounts that are only a discriminator (Anchor `#[account] pub struct
  NftAuthority {}`).

### Fixed
- An associated token account created in the instruction (`Ata<Init|InitIfNeeded<TokenAccount>>`) refuses optional
  TokenProgram / AssociatedTokenProgram / SystemProgram parameters at compile time (they used to fail at runtime with an
  access violation when left out), and refuses `Owner<…>` / `Executable<…>` (which could never hold).
- Unit enum values work as seeds in `create`, `signer([...])`, `findProgramAddress` and the other seed lists, one byte
  each, as they already did in `Seeds<…>`.
- `rest.slice(a, b)` is typed as something to spread into a CPI only (`RemainingSlice`), with a clear message elsewhere.

### Tooling
- Ports: the five transfer-hook examples with extra accounts (account-data-as-seed, allow-block-list-token, counter,
  transfer-cost, transfer-switch) are ported; their tests transfer through Token-2022, which checks the extra accounts.
  All 46 program-examples are ported now: 9 PORTED, 37 PARTIAL, 0 BLOCKED. The blocked-construct probes
  (test/ports-blocked.test.ts) are gone with the last blocker.
- Ports: compression/cnft-burn, cnft-vault, cutils and token-2022/transfer-fee, blocked until now, are ported (PARTIAL;
  test/ports/README.md). The compression ports run against Bubblegum, SPL Account Compression and Token Metadata, with
  the leaf hashes, roots and proofs computed in the tests.
- Ports: the eight remaining program-examples that had not been attempted are ported: basics/repository-layout and
  token-2022 cpi-guard, group, immutable-owner, interest-bearing, memo-transfer, metadata and nft-meta-data-pointer
  (all PARTIAL; test/ports/README.md lists the differences). Every one of the 46 programs is now ported or blocked
  by a named construct.
- Ports: token-swap is now PORTED (its `amm`, `pool`, authority and liquidity-mint PDAs are all checked
  declaratively, with no bump arguments); escrow and token-fundraiser check their PDAs declaratively instead of with
  `requirePda` in the body.

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
