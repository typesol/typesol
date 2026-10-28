// Port of compression/cutils @ de09019; see test/ports/README.md.
//
// mint: Bubblegum MintToCollectionV1 with the original's MetadataArgs ("BURGER", one unverified creator, the collection
// unverified, edition nonce 0). verify: the leaf hash (LeafSchema V1, with the asset id derived under Bubblegum) is
// computed here and checked by SPL Account Compression's verify_leaf, the proof passed on read-only.
// PARTIAL:
//  - interface: `bubblegum_program` is pinned to Bubblegum's address. `MintParams` is a `@layout borsh` struct (Anchor's
//    bytes and IDL); its uri holds up to 200 bytes, Bubblegum's own limit.
//  - the `Data` account type of the original's state module is not used by any instruction and is left out.
import {
  type BubblegumProgram,
  type AccountInfo,
  type FixedString,
  type Hash,
  type Mut,
  type Program,
  type Seeds,
  type Signer,
  type SystemProgram,
  type u64,
  findProgramAddress,
  invoke,
  keccak256,
  pubkey,
  readonly,
  remainingAccounts,
  sighash,
  u32,
  u8,
} from "typesol";

const MPL_BUBBLEGUM_ID = pubkey("BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY");

export interface VerifyParams {
  root: Hash;
  dataHash: Hash;
  creatorHash: Hash;
  nonce: u64;
  index: u32;
}

/** @layout borsh */
export interface MintParams {
  uri: FixedString<200>;
}

export function mint(
  payer: Signer,
  treeAuthority: Seeds<Mut<AccountInfo>, ["@merkleTree"], never, "@bubblegumProgram">,
  leafOwner: AccountInfo,
  leafDelegate: AccountInfo,
  merkleTree: Mut<AccountInfo>,
  treeDelegate: Signer,
  collectionAuthority: Signer,
  collectionAuthorityRecordPda: AccountInfo,
  collectionMint: AccountInfo,
  collectionMetadata: Mut<AccountInfo>,
  editionAccount: AccountInfo,
  bubblegumSigner: AccountInfo,
  logWrapper: AccountInfo,
  compressionProgram: Program<"cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK">,
  tokenMetadataProgram: AccountInfo,
  bubblegumProgram: BubblegumProgram,
  systemProgram: SystemProgram,
  params: MintParams,
): void {
  // MetadataArgs as the original's: seller fee 0, immutable, edition nonce Some(0), the collection authority as the
  // one unverified creator.
  bubblegumProgram.mintToCollection(
    treeAuthority,
    leafOwner,
    leafDelegate,
    merkleTree,
    payer,
    treeDelegate,
    collectionAuthority,
    collectionAuthorityRecordPda,
    collectionMint,
    collectionMetadata,
    editionAccount,
    bubblegumSigner,
    logWrapper,
    compressionProgram,
    tokenMetadataProgram,
    systemProgram,
    {
      name: "BURGER",
      symbol: "BURG",
      uri: params.uri,
      sellerFeeBasisPoints: 0n,
      isMutable: false,
      editionNonce: 0n,
      creators: [{ address: collectionAuthority.key, verified: false, share: 100n }],
    },
  );
}

export function verify(
  leafOwner: Signer,
  leafDelegate: AccountInfo,
  merkleTree: AccountInfo,
  compressionProgram: Program<"cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK">,
  params: VerifyParams,
): void {
  const assetId = findProgramAddress(["asset", merkleTree.key, params.nonce], MPL_BUBBLEGUM_ID);
  const leafHash = keccak256(u8(1n), assetId, leafOwner.key, leafDelegate.key, params.nonce, params.dataHash, params.creatorHash);
  // SPL Account Compression verify_leaf: root, leaf, index; the merkle tree, then the proof.
  invoke(compressionProgram, [readonly(merkleTree), ...readonly(remainingAccounts())], [sighash("verifyLeaf"), params.root, leafHash, params.index]);
}
