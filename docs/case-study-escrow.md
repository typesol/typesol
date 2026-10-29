# Case study: porting Anchor's escrow

This page follows one complete Anchor program into TypeSOL: the token escrow from
[solana-developers/program-examples](https://github.com/solana-developers/program-examples/tree/de090195e4de698e150572c4f886c333323a64a5/tokens/escrow/anchor)
(`tokens/escrow`, commit `de09019`). It shows the original and the port side by side, what changed, how the two were
checked against each other, where they still differ, and what the port costs to run. The port is
[`test/ports/tokens/escrow.ts`](../test/ports/tokens/escrow.ts); [Migrate from Anchor](migrate-from-anchor.md) is the
general reference.

## The program

A maker offers an amount of token A for an amount of token B.

- `make_offer(id, token_a_offered_amount, token_b_wanted_amount)` creates the offer account, a PDA at
  `["offer", maker, id]`, creates the vault (the offer's associated token account for mint A) and moves the offered
  tokens into it.
- `take_offer()` sends token B from the taker to the maker, releases the vault to the taker, closes the vault and the
  offer, and returns their rent to the maker. It creates the taker's mint A account and the maker's mint B account if
  they do not exist.
- `refund_offer()` returns the vault to the maker and closes both accounts.

Upstream, this is 398 lines of Rust in ten files. The port is one 95-line TypeScript file.

## Side by side

### State

```rust
#[account]
#[derive(InitSpace)]
pub struct Offer {
    pub id: u64,
    pub maker: Pubkey,
    pub token_mint_a: Pubkey,
    pub token_mint_b: Pubkey,
    pub token_b_wanted_amount: u64,
    pub bump: u8,
}
```

```ts
export interface Offer {
  id: u64;
  maker: Pubkey;
  tokenMintA: Pubkey;
  tokenMintB: Pubkey;
  tokenBWantedAmount: u64;
  bump: u8;
}
```

The account has the same discriminator and the same Borsh bytes: an Anchor client decodes a TypeSOL offer unchanged.
Field names are camelCase in TypeScript and snake_case in the IDL, as Anchor writes them.

### make_offer

Anchor declares the accounts in a struct with constraint attributes, then splits the work into helper functions:

```rust
#[derive(Accounts)]
#[instruction(id: u64)]
pub struct MakeOffer<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    #[account(mint::token_program = token_program)]
    pub token_mint_a: InterfaceAccount<'info, Mint>,
    #[account(mint::token_program = token_program)]
    pub token_mint_b: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = token_mint_a, associated_token::authority = maker,
              associated_token::token_program = token_program)]
    pub maker_token_account_a: InterfaceAccount<'info, TokenAccount>,
    #[account(init, payer = maker, space = ANCHOR_DISCRIMINATOR + Offer::INIT_SPACE,
              seeds = [b"offer", maker.key().as_ref(), id.to_le_bytes().as_ref()], bump)]
    pub offer: Account<'info, Offer>,
    #[account(init, payer = maker, associated_token::mint = token_mint_a, associated_token::authority = offer,
              associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
// + send_offered_tokens_to_vault (a TransferChecked CPI through a shared transfer_tokens helper)
// + save_offer (offer.set_inner(Offer { … bump: context.bumps.offer }))
```

In TypeSOL the accounts are the function's parameters, in the same order, and each constraint is part of the
parameter's type:

```ts
export function makeOffer(
  maker: Mut<Signer>,
  tokenMintA: MintOf<Mint, never, never, "tokenProgram">,
  tokenMintB: MintOf<Mint, never, never, "tokenProgram">,
  makerTokenAccountA: Ata<Mut<TokenAccount>, "maker", "tokenMintA">,
  offer: Init<Offer>,
  vault: Ata<Init<TokenAccount>, "offer", "tokenMintA">,
  associatedTokenProgram: AssociatedTokenProgram,
  tokenProgram: TokenInterface,
  systemProgram: SystemProgram,
  id: u64,
  tokenAOfferedAmount: u64,
  tokenBWantedAmount: u64,
): void {
  offer.bump = offer.create(maker, ["offer", maker.key, id]);
  vault.create(maker);
  tokenProgram.transferChecked(makerTokenAccountA, tokenMintA, vault, maker, tokenAOfferedAmount);
  offer.id = id;
  offer.maker = maker.key;
  offer.tokenMintA = tokenMintA.key;
  offer.tokenMintB = tokenMintB.key;
  offer.tokenBWantedAmount = tokenBWantedAmount;
}
```

`MintOf<Mint, never, never, "tokenProgram">` is `mint::token_program = token_program`: the mint must be owned by
the token program passed (2022 otherwise). `offer.create` finds the canonical bump, creates the PDA with the computed space and returns the bump, which Anchor
exposes as `context.bumps.offer`. `transferChecked` reads the mint's decimals itself.

### take_offer and refund_offer

The offer is checked declaratively, as in Anchor: the seeds come from the maker account and the offer's own `id`
field, and the stored bump is used.

```rust
#[account(mut, close = maker, has_one = maker, has_one = token_mint_a, has_one = token_mint_b,
          seeds = [b"offer", maker.key().as_ref(), offer.id.to_le_bytes().as_ref()], bump = offer.bump)]
offer: Account<'info, Offer>,
```

```ts
offer: Seeds<CloseTo<HasOne<Mut<Offer>, "maker" | "tokenMintA" | "tokenMintB">, "maker">, ["offer", "@maker", "@offer.id"], "bump">,
```

The body signs for the vault with the offer's seeds, where Anchor builds a `signer_seeds` array and a
`CpiContext::new_with_signer` for each call:

```ts
takerTokenAccountA.createIfNeeded(taker);
makerTokenAccountB.createIfNeeded(taker);
tokenProgram.transferChecked(takerTokenAccountB, tokenMintB, makerTokenAccountB, taker, offer.tokenBWantedAmount);
tokenProgram.transferChecked(vault, tokenMintA, takerTokenAccountA, offer, vault.amount, ["offer", maker.key, offer.id, offer.bump]);
tokenProgram.closeAccount(vault, maker, offer, ["offer", maker.key, offer.id, offer.bump]);
```

`CloseTo<…, "maker">` closes the offer after the body returns, as Anchor's `close = maker` does.

## What changed

| Anchor | Port |
| --- | --- |
| `Signer`, `SystemAccount` (`#[account(mut)]`) | `Mut<Signer>`, `Mut<SystemAccount>` |
| `InterfaceAccount<Mint>`, `InterfaceAccount<TokenAccount>` | `Mint`, `TokenAccount` |
| `mint::token_program = token_program` | `MintOf<Mint, never, never, "tokenProgram">` |
| `associated_token::mint = m, associated_token::authority = a` | `Ata<TokenAccount, "a", "m">` |
| `init` / `init_if_needed` on an associated token account | `Ata<Init<…>>` + `vault.create(payer)` / `Ata<InitIfNeeded<…>>` + `createIfNeeded(payer)` |
| `init, seeds, bump` + `context.bumps.offer` | `Init<Offer>` + `offer.bump = offer.create(maker, seeds)` |
| `seeds = […], bump = offer.bump` | `Seeds<…, ["offer", "@maker", "@offer.id"], "bump">` |
| `has_one`, `close` | `HasOne<…>`, `CloseTo<…>` |
| `transfer_checked(CpiContext::new_with_signer(…), amount, decimals)` | `tokenProgram.transferChecked(from, mint, to, authority, amount, seeds)` |
| `ErrorCode::CustomError` (unused upstream) | `enum ErrorCode`, the same code 6000 |

Nothing in the program needed a construct TypeSOL lacks, and every account constraint has its TypeSOL form; the port
is marked PORTED in [the ports table](../test/ports/README.md).

## Same inputs, same results

Two independent checks run the original and the port against each other.

- **The port's own test** ([`test/porting/ports-tokens.test.ts`](../test/porting/ports-tokens.test.ts)) runs the upstream flow with SPL
  Token mints and again with Token-2022 mints: make, take (creating the taker's and the maker's missing token accounts),
  make again, a refund attempt by someone other than the maker, and the refund. It checks balances, the decoded offer
  and that offer and vault are closed.
- **The four-way comparison** in [typesol/benchmarks](https://github.com/typesol/benchmarks) builds the upstream Anchor,
  native and Pinocchio versions unmodified and sends all four the same 21 offers (ten taken, ten refunded, one left
  open). The decoded open offer, every token balance, the vault's authority and which accounts were closed must be
  identical before any number is reported. They are.

Both implementations refuse the hostile calls the comparison makes:

| Hostile call | Anchor | TypeSOL |
| --- | --- | --- |
| refund_offer signed by someone other than the maker | 2006 ConstraintSeeds | 2006 ConstraintSeeds |
| take_offer naming the taker as the maker | 2015 ConstraintTokenOwner | 2040 ConstraintDuplicateMutableAccount |

TypeSOL checks each account's constraints in Anchor's order, so a refused transaction usually gets the same error
code (see [which error a transaction gets](errors.md#which-error-a-transaction-gets)). The second call differs on
purpose: taker and maker are then the same writable account, which TypeSOL refuses for any two writable parameters
unless one is marked `Dup<…>`, where Anchor only compares program and token accounts and fails later, on the maker's
token account. A client that matches on this code needs to accept either.

## Cost

Mean compute units per instruction in LiteSVM (21 make_offer, 10 take_offer and 10 refund_offer calls), and the
program size, from typesol/benchmarks (TypeSOL at this version; Anchor 1.0.2). Lower is better.

| | TypeSOL | Anchor | Native Rust | Pinocchio |
| --- | ---: | ---: | ---: | ---: |
| make_offer | **19,697** | 35,726 | 33,206 | 20,581 |
| take_offer | **7,053** | 29,235 | 24,995 | 21,606 |
| refund_offer | **4,271** | 15,326 | 12,477 | 8,137 |
| Binary | 32.0 KB | 244.5 KB | 120.4 KB | **25.1 KB** |

Most of `make_offer` in every version is the Associated Token Account program creating the vault. The native and
Pinocchio versions are teaching code with fewer checks (no owner or type check on the offer, `Transfer` instead of
`TransferChecked`; Pinocchio takes the offer's bump from the client).

The same program, built with an earlier TypeSOL, runs on mainnet next to the other three; the transactions are listed
with their Solscan links in the [performance report](https://typesol.com/report/) and the
[README](../README.md#on-mainnet).

## Porting your own program

The steps this port followed, in order:

1. Generate the skeleton from the Anchor IDL: `npx typesol port target/idl/escrow.json --out programs/escrow.ts`. It
   keeps instruction names, discriminators, account order and error codes.
2. Turn each `#[account(...)]` into the parameter's type, using the table above and
   [Accounts and constraints](migrate-from-anchor.md#accounts-and-constraints). Keep the account order: it is the
   wire format.
3. Port the bodies. Helpers like `transfer_tokens` usually disappear into one call; `signer_seeds` arrays become the
   last argument of the CPI.
4. Run the upstream test flow against the port with `typesol/testing`, including the failure paths, and compare the
   decoded accounts.
5. Compare the IDLs, and check the error codes your clients match on (the table above shows how they can differ).
