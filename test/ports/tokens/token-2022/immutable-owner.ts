// Port of tokens/token-2022/immutable-owner @ de09019; see test/ports/README.md.
//
// PORTED: Anchor's `init` with `extensions::…` is the same sequence: CreateAccount sized for the extension, the
// extension, InitializeAccount3.
import { type Mint, type Mut, type Signer, type SystemProgram, type Token2022Program, rentExempt } from "typesol";

/** Base token account (165) + account type (1) + ImmutableOwner TLV (2 + 2 + 0). */
const ACCOUNT_SIZE_IMMUTABLE_OWNER = 170n;

export function initialize(
  payer: Mut<Signer>,
  tokenAccount: Mut<Signer>,
  mintAccount: Mint,
  tokenProgram: Token2022Program,
  systemProgram: SystemProgram,
): void {
  systemProgram.createAccount(payer, tokenAccount, rentExempt(ACCOUNT_SIZE_IMMUTABLE_OWNER), ACCOUNT_SIZE_IMMUTABLE_OWNER, tokenProgram.key);
  tokenProgram.initializeImmutableOwner(tokenAccount);
  tokenProgram.initializeAccount3(tokenAccount, mintAccount, payer.key);
}
