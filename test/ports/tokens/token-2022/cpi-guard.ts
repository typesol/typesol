// Port of tokens/token-2022/cpi-guard @ de09019; see test/ports/README.md.
//
// PARTIAL: `token::mint` on the sender's account is checked in the body (6000), where Anchor fails with
// ConstraintTokenMint (2014): HasOne<…, "mint"> needs the mint parameter to be named `mint`, and the IDL keeps
// Anchor's `mint_account`.
import { type InitIfNeeded, type Mint, type Mut, type Signer, type SystemProgram, type Token2022Program, type TokenAccount, require } from "typesol";

export enum CpiGuardError {
  MintMismatch = "The sender's token account is not for this mint",
}

export function cpiTransfer(
  sender: Mut<Signer>,
  senderTokenAccount: Mut<TokenAccount>,
  recipientTokenAccount: InitIfNeeded<TokenAccount>,
  mintAccount: Mint,
  tokenProgram: Token2022Program,
  systemProgram: SystemProgram,
): void {
  require(senderTokenAccount.mint === mintAccount.key, CpiGuardError.MintMismatch);
  // `init_if_needed, token::mint = mint_account, token::authority = recipient_token_account, seeds = [b"pda"], bump`
  recipientTokenAccount.createIfNeeded(sender, ["pda"], mintAccount, recipientTokenAccount.key);
  // TransferChecked of 1 base unit, signed by the sender. A CPI guard on the sender's account refuses it.
  tokenProgram.transferChecked(senderTokenAccount, mintAccount, recipientTokenAccount, sender, 1n);
}
