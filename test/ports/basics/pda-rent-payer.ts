// Port of basics/pda-rent-payer @ de09019; see test/ports/README.md.
//
// PARTIAL (interface): `create_new_account` signs for the ["rent_vault"] PDA with `ctx.bumps.rent_vault`, the
// canonical bump Anchor finds while checking `seeds = [b"rent_vault"], bump`. A TypeSOL Seeds<> constraint finds and
// checks the canonical address too but does not expose its bump, so the client passes `bump` and the program checks
// it with requirePda (together the two checks only accept the canonical bump). The System CreateAccount is a raw
// invoke because systemProgram.createAccount takes a Mut<Signer> payer, not a PDA.
import {
  type AccountInfo,
  type Mut,
  type Owner,
  type Seeds,
  type Signer,
  type SystemProgram,
  type u8,
  type u64,
  invoke,
  rentExempt,
  requirePda,
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
  bump: u8,
): void {
  requirePda(rentVault, ["rent_vault"], bump);
  const lamports = rentExempt(0n);
  // System CreateAccount { lamports, space: 0, owner: System Program }, paid by the vault PDA.
  invoke(systemProgram, [writableSigner(rentVault), writableSigner(newAccount)], [u32(0n), lamports, 0n, systemProgram.key], ["rent_vault", bump]);
}
