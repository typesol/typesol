// Port of tokens/token-2022/basics @ de09019; see test/ports/README.md.
//
// PORTED: the PDA mint and token account sign their System CreateAccount with the bump Seeds<> finds (`pdaBump`, Anchor's
// `ctx.bumps`); the ATAs are Ata<Init<TokenAccount>, …>.
import {
  type Init,
  type AccountInfo,
  type AssociatedTokenProgram,
  type Ata,
  type Mint,
  type Mut,
  type Owner,
  type Seeds,
  type Signer,
  type SystemProgram,
  type TokenAccount,
  type TokenInterface,
  type u64,
  MINT_SIZE,
  TOKEN_ACCOUNT_SIZE,
  log,
  rentExempt,
} from "typesol";

export function createToken(
  signer: Mut<Signer>,
  mint: Seeds<Mut<AccountInfo>, ["token-2022-token", "@signer", "@tokenName"]>,
  systemProgram: SystemProgram,
  tokenProgram: TokenInterface,
  tokenName: string,
): void {
  systemProgram.createAccount(signer, mint, rentExempt(MINT_SIZE), MINT_SIZE, tokenProgram.key, ["token-2022-token", signer.key, tokenName, mint.pdaBump]);
  tokenProgram.initializeMint2(mint, 6n, signer.key, null);
  log("Create Token");
}

export function createTokenAccount(
  signer: Mut<Signer>,
  mint: Mint,
  tokenAccount: Seeds<Mut<AccountInfo>, ["token-2022-token-account", "@signer", "@mint"]>,
  systemProgram: SystemProgram,
  tokenProgram: TokenInterface,
): void {
  systemProgram.createAccount(signer, tokenAccount, rentExempt(TOKEN_ACCOUNT_SIZE), TOKEN_ACCOUNT_SIZE, tokenProgram.key, [
    "token-2022-token-account",
    signer.key,
    mint.key,
    tokenAccount.pdaBump,
  ]);
  tokenProgram.initializeAccount3(tokenAccount, mint, signer.key);
  log("Create Token Account");
}

export function createAssociatedTokenAccount(
  signer: Mut<Signer>,
  mint: Mint,
  tokenAccount: Ata<Init<TokenAccount>, "signer", "mint">,
  systemProgram: SystemProgram,
  tokenProgram: TokenInterface,
  associatedTokenProgram: AssociatedTokenProgram,
): void {
  tokenAccount.create(signer);
  log("Create Associated Token Account");
}

export function transferToken(
  signer: Mut<Signer>,
  from: Mut<TokenAccount>,
  to: Owner<AccountInfo, "11111111111111111111111111111111">,
  toAta: Ata<Init<TokenAccount>, "to", "mint">,
  mint: Mut<Mint>,
  tokenProgram: TokenInterface,
  systemProgram: SystemProgram,
  associatedTokenProgram: AssociatedTokenProgram,
  amount: u64,
): void {
  toAta.create(signer);
  tokenProgram.transferChecked(from, mint, toAta, signer, amount);
  log("Transfer Token");
}

export function mintToken(signer: Mut<Signer>, mint: Mut<Mint>, receiver: Mut<TokenAccount>, tokenProgram: TokenInterface, amount: u64): void {
  tokenProgram.mintTo(mint, receiver, signer, amount);
  log("Mint Token");
}
