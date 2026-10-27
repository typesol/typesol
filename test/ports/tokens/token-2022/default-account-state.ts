// Port of tokens/token-2022/default-account-state @ de09019; see test/ports/README.md.
//
// PARTIAL (builtin gap): no Token-2022 extension instructions, so DefaultAccountState Initialize / Update are
// hand-encoded (`invoke`). `AnchorAccountState` is the same Borsh enum (its index is SPL's AccountState value).
import {
  type HasOne,
  type Mint,
  type Mut,
  type Signer,
  type SystemProgram,
  type Token2022Program,
  invoke,
  readonlySigner,
  rentExempt,
  u8,
  writable,
} from "typesol";

/** Base mint (padded to 165) + account type + DefaultAccountState TLV (2 + 2 + 1). */
const MINT_SIZE_DEFAULT_STATE = 171n;

export enum AnchorAccountState {
  Uninitialized,
  Initialized,
  Frozen,
}

export function initialize(payer: Mut<Signer>, mintAccount: Mut<Signer>, tokenProgram: Token2022Program, systemProgram: SystemProgram): void {
  systemProgram.createAccount(payer, mintAccount, rentExempt(MINT_SIZE_DEFAULT_STATE), MINT_SIZE_DEFAULT_STATE, tokenProgram.key);
  // DefaultAccountStateExtension (28) / Initialize (0): new token accounts start frozen.
  invoke(tokenProgram, [writable(mintAccount)], [u8(28n), u8(0n), AnchorAccountState.Frozen]);
  tokenProgram.initializeMint2(mintAccount, 2n, payer.key, payer.key);
}

/** `mint::freeze_authority = freeze_authority` */
export function updateDefaultState(
  freezeAuthority: Mut<Signer>,
  mintAccount: HasOne<Mut<Mint>, "freezeAuthority">,
  tokenProgram: Token2022Program,
  systemProgram: SystemProgram,
  accountState: AnchorAccountState,
): void {
  // DefaultAccountStateExtension (28) / Update (1).
  invoke(tokenProgram, [writable(mintAccount), readonlySigner(freezeAuthority)], [u8(28n), u8(1n), accountState]);
}
