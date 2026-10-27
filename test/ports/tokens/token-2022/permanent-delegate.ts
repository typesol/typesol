// Port of tokens/token-2022/permanent-delegate @ de09019; see test/ports/README.md.
//
// PARTIAL (builtin gap): no Token-2022 extension initializers, so InitializePermanentDelegate is hand-encoded
// (`invoke`); the check reads the extension with permanentDelegate().
import { type Mut, type Signer, type SystemProgram, type Token2022Program, invoke, permanentDelegate, rentExempt, require, u8, writable } from "typesol";

/** Base mint (padded to 165) + account type + PermanentDelegate TLV (2 + 2 + 32). */
const MINT_WITH_PERMANENT_DELEGATE = 202n;

export enum PermanentDelegateError {
  WrongDelegate = "The mint's permanent delegate is not the payer",
}

export function initialize(payer: Mut<Signer>, mintAccount: Mut<Signer>, tokenProgram: Token2022Program, systemProgram: SystemProgram): void {
  systemProgram.createAccount(payer, mintAccount, rentExempt(MINT_WITH_PERMANENT_DELEGATE), MINT_WITH_PERMANENT_DELEGATE, tokenProgram.key);
  // InitializePermanentDelegate (instruction 35).
  invoke(tokenProgram, [writable(mintAccount)], [u8(35n), payer.key]);
  tokenProgram.initializeMint2(mintAccount, 2n, payer.key, null);
  require(permanentDelegate(mintAccount) === payer.key, PermanentDelegateError.WrongDelegate);
}
