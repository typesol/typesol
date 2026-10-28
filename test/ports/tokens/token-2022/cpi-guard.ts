// Port of tokens/token-2022/cpi-guard @ de09019; see test/ports/README.md.
//
// PORTED: `token::mint = mint_account` on the sender's account is TokenOf<…, "mintAccount"> (2014, as Anchor).
import { type InitIfNeeded, type Mint, type Mut, type Signer, type SystemProgram, type Token2022Program, type TokenAccount, type TokenOf } from "typesol";

export function cpiTransfer(
  sender: Mut<Signer>,
  senderTokenAccount: TokenOf<Mut<TokenAccount>, "mintAccount">,
  recipientTokenAccount: InitIfNeeded<TokenAccount>,
  mintAccount: Mint,
  tokenProgram: Token2022Program,
  systemProgram: SystemProgram,
): void {
  // `init_if_needed, token::mint = mint_account, token::authority = recipient_token_account, seeds = [b"pda"], bump`
  recipientTokenAccount.createIfNeeded(sender, ["pda"], mintAccount, recipientTokenAccount.key);
  // TransferChecked of 1 base unit, signed by the sender. A CPI guard on the sender's account refuses it.
  tokenProgram.transferChecked(senderTokenAccount, mintAccount, recipientTokenAccount, sender, 1n);
}
