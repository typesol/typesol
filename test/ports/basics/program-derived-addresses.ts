// Port of basics/program-derived-addresses @ de09019; see test/ports/README.md.
//
// PORTED.
import { type AccountInfo, type Init, type Mut, type Owner, type Seeds, type Signer, type SystemProgram, type u8, type u32 } from "typesol";

const SEED_PREFIX = "page_visits";

export interface PageVisits {
  pageVisits: u32;
  bump: u8;
}

export function createPageVisits(payer: Mut<Signer>, pageVisits: Init<PageVisits>, systemProgram: SystemProgram): void {
  pageVisits.bump = pageVisits.create(payer, [SEED_PREFIX, payer.key]);
  pageVisits.pageVisits = 0n;
}

/** `user` is a SystemAccount: owned by the System Program. */
export function incrementPageVisits(
  user: Owner<AccountInfo, "11111111111111111111111111111111">,
  pageVisits: Seeds<Mut<PageVisits>, ["page_visits", "@user"], "bump">,
): void {
  pageVisits.pageVisits += 1n;
}
