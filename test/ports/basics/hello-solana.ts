// Port of basics/hello-solana @ de09019; see test/ports/README.md.
//
// PARTIAL (logs): `msg!("Our program's Program ID: {}", &id())` is one log line in Anchor; TypeSOL templates cannot
// format a Pubkey yet, so the label and the address are two lines. `id()` is the declared address, as with declare_id!.
import { log, pubkey } from "typesol";

const PROGRAM_ID = pubkey("2phbC62wekpw95XuBk4i1KX4uA8zBUWmYbiTMhicSuBV");

export function hello(): void {
  log("Hello, Solana!");
  log("Our program's Program ID: ");
  log(PROGRAM_ID);
}
