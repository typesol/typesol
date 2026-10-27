// Port of basics/pda-rent-payer @ de09019; see test/ports/README.md.
//
// PORTED: `create_new_account` signs for the ["rent_vault"] PDA with the bump its Seeds<> check finds (`pdaBump`,
// Anchor's `ctx.bumps.rent_vault`). The System CreateAccount is a raw invoke because systemProgram.createAccount takes
// a Mut<Signer> payer, not a PDA.
import {
  type AccountInfo,
  type Mut,
  type Owner,
  type Seeds,
  type Signer,
  type SystemProgram,
  type u64,
  invoke,
  rentExempt,
  u32,
  writableSigner,
} from "typesol";

export function initRentVault(
  payer: Mut<Signer>,
  rentVault: Seeds<Owner<Mut<AccountInfo>, "11111111111111111111111111111111">, ["rent_vault"]>,
  systemProgram: SystemProgram,
  fundLamports: u64,
): void {
  systemProgram.transfer(payer, rentVault, fundLamports);
}

export function createNewAccount(
  newAccount: Mut<Signer>,
  rentVault: Seeds<Owner<Mut<AccountInfo>, "11111111111111111111111111111111">, ["rent_vault"]>,
  systemProgram: SystemProgram,
): void {
  const lamports = rentExempt(0n);
  // System CreateAccount { lamports, space: 0, owner: System Program }, paid by the vault PDA.
  invoke(systemProgram, [writableSigner(rentVault), writableSigner(newAccount)], [u32(0n), lamports, 0n, systemProgram.key], ["rent_vault", rentVault.pdaBump]);
}
