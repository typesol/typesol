// IDL docs, clock slot/epoch, Owner/Executable/Seeds-program constraints, ProgramData.
import {
  type AccountInfo,
  type Executable,
  type Owner,
  type ProgramData,
  type Seeds,
  type Signer,
  type u64,
  currentEpoch,
  currentSlot,
  require,
} from "typesol";

/** A record kept by the program. */
export interface Note {
  /** Who wrote it. */
  author: u64;
}

/**
 * Packs the clock: slot * 1000 + epoch.
 * Second line of docs.
 */
export function clock(): u64 {
  return currentSlot() * 1000n + currentEpoch();
}

/**
 * Only token accounts and programs.
 * @param tokenAccount - any account owned by SPL Token
 * @param program an executable account
 */
export function owners(tokenAccount: Owner<AccountInfo, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">, program: Executable<AccountInfo>): void {}

/** The Metaplex metadata PDA of `mint`, derived under the metadata program. */
export function metadataOf(
  metadata: Seeds<AccountInfo, ["metadata", "@metadataProgram", "@mint"], never, "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s">,
  metadataProgram: AccountInfo,
  mint: AccountInfo,
): void {}

/** The same PDA, with the deriving program given as a parameter. */
export function metadataVia(metadata: Seeds<AccountInfo, ["metadata", "@metadataProgram", "@mint"], "", "@metadataProgram">, metadataProgram: AccountInfo, mint: AccountInfo): void {}

/** Only the upgrade authority may call this. */
export function adminOnly(programData: ProgramData, admin: Signer): u64 {
  require(programData.upgradeAuthority === admin.key, "not the upgrade authority");
  return programData.deploySlot;
}
