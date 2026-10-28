// Port of tokens/nft-operations @ de09019; see test/ports/README.md.
//
// PARTIAL:
//  - `Account<MetadataAccount>` / `Account<MasterEditionAccount>` are checked as Token Metadata-owned accounts whose
//    first byte is the Metadata (4) / MasterEditionV2 (6) key. A wrong key fails with this program's NotMetadata /
//    NotMasterEdition (6000 / 6001), where Anchor fails deserializing with AccountDidNotDeserialize (3003).
import {
  type AccountInfo,
  type Address,
  type AssociatedTokenProgram,
  type Ata,
  type Init,
  type Mint,
  type Mut,
  type Owner,
  type Seeds,
  type Signer,
  type SystemProgram,
  type TokenMetadataProgram,
  type TokenAccount,
  type TokenProgram,
  log,
  readData,
  require,
  u8,
} from "typesol";

export enum NftError {
  NotMetadata = "Not a Token Metadata account",
  NotMasterEdition = "Not a Token Metadata master edition account",
}

export function createCollection(
  user: Mut<Signer>,
  mint: Init<Mint>,
  mintAuthority: Seeds<AccountInfo, ["authority"]>,
  metadata: Mut<AccountInfo>,
  masterEdition: Mut<AccountInfo>,
  destination: Ata<Init<TokenAccount>, "user", "mint">,
  systemProgram: SystemProgram,
  tokenProgram: TokenProgram,
  associatedTokenProgram: AssociatedTokenProgram,
  tokenMetadataProgram: TokenMetadataProgram,
): void {
  // `init, mint::decimals = 0, mint::authority = mint_authority, mint::freeze_authority = mint_authority`
  mint.create(user, null, 0n, mintAuthority.key, mintAuthority.key);
  destination.create(user);
  tokenProgram.mintTo(mint, destination, mintAuthority, 1n, ["authority", mintAuthority.pdaBump]);
  log("Collection NFT minted!");
  tokenMetadataProgram.createV3(
    metadata,
    mint,
    mintAuthority,
    user,
    mintAuthority,
    systemProgram,
    "DummyCollection",
    "DC",
    "",
    0n,
    true,
    {
      creators: [{ address: mintAuthority.key, verified: true, share: 100n }],
      isCollection: true,
    },
    ["authority", mintAuthority.pdaBump],
  );
  log("Metadata Account created!");
  tokenMetadataProgram.createMasterEditionV3(masterEdition, mint, mintAuthority, mintAuthority, user, metadata, tokenProgram, systemProgram, 0n, [
    "authority",
    mintAuthority.pdaBump,
  ]);
  log("Master Edition Account created");
}

export function mintNft(
  owner: Mut<Signer>,
  mint: Init<Mint>,
  destination: Ata<Init<TokenAccount>, "owner", "mint">,
  metadata: Mut<AccountInfo>,
  masterEdition: Mut<AccountInfo>,
  mintAuthority: Seeds<AccountInfo, ["authority"]>,
  collectionMint: Mut<Mint>,
  systemProgram: SystemProgram,
  tokenProgram: TokenProgram,
  associatedTokenProgram: AssociatedTokenProgram,
  tokenMetadataProgram: TokenMetadataProgram,
): void {
  mint.create(owner, null, 0n, mintAuthority.key, mintAuthority.key);
  destination.create(owner);
  tokenProgram.mintTo(mint, destination, mintAuthority, 1n, ["authority", mintAuthority.pdaBump]);
  log("Collection NFT minted!");
  tokenMetadataProgram.createV3(
    metadata,
    mint,
    mintAuthority,
    owner,
    mintAuthority,
    systemProgram,
    "Mint Test",
    "YAY",
    "",
    0n,
    true,
    {
      creators: [{ address: mintAuthority.key, verified: true, share: 100n }],
      collection: collectionMint.key,
    },
    ["authority", mintAuthority.pdaBump],
  );
  log("Metadata Account created!");
  tokenMetadataProgram.createMasterEditionV3(masterEdition, mint, mintAuthority, mintAuthority, owner, metadata, tokenProgram, systemProgram, 0n, [
    "authority",
    mintAuthority.pdaBump,
  ]);
  log("Master Edition Account created");
}

export function verifyCollection(
  authority: Signer,
  metadata: Owner<Mut<AccountInfo>, "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s">,
  mint: Owner<Mint, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">,
  mintAuthority: Seeds<AccountInfo, ["authority"]>,
  collectionMint: Owner<Mint, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">,
  collectionMetadata: Owner<Mut<AccountInfo>, "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s">,
  collectionMasterEdition: Owner<AccountInfo, "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s">,
  systemProgram: SystemProgram,
  sysvarInstruction: Address<AccountInfo, "Sysvar1nstructions1111111111111111111111111">,
  tokenMetadataProgram: TokenMetadataProgram,
): void {
  require(readData<u8>(metadata, 0n) === 4n && readData<u8>(collectionMetadata, 0n) === 4n, NftError.NotMetadata);
  require(readData<u8>(collectionMasterEdition, 0n) === 6n, NftError.NotMasterEdition);
  tokenMetadataProgram.verifyCollection(
    mintAuthority,
    metadata,
    collectionMint,
    collectionMetadata,
    collectionMasterEdition,
    systemProgram,
    sysvarInstruction,
    ["authority", mintAuthority.pdaBump],
  );
  log("Collection Verified!");
}
