// Port of tokens/nft-operations @ de09019; see test/ports/README.md.
//
// PARTIAL:
//  - builtin gap: TypeSOL's Token Metadata support is createV3 without creators / collection / collection details,
//    and has no CreateMasterEditionV3 or Verify. CreateMetadataAccountV3 (with a verified creator, a collection,
//    CollectionDetails::V1), CreateMasterEditionV3 and Verify(CollectionV1) are hand-encoded (`invoke`) with the
//    same accounts and Borsh data as the mpl-token-metadata CPI builders. The new mint and its ATA are created in the
//    body, so MintTo is hand-encoded as well.
//  - `Account<MetadataAccount>` / `Account<MasterEditionAccount>` are checked as Token Metadata-owned accounts whose
//    first byte is the Metadata (4) / MasterEditionV2 (6) key. A wrong key fails with this program's NotMetadata /
//    NotMasterEdition (6000 / 6001), where Anchor fails deserializing with AccountDidNotDeserialize (3003).
import {
  type AccountInfo,
  type Address,
  type AssociatedTokenProgram,
  type Ata,
  type Mint,
  type Mut,
  type Owner,
  type Program,
  type Seeds,
  type Signer,
  type SystemProgram,
  type TokenProgram,
  MINT_SIZE,
  invoke,
  log,
  readData,
  readonly,
  readonlySigner,
  rentExempt,
  require,
  u8,
  u16,
  u32,
  writable,
  writableSigner,
} from "typesol";

export enum NftError {
  NotMetadata = "Not a Token Metadata account",
  NotMasterEdition = "Not a Token Metadata master edition account",
}

export function createCollection(
  user: Mut<Signer>,
  mint: Mut<Signer>,
  mintAuthority: Seeds<AccountInfo, ["authority"]>,
  metadata: Mut<AccountInfo>,
  masterEdition: Mut<AccountInfo>,
  destination: Ata<Mut<AccountInfo>, "user", "mint">,
  systemProgram: SystemProgram,
  tokenProgram: TokenProgram,
  associatedTokenProgram: AssociatedTokenProgram,
  tokenMetadataProgram: Program<"metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s">,
): void {
  // `init, mint::decimals = 0, mint::authority = mint_authority, mint::freeze_authority = mint_authority`
  systemProgram.createAccount(user, mint, rentExempt(MINT_SIZE), MINT_SIZE, tokenProgram.key);
  tokenProgram.initializeMint2(mint, 0n, mintAuthority.key, mintAuthority.key);
  associatedTokenProgram.create(user, destination, user, mint, systemProgram, tokenProgram);
  // SPL Token MintTo (7): one collection NFT.
  invoke(tokenProgram, [writable(mint), writable(destination), readonlySigner(mintAuthority)], [u8(7n), 1n], ["authority", mintAuthority.pdaBump]);
  log("Collection NFT minted!");
  // CreateMetadataAccountV3 (33): DataV2 with one verified creator, no collection, CollectionDetails::V1 { size: 0 }.
  invoke(
    tokenMetadataProgram,
    [writable(metadata), readonly(mint), readonlySigner(mintAuthority), writableSigner(user), readonlySigner(mintAuthority), readonly(systemProgram)],
    [u8(33n), "DummyCollection", "DC", "", u16(0n), u8(1n), u32(1n), mintAuthority.key, true, u8(100n), u8(0n), u8(0n), true, u8(1n), u8(0n), 0n],
    ["authority", mintAuthority.pdaBump],
  );
  log("Metadata Account created!");
  // CreateMasterEditionV3 (17) with max_supply Some(0).
  invoke(
    tokenMetadataProgram,
    [
      writable(masterEdition),
      writable(mint),
      readonlySigner(mintAuthority),
      readonlySigner(mintAuthority),
      writableSigner(user),
      writable(metadata),
      readonly(tokenProgram),
      readonly(systemProgram),
    ],
    [u8(17n), u8(1n), 0n],
    ["authority", mintAuthority.pdaBump],
  );
  log("Master Edition Account created");
}

export function mintNft(
  owner: Mut<Signer>,
  mint: Mut<Signer>,
  destination: Ata<Mut<AccountInfo>, "owner", "mint">,
  metadata: Mut<AccountInfo>,
  masterEdition: Mut<AccountInfo>,
  mintAuthority: Seeds<AccountInfo, ["authority"]>,
  collectionMint: Mut<Mint>,
  systemProgram: SystemProgram,
  tokenProgram: TokenProgram,
  associatedTokenProgram: AssociatedTokenProgram,
  tokenMetadataProgram: Program<"metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s">,
): void {
  systemProgram.createAccount(owner, mint, rentExempt(MINT_SIZE), MINT_SIZE, tokenProgram.key);
  tokenProgram.initializeMint2(mint, 0n, mintAuthority.key, mintAuthority.key);
  associatedTokenProgram.create(owner, destination, owner, mint, systemProgram, tokenProgram);
  invoke(tokenProgram, [writable(mint), writable(destination), readonlySigner(mintAuthority)], [u8(7n), 1n], ["authority", mintAuthority.pdaBump]);
  log("Collection NFT minted!");
  // CreateMetadataAccountV3 (33): one verified creator, an unverified collection, mutable, no collection details.
  invoke(
    tokenMetadataProgram,
    [writable(metadata), readonly(mint), readonlySigner(mintAuthority), writableSigner(owner), readonlySigner(mintAuthority), readonly(systemProgram)],
    [u8(33n), "Mint Test", "YAY", "", u16(0n), u8(1n), u32(1n), mintAuthority.key, true, u8(100n), u8(1n), false, collectionMint.key, u8(0n), true, u8(0n)],
    ["authority", mintAuthority.pdaBump],
  );
  log("Metadata Account created!");
  invoke(
    tokenMetadataProgram,
    [
      writable(masterEdition),
      writable(mint),
      readonlySigner(mintAuthority),
      readonlySigner(mintAuthority),
      writableSigner(owner),
      writable(metadata),
      readonly(tokenProgram),
      readonly(systemProgram),
    ],
    [u8(17n), u8(1n), 0n],
    ["authority", mintAuthority.pdaBump],
  );
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
  tokenMetadataProgram: Program<"metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s">,
): void {
  require(readData<u8>(metadata, 0n) === 4n && readData<u8>(collectionMetadata, 0n) === 4n, NftError.NotMetadata);
  require(readData<u8>(collectionMasterEdition, 0n) === 6n, NftError.NotMasterEdition);
  // Verify (52) with VerificationArgs::CollectionV1; the absent delegate record is the program id.
  invoke(
    tokenMetadataProgram,
    [
      readonlySigner(mintAuthority),
      readonly(tokenMetadataProgram),
      writable(metadata),
      readonly(collectionMint),
      writable(collectionMetadata),
      readonly(collectionMasterEdition),
      readonly(systemProgram),
      readonly(sysvarInstruction),
    ],
    [u8(52n), u8(1n)],
    ["authority", mintAuthority.pdaBump],
  );
  log("Collection Verified!");
}
