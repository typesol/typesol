// Port of basics/transfer-sol @ de09019; see test/ports/README.md.
//
// PORTED. `SystemAccount` is an AccountInfo owned by the System Program; `owner = id()` pins this program's address.
import { type AccountInfo, type Mut, type Owner, type Signer, type SystemProgram, type u64 } from "typesol";

export function transferSolWithCpi(
  payer: Mut<Signer>,
  recipient: Owner<Mut<AccountInfo>, "11111111111111111111111111111111">,
  systemProgram: SystemProgram,
  amount: u64,
): void {
  systemProgram.transfer(payer, recipient, amount);
}

/** Moves lamports directly: only possible because `payer` is owned by this program. Underflow aborts. */
export function transferSolWithProgram(
  payer: Owner<Mut<Signer>, "4fQVnLWKKKYxtxgGn7Haw8v2g2Hzbu8K61JvWKvqAi7W">,
  recipient: Owner<Mut<AccountInfo>, "11111111111111111111111111111111">,
  amount: u64,
): void {
  payer.lamports -= amount;
  recipient.lamports += amount;
}
