// Port of compression/cnft-vault @ de09019; see test/ports/README.md.
//
// The vault PDA ["cNFT-vault"] signs Bubblegum transfers of the cNFTs it owns; the proofs are passed on read-only from
// the remaining accounts (withdraw_two_cnfts splits them at `proof_1_length`: `rest.slice(…)`).
// PARTIAL:
//  - interface: `bubblegum_program` is a Program<…> pinned to Bubblegum's address, where the original takes it unchecked
//    and calls the fixed MPL_BUBBLEGUM_ID.
//  - IDL: the proof lengths are named `proof1_length` / `proof2_length` (snake case of proof1Length), where the original
//    says `proof_1_length` / `proof_2_length`; the instruction bytes are the same.
import {
  type AccountInfo,
  type Hash,
  type Mut,
  type Program,
  type Seeds,
  type SystemProgram,
  type u32,
  type u8,
  hex,
  invoke,
  log,
  readonly,
  readonlySigner,
  remainingAccounts,
  u64,
  writable,
} from "typesol";

export function withdrawCnft(
  treeAuthority: Seeds<Mut<AccountInfo>, ["@merkleTree"], never, "@bubblegumProgram">,
  leafOwner: Seeds<AccountInfo, ["cNFT-vault"]>,
  newLeafOwner: AccountInfo,
  merkleTree: Mut<AccountInfo>,
  logWrapper: AccountInfo,
  compressionProgram: Program<"cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK">,
  bubblegumProgram: Program<"BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY">,
  systemProgram: SystemProgram,
  root: Hash,
  dataHash: Hash,
  creatorHash: Hash,
  nonce: u64,
  index: u32,
): void {
  log(`attempting to send nft ${index} from tree ${merkleTree.key}`);
  // Bubblegum Transfer: tree config, leaf owner (the vault, signing), leaf delegate, new owner, merkle tree, log
  // wrapper, compression program, system program, then the proof.
  invoke(
    bubblegumProgram,
    [
      readonly(treeAuthority),
      readonlySigner(leafOwner),
      readonly(leafOwner),
      readonly(newLeafOwner),
      writable(merkleTree),
      readonly(logWrapper),
      readonly(compressionProgram),
      readonly(systemProgram),
      ...readonly(remainingAccounts()),
    ],
    [hex("a334c8e78c0345ba"), root, dataHash, creatorHash, nonce, index],
    ["cNFT-vault", leafOwner.pdaBump],
  );
}

export function withdrawTwoCnfts(
  treeAuthority1: Seeds<Mut<AccountInfo>, ["@merkleTree1"], never, "@bubblegumProgram">,
  leafOwner: Seeds<AccountInfo, ["cNFT-vault"]>,
  newLeafOwner1: AccountInfo,
  merkleTree1: Mut<AccountInfo>,
  treeAuthority2: Seeds<Mut<AccountInfo>, ["@merkleTree2"], never, "@bubblegumProgram">,
  newLeafOwner2: AccountInfo,
  merkleTree2: Mut<AccountInfo>,
  logWrapper: AccountInfo,
  compressionProgram: Program<"cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK">,
  bubblegumProgram: Program<"BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY">,
  systemProgram: SystemProgram,
  root1: Hash,
  dataHash1: Hash,
  creatorHash1: Hash,
  nonce1: u64,
  index1: u32,
  proof1Length: u8,
  root2: Hash,
  dataHash2: Hash,
  creatorHash2: Hash,
  nonce2: u64,
  index2: u32,
  proof2Length: u8,
): void {
  log(`attempting to send nfts from trees ${merkleTree1.key} and ${merkleTree2.key}`);
  const rest = remainingAccounts();
  log("withdrawing cNFT#1");
  invoke(
    bubblegumProgram,
    [
      readonly(treeAuthority1),
      readonlySigner(leafOwner),
      readonly(leafOwner),
      readonly(newLeafOwner1),
      writable(merkleTree1),
      readonly(logWrapper),
      readonly(compressionProgram),
      readonly(systemProgram),
      ...readonly(rest.slice(0n, u64(proof1Length))),
    ],
    [hex("a334c8e78c0345ba"), root1, dataHash1, creatorHash1, nonce1, index1],
    ["cNFT-vault", leafOwner.pdaBump],
  );
  log("withdrawing cNFT#2");
  invoke(
    bubblegumProgram,
    [
      readonly(treeAuthority2),
      readonlySigner(leafOwner),
      readonly(leafOwner),
      readonly(newLeafOwner2),
      writable(merkleTree2),
      readonly(logWrapper),
      readonly(compressionProgram),
      readonly(systemProgram),
      ...readonly(rest.slice(u64(proof1Length))),
    ],
    [hex("a334c8e78c0345ba"), root2, dataHash2, creatorHash2, nonce2, index2],
    ["cNFT-vault", leafOwner.pdaBump],
  );
  log("successfully sent cNFTs");
}
