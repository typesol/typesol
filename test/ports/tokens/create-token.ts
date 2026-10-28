// Port of tokens/create-token @ de09019; see test/ports/README.md.
//
// PORTED.
// Anchor's `init, mint::decimals, mint::authority` on the keypair mint is System CreateAccount + InitializeMint2;
// the metadata PDA is checked under the Token Metadata program (`seeds::program`) like the original.
import {
  type AccountInfo,
  type Address,
  type Mut,
  type Seeds,
  type Signer,
  type SystemProgram,
  type TokenMetadataProgram,
  type TokenProgram,
  type u8,
  MINT_SIZE,
  log,
  rentExempt,
} from "typesol";

export function createTokenMint(
  payer: Mut<Signer>,
  metadataAccount: Seeds<Mut<AccountInfo>, ["metadata", "@tokenMetadataProgram", "@mintAccount"], never, "@tokenMetadataProgram">,
  mintAccount: Mut<Signer>,
  tokenMetadataProgram: TokenMetadataProgram,
  tokenProgram: TokenProgram,
  systemProgram: SystemProgram,
  rent: Address<AccountInfo, "SysvarRent111111111111111111111111111111111">,
  tokenDecimals: u8,
  tokenName: string,
  tokenSymbol: string,
  tokenUri: string,
): void {
  systemProgram.createAccount(payer, mintAccount, rentExempt(MINT_SIZE), MINT_SIZE, tokenProgram.key);
  tokenProgram.initializeMint2(mintAccount, tokenDecimals, payer.key, null);
  log("Creating metadata account...");
  log(`Metadata account address: ${metadataAccount.key}`);
  // Not mutable, no seller fee; the payer is mint and update authority.
  tokenMetadataProgram.createV3(metadataAccount, mintAccount, payer, payer, payer, systemProgram, tokenName, tokenSymbol, tokenUri, 0n, false);
  log("Token mint created successfully.");
}
