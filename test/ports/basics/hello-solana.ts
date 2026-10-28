// Port of basics/hello-solana @ de09019; see test/ports/README.md.
//
// FULL: `id()` is the declared address, as with declare_id!; a Pubkey in a template is base58, as `{}` prints it.
import { log, pubkey } from "typesol";

const PROGRAM_ID = pubkey("2phbC62wekpw95XuBk4i1KX4uA8zBUWmYbiTMhicSuBV");

export function hello(): void {
  log("Hello, Solana!");
  log(`Our program's Program ID: ${PROGRAM_ID}`);
}
