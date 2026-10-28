// Port of compression/cnft-burn @ de09019; see test/ports/README.md.
//
// The proof is passed on read-only from the remaining accounts, as the original pushes every remaining account read-only.
// PARTIAL (interface): `bubblegum_program` is a Program<…> pinned to Bubblegum's address, where the original takes it
// unchecked and calls the fixed MPL_BUBBLEGUM_ID (another address fails there because the program is missing from the
// CPI; here it fails the address check).
import {
  type BubblegumProgram,
  type AccountInfo,
  type Hash,
  type Mut,
  type Program,
  type Seeds,
  type Signer,
  type SystemProgram,
  type u32,
  type u64,
  remainingAccounts,
} from "typesol";

export function burnCnft(
  leafOwner: Mut<Signer>,
  treeAuthority: Seeds<Mut<AccountInfo>, ["@merkleTree"], never, "@bubblegumProgram">,
  merkleTree: Mut<AccountInfo>,
  logWrapper: AccountInfo,
  compressionProgram: Program<"cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK">,
  bubblegumProgram: BubblegumProgram,
  systemProgram: SystemProgram,
  root: Hash,
  dataHash: Hash,
  creatorHash: Hash,
  nonce: u64,
  index: u32,
): void {
  bubblegumProgram.burn(
    treeAuthority,
    leafOwner,
    leafOwner,
    merkleTree,
    logWrapper,
    compressionProgram,
    systemProgram,
    { root, dataHash, creatorHash, nonce, index },
    remainingAccounts(),
  );
}
