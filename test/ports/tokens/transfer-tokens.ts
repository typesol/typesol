// Port of tokens/transfer-tokens @ de09019; see test/ports/README.md.
//
// PARTIAL:
//  - logs: lines that print an address print the label and the address on two lines (no Pubkeys in templates).
import {
  type AccountInfo,
  type Address,
  type AssociatedTokenProgram,
  type Ata,
  type InitIfNeeded,
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
  log,
  rentExempt,
  u8,
  u64,
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
  associatedTokenAccount: Ata<InitIfNeeded<TokenAccount>, "recipient", "mintAccount">,
  tokenProgram: TokenProgram,
  associatedTokenProgram: AssociatedTokenProgram,
  systemProgram: SystemProgram,
  amount: u64,
): void {
  associatedTokenAccount.createIfNeeded(mintAuthority);
  log("Minting tokens to associated token account...");
  log("Mint: ");
  log(mintAccount.key);
  log("Token Address: ");
  log(associatedTokenAccount.key);
  tokenProgram.mintTo(mintAccount, associatedTokenAccount, mintAuthority, withDecimals(amount, mintAccount.decimals));
  log("Token minted successfully.");
}

export function transferTokens(
  sender: Mut<Signer>,
  recipient: Owner<AccountInfo, "11111111111111111111111111111111">,
  mintAccount: Mut<Mint>,
  senderTokenAccount: Ata<Mut<TokenAccount>, "sender", "mintAccount">,
  recipientTokenAccount: Ata<InitIfNeeded<TokenAccount>, "recipient", "mintAccount">,
  tokenProgram: TokenProgram,
  associatedTokenProgram: AssociatedTokenProgram,
  systemProgram: SystemProgram,
  amount: u64,
): void {
  recipientTokenAccount.createIfNeeded(sender);
  log("Transferring tokens...");
  log("Mint: ");
  log(mintAccount.key);
  log("From Token Address: ");
  log(senderTokenAccount.key);
  log("To Token Address: ");
  log(recipientTokenAccount.key);
  tokenProgram.transfer(senderTokenAccount, recipientTokenAccount, sender, withDecimals(amount, mintAccount.decimals));
  log("Tokens transferred successfully.");
}
