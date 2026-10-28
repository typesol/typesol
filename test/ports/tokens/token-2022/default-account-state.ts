// Port of tokens/token-2022/default-account-state @ de09019; see test/ports/README.md.
//
// PARTIAL: `AnchorAccountState` is the same Borsh enum argument; Uninitialized, which Token-2022 refuses with
// InvalidState, is refused here first with this program's error (6000).
// The mint is created as Anchor's `init` with `extensions::…` does: CreateAccount sized for the extension, the
// extension, InitializeMint2.
import { type HasOne, type Mint, type Mut, type Signer, type SystemProgram, type Token2022Program, rentExempt, require } from "typesol";

/** Base mint (padded to 165) + account type + DefaultAccountState TLV (2 + 2 + 1). */
const MINT_SIZE_DEFAULT_STATE = 171n;

export enum AnchorAccountState {
  Uninitialized,
  Initialized,
  Frozen,
}

export enum DefaultStateError {
  Uninitialized = "Token-2022 refuses Uninitialized as a default account state",
}

export function initialize(payer: Mut<Signer>, mintAccount: Mut<Signer>, tokenProgram: Token2022Program, systemProgram: SystemProgram): void {
  systemProgram.createAccount(payer, mintAccount, rentExempt(MINT_SIZE_DEFAULT_STATE), MINT_SIZE_DEFAULT_STATE, tokenProgram.key);
  tokenProgram.initializeDefaultAccountState(mintAccount, true);
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
  require(accountState !== AnchorAccountState.Uninitialized, DefaultStateError.Uninitialized);
  tokenProgram.updateDefaultAccountState(mintAccount, freezeAuthority, accountState === AnchorAccountState.Frozen);
}
