// Port of tokens/token-2022/permanent-delegate @ de09019; see test/ports/README.md.
//
// PORTED: `init` with `extensions::permanent_delegate` is `mint.create(…, { permanentDelegate })`; the check reads the
// extension with permanentDelegate().
import { type Mint, type Init, type Mut, type Signer, type SystemProgram, type Token2022Program, permanentDelegate, require } from "typesol";

export enum PermanentDelegateError {
  WrongDelegate = "The mint's permanent delegate is not the payer",
}

export function initialize(payer: Mut<Signer>, mintAccount: Init<Mint>, tokenProgram: Token2022Program, systemProgram: SystemProgram): void {
  mintAccount.create(payer, null, 2n, payer.key, null, { permanentDelegate: payer.key });
  require(permanentDelegate(mintAccount) === payer.key, PermanentDelegateError.WrongDelegate);
}
