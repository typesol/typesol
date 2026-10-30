# Changelog

TypeSOL follows the organization's [versioning policy](https://github.com/typesol/.github/blob/main/VERSIONING.md)
(compiler specifics in CONTRIBUTING.md): until 1.0, a minor version may change the language, the IDL layout or error
codes, and says so here.

## Unreleased

Raydium CP-Swap's pool creation, and what creating accounts by hand needs.

- New: `systemProgram.allocate(account, space, seeds?)` / `assign(account, owner, seeds?)`, `programId()`,
  `findProgramAddressBump(seeds, program)`, `initAccount<T>(account)` (Anchor's `load_init` on an account the body
  created: 3007 / 3006 / 3003 / 3000), `Pubkey.compare(other)` (Rust's byte order), and `ata.create(payer,
  tokenProgram)` / `createIfNeeded(payer, tokenProgram)` to pick among several token programs.
- Changed: an `Init` create on an address already in use now fails as Anchor's `init` does, with the System Program's
  AccountAlreadyInUse (custom 0) instead of TypeSOL's 3000; a payer that is the account being created fails with 4101
  (TryingToInitPayerAsProgramAccount). Programs creating accounts use 9–13 fewer compute units; binaries move by ±1%.
- Faster: u128 multiplication, division and remainder take the native 64-bit instructions when the values fit in 64
  bits (most amounts and rates) instead of the 128-bit library routines: Raydium CP-Swap's swap drops from 7,478 to
  6,062 compute units; results are unchanged (the arithmetic fuzzer now samples such values a third of the time).
- Changed: examples/raydium-cp-swap ports `initialize` too (10 of 24 instructions; 70 transactions against mainnet).

## 0.31.0 — 2026-10-30

A second real program checked against its mainnet binary: Raydium CP-Swap's trading core, and the Token-2022 reads an
AMM needs. Programs that do not use the new reads compile to the same binaries as in 0.30.0.

- New: Token-2022 fee and extension reads: `transferFeeInverse(mint, amountReceived)` (spl-token-2022's
  `calculate_inverse_epoch_fee`: what to send so the recipient gets that much), `transferFeeBasisPoints(mint)` and
  `transferFeeMaximum(mint)` (this epoch's), and `extensionsWithin(account, [types…])` (accept only mints whose
  extensions you handle).
- New: examples/raydium-cp-swap, Raydium CP-Swap's trading core (swaps both ways, deposit, withdraw, fee collection,
  config and status admin; 9 of its 24 instructions), checked against the program deployed on mainnet on 59
  transactions (creator fees, the price oracle's wrap and Token-2022 transfer fees included): same outcomes, account
  bytes and events, 51–79% fewer compute units. docs/case-study-raydium-cp-swap.md.

## 0.30.0 — 2026-10-30

Editor errors that follow you through a program, faster. The compiler's output is the same as 0.29.0 for every
program.

- Changed: `typesol/ts-plugin` shows the compiler's refusals in every file of a program (a helper or state file the
  entry imports, not only the entry), for the unsaved text of every open file, underlining the whole construct.
- Changed: the plugin runs the compiler inside the editor's TypeScript server once it has loaded (a check takes
  milliseconds instead of starting a process), and `typesol init` writes `.vscode/settings.json` so VS Code offers the
  workspace's TypeScript, which loads the plugin.
- New: `typesol check --files` reads `{ "files": { "<path>": "<text>" } }` from stdin (unsaved buffers of any file);
  `--json` diagnostics carry a `length`. The compiler's `generate(entry, { files })` takes the same overrides.

## 0.29.0 — 2026-10-30

The remaining Anchor gaps: declarative constraints in Anchor's order, Anchor's unbounded `Vec` in Borsh accounts, and
more than 32 accounts per instruction. Programs that use none of them compile to the same binaries as in 0.28.0.

- New: `export const MAX_ACCOUNTS = 128n` (33–255) lets a program's instructions take more than 32 accounts, as Anchor
  programs can. Above 32 the CPI scratch lists live on the heap, grown as needed.

- New: `constraint(account, condition, error?)`, Anchor's `constraint = condition @ error`: statements at the start of
  an instruction that run with that account's checks (after its `has_one`), so a transaction breaking several checks
  gets Anchor's code. The default error is ConstraintRaw (2003).
- New: `Vec<T>` in a `@layout borsh` struct is Anchor's Vec: any field position, held on the heap while the instruction
  runs (growing as Rust's does), bounded only by the account when it is written back (3004). Such a struct can be an
  account or a whole argument (not return data or an event); `Init` of one takes its space. `typesol port` now writes
  `Vec<T>` for Anchor's Vec fields instead of a `FixedVec` to size by hand.
- Changed: `push(value, payer)`'s payer is optional in the types (the compiler still requires it for a Vec that grows
  the account), so a `Vec` assigns to a `FixedVec` without the earlier type workaround.
- Changed: examples/multisig.ts uses both; it now matches the mainnet program on 52 transactions, including one that
  breaks two checks at once and an account holding 40 owners.
- Internal: `cpi.ts` split into `cpi-core`, `create`, `token`, `metaplex` and `cpi`; aliasing rules in `alias.ts`;
  `scripts/codegen-snapshot.ts`; the IR decision in docs/architecture.md.

## 0.28.0 — 2026-10-29

A port of coral-xyz/multisig, checked against the program deployed on mainnet, and the features it needed. The
benchmark programs compile to the same numbers as in 0.27.0.

- New: `invokeInstruction(programId, metas, data, infos, signerSeeds?)`, a CPI decided at run time (Rust's
  `invoke_signed` of an `Instruction` built from data): metas are structs with `pubkey`, `isSigner`, `isWritable`, the
  data a list of u8, and every account in `infos` (the remaining accounts or a slice) goes to the runtime.
- New: `Signed<A>`, Anchor's `signer` constraint on an account that is not a `Signer` (2002); the IDL marks it a signer.
- New: `Zeroed<T>` of a `@layout borsh` struct (Anchor's `#[account(zero)]` on a Borsh account): it starts empty and is
  written as Borsh when the instruction returns.
- New: a Seeds bump stored in another struct account, `Seeds<A, ["@multisig"], "@multisig.nonce">` (Anchor's
  `bump = multisig.nonce`).
- New: `list = vecArgument` copies a `Vec` argument (or another list of the same elements) into a `FixedVec` (5104 when
  it does not fit).
- Changed: a `Zeroed<T>` account whose discriminator is already set fails with 2013 (ConstraintZero), checked before its
  owner, as under Anchor; it was 3000 after the owner check.
- Changed: `key`, `lamports`, `dataLen`, `isSigner`, `isWritable` and `pdaBump` are refused as field names only in
  structs held in an account (where they would shadow `acct.key` and the others), no longer in every struct.
- Docs: `docs/case-study-multisig.md`; the mainnet binary is in `test/programs/coral_multisig.so`.

## 0.27.0 — 2026-10-29

Anchor 1.0 parity: instruction introspection, `Dup<…>` and account migration. Existing programs compile to the same
binaries as in 0.26.0.

- New: instruction introspection. `InstructionsSysvar` has `length`, `currentIndex()` and `get(i)`, a
  `TransactionInstruction` with `programId`, its accounts (key, signer, writable), its data
  (`readU8/U16/U32/U64/readPubkey`) and `is(program, "name")` (an instruction by its Anchor discriminator); every read
  is bounds-checked (5104). `stackHeight()` is 1 at the top level, more under a CPI.
- New: `Dup<…>`, Anchor's `dup`: a writable parameter that may be the same account as another, for accounts read and
  written in place (not created, closed, a close destination or `@layout borsh`, which are refused at compile time).
- New: `Migrate<From, To>`, Anchor 1.0's `Migration`: an existing account rewritten from one struct to another with
  `acct.migrate(payer, value)`, the old data readable through `acct.from` until then (the new value is built before
  the bytes are rewritten), the new through `acct.to` after; resized with the payer topping up rent. For now:
  fixed-layout structs without growable Vecs, no constraints on the account, and it cannot be passed to a helper.
- New: `/** @discriminator … */` on an account struct (a sha256 preimage such as `account:Counter`, or 0x and 8
  bytes), Anchor's `#[account(discriminator = …)]`: keeps an old type's on-chain discriminator under a new name.

## 0.26.0 — 2026-10-29

A first-run experience pass, the security model and audit package, and more fuzzing. The compiler's output is the
same as 0.25.0 for every program.

- New: `typesol doctor` checks Node.js, the platform-tools, the Solana CLI, its keypair, the RPC and the keypair's
  balance there, and the project, and prints the command that fixes each problem (exit 1 when building is impossible).
- `typesol init` prints the files it creates relative to where it runs, warns with the install commands when the
  platform-tools are missing, and lists the next steps.
- `typesol deploy` checks, before sending anything, that the RPC answers (else: start `solana-test-validator`, or
  `--url devnet`) and that the payer can pay the rent (else: how much, and the `solana airdrop` command on devnet or a
  local validator). RPC URLs in these messages show only the host.
- Docs: [security model](docs/security-model.md) (the guarantees a compiled program can rely on, trust boundaries,
  what is left to the author) and [audit package](docs/audit.md) (scope, priorities, earlier reviews, evidence);
  README: deploying on devnet and on a local validator.
- Tests: `test/verification/fuzz-layout.test.ts`, model-based fuzzing of an account with two growable Vecs and of
  `loadAccountMut` aliasing through remaining accounts (also in `pnpm fuzz`).
- Repository: tests grouped by subject under `test/`, the Anchor twins in `test/anchor-twins` (`pnpm build:twins`),
  the generators and chain tooling in `src/tools/` (the package's import paths are unchanged); Dependabot for npm and
  GitHub Actions.

## 0.25.0 — 2026-10-29

Security review (October 2026) fixes, and error codes aligned with Anchor. Some refused transactions now report a
different error code (below): a minor version.

- Fixed: `loadAccountMut` on the same remaining account twice (`rest.get(i)`, `rest.get(j)` with `i == j`) gave two
  writable views of one account; a program reading both before writing both could be made to create value. The second
  load is now refused with 2040.
- Fixed: a Vec element written with a right side that resizes the Vec (`book.bids.get(i).qty += settle(book)` where the
  helper pops, a closure, or a `push` / `pop` / `clear` in the expression) wrote through the element's old position,
  into the bytes of the next Vec. Such an assignment is now a compile error ("store its result in a local first"),
  as it already was for a plain `=` with a helper.
- Fixed: `Ata<Init<…>>` / `Ata<InitIfNeeded<…>>` creation and `Ata<AccountInfo, …>` with two token program parameters
  used the first one; they now need exactly one (use `TokenInterface`).
- New: `TokenOf<…, …, …, "tokenProgram">` / `MintOf<…, …, …, "tokenProgram">`, Anchor's `token::token_program` /
  `mint::token_program` (2021 / 2022). The escrow port uses it.
- New: `pythPrice(update, feedId, maxAge, exponent)` refuses a feed whose exponent is not the one given;
  `switchboardValue(…, minSamples)` refuses a result resting on fewer oracle samples.
- Changed: each account's constraints are checked in Anchor's order (seeds, associated token account, has_one, owner,
  executable, address, token::, mint::), so a transaction breaking several fails with Anchor's code: e.g. a stranger's
  call on a `Seeds<HasOne<…>>` account now fails with 2006 (ConstraintSeeds) instead of 2001, and an `Ata<…>` of
  another wallet with 2015 instead of 2009. A `Mut<…>` account passed read-only fails with 2000 (ConstraintMut), as
  Anchor's `#[account(mut)]`, instead of 3006. docs/errors.md lists the order and the differences left.
- Docs: unchecked raw Pyth fields, `requirePda` with a bump from the arguments, Merkle leaves, and what
  `createIfNeeded` leaves unchecked on an existing account.
- Docs: [Case study: porting Anchor's escrow](docs/case-study-escrow.md), one Anchor program ported end to end, with the
  differences, the checks run against the original and the cost.
- Releases: the release workflow checks that CHANGELOG.md has the version, and after publishing installs the package
  from npm, scaffolds a project from each template and runs its typecheck, build and test.

## 0.24.1 — 2026-10-28

Smaller programs and fewer compute units, with the same results; no change to the language, IDLs or error codes. Also
new contributor docs (repository layout, a guide to the C runtime). Not externally audited (see SECURITY.md).

### Performance
- Smaller programs, same results: the rent calculation no longer links soft-float (an exact integer equivalent,
  checked against IEEE doubles), and every failure logs through one shared call. The benchmarked programs are 11.6%
  smaller in total (counter 13.1 → 11.0 KB, escrow 23.9 → 21.3 KB). A failing instruction costs 2 more compute units;
  successful ones are unchanged.
- An identical signer-seed list in the same scope reuses the array declared for the first CPI (escrow `take_offer`
  7058 → 7044, `refund_offer` 4287 → 4271).

## 0.24.0 — 2026-10-28

Functions as values, closures for any helper, stored `map` to structs and text, Metaplex Core external plugins, and
the fixes and identical-result compute-unit savings from a full code review: expanded helpers see only their own
scope, generated clients read only their program's events, and IDLs from the chain are read with limits. Not externally
audited (see SECURITY.md).

### Added
- Functions as values: `const h = g`, and functions that return functions (`function adder(n: u64): (x: u64) => u64
  { return (x) => x + n; }`), which make a closure where they are called (`const add5 = adder(5n)`, `adder(5n)(x)`).
- Closures given to helpers with type parameters or accounts: the helper is expanded where it is called, its type
  parameters bound from the call and its accounts the caller's.
- A stored `map` to structs or text: `const ps: FixedVec<Pair, 8> = xs.map((o) => ({ qty: o.qty, doubled: o.qty * 2n }))`,
  `const names: FixedVec<FixedString<8>, 4> = xs.map(…)`.
- A struct argument holding a FixedVec, when the struct is only an argument: read as Anchor sends it (the FixedVec a
  Borsh Vec), as a `@layout borsh` struct is.
- Metaplex Core external plugin adapters: `addExternalPlugin`, `removeExternalPlugin`, `writeExternalPluginData` and
  their Collection forms, for AppData, Oracle and LifecycleHook (and the Linked forms), checked against the Core program
  (Core itself answers lifecycle hooks with NotAvailable for now).

### Changed
- Fewer compute units, same results: the PDA bump search builds its seed list once, a growing account reads the rent
  sysvar once, integers become text two digits at a time, a lone `${n}` template is not copied again, and
  `list = fixedVec([])` clears the list in place. For example escrow `make` 3638 → 3605, `take_offer` 7117 → 7058,
  `transfer_tokens` 8467 → 8367 CU.
- `eventsOf` takes the transaction with its account keys (`transaction.message.accountKeys`, as getTransaction returns
  it); without them it reads log events only. `errorCode` / `isError` also read the RPC's JSON error
  (`{ InstructionError: [0, { Custom: 6000 }] }`).
- `svmConnection`: `accountNotifications` yields after each later transaction that names the account (no snapshot of
  it as it is), `logsNotifications` honors `{ mentions }` and includes failed transactions (with `err`), simulation
  errors are in the RPC's JSON shape, and `getTransaction` returns the account keys and each inner instruction's
  program index.
- Compiler messages about accounts with a growable Vec say "has a growable Vec" instead of "ends in a Vec", and the
  field-type list no longer says `Vec<T> (last)`, since a Vec can be any field (0.23.0).

### Fixed
- A helper expanded where it is called (given a closure), and a function a helper made, read a module constant as
  the instruction argument of the same name; they now see only their parameters and the module.
- A struct parameter of a closure or expanded helper could be used after a push, pop or clear moved the Vec it points
  into (a stale pointer); that is refused like any other reference across the move.
- A closure parameter named like an account read the account; it is refused.
- A helper from another file, expanded here or typed from an arrow passed to it, resolved its types with this file's
  imports (an aliased or unimported type failed to compile, or an annotation was dropped); its own file's imports are
  used, and `applyT<u64>((v) => …)` takes the type given at the call.
- A struct with a FixedVec held in a data enum variant was read as Borsh when also an argument; that conflict is refused.
- Generated clients read only this program's events: `parseEvents` follows the invoke stack and reads a `Program data:`
  line only while the program is the innermost one running, and `eventsOf` reads only `emitCpi` inner instructions that
  call the program. Another program can no longer forge them.
- `watchEvents` skips failed transactions.
- `typesol client` refuses malformed generic arguments, array lengths that are not whole numbers and `repr` alignments
  that are not powers of two, and caps generic instantiation (256 types, 16 levels): a ClientIdlError instead of a crash
  or a hang. Sizing deeply nested structs no longer takes exponential time.
- Accounts named like `Object.prototype` properties (`constructor`, `toString`, …) are read as given, not inherited.
- `resolve.<ix>` derives a has_one source that is a PDA (a `config` PDA) before reading it, and names the account to
  pass when a source is missing.
- Notes and errors escape control characters from the IDL.
- Reading an IDL from the chain caps inflation at 16 MiB, checks Anchor's IdlAccount discriminator, and refuses a
  Program Metadata IDL that links to a URL or another account instead of following it.
- `typesol/testing`'s `returned()` decodes string, bytes, f32 and f64 return values, and throws for types it cannot
  decode instead of misreading them.

## 0.23.0 — 2026-10-28

Language limits lifted: `map` and `filter`, any number of growable Vecs per account, closures and arrow functions as
helper arguments, FixedVec arguments and list fields in events. Existing programs compile to the same bytes. Not
externally audited (see SECURITY.md).

### Added
- `map` and `filter` on Vecs, FixedArrays, FixedVecs and Vec arguments. A chain used right away
  (`xs.filter(f).map(g).reduce(h, 0n)`, `.length`, `for … of`, any list method) is one loop that builds no list;
  callbacks after a filter get the index among the elements it let through, as in JS. Stored (`const ys = xs.map(f)`),
  it is a FixedVec on the stack as big as the list it starts from, or as annotated (`const ys: FixedVec<u64, 16> = …`,
  needed for a `Vec`); a list one element too small aborts with 5104.
- Arrow functions written as helper arguments (`applyTwice((x) => x * 3n, v)`), typed from the helper's parameter when
  left unannotated. Given a closure (one that reads the caller's variables), the helper is expanded where it is called,
  so the closure runs where it can.
- Any number of growable `Vec<T>` fields in an account, declared anywhere. They are stored after the fixed-size fields,
  in the order declared (every other field keeps a fixed offset; the IDL lists the stored order), and a push, pop or
  clear moves the Vecs after it. An account with one Vec is laid out as before.
- `FixedVec<T, N>` arguments (a Borsh Vec of at most N elements; more fail with 102), and `FixedVec` and `Vec` fields
  in events.

## 0.22.0 — 2026-10-28

Generated clients fill in the accounts Anchor's client still asked you to pass (signers from a default signer, PDAs
seeded from string, byte and argument fields, PDAs under a program given as an argument, a helper for PDAs seeded from
their own fields), read Anchor zero-copy accounts and generic types, and run in tests over LiteSVM. Programs and their
bytes are unchanged. Not externally audited (see SECURITY.md).

### Added
- Generated clients fill in the accounts Anchor's client still asks for:
  - `resolve.<instruction>(rpc, accounts, args?, { signer })` fills signer accounts that were left out with a default
    signer (the wallet), as Anchor's client uses the provider's wallet.
  - PDAs seeded from another account's string, byte and `FixedString` fields are derived by `resolve`, as scalar fields
    already were.
  - A PDA seeded from its own fields gets a `pdas.<name>({ field values })` helper (its address is needed to read it).
  - A PDA whose program is a `Pubkey` argument is derived by the instruction builder.
- Clients generated from Anchor IDLs read and write zero-copy (`bytemuck`, `AccountLoader`) accounts at their
  `#[repr(C)]` offsets on SBF (padding, `packed` and `align` included), checked byte for byte against an Anchor
  program, and turn generic types into one concrete type per use (`Pair<u64, 2>` → `PairU64N2`).
- PDAs seeded from fields of a struct argument (`seeds = [params.id]`) are derived by the instruction builder.
- `typesol/testing`: `svmConnection(svm)` (and `t.connection`), a kit RPC and subscriptions pair answered by LiteSVM,
  so a generated client sends, fetches, simulates, resolves and watches in tests as it does against a cluster.

## 0.21.0 — 2026-10-28

Clients from a program's address alone, and the last pieces Anchor's client resolves for you: `has_one` accounts,
PDAs seeded from another account's fields, and `emitCpi` events as they happen. Programs and their bytes are
unchanged. Not externally audited (see SECURITY.md).

### Added
- `typesol client --address <program id> --url <rpc>`: a client from the IDL on chain, the canonical Program Metadata
  IDL (`typesol idl publish`, Codama) or else Anchor's IDL account (`anchor idl init`).
- Generated clients: `resolve.<instruction>(rpc, accounts)` fills in `has_one` accounts that do not sign from the
  account that names them, as Anchor's client resolves `relations`, and PDAs seeded from another account's fields
  (`seeds = [b"vault", book.owner]`: the account is read, then the PDA derived).
- `watchEvents(rpcSubscriptions, { abortSignal, rpc })`: with an RPC, `emitCpi` events arrive live too (the transaction
  is fetched when the program invoked itself).

## 0.20.0 — 2026-10-28

The generated TypeScript clients catch up with Anchor's: remaining accounts, listing and watching accounts, sending
and simulating, views, `emitCpi` events and every Anchor error by name. Programs and their bytes are unchanged. Not
externally audited (see SECURITY.md).

### Added
- Generated clients: remaining accounts on every instruction builder; `accounts.<Name>.fetchMultiple`, `fetchAll`
  (getProgramAccounts by discriminator, with `{ offset, bytes }` filters) and `watch` (account subscription);
  `sendInstructions` (send and confirm), `simulate`, and `views.<instruction>` (a return value by simulation, Anchor's
  `.view()`); `parseCpiEvents` / `eventsOf` for `emitCpi` events, and `watchEvents` (log subscription). Every Anchor
  framework error has its name in `errors`, so `isError` knows the codes `AnchorError` and the constraints raise.

## 0.19.0 — 2026-10-28

Anchor's error codes where TypeSOL raised its own: `TokenOf` / `MintOf` constraints that name the parameters as
`token::mint = …` does, every Anchor `ErrorCode` for `require`, and `init_if_needed` mints with extensions checked as
Anchor checks them. Strings and logs cost up to a third fewer compute units. 30 of the 46 official examples are now
full ports. Existing programs keep their layouts and error codes. Not externally audited (see SECURITY.md).

### Added
- `TokenOf<TokenAccount, "mintParam", "authorityParam">` and `MintOf<Mint, "authorityParam", "freezeParam">`: Anchor's
  `token::mint = …` / `mint::authority = …` naming the parameters (2014 / 2015 / 2016 / 2017).
- `AnchorError`: Anchor's own error codes for `require(condition, AnchorError.X)` (`RequireKeysEqViolated`,
  `AccountDidNotDeserialize`, the extension constraints …), as `require!` / `err!` with `ErrorCode` raise them.
- Extensions on `InitIfNeeded<Mint>`: an existing mint is checked as Anchor's `extensions::…` constraints check it
  (2024–2039).
- Bubblegum `mintToCollection` (MintToCollectionV1 on V1 trees, Token Metadata collections).

### Changed
- Strings are built with less work and heap: a template literal is joined in one allocation (it was copied piece by
  piece), text known at compile time (literals, string and Pubkey constants) is folded in, `s += …` and `a + b` grow
  the newest heap string in place, and base58 of a Pubkey is about 20% cheaper. Results are the same; official
  examples that log addresses use 11–36% fewer compute units (set_favorites 10,244 → 6,601, transfer_tokens
  9,760 → 8,467, create_system_account 4,664 → 4,075, go_to_park 435 → 372); binaries of programs that build
  strings grow by up to 2.4 KB.

## 0.18.0 — 2026-10-28

The remaining Anchor differences, closed: Anchor's argument structs (Strings, Vecs, Options and enums in Borsh),
keypair `init` with `space`, `init` of mints with Token-2022 extensions and of token accounts, `Vec<String>`
arguments, `SystemAccount`, string return values, and the Token-2022 and Token Metadata instructions programs call.
Closures, list callbacks and more everyday TypeScript; the rest of Bubblegum and Core. 26 of the 46 official
examples are now full ports. Existing programs keep their layouts and error codes (2018 and 3011 are new, raised only
by the new `Init<Mint>` and `SystemAccount` checks). Not externally audited (see SECURITY.md).

### Added
Anchor accounts and arguments:
- `@layout borsh` structs as whole instruction arguments, return values and events, in Anchor's Borsh bytes (a
  FixedString is a String, a FixedVec a Vec, an Option one byte when empty). Arguments are checked as Borsh
  deserialization does, UTF-8 included (102 otherwise). `return vault` returns a whole struct account.
- `@layout borsh` structs used as arguments, return values or events may hold `string` fields and data enums (with or
  without strings), as Anchor argument structs do; Borsh accounts may hold data enums without strings.
- `acct.create(payer, null)` on `Init<T>`: Anchor's `init` of a keypair account (it must sign; 3010 otherwise), and an
  optional third argument for Anchor's `space = …` on `create` / `createIfNeeded`.
- Mint extensions on `Init<Mint>`: `mint.create(payer, seeds | null, decimals, authority, freeze, { … })` with
  transferFee, closeAuthority, defaultAccountState, nonTransferable, interestBearing, permanentDelegate, transferHook,
  metadataPointer, groupPointer and groupMemberPointer (Anchor's `extensions::…`).
- `Init<Mint>` / `InitIfNeeded<Mint>` with `mint.create(payer, seeds | null, decimals, mintAuthority, freezeAuthority)`
  and `Init<TokenAccount>` / `InitIfNeeded<TokenAccount>` (without `Ata<…>`) with `vault.create(payer, seeds | null,
  mint, authority)`: Anchor's `init` with `mint::` / `token::` constraints, at a PDA of this program or (with `null`) a
  new keypair account that signs, under SPL Token or Token-2022 (token accounts sized with GetAccountDataSize). The
  `createIfNeeded` forms check an existing account like Anchor's `init_if_needed` (2014 / 2015 / 2016 / 2017 and the
  new 2018 ConstraintMintDecimals). The IDL marks keypair-created accounts as signers.
- `SystemAccount` / `Mut<SystemAccount>`: Anchor's `SystemAccount`, refused with 3011 (AccountNotSystemOwned) when
  another program owns it.
- `Vec<string>` instruction arguments (Anchor's `Vec<String>`): `.get(i)`, `.length`, `for … of`, list callbacks,
  helper parameters, storing into `FixedVec<FixedString<N>, M>`, and re-encoding through `invoke`; each string is
  checked as UTF-8 on entry (102).
- Helpers and instructions can return `string` (an instruction's is Borsh String return data).
- `acct.key` of an `Init<…>` account before it is created (the address is known; Anchor seeds use it that way).
- `mint.create(…, tokenProgram)` / `vault.create(…, tokenProgram)`: an explicit token program, for instructions that
  take more than one.

Language:
- Closures: a local function that reads or writes the enclosing function's variables is expanded where it is called,
  with the names it was declared with (a block at the call that declares the same name does not change it), struct
  parameters by reference and `return` leaving the closure. Recursion and storing / returning closures are refused.
- List callbacks on Vec, FixedArray, FixedVec and Vec arguments: `forEach`, `some`, `every`, `find`, `findIndex`,
  `reduce`, `includes`, `indexOf`, expanded into loops with the arrow written at the call.
- Helpers can take function parameters (`f: (x: u64) => u64`): compiled once per named function passed.
- `do … while` loops (`continue` goes to the test).
- `x **= n` (the target must not call a function: it is read and written).
- `switch` on 128-bit integers (the case is picked with comparisons, then switched on as usual, fallthrough included).
- `?.` on optional accounts (`acct?.field`) and on `Option<struct>` fields (`x.home?.field`): an Option, empty when the
  account was left out or the option is empty; use it with `??`.
- `acct!` on optional accounts (fails with 5115 when it was left out), Pubkeys / Hashes in template strings (base58),
  and data-enum arguments whose variants carry fixed-size structs or arrays.
- Type parameters standing for fixed-size structs (`pick<Point>(…)`, or taken from struct arguments), and `cond ? a : b`
  for struct values (places, literals or calls).
- Growable `Vec<T>` `push` / `pop` / `clear` inside helpers that take the account as `Mut<T>` (with its payer and
  SystemProgram, as in instructions).
- `mulDiv` / `mulDivCeil` on u128 through a 256-bit product (all three u128; literals take that type).

CPI:
- Token-2022 extension instructions: `updateDefaultAccountState`, `updateTransferHook`, `enableRequiredMemoTransfers` /
  `disableRequiredMemoTransfers`, `updateInterestRate`, `transferCheckedWithFee`, `harvestWithheldTokensToMint`,
  `withdrawWithheldTokensFromMint`, `setTransferFee`; the Token Metadata interface: `updateMetadataField`,
  `removeMetadataKey`, `updateMetadataAuthority`, `emitMetadata`; `closeAccount` of a mint; `mintTo` /
  `initializeMetadata` on a mint created earlier in the instruction; `isTransferring(tokenAccount)` and
  `transferHookAuthority(mint)`.
- Metaplex Core plugin values: MasterEdition, VerifiedCreators, Autograph, FreezeExecute, PermanentFreezeExecute, and
  royalty rule sets (`ruleSet: { programAllowList | programDenyList }`).
- Bubblegum: `delegateV2`, `freezeV2`, `thawV2`, `setNonTransferableV2`, `updateMetadataV2`, `verifyCreatorV2`,
  `unverifyCreatorV2`, `setCollectionV2`, and the V1 `transfer`, `burn`, `delegate`. Checked on the real programs with
  every leaf recomputed: verify → delegate → freeze (a frozen leaf is refused) → thaw → rename, unverify, moving a leaf
  into a collection, soulbinding a collection's leaf, and a V1 transfer signed by a PDA owner, delegate and burn.

### Fixed
- Bubblegum leaf fields that may be null at run time (`assetDataHash: Hash | null`, `flags`) are sent as Borsh Options;
  a null aborted the instruction before.

## 0.17.0 — 2026-10-28

Anchor's account bytes on request (`@layout borsh`, so a TypeSOL program can take over an Anchor program's accounts
without a migration), lists with a fixed capacity anywhere in account data (`FixedVec`), arrow functions and generic
helpers, Metaplex collection verification, Core plugins and Bubblegum V2, and a faster UTF-8 check. Existing programs
keep their layouts and error codes (3004 is new, raised only by `@layout borsh` accounts). Not externally audited (see
SECURITY.md).

### Added
- `/** @layout borsh */` on an account struct stores it with Anchor's bytes (Borsh String / Vec / Option for
  `FixedString` / `FixedVec` / `Option`), so a TypeSOL program can take over an Anchor program's accounts without a
  migration; its IDL lists Anchor's own types. An instruction unpacks the account into the fixed layout when it starts
  and packs it back when it returns (3003 for bytes that are not a valid value, 3004 when the account is too small).
  Checked byte for byte against an Anchor twin, including switching programs in the middle of a sequence.
  `typesol port` marks Anchor account structs that need it.
- `FixedVec<T, N>`: a list with room for N elements (u32 length + N slots, like `FixedString<N>`) as any account field,
  several per struct and in nested structs, with `get` / `set` / `push` / `pop` / `clear` / `.length` / `for … of`;
  `push` on a full one fails with 5104, `fixedVec([…])` writes a whole one. The IDL describes each as a
  `FixedVec<N>_<T>` struct `{ len, items }`; the generated client reads and writes them as arrays. The
  basics/favorites port uses one.
- Bubblegum V2: `createTreeV2`, `mintV2` (optionally into a Metaplex Core collection), `transferV2` and `burnV2`, which
  take the leaf (root, data and creator hashes, nonce, index) and pass its Merkle proof on from the remaining accounts;
  the Core `BubblegumV2` collection plugin. Checked against Bubblegum, mpl-account-compression, mpl-noop and Core
  (`pnpm fetch:programs` now fetches the mpl-account-compression pair too).
- Metaplex Core plugins: a literal plugin list in `createAsset` / `createCollection` (Royalties, freeze / burn / transfer /
  update delegates and their permanent forms, Attributes, Edition, AddBlocker, ImmutableMetadata, each with an optional
  authority), and `addPlugin`, `updatePlugin`, `removePlugin` with their collection forms, checked against the real Core
  program (a frozen asset cannot move until it is thawed).
- Arrow functions: `const f = (x: u64): u64 => …` (and `const f = function (…) {…}`) at the top level or inside a
  function is a helper. Local ones capture nothing (a closure over the enclosing function's variables is refused with
  the name it reads); functions are called, not passed around.
- Generic helpers: `function max<T extends bigint>(a: T, b: T): T` compiles once per set of types it is called with,
  inferred from the arguments or written out (`max<u128>(x, 1n)`); type parameters stand for integers, booleans,
  Pubkeys or enums.
- `x as T` (and `satisfies`): names a type the value already has, never a conversion; mainly `return (a + b) as T`
  in a generic helper.
- Metaplex collections: `createV3`'s `isCollection: true` (CollectionDetails::V1), `createMasterEditionV3(…, maxSupply | null)`,
  `verifyCollection(…)` (Verify with CollectionV1) and `masterEditionAddress(mint)`. The tokens/nft-operations port now
  uses them instead of hand-encoded `invoke`s, checked against the real Token Metadata program.

### Changed
- IDLs no longer list `FixedString*` / `FixedOption_*` / `FixedVec*` helper types that nothing in them refers to
  (for example an `Option` used only as an instruction argument, which is Borsh there).
- UTF-8 checks of strings run eight ASCII bytes at a time: every official-example instruction with a string argument
  gets cheaper (create_token_mint 40,919 → 39,828 CU, set_favorites 4,282 → 4,195).

## 0.16.0 — 2026-10-28

Everyday TypeScript that Anchor developers reach for (`for … of`, `??`, destructuring, `**`, structs returned from
helpers and instructions, strings in enum variants), tools to move an Anchor program over (`typesol port`, a migration
guide) and to work on it (`typesol/testing`, an editor plugin, `verify` against the cluster), Token-2022 extension
setup and Metaplex creators. No IDL or error-code changes for existing programs. Not externally audited (see
SECURITY.md).

### Added
- Metaplex `createV3(…, isMutable, { creators, collection }, signerSeeds?)`: 1–5 creators (shares checked to add up to 100
  when literal) and an unverified collection mint, checked against the real Token Metadata program.
- Data-enum variants can hold a `string` (`type Cmd = { kind: "Say"; text: string } | …`), as Anchor enums with `String`
  payloads: Borsh in instruction arguments and events, a value in code (a copy when built from account text), refused
  in account data. The IDL describes them as Borsh enums only.
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
- `createV3` evaluates its arguments in source order (a creator share computed by a helper that changes account text
  no longer changes the name or fee read before it).
- A function whose stack frame exceeds SBPF v0's 4 KiB used to build and then corrupt memory at runtime (the toolchain
  only printed a note). The build now fails, naming the instruction or helper and its frame size (v1/v2 frames grow
  dynamically and are not limited).

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
