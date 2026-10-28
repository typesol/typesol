// Port of tokens/token-2022/permanent-delegate @ de09019; see test/ports/README.md.
//
// PORTED: Anchor's `init` with `extensions::permanent_delegate` is CreateAccount sized for the extension, the
// extension, InitializeMint2; the check reads the extension with permanentDelegate().
import { type Mut, type Signer, type SystemProgram, type Token2022Program, permanentDelegate, rentExempt, require } from "typesol";

/** Base mint (padded to 165) + account type + PermanentDelegate TLV (2 + 2 + 32). */
const MINT_WITH_PERMANENT_DELEGATE = 202n;

export enum PermanentDelegateError {
  WrongDelegate = "The mint's permanent delegate is not the payer",
}

export function initialize(payer: Mut<Signer>, mintAccount: Mut<Signer>, tokenProgram: Token2022Program, systemProgram: SystemProgram): void {
  systemProgram.createAccount(payer, mintAccount, rentExempt(MINT_WITH_PERMANENT_DELEGATE), MINT_WITH_PERMANENT_DELEGATE, tokenProgram.key);
  tokenProgram.initializePermanentDelegate(mintAccount, payer.key);
  tokenProgram.initializeMint2(mintAccount, 2n, payer.key, null);
  require(permanentDelegate(mintAccount) === payer.key, PermanentDelegateError.WrongDelegate);
}
