// Port of tokens/token-2022/non-transferable @ de09019; see test/ports/README.md.
//
// PORTED: `init` with `extensions::non_transferable` is `mint.create(…, { nonTransferable: true })`.
import { type Mint, type Init, type Mut, type Signer, type SystemProgram, type Token2022Program } from "typesol";

export function initialize(payer: Mut<Signer>, mintAccount: Init<Mint>, tokenProgram: Token2022Program, systemProgram: SystemProgram): void {
  mintAccount.create(payer, null, 2n, payer.key, payer.key, { nonTransferable: true });
}
