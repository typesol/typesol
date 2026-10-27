// Port of tokens/pda-mint-authority @ de09019; see test/ports/README.md.
//
// PARTIAL:
//  - interface: the mint is the PDA ["mint"] and signs as its own mint authority with `ctx.bumps.mint_account`.
//    A TypeSOL Seeds<> constraint checks the canonical address but does not expose the bump, so both instructions
//    take a `mint_bump` argument checked with requirePda (together: only the canonical bump passes).
//  - builtin gap: the payer's associated token account is `init_if_needed`; MintTo into it is hand-encoded
//    (`invoke`) because an account created in the body is an AccountInfo to TypeSOL.
//  - logs: address lines are split in two (no Pubkeys in templates).
import {
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
  MINT_SIZE,
  invoke,
  log,
  readonlySigner,
  rentExempt,
  require,
  requirePda,
  u8,
  u64,
  writable,
} from "typesol";

export interface MintConfig {
  admin: Pubkey;
}

export enum TokenMinterError {
  Unauthorized = "Only the admin recorded at token creation may mint",
}

export function createToken(
  payer: Mut<Signer>,
  mintAccount: Seeds<Mut<AccountInfo>, ["mint"]>,
  metadataAccount: Seeds<Mut<AccountInfo>, ["metadata", "@tokenMetadataProgram", "@mintAccount"], never, "@tokenMetadataProgram">,
  mintConfig: Init<MintConfig>,
  tokenProgram: TokenProgram,
  tokenMetadataProgram: TokenMetadataProgram,
  systemProgram: SystemProgram,
  rent: Address<AccountInfo, "SysvarRent111111111111111111111111111111111">,
  tokenName: string,
  tokenSymbol: string,
  tokenUri: string,
  mintBump: u8,
): void {
  requirePda(mintAccount, ["mint"], mintBump);
  // `init, seeds = [b"mint"], mint::decimals = 9, mint::authority = mint_account, mint::freeze_authority = mint_account`
  systemProgram.createAccount(payer, mintAccount, rentExempt(MINT_SIZE), MINT_SIZE, tokenProgram.key, ["mint", mintBump]);
  tokenProgram.initializeMint2(mintAccount, 9n, mintAccount.key, mintAccount.key);
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
  associatedTokenAccount: Ata<Mut<AccountInfo>, "payer", "mintAccount">,
  tokenProgram: TokenProgram,
  associatedTokenProgram: AssociatedTokenProgram,
  systemProgram: SystemProgram,
  amount: u64,
  mintBump: u8,
): void {
  require(mintConfig.admin === payer.key, TokenMinterError.Unauthorized);
  requirePda(mintAccount, ["mint"], mintBump);
  associatedTokenProgram.createIdempotent(payer, associatedTokenAccount, payer, mintAccount, systemProgram, tokenProgram);
  log("Minting token to associated token account...");
  log("Mint: ");
  log(mintAccount.key);
  log("Token Address: ");
  log(associatedTokenAccount.key);
  let scaled = amount;
  for (let i = 0n; i < u64(mintAccount.decimals); i++) scaled *= 10n;
  // SPL Token MintTo (instruction 7), signed by the mint PDA.
  invoke(tokenProgram, [writable(mintAccount), writable(associatedTokenAccount), readonlySigner(mintAccount)], [u8(7n), scaled], ["mint", mintBump]);
  log("Token minted successfully.");
}
