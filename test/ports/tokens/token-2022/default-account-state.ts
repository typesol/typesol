// Port of tokens/token-2022/default-account-state @ de09019; see test/ports/README.md.
//
// PARTIAL: `AnchorAccountState` is the same Borsh enum argument; Uninitialized, which Token-2022 refuses with
// InvalidState, is refused here first with this program's error (6000).
// The mint's `init` with `extensions::default_account_state` is `mint.create(…, { defaultAccountState: true })`.
import { type Init, type HasOne, type Mint, type Mut, type Signer, type SystemProgram, type Token2022Program, require } from "typesol";

export enum AnchorAccountState {
  Uninitialized,
  Initialized,
  Frozen,
}

export enum DefaultStateError {
  Uninitialized = "Token-2022 refuses Uninitialized as a default account state",
}

export function initialize(payer: Mut<Signer>, mintAccount: Init<Mint>, tokenProgram: Token2022Program, systemProgram: SystemProgram): void {
  mintAccount.create(payer, null, 2n, payer.key, payer.key, { defaultAccountState: true });
}

/** `mint::freeze_authority = freeze_authority` */
export function updateDefaultState(
  freezeAuthority: Mut<Signer>,
  mintAccount: HasOne<Mut<Mint>, "freezeAuthority">,
  tokenProgram: Token2022Program,
  systemProgram: SystemProgram,
  accountState: AnchorAccountState,
): void {
  require(accountState !== AnchorAccountState.Uninitialized, DefaultStateError.Uninitialized);
  tokenProgram.updateDefaultAccountState(mintAccount, freezeAuthority, accountState === AnchorAccountState.Frozen);
}
