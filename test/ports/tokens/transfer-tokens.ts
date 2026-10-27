// Port of tokens/transfer-tokens @ de09019; see test/ports/README.md.
//
// PARTIAL:
//  - builtin gap: the recipient's associated token account is `init_if_needed`. An account created in the body is an
//    AccountInfo to TypeSOL (TokenAccount parameters are checked before the body), so MintTo / Transfer into it are
//    hand-encoded (`invoke`).
//  - logs: lines that print an address print the label and the address on two lines (no Pubkeys in templates).
import {
  type AccountInfo,
  type Address,
  type AssociatedTokenProgram,
  type Ata,
  type Mint,
  type Mut,
  type Owner,
  type Seeds,
  type Signer,
  type SystemProgram,
  type TokenAccount,
  type TokenMetadataProgram,
  type TokenProgram,
  MINT_SIZE,
  invoke,
  log,
  readonlySigner,
  rentExempt,
  u8,
  u64,
  writable,
} from "typesol";

/** amount * 10^decimals, checked. */
function withDecimals(amount: u64, decimals: u8): u64 {
  let v = amount;
  for (let i = 0n; i < u64(decimals); i++) v *= 10n;
  return v;
}

export function createToken(
  payer: Mut<Signer>,
  mintAccount: Mut<Signer>,
  metadataAccount: Seeds<Mut<AccountInfo>, ["metadata", "@tokenMetadataProgram", "@mintAccount"], never, "@tokenMetadataProgram">,
  tokenProgram: TokenProgram,
  tokenMetadataProgram: TokenMetadataProgram,
  systemProgram: SystemProgram,
  rent: Address<AccountInfo, "SysvarRent111111111111111111111111111111111">,
  tokenTitle: string,
  tokenSymbol: string,
  tokenUri: string,
): void {
  systemProgram.createAccount(payer, mintAccount, rentExempt(MINT_SIZE), MINT_SIZE, tokenProgram.key);
  tokenProgram.initializeMint2(mintAccount, 9n, payer.key, payer.key);
  log("Creating metadata account");
  tokenMetadataProgram.createV3(metadataAccount, mintAccount, payer, payer, payer, systemProgram, tokenTitle, tokenSymbol, tokenUri, 0n, false);
  log("Token created successfully.");
}

export function mintToken(
  mintAuthority: Mut<Signer>,
  recipient: Owner<AccountInfo, "11111111111111111111111111111111">,
  mintAccount: Mut<Mint>,
  associatedTokenAccount: Ata<Mut<AccountInfo>, "recipient", "mintAccount">,
  tokenProgram: TokenProgram,
  associatedTokenProgram: AssociatedTokenProgram,
  systemProgram: SystemProgram,
  amount: u64,
): void {
  associatedTokenProgram.createIdempotent(mintAuthority, associatedTokenAccount, recipient, mintAccount, systemProgram, tokenProgram);
  log("Minting tokens to associated token account...");
  log("Mint: ");
  log(mintAccount.key);
  log("Token Address: ");
  log(associatedTokenAccount.key);
  // SPL Token MintTo (instruction 7).
  invoke(
    tokenProgram,
    [writable(mintAccount), writable(associatedTokenAccount), readonlySigner(mintAuthority)],
    [u8(7n), withDecimals(amount, mintAccount.decimals)],
  );
  log("Token minted successfully.");
}

export function transferTokens(
  sender: Mut<Signer>,
  recipient: Owner<AccountInfo, "11111111111111111111111111111111">,
  mintAccount: Mut<Mint>,
  senderTokenAccount: Ata<Mut<TokenAccount>, "sender", "mintAccount">,
  recipientTokenAccount: Ata<Mut<AccountInfo>, "recipient", "mintAccount">,
  tokenProgram: TokenProgram,
  associatedTokenProgram: AssociatedTokenProgram,
  systemProgram: SystemProgram,
  amount: u64,
): void {
  associatedTokenProgram.createIdempotent(sender, recipientTokenAccount, recipient, mintAccount, systemProgram, tokenProgram);
  log("Transferring tokens...");
  log("Mint: ");
  log(mintAccount.key);
  log("From Token Address: ");
  log(senderTokenAccount.key);
  log("To Token Address: ");
  log(recipientTokenAccount.key);
  // SPL Token Transfer (instruction 3).
  invoke(
    tokenProgram,
    [writable(senderTokenAccount), writable(recipientTokenAccount), readonlySigner(sender)],
    [u8(3n), withDecimals(amount, mintAccount.decimals)],
  );
  log("Tokens transferred successfully.");
}
