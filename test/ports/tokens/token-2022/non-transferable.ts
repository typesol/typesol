// Port of tokens/token-2022/non-transferable @ de09019; see test/ports/README.md.
//
// PARTIAL (builtin gap): no Token-2022 extension initializers, so InitializeNonTransferableMint is hand-encoded
// (`invoke`); the rest is the same sequence (CreateAccount sized for the extension, extension, InitializeMint2).
import { type Mut, type Signer, type SystemProgram, type Token2022Program, invoke, rentExempt, u8, writable } from "typesol";

/** Base mint (padded to 165) + account type + NonTransferable TLV (2 + 2 + 0). */
const MINT_SIZE_NON_TRANSFERABLE = 170n;

export function initialize(payer: Mut<Signer>, mintAccount: Mut<Signer>, tokenProgram: Token2022Program, systemProgram: SystemProgram): void {
  systemProgram.createAccount(payer, mintAccount, rentExempt(MINT_SIZE_NON_TRANSFERABLE), MINT_SIZE_NON_TRANSFERABLE, tokenProgram.key);
  // InitializeNonTransferableMint (instruction 32).
  invoke(tokenProgram, [writable(mintAccount)], [u8(32n)]);
  tokenProgram.initializeMint2(mintAccount, 2n, payer.key, payer.key);
}
