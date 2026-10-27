import {
  type AccountInfo,
  type AssociatedTokenProgram,
  type Ata,
  type Init,
  type InitIfNeeded,
  type Mut,
  type Mint,
  type Signer,
  type SystemProgram,
  type TokenAccount,
  type TokenInterface,
  type u64,
} from "typesol";

/** Anchor `init` + `associated_token`: creates the owner's ATA (fails if it exists), then mints into it. */
export function open(
  payer: Mut<Signer>,
  owner: AccountInfo,
  mint: Mut<Mint>,
  ata: Ata<Init<TokenAccount>, "owner", "mint">,
  tokenProgram: TokenInterface,
  associatedTokenProgram: AssociatedTokenProgram,
  systemProgram: SystemProgram,
  amount: u64,
): void {
  ata.create(payer);
  tokenProgram.mintTo(mint, ata, payer, amount);
}

/** Anchor `init_if_needed` + `associated_token`: creates the ATA only when missing; returns whether it did. */
export function fund(
  payer: Mut<Signer>,
  owner: AccountInfo,
  mint: Mut<Mint>,
  ata: Ata<InitIfNeeded<TokenAccount>, "owner", "mint">,
  tokenProgram: TokenInterface,
  associatedTokenProgram: AssociatedTokenProgram,
  systemProgram: SystemProgram,
  amount: u64,
): boolean {
  const fresh = ata.createIfNeeded(payer);
  tokenProgram.mintTo(mint, ata, payer, amount);
  return fresh;
}

/** The created account is a TokenAccount: its fields read like any other's. */
export function balance(
  payer: Mut<Signer>,
  owner: AccountInfo,
  mint: Mint,
  ata: Ata<InitIfNeeded<TokenAccount>, "owner", "mint">,
  tokenProgram: TokenInterface,
  associatedTokenProgram: AssociatedTokenProgram,
  systemProgram: SystemProgram,
): u64 {
  ata.createIfNeeded(payer);
  return ata.amount;
}
