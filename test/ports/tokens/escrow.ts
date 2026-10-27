// Port of tokens/escrow @ de09019; see test/ports/README.md.
//
// PARTIAL (builtin gap): `vault`, `taker_token_account_a` and `maker_token_account_b` are associated token accounts
// that Anchor creates in the instruction (`init` / `init_if_needed`) and then uses as InterfaceAccount<TokenAccount>.
// A TypeSOL TokenAccount parameter is checked before the body runs, so an account created in the body stays an
// AccountInfo and the typed token CPIs (which take TokenAccount) cannot target it: the transfers into those accounts
// are hand-encoded TransferChecked instructions (`invoke`). The ATA address checks are declarative (Ata<…>); the
// offer PDA (seeded with its own `id` field) is checked with requirePda in the body.
import {
  type AccountInfo,
  type AccountMeta,
  type Ata,
  type AssociatedTokenProgram,
  type CloseTo,
  type HasOne,
  type Init,
  type Mint,
  type Mut,
  type Owner,
  type Pubkey,
  type Signer,
  type SignerSeeds,
  type SystemProgram,
  type TokenAccount,
  type TokenInterface,
  type u64,
  invoke,
  readonly,
  readonlySigner,
  requirePda,
  signer,
  u8,
  writable,
} from "typesol";

export interface Offer {
  id: u64;
  maker: Pubkey;
  tokenMintA: Pubkey;
  tokenMintB: Pubkey;
  tokenBWantedAmount: u64;
  bump: u8;
}

export enum ErrorCode {
  CustomError = "Custom error message",
}

/** SPL TransferChecked (instruction 12) between token accounts the program may only know as AccountInfo. */
function transferChecked(
  tokenProgram: TokenInterface,
  from: Mut<AccountMeta>,
  mint: Mint,
  to: Mut<AccountMeta>,
  authority: AccountMeta,
  amount: u64,
  seeds: SignerSeeds,
): void {
  invoke(tokenProgram, [writable(from), readonly(mint), writable(to), readonlySigner(authority)], [u8(12n), amount, mint.decimals], seeds);
}

export function makeOffer(
  maker: Mut<Signer>,
  tokenMintA: Mint,
  tokenMintB: Mint,
  makerTokenAccountA: Ata<Mut<TokenAccount>, "maker", "tokenMintA">,
  offer: Init<Offer>,
  vault: Ata<Mut<AccountInfo>, "offer", "tokenMintA">,
  associatedTokenProgram: AssociatedTokenProgram,
  tokenProgram: TokenInterface,
  systemProgram: SystemProgram,
  id: u64,
  tokenAOfferedAmount: u64,
  tokenBWantedAmount: u64,
): void {
  offer.bump = offer.create(maker, ["offer", maker.key, id]);
  associatedTokenProgram.create(maker, vault, offer, tokenMintA, systemProgram, tokenProgram);
  transferChecked(tokenProgram, makerTokenAccountA, tokenMintA, vault, maker, tokenAOfferedAmount, signer([]));
  offer.id = id;
  offer.maker = maker.key;
  offer.tokenMintA = tokenMintA.key;
  offer.tokenMintB = tokenMintB.key;
  offer.tokenBWantedAmount = tokenBWantedAmount;
}

export function takeOffer(
  taker: Mut<Signer>,
  maker: Owner<Mut<AccountInfo>, "11111111111111111111111111111111">,
  tokenMintA: Mint,
  tokenMintB: Mint,
  takerTokenAccountA: Ata<Mut<AccountInfo>, "taker", "tokenMintA">,
  takerTokenAccountB: Ata<Mut<TokenAccount>, "taker", "tokenMintB">,
  makerTokenAccountB: Ata<Mut<AccountInfo>, "maker", "tokenMintB">,
  offer: CloseTo<HasOne<Mut<Offer>, "maker" | "tokenMintA" | "tokenMintB">, "maker">,
  vault: Ata<Mut<TokenAccount>, "offer", "tokenMintA">,
  associatedTokenProgram: AssociatedTokenProgram,
  tokenProgram: TokenInterface,
  systemProgram: SystemProgram,
): void {
  requirePda(offer, ["offer", maker.key, offer.id], offer.bump);
  associatedTokenProgram.createIdempotent(taker, takerTokenAccountA, taker, tokenMintA, systemProgram, tokenProgram);
  associatedTokenProgram.createIdempotent(taker, makerTokenAccountB, maker, tokenMintB, systemProgram, tokenProgram);
  transferChecked(tokenProgram, takerTokenAccountB, tokenMintB, makerTokenAccountB, taker, offer.tokenBWantedAmount, signer([]));
  transferChecked(tokenProgram, vault, tokenMintA, takerTokenAccountA, offer, vault.amount, signer(["offer", maker.key, offer.id, offer.bump]));
  tokenProgram.closeAccount(vault, maker, offer, ["offer", maker.key, offer.id, offer.bump]);
}

export function refundOffer(
  maker: Mut<Signer>,
  tokenMintA: Mint,
  makerTokenAccountA: Ata<Mut<TokenAccount>, "maker", "tokenMintA">,
  offer: CloseTo<HasOne<Mut<Offer>, "maker" | "tokenMintA">, "maker">,
  vault: Ata<Mut<TokenAccount>, "offer", "tokenMintA">,
  tokenProgram: TokenInterface,
): void {
  requirePda(offer, ["offer", maker.key, offer.id], offer.bump);
  tokenProgram.transferChecked(vault, tokenMintA, makerTokenAccountA, offer, vault.amount, ["offer", maker.key, offer.id, offer.bump]);
  tokenProgram.closeAccount(vault, maker, offer, ["offer", maker.key, offer.id, offer.bump]);
}
