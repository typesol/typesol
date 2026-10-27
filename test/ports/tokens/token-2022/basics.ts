// Port of tokens/token-2022/basics @ de09019; see test/ports/README.md.
//
// PARTIAL:
//  - interface: `create_token` and `create_token_account` create PDAs (`init, seeds = [...], bump`) owned by the token
//    program; signing their System CreateAccount needs the bump Anchor finds (`ctx.bumps`). TypeSOL's Seeds<> checks
//    the canonical address but does not expose the bump, so both take a `bump` argument (checked with requirePda).
//  - builtin gap: `to_ata` is created in `transfer_token` (`init`), where it is an AccountInfo to TypeSOL, so the
//    TransferChecked into it is hand-encoded (`invoke`).
import {
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
  invoke,
  log,
  readonly,
  readonlySigner,
  rentExempt,
  requirePda,
  u8,
  writable,
} from "typesol";

export function createToken(
  signer: Mut<Signer>,
  mint: Seeds<Mut<AccountInfo>, ["token-2022-token", "@signer", "@tokenName"]>,
  systemProgram: SystemProgram,
  tokenProgram: TokenInterface,
  tokenName: string,
  bump: u8,
): void {
  requirePda(mint, ["token-2022-token", signer.key, tokenName], bump);
  systemProgram.createAccount(signer, mint, rentExempt(MINT_SIZE), MINT_SIZE, tokenProgram.key, ["token-2022-token", signer.key, tokenName, bump]);
  tokenProgram.initializeMint2(mint, 6n, signer.key, null);
  log("Create Token");
}

export function createTokenAccount(
  signer: Mut<Signer>,
  mint: Mint,
  tokenAccount: Seeds<Mut<AccountInfo>, ["token-2022-token-account", "@signer", "@mint"]>,
  systemProgram: SystemProgram,
  tokenProgram: TokenInterface,
  bump: u8,
): void {
  requirePda(tokenAccount, ["token-2022-token-account", signer.key, mint.key], bump);
  systemProgram.createAccount(signer, tokenAccount, rentExempt(TOKEN_ACCOUNT_SIZE), TOKEN_ACCOUNT_SIZE, tokenProgram.key, [
    "token-2022-token-account",
    signer.key,
    mint.key,
    bump,
  ]);
  tokenProgram.initializeAccount3(tokenAccount, mint, signer.key);
  log("Create Token Account");
}

export function createAssociatedTokenAccount(
  signer: Mut<Signer>,
  mint: Mint,
  tokenAccount: Ata<Mut<AccountInfo>, "signer", "mint">,
  systemProgram: SystemProgram,
  tokenProgram: TokenInterface,
  associatedTokenProgram: AssociatedTokenProgram,
): void {
  associatedTokenProgram.create(signer, tokenAccount, signer, mint, systemProgram, tokenProgram);
  log("Create Associated Token Account");
}

export function transferToken(
  signer: Mut<Signer>,
  from: Mut<TokenAccount>,
  to: Owner<AccountInfo, "11111111111111111111111111111111">,
  toAta: Ata<Mut<AccountInfo>, "to", "mint">,
  mint: Mut<Mint>,
  tokenProgram: TokenInterface,
  systemProgram: SystemProgram,
  associatedTokenProgram: AssociatedTokenProgram,
  amount: u64,
): void {
  associatedTokenProgram.create(signer, toAta, to, mint, systemProgram, tokenProgram);
  // TransferChecked (instruction 12).
  invoke(tokenProgram, [writable(from), readonly(mint), writable(toAta), readonlySigner(signer)], [u8(12n), amount, mint.decimals]);
  log("Transfer Token");
}

export function mintToken(signer: Mut<Signer>, mint: Mut<Mint>, receiver: Mut<TokenAccount>, tokenProgram: TokenInterface, amount: u64): void {
  tokenProgram.mintTo(mint, receiver, signer, amount);
  log("Mint Token");
}
