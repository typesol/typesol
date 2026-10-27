// Port of tokens/token-2022/cpi-guard @ de09019; see test/ports/README.md.
//
// PARTIAL (builtin gap): `recipient_token_account` is a PDA token account (["pda"]) that Anchor creates with
// `init_if_needed` and `token::mint` / `token::authority`. TypeSOL creates associated token accounts in the instruction
// (Ata<InitIfNeeded<TokenAccount>>) but not PDA token accounts, so the port creates it in the body when it is still empty
// (CreateAccount signed with the PDA's seeds, then InitializeAccount3 with itself as the owner), and the
// TransferChecked into it is hand-encoded. An existing account at that address can only be the one this program
// created: nobody else can sign for the PDA. `token::mint` on the sender's account is checked in the body (6000), where
// Anchor fails with ConstraintTokenMint (2014).
import {
  type AccountInfo,
  type Mint,
  type Mut,
  type Seeds,
  type Signer,
  type SystemProgram,
  type Token2022Program,
  type TokenAccount,
  TOKEN_ACCOUNT_SIZE,
  invoke,
  readonly,
  readonlySigner,
  rentExempt,
  require,
  u8,
  writable,
} from "typesol";

export enum CpiGuardError {
  MintMismatch = "The sender's token account is not for this mint",
}

export function cpiTransfer(
  sender: Mut<Signer>,
  senderTokenAccount: Mut<TokenAccount>,
  recipientTokenAccount: Seeds<Mut<AccountInfo>, ["pda"]>,
  mintAccount: Mint,
  tokenProgram: Token2022Program,
  systemProgram: SystemProgram,
): void {
  require(senderTokenAccount.mint === mintAccount.key, CpiGuardError.MintMismatch);
  if (recipientTokenAccount.dataLen === 0n) {
    systemProgram.createAccount(sender, recipientTokenAccount, rentExempt(TOKEN_ACCOUNT_SIZE), TOKEN_ACCOUNT_SIZE, tokenProgram.key, [
      "pda",
      recipientTokenAccount.pdaBump,
    ]);
    tokenProgram.initializeAccount3(recipientTokenAccount, mintAccount, recipientTokenAccount.key);
  }
  // TransferChecked (12) of 1 base unit, signed by the sender. A CPI guard on the sender's account refuses it.
  invoke(
    tokenProgram,
    [writable(senderTokenAccount), readonly(mintAccount), writable(recipientTokenAccount), readonlySigner(sender)],
    [u8(12n), 1n, mintAccount.decimals],
  );
}
