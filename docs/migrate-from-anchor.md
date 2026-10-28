# Migrate from Anchor

TypeSOL programs speak Anchor's wire format: the same instruction and account discriminators, Borsh arguments, an
Anchor-format IDL, the same error numbering and event logs. A ported program can keep its clients. This page maps
Anchor's constructs to TypeSOL's and shows the porting workflow.

## Start from the IDL

```sh
anchor build                                   # in the Anchor project: target/idl/my_program.json
npx @typesol/cli init my-program && cd my-program
rm programs/my_program.ts tests/my_program.test.ts   # the counter template's program and test
npx typesol port ../anchor/target/idl/my_program.json --out programs/my_program.ts
```

`typesol port` writes the account structs, enums, errors and one function per instruction with its accounts and
arguments, each body failing with `NotPorted` until you write it. It keeps instruction discriminators, account names
and error codes. Its notes (on stderr) list what an existing Anchor client would see differently; see
[Account data](#account-data) below. Then, for each instruction:

1. Give each account its real type: `Account<T>` / `Mut<T>` for your structs, `Init<T>` for one the instruction creates,
   token types for token accounts (the table below).
2. Move the constraints from `#[account(...)]` into the parameter types or the body.
3. Port the body. Integers are `bigint`s with `n` literals, and every `+ - * / %` is checked.
4. Test with `typesol/testing` ([test your program](test-your-program.md)), then compare the IDLs.

## Accounts and constraints

| Anchor | TypeSOL |
| --- | --- |
| `#[derive(Accounts)] struct Ctx` + `ctx.accounts.x` | the instruction's parameters, in the same order |
| `Signer<'info>` / `#[account(mut)] Signer` | `Signer` / `Mut<Signer>` |
| `Account<'info, T>` / `#[account(mut)]` | `Account<T>` / `Mut<T>` |
| `#[account(init, payer = p, space = …, seeds = […], bump)]` | `Init<T>`, then `const bump = acct.create(p, ["seed", other.key])` (space is computed; `acct.create(p, […], 8n + 64n)` keeps an explicit `space`) |
| `#[account(init, payer = p, space = …)]` (a keypair account) | `Init<T>`, then `acct.create(p, null)` (the account signs the transaction, as in Anchor) |
| `init_if_needed` | `InitIfNeeded<T>`, then `const created = acct.createIfNeeded(p, seeds)` |
| `seeds = [b"vault", owner.key().as_ref()], bump = vault.bump` | `Seeds<Mut<Vault>, ["vault", "@owner"], "bump">` |
| `seeds = [b"offer", offer.maker.as_ref(), offer.id.to_le_bytes().as_ref()]` | `Seeds<…, ["offer", "@offer.maker", "@offer.id"], "bump">` |
| `has_one = owner` | `HasOne<Mut<T>, "owner">` |
| `close = destination` | `CloseTo<Mut<T>, "destination">`, or `close(acct, destination)` in the body |
| `address = ADMIN` | `Address<AccountInfo, "Admin1111…">` |
| `owner = program`, `executable` | `Owner<A, "…">`, `Executable<A>` |
| `constraint = expr @ MyError::X` | `require(expr, MyError.X)` at the start of the body |
| `realloc = n, realloc::payer = p` | `realloc(acct, n, p)` |
| `Option<Account<'info, T>>` | `Mut<T> \| null` (the client passes the program id to leave it out) |
| `UncheckedAccount` / `AccountInfo` | `AccountInfo` / `Mut<AccountInfo>`: check what you rely on yourself |
| `SystemAccount<'info>` | `SystemAccount` / `Mut<SystemAccount>` |
| `AccountLoader<T>` with `#[account(zero)]` | `Zeroed<T>` (TypeSOL reads every account in place: no copy to avoid) |
| `Program<'info, System>` | `SystemProgram` |
| `Program<'info, Token>` / `Token2022` / `Interface<'info, TokenInterface>` | `TokenProgram` / `Token2022Program` / `TokenInterface` |
| `Account<'info, TokenAccount>` / `Account<'info, Mint>` (`InterfaceAccount`) | `TokenAccount` / `Mint` (`Mut<…>` when written) |
| `token::mint = m, token::authority = a` | `TokenOf<TokenAccount, "m", "a">` (2014 / 2015), or `HasOne<TokenAccount, "mint" \| "owner">` when the parameters have those names; `mint::authority = a, mint::freeze_authority = f` on an existing mint: `MintOf<Mint, "a", "f">` (2016 / 2017) |
| `extensions::metadata_pointer::authority = a, …` (with `mint::…`) | `mint.create(p, …, { metadataPointer: { authority: a.key, metadataAddress: mint.key }, … })`: transferHook, closeAuthority, permanentDelegate, nonTransferable, groupPointer, groupMemberPointer and more |
| `#[account(init, payer = p, seeds = […], bump, mint::decimals = 6, mint::authority = a, mint::freeze_authority = f)]` | `Init<Mint>`, then `const bump = mint.create(p, […], 6n, a.key, f.key)` (`null` seeds: a keypair mint; `InitIfNeeded<Mint>` + `createIfNeeded`) |
| `#[account(init, payer = p, seeds = […], bump, token::mint = m, token::authority = a)]` | `Init<TokenAccount>`, then `vault.create(p, […], m, a.key)` (`InitIfNeeded<TokenAccount>` + `createIfNeeded`) |
| `associated_token::mint = m, associated_token::authority = a` | `Ata<TokenAccount, "a", "m">`; `Ata<Init<TokenAccount>, "a", "m">` creates it |
| `ctx.remaining_accounts` | `remainingAccounts()` |
| `ctx.bumps.vault` | the value `create` returns, or `acct.pdaBump` |

## Account data

| Anchor | TypeSOL |
| --- | --- |
| `#[account] pub struct T { … }` | `export interface T { … }` |
| `u8` … `u128`, `i8` … `i128`, `bool`, `Pubkey` | `u8` … `u128`, `i8` … `i128`, `boolean`, `Pubkey` |
| `[T; N]` | `FixedArray<T, N>` |
| `String` with `#[max_len(n)]` | `FixedString<N>`: a u32 length and N bytes, always N bytes long |
| `Vec<T>` with `#[max_len(n)]` | `Vec<T>` as the account's last field (it grows with `push(v, payer)`), or `FixedVec<T, n>` anywhere: a u32 length and room for n, always 4 + n × size bytes |
| `Option<T>` | `Option<T>`: fixed size (1 + size of T) |
| `#[derive(AnchorSerialize…)] enum` | `export enum` (unit variants) or a data enum `type A = { kind: "X"; … } \| …` |

TypeSOL keeps account data at a fixed layout by default, so three Anchor layouts differ: a Borsh `String` is
variable-length (TypeSOL uses `FixedString<N>`), a Borsh `Option` takes 1 byte when empty (TypeSOL always reserves the
value), and a `Vec` can be anywhere in an Anchor struct (TypeSOL keeps a growable one last; a `FixedVec<T, N>` elsewhere
always takes its full capacity, where Anchor packs the elements and moves the fields after them).

To keep an Anchor program's existing accounts, mark the struct `/** @layout borsh */`: it is then stored exactly as
Anchor stores it (`FixedString<N>` / `FixedVec<T, N>` / `Option<T>` become Borsh String / Vec / Option, N being the
`#[max_len]`), its IDL type is Anchor's, and the upgraded program reads and writes the accounts in place. `typesol port`
adds it for you. It costs some compute (the account is unpacked and packed in every instruction that uses it) but stays
several times cheaper than Anchor. Accounts using them need a migration (or a new program) rather
than an in-place upgrade, unless they use `@layout borsh`. Everything else, including instruction arguments (`String`, `Option`, `Vec` are Borsh there),
matches byte for byte. A `@layout borsh` struct passed as a whole argument, returned or emitted is Borsh too, so an
Anchor instruction that takes or returns a struct with `String` / `Vec` / `Option` fields keeps its client bytes.

## Code

| Anchor | TypeSOL |
| --- | --- |
| `pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()>` | `export function deposit(owner: Mut<Signer>, vault: Mut<Vault>, …, amount: u64): void` |
| `-> Result<u64>` / a struct | `: u64` / a struct: sent as return data, listed in the IDL |
| `#[error_code] enum MyError { #[msg("…")] X }` | `export enum MyError { X = "…" }` (codes from 6000, in order) |
| `require!(c, MyError::X)`, `err!(MyError::X)` | `require(c, MyError.X)`, `require(false, MyError.X)` |
| `require_keys_eq!(a, b)`, `err!(ErrorCode::AccountDidNotDeserialize)` (Anchor's own codes) | `require(a === b, AnchorError.RequireKeysEqViolated)`, `require(false, AnchorError.AccountDidNotDeserialize)` |
| `init_if_needed` + `extensions::…` on a mint | `mint.createIfNeeded(…, { metadataPointer: {…}, … })`: an existing mint is checked as Anchor checks it (2024–2039) |
| `require_keys_eq!(a, b)` | `require(a === b, …)` |
| `a.checked_add(b).ok_or(…)?` | `a + b` (every operation is checked; overflow aborts with 5100) |
| `emit!(Ev { … })` / `emit_cpi!` | `emit<Ev>({ … })` / `emitCpi<Ev>({ … }, eventAuthority, self)` |
| `msg!("…")` | `log("…")` |
| `Clock::get()?.unix_timestamp`, `.slot` | `now()`, `currentSlot()` |
| `Rent::get()?.minimum_balance(n)` | `rentExempt(n)`, `minimumBalance(acct)` |
| `system_program::transfer(CpiContext::new(…), lamports)` | `systemProgram.transfer(from, to, lamports)` |
| `token::transfer_checked(CpiContext::new_with_signer(…, seeds), amount, decimals)` | `tokenProgram.transferChecked(from, mint, to, authority, amount, ["seed", key, bump])` |
| `invoke_signed(&ix, &accounts, &[seeds])` | `invoke(program, [writable(a), readonly(b)], [data…], seeds)` |
| `declare_program!(other)` / CPI to another Anchor program | `typesol cpi other.json` generates typed helpers |
| `for x in v.iter()` | `for (const x of v)` |
| `v.iter().any(\|x\| …)`, `.all`, `.position`, `.find`, `.fold(init, …)`, `.contains(&x)` | `v.some((x) => …)`, `every`, `findIndex`, `find`, `reduce((acc, x) => …, init)`, `includes(x)` |
| a closure `\|x\| x + offset` | `const f = (x: u64): u64 => x + offset` (it may read and write the function's variables) |
| `x.unwrap_or(d)` | `x ?? d` |
| `fn max<T: PartialOrd>(a: T, b: T) -> T` | `function max<T extends bigint>(a: T, b: T): T` (one copy per type used) |
| `let fee = \|x: u64\| x / 100;` (no captures) | `const fee = (x: u64): u64 => x / 100n;` |

## Tooling

| Anchor | TypeSOL |
| --- | --- |
| `anchor init` | `typesol init` (`--template vault` / `escrow`) |
| `anchor build` | `typesol build` (writes the IDL and a TypeScript client next to the binary) |
| `anchor test` (mocha, bankrun) | `npm test` with `typesol/testing` in LiteSVM |
| `anchor deploy` | `typesol deploy` ([deploy to mainnet](mainnet.md)) |
| `anchor idl init` / `upgrade` | `typesol idl publish` |
| `anchor verify` | `typesol verify` (reads the deployed program and IDL from the cluster) |
| `@coral-xyz/anchor` `Program` client | the generated `<name>.client.ts` on `@solana/kit`, or Anchor's client with the IDL |
