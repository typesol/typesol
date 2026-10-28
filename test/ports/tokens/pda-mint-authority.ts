// Port of tokens/pda-mint-authority @ de09019; see test/ports/README.md.
//
// PARTIAL:
//  - logs: address lines are split in two (no Pubkeys in templates).
import {
  type TokenAccount,
  type InitIfNeeded,
  type AccountInfo,
  type Account,
  type Address,
  type AssociatedTokenProgram,
  type Ata,
  type Init,
  type Mint,
  type Mut,
  type Pubkey,
  type Seeds,
  type Signer,
  type SystemProgram,
  type TokenMetadataProgram,
  type TokenProgram,
  log,
  require,
  u64,
} from "typesol";

export interface MintConfig {
  admin: Pubkey;
}

export enum TokenMinterError {
  Unauthorized = "Only the admin recorded at token creation may mint",
}

export function createToken(
  payer: Mut<Signer>,
  mintAccount: Init<Mint>,
  metadataAccount: Seeds<Mut<AccountInfo>, ["metadata", "@tokenMetadataProgram", "@mintAccount"], never, "@tokenMetadataProgram">,
  mintConfig: Init<MintConfig>,
  tokenProgram: TokenProgram,
  tokenMetadataProgram: TokenMetadataProgram,
  systemProgram: SystemProgram,
  rent: Address<AccountInfo, "SysvarRent111111111111111111111111111111111">,
  tokenName: string,
  tokenSymbol: string,
  tokenUri: string,
): void {
  // `init, seeds = [b"mint"], mint::decimals = 9, mint::authority = mint_account, mint::freeze_authority = mint_account`
  const mintBump = mintAccount.create(payer, ["mint"], 9n, mintAccount.key, mintAccount.key);
  mintConfig.create(payer, ["mint_config"]);
  log("Creating metadata account");
  tokenMetadataProgram.createV3(metadataAccount, mintAccount, mintAccount, payer, mintAccount, systemProgram, tokenName, tokenSymbol, tokenUri, 0n, false, [
    "mint",
    mintBump,
  ]);
  mintConfig.admin = payer.key;
  log("Token created successfully.");
}

export function mintToken(
  payer: Mut<Signer>,
  mintAccount: Seeds<Mut<Mint>, ["mint"]>,
  mintConfig: Seeds<Account<MintConfig>, ["mint_config"]>,
  associatedTokenAccount: Ata<InitIfNeeded<TokenAccount>, "payer", "mintAccount">,
  tokenProgram: TokenProgram,
  associatedTokenProgram: AssociatedTokenProgram,
  systemProgram: SystemProgram,
  amount: u64,
): void {
  require(mintConfig.admin === payer.key, TokenMinterError.Unauthorized);
  associatedTokenAccount.createIfNeeded(payer);
  log("Minting token to associated token account...");
  log("Mint: ");
  log(mintAccount.key);
  log("Token Address: ");
  log(associatedTokenAccount.key);
  let scaled = amount;
  for (let i = 0n; i < u64(mintAccount.decimals); i++) scaled *= 10n;
  tokenProgram.mintTo(mintAccount, associatedTokenAccount, mintAccount, scaled, ["mint", mintAccount.pdaBump]);
  log("Token minted successfully.");
}
