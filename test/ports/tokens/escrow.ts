// Port of tokens/escrow @ de09019; see test/ports/README.md.
//
// PORTED: `vault` (`init`) and `taker_token_account_a` / `maker_token_account_b` (`init_if_needed`) are associated
// token accounts the instruction creates: Ata<Init<TokenAccount>, …> / Ata<InitIfNeeded<TokenAccount>, …>. The offer PDA
// (seeded with its own `id` field) is checked declaratively: Seeds<…, ["offer", "@maker", "@offer.id"], "bump">.
// `mint::token_program = token_program` on make_offer's mints is MintOf<Mint, never, never, "tokenProgram">.
import {
  type Ata,
  type AssociatedTokenProgram,
  type CloseTo,
  type HasOne,
  type Init,
  type InitIfNeeded,
  type Mint,
  type MintOf,
  type Mut,
  type Pubkey,
  type Seeds,
  type Signer,
  type SystemAccount,
  type SystemProgram,
  type TokenAccount,
  type TokenInterface,
  type u64,
  u8,
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

export function takeOffer(
  taker: Mut<Signer>,
  maker: Mut<SystemAccount>,
  tokenMintA: Mint,
  tokenMintB: Mint,
  takerTokenAccountA: Ata<InitIfNeeded<TokenAccount>, "taker", "tokenMintA">,
  takerTokenAccountB: Ata<Mut<TokenAccount>, "taker", "tokenMintB">,
  makerTokenAccountB: Ata<InitIfNeeded<TokenAccount>, "maker", "tokenMintB">,
  offer: Seeds<CloseTo<HasOne<Mut<Offer>, "maker" | "tokenMintA" | "tokenMintB">, "maker">, ["offer", "@maker", "@offer.id"], "bump">,
  vault: Ata<Mut<TokenAccount>, "offer", "tokenMintA">,
  associatedTokenProgram: AssociatedTokenProgram,
  tokenProgram: TokenInterface,
  systemProgram: SystemProgram,
): void {
  takerTokenAccountA.createIfNeeded(taker);
  makerTokenAccountB.createIfNeeded(taker);
  tokenProgram.transferChecked(takerTokenAccountB, tokenMintB, makerTokenAccountB, taker, offer.tokenBWantedAmount);
  tokenProgram.transferChecked(vault, tokenMintA, takerTokenAccountA, offer, vault.amount, ["offer", maker.key, offer.id, offer.bump]);
  tokenProgram.closeAccount(vault, maker, offer, ["offer", maker.key, offer.id, offer.bump]);
}

export function refundOffer(
  maker: Mut<Signer>,
  tokenMintA: Mint,
  makerTokenAccountA: Ata<Mut<TokenAccount>, "maker", "tokenMintA">,
  offer: Seeds<CloseTo<HasOne<Mut<Offer>, "maker" | "tokenMintA">, "maker">, ["offer", "@maker", "@offer.id"], "bump">,
  vault: Ata<Mut<TokenAccount>, "offer", "tokenMintA">,
  tokenProgram: TokenInterface,
): void {
  tokenProgram.transferChecked(vault, tokenMintA, makerTokenAccountA, offer, vault.amount, ["offer", maker.key, offer.id, offer.bump]);
  tokenProgram.closeAccount(vault, maker, offer, ["offer", maker.key, offer.id, offer.bump]);
}
