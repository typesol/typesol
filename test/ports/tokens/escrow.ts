// Port of tokens/escrow @ de09019; see test/ports/README.md.
//
// PORTED: `vault` (`init`) and `taker_token_account_a` / `maker_token_account_b` (`init_if_needed`) are associated
// token accounts the instruction creates: Ata<Init<TokenAccount>, …> / Ata<InitIfNeeded<TokenAccount>, …>. The offer PDA
// (seeded with its own `id` field) is checked with requirePda in the body.
import {
  type AccountInfo,
  type Ata,
  type AssociatedTokenProgram,
  type CloseTo,
  type HasOne,
  type Init,
  type InitIfNeeded,
  type Mint,
  type Mut,
  type Owner,
  type Pubkey,
  type Signer,
  type SystemProgram,
  type TokenAccount,
  type TokenInterface,
  type u64,
  requirePda,
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
  tokenMintA: Mint,
  tokenMintB: Mint,
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
  maker: Owner<Mut<AccountInfo>, "11111111111111111111111111111111">,
  tokenMintA: Mint,
  tokenMintB: Mint,
  takerTokenAccountA: Ata<InitIfNeeded<TokenAccount>, "taker", "tokenMintA">,
  takerTokenAccountB: Ata<Mut<TokenAccount>, "taker", "tokenMintB">,
  makerTokenAccountB: Ata<InitIfNeeded<TokenAccount>, "maker", "tokenMintB">,
  offer: CloseTo<HasOne<Mut<Offer>, "maker" | "tokenMintA" | "tokenMintB">, "maker">,
  vault: Ata<Mut<TokenAccount>, "offer", "tokenMintA">,
  associatedTokenProgram: AssociatedTokenProgram,
  tokenProgram: TokenInterface,
  systemProgram: SystemProgram,
): void {
  requirePda(offer, ["offer", maker.key, offer.id], offer.bump);
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
  offer: CloseTo<HasOne<Mut<Offer>, "maker" | "tokenMintA">, "maker">,
  vault: Ata<Mut<TokenAccount>, "offer", "tokenMintA">,
  tokenProgram: TokenInterface,
): void {
  requirePda(offer, ["offer", maker.key, offer.id], offer.bump);
  tokenProgram.transferChecked(vault, tokenMintA, makerTokenAccountA, offer, vault.amount, ["offer", maker.key, offer.id, offer.bump]);
  tokenProgram.closeAccount(vault, maker, offer, ["offer", maker.key, offer.id, offer.bump]);
}
