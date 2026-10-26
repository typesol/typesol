import {
  type AccountInfo,
  type Init,
  type Mut,
  type Pubkey,
  type Signer,
  type SystemProgram,
  type TokenAccount,
  type TokenProgram,
  type u8,
  type u64,
  close,
  require,
} from "typesol";

/**
 * A maker escrows `amountA` of mint A and asks for `wantB` of mint B.
 * Anyone can take the offer atomically; the maker can refund while it is open.
 *
 * The client creates `vault` beforehand as a token account for mint A whose
 * owner is the offer PDA ["offer", maker, seed].
 */
export interface Offer {
  maker: Pubkey;
  mintA: Pubkey;
  mintB: Pubkey;
  vault: Pubkey;
  amountA: u64;
  wantB: u64;
  seed: u64;
  bump: u8;
}

export enum EscrowError {
  ZeroAmount = "Amounts must be greater than zero",
  BadVault = "Vault must be an empty token account owned by the offer",
  WrongMaker = "Maker does not match the offer",
  WrongVault = "Vault does not match the offer",
  WrongMint = "Token account has the wrong mint",
  WrongRecipient = "Maker's token account is not owned by the maker",
}

export function make(
  maker: Mut<Signer>,
  offer: Init<Offer>,
  makerTokenA: Mut<TokenAccount>,
  vault: Mut<TokenAccount>,
  systemProgram: SystemProgram,
  tokenProgram: TokenProgram,
  seed: u64,
  amountA: u64,
  wantB: u64,
  mintB: Pubkey,
): void {
  offer.bump = offer.create(maker, ["offer", maker.key, seed]);
  require(amountA > 0n && wantB > 0n, EscrowError.ZeroAmount);
  require(vault.owner === offer.key && vault.mint === makerTokenA.mint && vault.amount === 0n, EscrowError.BadVault);

  tokenProgram.transfer(makerTokenA, vault, maker, amountA);

  offer.maker = maker.key;
  offer.mintA = makerTokenA.mint;
  offer.mintB = mintB;
  offer.vault = vault.key;
  offer.amountA = amountA;
  offer.wantB = wantB;
  offer.seed = seed;
}

export function take(
  taker: Mut<Signer>,
  maker: Mut<AccountInfo>,
  offer: Mut<Offer>,
  takerTokenA: Mut<TokenAccount>,
  takerTokenB: Mut<TokenAccount>,
  makerTokenB: Mut<TokenAccount>,
  vault: Mut<TokenAccount>,
  tokenProgram: TokenProgram,
): void {
  require(offer.maker === maker.key, EscrowError.WrongMaker);
  require(offer.vault === vault.key, EscrowError.WrongVault);
  require(takerTokenA.mint === offer.mintA && takerTokenB.mint === offer.mintB, EscrowError.WrongMint);
  require(makerTokenB.mint === offer.mintB, EscrowError.WrongMint);
  require(makerTokenB.owner === offer.maker, EscrowError.WrongRecipient);

  tokenProgram.transfer(takerTokenB, makerTokenB, taker, offer.wantB);
  tokenProgram.transfer(vault, takerTokenA, offer, offer.amountA, ["offer", offer.maker, offer.seed, offer.bump]);
  tokenProgram.closeAccount(vault, maker, offer, ["offer", offer.maker, offer.seed, offer.bump]);
  close(offer, maker);
}

export function refund(
  maker: Mut<Signer>,
  offer: Mut<Offer>,
  makerTokenA: Mut<TokenAccount>,
  vault: Mut<TokenAccount>,
  tokenProgram: TokenProgram,
): void {
  require(offer.maker === maker.key, EscrowError.WrongMaker);
  require(offer.vault === vault.key, EscrowError.WrongVault);
  require(makerTokenA.mint === offer.mintA, EscrowError.WrongMint);

  tokenProgram.transfer(vault, makerTokenA, offer, offer.amountA, ["offer", offer.maker, offer.seed, offer.bump]);
  tokenProgram.closeAccount(vault, maker, offer, ["offer", offer.maker, offer.seed, offer.bump]);
  close(offer, maker);
}
