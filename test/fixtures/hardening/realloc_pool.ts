import { type Init, type Mut, type Pubkey, type Signer, type SystemProgram, type u64, realloc } from "typesol";

/** A shared SOL pool: lamports above rent belong to depositors. */
export interface Pool {
  admin: Pubkey;
  total: u64;
}

export function open(admin: Mut<Signer>, pool: Init<Pool>, systemProgram: SystemProgram): void {
  pool.create(admin, ["pool"]);
  pool.admin = admin.key;
}

export function deposit(user: Mut<Signer>, pool: Mut<Pool>, systemProgram: SystemProgram, amount: u64): void {
  systemProgram.transfer(user, pool, amount);
  pool.total += amount;
}

/** Anyone may pay to grow the pool account (e.g. room for future fields). */
export function expand(payer: Mut<Signer>, pool: Mut<Pool>, systemProgram: SystemProgram, size: u64): void {
  realloc(pool, size, payer);
}
