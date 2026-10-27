// Port of compression/cutils @ de09019; see test/ports/README.md.
//
// mint: Bubblegum MintToCollectionV1 with the original's MetadataArgs ("BURGER", one unverified creator, the collection
// unverified, edition nonce 0). verify: the leaf hash (LeafSchema V1, with the asset id derived under Bubblegum) is
// computed here and checked by SPL Account Compression's verify_leaf, the proof passed on read-only.
// PARTIAL:
//  - interface: `mint` takes `uri` as an argument instead of a MintParams struct (same instruction bytes, different
//    IDL), since struct arguments need a fixed layout. `bubblegum_program` is pinned to Bubblegum's address.
//  - the `Data` account type of the original's state module is not used by any instruction and is left out.
import {
  type AccountInfo,
  type Hash,
  type Mut,
  type Program,
  type Seeds,
  type Signer,
  type SystemProgram,
  type u64,
  findProgramAddress,
  hex,
  invoke,
  keccak256,
  pubkey,
  readonly,
  readonlySigner,
  remainingAccounts,
  sighash,
  u16,
  u32,
  u8,
  writable,
} from "typesol";

const MPL_BUBBLEGUM_ID = pubkey("BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY");

export interface VerifyParams {
  root: Hash;
  dataHash: Hash;
  creatorHash: Hash;
  nonce: u64;
  index: u32;
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
  bubblegumProgram: Program<"BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY">,
  systemProgram: SystemProgram,
  uri: string,
): void {
  // MintToCollectionV1 with MetadataArgs: name, symbol, uri, seller fee 0, primary sale false, immutable,
  // edition nonce Some(0), token standard Some(NonFungible), collection Some({ verified: false, key }), uses None,
  // token program version Original, creators [{ collection authority, unverified, 100 }].
  invoke(
    bubblegumProgram,
    [
      writable(treeAuthority),
      readonly(leafOwner),
      readonly(leafDelegate),
      writable(merkleTree),
      readonlySigner(payer),
      readonlySigner(treeDelegate),
      readonlySigner(collectionAuthority),
      readonly(collectionAuthorityRecordPda),
      readonly(collectionMint),
      writable(collectionMetadata),
      readonly(editionAccount),
      readonly(bubblegumSigner),
      readonly(logWrapper),
      readonly(compressionProgram),
      readonly(tokenMetadataProgram),
      readonly(systemProgram),
    ],
    [
      hex("9912b22fc59e560f"),
      "BURGER",
      "BURG",
      uri,
      u16(0n),
      false,
      false,
      u8(1n),
      u8(0n),
      u8(1n),
      u8(0n),
      u8(1n),
      false,
      collectionMint.key,
      u8(0n),
      u8(0n),
      u32(1n),
      collectionAuthority.key,
      false,
      u8(100n),
    ],
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
