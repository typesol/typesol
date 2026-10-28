# The TypeSOL language

The full reference. For a tour, start with the [README](../README.md).

## Types and statements

| Concept | TypeSOL |
| --- | --- |
| Instruction | an exported function returning `void`, one integer / boolean / `Pubkey`, or a fixed-size struct (sent as return data, at most 1024 bytes; `returns` in the IDL, and the generated client decodes it) |
| Account data | an exported `interface` with fixed-size fields; interfaces nest (`home: Point`, `trail: FixedArray<Point, 4>`) |
| Integers | `u8` `u16` `u32` `u64` `u128` `i8` `i16` `i32` `i64` `i128` — bigint literals (`1n`), every `+ - * / % **` checked (`**` aborts on a negative exponent, as JS throws); `& \| ^` on equal types, `~` within the width, `<<` / `>>` checked (amount below the width, `<<` may not lose bits) |
| Integer helpers | `mulDiv(a, b, c)` / `mulDivCeil` (u64 through a 128-bit product), `isqrt(x)` (up to u128), `min(a, b)`, `max(a, b)` |
| Other scalars | `boolean`, `Pubkey` (compare with `===` or `.equals`) |
| Errors | `export enum MyError { Name = "message" }` + `require(cond, MyError.Name)` → codes 6000+ |
| Casts | `u8(x)`, `u64(x)`, … abort if the value does not fit |
| Logging | `log("text")`, `log(value)`, `log(pubkey)` |
| Arrays | `scores: FixedArray<u64, 8>` in account data — `.get(i)`, `.set(i, v)`, `.length`, bounds-checked; elements can be structs or strings |
| Local arrays | `const xs = fixedArray<i64, 5>(0n)` — up to 256 elements on the stack |
| Strings | `string` arguments and literals; `name: FixedString<32>` in account data (u32 length + 32 bytes); `===`, `byteLength(s)`, `log(s)`, `+=`, as PDA seeds; too-long writes abort (5105). A local bound to account text keeps its own copy |
| Copies | `a.home = b.home`, `a.trail.set(0n, a.home)` copy whole structs / arrays of the same type: assignment copies (like Rust/Anchor), binding with `const` references |
| Destructuring | `const { owner, pos: p } = acct` (or `let` for scalars to change) from a name or a field path — one declaration per name, read like `acct.owner`: scalars are copies, nested structs are references. No rest, defaults or nesting |
| Struct values | `const p: Point = { x, y }` (or a copy of another Point) — a local struct; fields can be updated, store it with `acct.home = p` |
| Pubkey constants | `const ADMIN = pubkey("4Nd1…")` (checked at compile time) or inline `pubkey("…")`; usable as seeds |
| Events | `emit<Deposited>({ owner: owner.key, amount })` — Anchor-format `Program data:` logs, listed under `events` in the IDL; event structs may hold `string` and `Option` |
| Enums | `export enum Status { Pending, Approved }` — unit variants stored as the Borsh u8 index; `Status.Approved`, `===` |
| Options | `best: Option<u64>` (or `u64 \| null`) — `null`, `=== null`, TypeScript narrowing; `===` between options or with a value follows JS (null equals null, empty never equals a value); empty use aborts (5108); `a ?? b` takes b only when a is empty (b runs only then; the result is an Option when b can be null), `x!` is the value or aborts with 5108; `${opt}` prints the value or `null`. Borsh `option` in arguments/events, fixed `{ is_some, value }` in account data |
| Vecs | `entries: Vec<Entry>` as the last account field — `get`, `set`, `push(v, payer)`, `pop()`, `clear()`, `.length`; the account is resized (realloc) and rent topped up by `payer`; `Vec<u64>` arguments are read-only views; `pop()` of a Vec of structs works as a statement |
| Anchor's account bytes | `/** @layout borsh */` on an account struct stores it as Anchor does (Borsh: a `FixedString<N>` is a String, a `FixedVec<T, N>` a Vec, an `Option` one byte when empty, and the fields after them move), so a TypeSOL program can take over accounts an Anchor program wrote and the IDL lists Anchor's own types. The instruction unpacks it into the usual fixed layout when it starts (bad bytes fail with 3003) and packs it back when it returns (3004 when the account is too small for the new value), so everything else works on it unchanged. Programs invoked from the body (CPIs) see the account's bytes as they were when the instruction started. Costs more compute than the fixed layout (the whole account is read and written each time; see the benchmarks); nested structs and list elements must be fixed-size (FixedString elements allowed); not for arguments, events, `Zeroed<T>`, `loadAccount` or a growable `Vec<T>` |
| Fixed-capacity lists | `owners: FixedVec<Pubkey, 8>` — any field, any number of them, in nested structs too: a u32 length and room for N elements (always 4 + N × size bytes), the same `get`, `set`, `push(v)`, `pop()`, `clear()`, `.length` and `for … of`; `push` on a full one fails (5104); `acct.owners = fixedVec([a, b])` writes a whole one (unused slots zeroed). Account data and returned structs only: arguments use `Vec<T>` |
| Struct arguments | `order: Order`, `ids: FixedArray<u8, 4>`, `orders: Vec<Order>` — fixed layouts, Borsh-identical, validated on entry (bools, enums, option tags, string lengths, enum tags; 102) and read-only |
| Remaining accounts | `remainingAccounts()` — `.length`, `.get(i)` → `key`, `owner`, `lamports` (writes check writability), `isSigner`, `isWritable`; `loadAccount<T>` / `loadAccountMut<T>` give checked struct views; pass them to `invoke`, one at a time or spread: `...remainingAccounts()` (each with the flags it was passed with), `...readonly(rest)` / `...writable(rest)` (all with that role), `rest.slice(a, b)` for part of them; a CPI lists at most 32 accounts (5113) |
| Struct literals | `book.entries.push({ who: who.key, amount, status: Status.Pending, note }, who)` — every field required |
| Struct references | `const o = side === Side.Bid ? book.bids.get(i) : book.asks.get(i)` — aliases account data like a JS object reference (no copy); replacing the referenced place (`book.bids.set(i, …)`, `pop()`, `clear()`, `acct.p = …`) while the reference is still used afterwards is a compile error, because JS would keep the old object |
| Other programs' accounts | `const pool = loadForeign<Pool>(account, AMM_PROGRAM)` — owner, `account:Pool` discriminator and size checked (3007 / 3002 / 3003); `readData<u64>(account, offset)` for raw little-endian reads (bounds-checked, 3003) |
| Ternaries | `const fee = vip ? 0n : 30n` — only the chosen branch runs |
| Constants | top-level `const SEED = "vault"`, `const FEE: u16 = 30n`, `const ON = true` — inlined, usable as seeds (and described in the IDL) |
| Data enums | `export type Action = { kind: "Deposit"; amount: u64 } \| { kind: "Pause" }` — `a.kind === "Deposit"`, `switch (a.kind)`, TypeScript narrowing picks the variant (checked again at runtime, 5112); Borsh enums in arguments/events, fixed `{ tag, payload }` in account data. A variant may hold a `string` (`{ kind: "Say"; text: string }`): such an enum works in arguments, events and locals (Borsh, as Anchor encodes it) but not in account data |
| Option of structs | `home: Option<Point>` in account data — `=== null`, `p.home.x` after narrowing, `p.home = null` / `{ x, y }` |
| Strings at runtime | `"hello, " + name`, `` `#${n}` `` — built on the 32 KiB heap (5110 when full) |
| `switch` | on integers (up to 64 bits), enums and data-enum `.kind`, with JS `break` / fallthrough; case labels are literals, constants or enum members |
| Hashing & signatures | `sha256(...)`, `keccak256(...)` → `Hash`; `findProgramAddress(seeds, program)` → the canonical PDA of any program (Rust `Pubkey::find_program_address(..).0`, e.g. a Bubblegum asset id); `merkleVerify(leaf, proof: Vec<Hash>, root)` (sorted-pair keccak, OpenZeppelin convention); `verifyEd25519(instructionsSysvar, signer, message)` checks an Ed25519 precompile instruction in the same transaction; `verifySecp256k1(keccak256(...message) | ethMessageHash(message), recoveryId, r, s, ethAddress)` (the hash must be computed in the program; a passed-in hash could be forged) |
| Oracles | `pythPrice(update: PythPriceUpdate, feedId, maxAgeSeconds)` (fully verified, feed-matched, fresh); raw `update.price / conf / exponent / publishTime`; `switchboardValue(feed: SwitchboardFeed, expectedFeed, maxStaleSlots, decimals)` (the feed must be the expected one: anyone can create feeds) (mainnet program unless `SwitchboardFeed<"devnet">`) |
| Multiple files | `import { Side, min } from "./math"` — structs, enums, constants and helpers can live in other files; only the entry file's exported functions are instructions; names are program-wide, so imports from TypeSOL files cannot be renamed; error codes number imported files first |
| Loops | `for (let i = 0n; i < n; i++)`, `while`, `for (const x of list)` over a `Vec` or `FixedArray` (each `x` is what `list.get(i)` gives: a value, or a reference into account data for structs; the length is read again every step, as in JS), `break`, `continue` — bounded by the compute budget. Remaining accounts are iterated by index |
| Helpers | non-exported functions (and every function of an imported file): take values, structs, Vec arguments, `SignerSeeds` and accounts the instruction already checked (`Signer`, `AccountInfo`/`AccountMeta`, `Mut<T>`, token accounts, programs); return `void`, a scalar or a fixed-size struct (`function at(x: u64, y: u64): Point { return { x, y }; }`: the caller gets its own copy, to bind, store with `acct.home = at(…)` / `arr.set(i, at(…))` or read as `at(…).x`); no recursion. Helpers cannot grow Vecs (only instructions know the entry size) |
| Arrow functions | `const fee = (x: u64): u64 => x / 100n` (or `const f = function (…) {…}`) at the top level or inside a function is a helper (parameter and return types written out). A local one capturing nothing: it reads its parameters, top-level names and other functions, not the enclosing function's variables (pass them in). Functions are called, not stored or passed |
| Generic helpers | `function max<T extends bigint>(a: T, b: T): T` — compiled once per set of types it is called with (`max(a, b)` with u64 arguments, or `max<u128>(x, 1n)` when only literals tell); a type parameter stands for an integer, boolean, Pubkey or enum. Each instance is checked like any helper; one that is never called is not compiled (TypeScript still type-checks it). Arithmetic on `T` is a `bigint` to TypeScript: `return (a + b) as T` (`as` names a type the value already has; it never converts) |
| Evaluation order | operands and arguments are read left to right, as in JS, even when a later one changes account data (`v.length + v.pop()`) |
| `++` `--` `+=` `-=` `*=` `/=` `%=` `&=` `\|=` `^=` `<<=` `>>=` | all checked |
| Sysvars | `now()`, `currentSlot()`, `currentEpoch()` (clock), `minimumBalance(account)`, `rentExempt(space)` (rent) |
| Account size | `realloc(account, newSize, payer)` on a `Mut<Struct>` — growing charges the payer the extra rent (at most 10 KiB per instruction, 3016); shrinking keeps the lamports in the account; never below the struct |
| Token-2022 extensions | `transferFee(mint, amount)` (current-epoch TransferFeeConfig, ceil + cap like spl-token-2022), `transferHookProgram(mint)`, `permanentDelegate(mint)`, `mintCloseAuthority(mint)` (Option<Pubkey>), `hasExtension(account, type)` |
| Events through CPI | `emitCpi<Paid>({ … }, eventAuthority, self)` with `eventAuthority: EventAuthority, self: SelfProgram` parameters — Anchor `emit_cpi!`: the event rides in a self-CPI (inner instruction), not in logs; the program accepts Anchor's event instruction (2002 / 2006 otherwise) |
| Heap | 32 KiB by default; `const HEAP_SIZE_KIB = 64n` (32–256) lets the program use more, when clients add ComputeBudget `requestHeapFrame` |
| Docs | JSDoc on instructions, `@param`, structs, fields and data enums becomes `docs` in the IDL |
| Metaplex Core | `core: MplCoreProgram` — `createCollection`, `createAsset` (in a collection, PDA authorities via signerSeeds), `transferAsset`, `burnAsset` (`null` leaves an optional account out); plugins as a literal list after the uri (`[{ kind: "Royalties", basisPoints: 500n, creators: [{ address, percentage: 100n }] }, { kind: "PermanentFreezeDelegate", frozen: false, authority: studio.key }]`), and `addPlugin` / `updatePlugin` / `removePlugin(…, "FreezeDelegate")` with their `…CollectionPlugin` forms. Plugins: Royalties (no rule set), FreezeDelegate, BurnDelegate, TransferDelegate, UpdateDelegate, PermanentFreezeDelegate, Attributes, PermanentTransferDelegate, PermanentBurnDelegate, Edition, AddBlocker, ImmutableMetadata; `authority` is `"owner"`, `"updateAuthority"`, `"none"` or a Pubkey; `coreAssetOwner(asset)`, `coreAssetCollection(asset)` |
| Compressed NFTs | `bubblegum: BubblegumProgram` — V1: `createTree` (client-allocated tree on SPL Account Compression), `mint` (MintV1, no collection/creators). V2 (trees on mpl-account-compression with mpl-noop): `createTreeV2`, `mintV2(…, { name, symbol, uri, sellerFeeBasisPoints, creators?, isMutable? }, { collection, authority, cpiSigner }?)` (into a Core collection that has the `BubblegumV2` plugin), `transferV2` and `burnV2` with the leaf `{ root, dataHash, creatorHash, assetDataHash?, flags?, nonce, index }` and its proof as `remainingAccounts()` / `rest.slice(a)` |

## Account parameters and the checks they emit

| Parameter type | Checked before your code runs |
| --- | --- |
| `Signer` / `Mut<Signer>` | signed (and writable) |
| `Account<T>` / `Mut<T>` | owned by this program, 8-byte discriminator matches, data large enough (and writable) |
| `Init<T>` | writable; `create(payer, seeds)` derives the PDA, verifies it, funds rent, writes the discriminator (up to 10 KiB) |
| `InitIfNeeded<T>` | `const created = acct.createIfNeeded(payer, seeds)` — creates once; afterwards re-derives the PDA and checks owner, discriminator and size (Anchor `init_if_needed`); `acct.pdaBump` after create |
| `HasOne<A, "owner">`, `Seeds<A, ["vault", "@owner"], "bump">`, `CloseTo<A, "owner">` | declarative constraints like Anchor's `has_one`, `seeds`/`bump` and `close`: checked before the body (2001 / 2006), close runs when the instruction succeeds; `"@name"` = account key or argument bytes, `"@acct.field"` = a Pubkey, integer or unit enum field of a struct account parameter (also the account's own: `["offer", "@maker", "@offer.id"]`), other strings are literals; recorded as `relations` / `pda` in the IDL. `acct.pdaBump` is the bump (Anchor `ctx.bumps.acct`): the stored field when one is named, else the canonical bump the check found — use it to sign as the PDA |
| `HasOne<TokenAccount, "mint" \| "owner">`, `HasOne<Mint, "mintAuthority" \| "freezeAuthority">` | token constraints (2014 / 2015 / 2016 / 2017) against the parameter with that name |
| `Ata<TokenAccount, "owner", "mint">` | the account is the associated token account of those parameters (2009; ATA `pda` in the IDL) |
| `Ata<Init<TokenAccount>, "owner", "mint">`, `Ata<InitIfNeeded<TokenAccount>, "owner", "mint">` | Anchor `init` / `init_if_needed` with `associated_token::…`: `acct.create(payer)` creates the ATA (fails if it exists); `const created = acct.createIfNeeded(payer)` creates it only when missing, otherwise checks it is that ATA (2009). Then it is a `TokenAccount` of that mint and owner (2014 / 2015). Needs `AssociatedTokenProgram`, `SystemProgram` and a token program parameter; call it at the top level before using the account |
| `Address<A, "4Nd1…">` | exact address (2012; `address` in the IDL) |
| `Owner<A, "Tokenkeg…">`, `Executable<A>` | owner program (2004), executable (2007) |
| `Seeds<A, ["metadata", "@mint"], never, "@metadataProgram">` | the fourth argument derives the PDA under another program (a program parameter or a base58 address; `pda.program` in the IDL) |
| `A \| null` / `Optional<A>` | optional account (Anchor `Option<Account>`): the client passes this program's id to leave it out; its checks and constraints run only when present; `x !== null` before use (5115 otherwise); `optional` in the IDL |
| `ProgramData` | this program's ProgramData (address derived from the program id, upgradeable-loader owner and state checked); `upgradeAuthority`, `deploySlot` — gate admin setup on `programData.upgradeAuthority === admin.key` |
| `EventAuthority`, `SelfProgram` | Anchor's `["__event_authority"]` PDA, and this program's own address, for `emitCpi` |
| `Zeroed<T>` | large accounts (up to 10 MiB) the client allocated with System `CreateAccount`: owned by this program, big enough, rent-exempt, discriminator still zero — then initialized; like Anchor's zero-copy `zero` |
| `Init<Mint>`, `InitIfNeeded<Mint>` | Anchor `init` / `init_if_needed` with `mint::decimals` / `mint::authority` / `mint::freeze_authority`: `const bump = mint.create(payer, ["mint", payer.key], 6n, authority, freezeAuthority \| null)` creates the mint at that PDA of this program, or with `null` seeds as a new keypair account that signs (3010 if it did not), under the instruction's token program (exactly one token program parameter, plus `SystemProgram`). `createIfNeeded(…)` returns whether it created it; an existing one must be that PDA and have those decimals and authorities (2018 / 2016 / 2017) |
| `Init<TokenAccount>`, `InitIfNeeded<TokenAccount>` (no `Ata<…>`) | Anchor `init` / `init_if_needed` with `token::mint` / `token::authority`: `vault.create(payer, ["vault", mint.key], mint, authority)` (the authority may be `vault.key` itself) creates a token account at that PDA (or a keypair account with `null`), sized for the mint's extensions under Token-2022. `createIfNeeded` checks an existing one has that mint and owner (2014 / 2015) |
| `TokenAccount` / `Mut<TokenAccount>` | owned by SPL Token or Token-2022 (extensions allowed, multisig accounts refused), initialized; `mint`, `owner`, `amount`, `delegate`, `delegatedAmount`, `isFrozen`, `isNative`, `closeAuthority`, `tokenProgram` |
| `Mint` / `Mut<Mint>` | owned by SPL Token or Token-2022, initialized; `decimals`, `supply`, `mintAuthority`, `freezeAuthority`, `tokenProgram` |
| `SystemProgram`, `TokenProgram`, `Token2022Program` | exact program address |
| `TokenInterface` | either token program |
| `AssociatedTokenProgram` | `create` / `createIdempotent` CPIs; `associatedTokenAddress(owner, mint, tokenProgram)` |
| `TokenMetadataProgram` | Metaplex `createV3(...)` (CreateMetadataAccountV3), optionally with `{ creators: [{ address, verified, share }], collection: mint }` after `isMutable` (1–5 creators, shares adding up to 100; only the update authority, signing, can be `verified: true`; the collection is written unverified; `isCollection: true` makes the NFT a sized collection); `createMasterEditionV3(edition, mint, updateAuthority, mintAuthority, payer, metadata, tokenProgram, systemProgram, maxSupply \| null)`; `verifyCollection(authority, metadata, collectionMint, collectionMetadata, collectionMasterEdition, systemProgram, instructionsSysvar)` (Verify with CollectionV1); `metadataAddress(mint)`, `masterEditionAddress(mint)` |
| `InstructionsSysvar`, `PythPriceUpdate`, `SwitchboardFeed` | exact address / owner program + discriminator |
| `Program<"Address…">` | exact program address + executable |
| `UncheckedProgram` | executable only — check `.key` yourself |
| `AccountInfo` / `Mut<AccountInfo>` | nothing (writable for `Mut`); `owner`, `executable` |
| `SystemAccount` / `Mut<SystemAccount>` | owned by the System Program, e.g. a wallet (Anchor `SystemAccount`, 3011) |

Every account exposes `key`, `lamports`, `dataLen`, `isSigner`, `isWritable`. At most 32 accounts per instruction (more is refused, 5113).

Two writable parameters can never be the same account: aliasing is refused with error 2040 (also when a remaining
account written through `.lamports` or `loadAccountMut` is another account of the instruction).

## Built-ins

- `systemProgram.transfer(from: Mut<Signer>, to, lamports)`, `systemProgram.createAccount(payer, account, lamports, space, owner, signerSeeds?)`
  (the new account signs: a keypair `Mut<Signer>` or this program's PDA), `rentExempt(space)`, `MINT_SIZE`, `TOKEN_ACCOUNT_SIZE`
- Token programs (`TokenProgram`, `Token2022Program`, `TokenInterface`) — pass `signerSeeds` (with the bump) when the authority is a PDA:
  `transfer`, `transferChecked(from, mint, to, authority, amount)` (required by Token-2022 mints with fees/hooks), `mintTo`, `burn`, `closeAccount`,
  `approve(source, delegate, owner, amount)`, `revoke`, `setAuthority(target, current, AuthorityType.MintTokens, next | null)`,
  `freezeAccount` / `thawAccount(account, mint, freezeAuthority)`, `syncNative(account)`, `initializeMint2(mint, decimals, mintAuthority, freezeAuthority | null)`,
  `initializeAccount3(account, mint, owner)`, and on Token-2022 `initializeMetadata(mint, updateAuthority, mintAuthority, name, symbol, uri)` (metadata extension) and the extension initializers to call between `createAccount` and `initializeMint2` / `initializeAccount3`: `initializeTransferFeeConfig(mint, configAuthority | null, withdrawAuthority | null, basisPoints, maximumFee)`, `initializeMintCloseAuthority(mint, authority | null)`, `initializeNonTransferableMint(mint)`, `initializePermanentDelegate(mint, delegate)`, `initializeDefaultAccountState(mint, frozen)`, `initializeMetadataPointer` / `initializeGroupPointer` / `initializeGroupMemberPointer` / `initializeTransferHook(mint, authority | null, address | null)`, `initializeInterestBearingMint(mint, rateAuthority | null, rate)`, `initializeImmutableOwner(account)`
- `account.lamports` read/write on `Mut` accounts, `close(account, destination)` for program accounts
- `requirePda(account, seeds, bump)`

## Implementing another program's interface (transfer hooks)

`/** @discriminator spl-transfer-hook-interface:execute */` above an instruction replaces its Anchor discriminator with
sha256(preimage)[..8] (or `@discriminator 0x…` for raw bytes), so a TypeSOL program can be a Token-2022 transfer hook:
`execute(source, mint, destination, owner, extraMetas, ...extraAccounts, amount)` plus
`initExtraAccountMetas(payer, account, mint, systemProgram, extraAccounts?)` for the validation account (an
ExtraAccountMetaList). Extra accounts are listed as `{ address, isSigner?, isWritable? }` (a fixed address) or
`{ seeds: [...], program?, isSigner?, isWritable? }` (a PDA of this program, or with `program: i` of the program at account
index i), with seeds from string literals, `seedAccountKey(i)`, `seedAccountData(i, offset, length)` and
`seedInstructionData(offset, length)`; Token-2022 resolves and checks them on every transfer. The first extra account has
index 5. `updateExtraAccountMetas(...)` rewrites and resizes an existing list. See `test/fixtures/hook.ts` and the
transfer-hook ports.

## Calling other programs

```ts
export function relayIncrement(authority: Signer, counter: Mut<AccountInfo>, counterProgram: Program<"JD2v…99Y2">, by: u64): void {
  invoke(counterProgram, [readonlySigner(authority), writable(counter)], [sighash("increment"), by]);
}

// Sign for a PDA of this program: raw System transfer (u32 tag 2, u64 lamports) out of a treasury PDA.
invoke(systemProgram, [writableSigner(treasury), writable(recipient)], [u32(2n), amount], ["treasury", admin.key, bump]);
```

- accounts: `readonly(x)`, `writable(x)`, `readonlySigner(x)`, `writableSigner(x)`. The compiler refuses `writable` on a
  non-`Mut` parameter and a signer flag on an account that neither signed nor is covered by `signerSeeds`.
- data (Borsh): integers little-endian at their declared width (`u32(2n)` is 4 bytes, a bare `5n` is a u64), booleans,
  Pubkeys, strings, Options, structs and FixedArrays (their fixed layout), data enums, `Vec` arguments,
  `sighash("name")` (Anchor discriminator), `hex("0a0b")`. Up to 1024 bytes.
- `signerSeeds` (with the bump) signs for this program's PDA.
- After the call, `returnData<u64>(program)` reads what the callee returned, checking the size and that it came from `program`.

Typed calls from an IDL: `typesol cpi other.json --out other_cpi.ts` writes one helper per instruction
(`vaultDeposit(program, owner, vault, systemProgram, amount, seeds)`), with the account flags, discriminator and
argument encoding taken from the IDL (Anchor 0.30+ / 1.x, or TypeSOL's own). Call it with `signer([...seeds, bump])`
when a PDA of your program signs, or `signer([])`. Instructions whose arguments have no Borsh-identical TypeSOL type
(strings or Options inside structs, data-carrying enums) are listed and left out.

## PDAs in the IDL

When an instruction calls `x.create(payer, seeds)` or `requirePda(x, seeds, bump)` and every seed is a string literal,
an integer literal, an argument, `acct.key` or a scalar field of an account, the IDL entry for `x` gets Anchor `pda.seeds`
(`const` / `arg` / `account`), so Anchor and Codama clients derive the address themselves.

## Not supported yet

Growable `Vec`s anywhere but the last account field (use `FixedVec<T, N>`), FixedVec in arguments and events, growing an account by more than 10 KiB in one instruction, growing a Vec
inside a helper, data-enum arguments carrying structs, Pubkeys in templates, `?.`, `**=`, `!` on anything but an Option, `switch` on
128-bit integers, `mulDiv` beyond u64, Core's MasterEdition / VerifiedCreators / Autograph plugins, royalty rule sets and external plugin adapters, Bubblegum V2 delegates / freezes / metadata updates / V1 transfers, closures (local functions reading the enclosing function's variables), functions as values (callbacks,
`.map`), type parameters standing for structs, floating point (by design), `do … while`.
They are rejected at compile time rather than half-supported.

`Init.create` handles a PDA address someone pre-funded: it tops up rent, then allocates and assigns instead of
`create_account` (which would fail).
