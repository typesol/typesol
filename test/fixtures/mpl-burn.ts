// Token Metadata BurnV1 of an NFT this program's PDA ["vault"] holds.
import {
  type AccountInfo,
  type AssociatedTokenProgram,
  type Ata,
  type Init,
  type Mint,
  type Mut,
  type Seeds,
  type Signer,
  type SystemProgram,
  type TokenAccount,
  type TokenMetadataProgram,
  type TokenProgram,
} from "typesol";

/** An NFT (mint, metadata, master edition) minted into the vault's associated token account. */
export function mintToVault(
  user: Mut<Signer>,
  mint: Init<Mint>,
  authority: Seeds<AccountInfo, ["authority"]>,
  vault: Seeds<AccountInfo, ["vault"]>,
  token: Ata<Init<TokenAccount>, "vault", "mint">,
  metadata: Mut<AccountInfo>,
  edition: Mut<AccountInfo>,
  systemProgram: SystemProgram,
  tokenProgram: TokenProgram,
  associatedTokenProgram: AssociatedTokenProgram,
  metadataProgram: TokenMetadataProgram,
): void {
  mint.create(user, null, 0n, authority.key, authority.key);
  token.create(user);
  tokenProgram.mintTo(mint, token, authority, 1n, ["authority", authority.pdaBump]);
  metadataProgram.createV3(metadata, mint, authority, user, authority, systemProgram, "Burnable", "BRN", "", 0n, true, ["authority", authority.pdaBump]);
  metadataProgram.createMasterEditionV3(edition, mint, authority, authority, user, metadata, tokenProgram, systemProgram, 0n, ["authority", authority.pdaBump]);
}

/** The vault burns the NFT it holds; the rent of the token account, metadata and edition goes to it. */
export function burnFromVault(
  vault: Seeds<Mut<AccountInfo>, ["vault"]>,
  metadata: Mut<AccountInfo>,
  edition: Mut<AccountInfo>,
  mint: Mut<AccountInfo>,
  token: Mut<AccountInfo>,
  systemProgram: SystemProgram,
  instructions: AccountInfo,
  tokenProgram: TokenProgram,
  metadataProgram: TokenMetadataProgram,
): void {
  metadataProgram.burnV1(vault, metadata, edition, mint, token, null, systemProgram, instructions, tokenProgram, 1n, ["vault", vault.pdaBump]);
}
