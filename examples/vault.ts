import {
  type Init,
  type Mut,
  type Pubkey,
  type Signer,
  type SystemProgram,
  type u8,
  type u64,
  close,
  minimumBalance,
  require,
} from "typesol";

/** A personal SOL vault at PDA ["vault", owner]. Lamports above rent are the balance. */
export interface Vault {
  owner: Pubkey;
  deposited: u64;
  withdrawn: u64;
  bump: u8;
}

export enum VaultError {
  NotOwner = "Only the vault owner can do this",
  ZeroAmount = "Amount must be greater than zero",
  InsufficientFunds = "Withdrawal would dip below the rent-exempt minimum",
}

export function open(owner: Mut<Signer>, vault: Init<Vault>, systemProgram: SystemProgram): void {
  vault.bump = vault.create(owner, ["vault", owner.key]);
  vault.owner = owner.key;
}

export function deposit(owner: Mut<Signer>, vault: Mut<Vault>, systemProgram: SystemProgram, amount: u64): void {
  require(amount > 0n, VaultError.ZeroAmount);
  require(vault.owner === owner.key, VaultError.NotOwner);
  systemProgram.transfer(owner, vault, amount);
  vault.deposited += amount;
}

export function withdraw(owner: Mut<Signer>, vault: Mut<Vault>, amount: u64): void {
  require(amount > 0n, VaultError.ZeroAmount);
  require(vault.owner === owner.key, VaultError.NotOwner);
  const floor = minimumBalance(vault);
  require(vault.lamports - amount >= floor, VaultError.InsufficientFunds);
  // The vault is owned by this program, so it can move lamports directly.
  vault.lamports -= amount;
  owner.lamports += amount;
  vault.withdrawn += amount;
}

/** Close the vault and return everything, rent included, to the owner. */
export function shut(owner: Mut<Signer>, vault: Mut<Vault>): void {
  require(vault.owner === owner.key, VaultError.NotOwner);
  close(vault, owner);
}
