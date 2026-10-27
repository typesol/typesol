// Port of compression/cnft-burn @ de09019; see test/ports/README.md.
//
// The proof is passed on as `...readonly(remainingAccounts())`, as the original pushes every remaining account read-only.
// PARTIAL (interface): `bubblegum_program` is a Program<…> pinned to Bubblegum's address, where the original takes it
// unchecked and calls the fixed MPL_BUBBLEGUM_ID (another address fails there because the program is missing from the
// CPI; here it fails the address check).
import {
  type AccountInfo,
  type Hash,
  type Mut,
  type Program,
  type Seeds,
  type Signer,
  type SystemProgram,
  type u32,
  type u64,
  hex,
  invoke,
  readonly,
  readonlySigner,
  remainingAccounts,
  writable,
} from "typesol";

export function burnCnft(
  leafOwner: Mut<Signer>,
  treeAuthority: Seeds<Mut<AccountInfo>, ["@merkleTree"], never, "@bubblegumProgram">,
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
  // Bubblegum Burn: tree authority, leaf owner (signing), leaf delegate, merkle tree, log wrapper, compression
  // program, system program, then the proof.
  invoke(
    bubblegumProgram,
    [
      readonly(treeAuthority),
      readonlySigner(leafOwner),
      readonly(leafOwner),
      writable(merkleTree),
      readonly(logWrapper),
      readonly(compressionProgram),
      readonly(systemProgram),
      ...readonly(remainingAccounts()),
    ],
    [hex("746e1d386bdb2a5d"), root, dataHash, creatorHash, nonce, index],
  );
}
