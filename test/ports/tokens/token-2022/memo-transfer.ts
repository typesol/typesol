// Port of tokens/token-2022/memo-transfer @ de09019; see test/ports/README.md.
//
// PARTIAL (builtin gap): no Token-2022 extension instructions, so MemoTransfer enable / disable are hand-encoded
// (`invoke`); the rest is the same (CreateAccount sized for the extension, InitializeAccount3, then enable).
import {
  type HasOne,
  type Mint,
  type Mut,
  type Signer,
  type SystemProgram,
  type Token2022Program,
  type TokenAccount,
  invoke,
  readonlySigner,
  rentExempt,
  u8,
  writable,
} from "typesol";

/** Base token account (165) + account type (1) + MemoTransfer TLV (2 + 2 + 1). */
const ACCOUNT_SIZE_MEMO_TRANSFER = 171n;

export function initialize(
  payer: Mut<Signer>,
  tokenAccount: Mut<Signer>,
  mintAccount: Mint,
  tokenProgram: Token2022Program,
  systemProgram: SystemProgram,
): void {
  systemProgram.createAccount(payer, tokenAccount, rentExempt(ACCOUNT_SIZE_MEMO_TRANSFER), ACCOUNT_SIZE_MEMO_TRANSFER, tokenProgram.key);
  tokenProgram.initializeAccount3(tokenAccount, mintAccount, payer.key);
  // MemoTransferExtension (30) / Enable (0): incoming transfers need a memo.
  invoke(tokenProgram, [writable(tokenAccount), readonlySigner(payer)], [u8(30n), u8(0n)]);
}

export function disable(owner: Mut<Signer>, tokenAccount: HasOne<Mut<TokenAccount>, "owner">, tokenProgram: Token2022Program): void {
  // MemoTransferExtension (30) / Disable (1).
  invoke(tokenProgram, [writable(tokenAccount), readonlySigner(owner)], [u8(30n), u8(1n)]);
}
