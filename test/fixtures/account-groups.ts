// Account groups (Anchor's composite accounts: a `#[derive(Accounts)]` struct as a field of another): an interface of
// accounts, used as one parameter by several instructions. Constraints inside a group name its own fields.
import {
  type AccountInfo,
  type HasOne,
  type Init,
  type Mint,
  type Mut,
  type Pubkey,
  type Seeds,
  type Signer,
  type SystemProgram,
  type TokenAccount,
  type TokenInterface,
  type TokenOf,
  type u8,
  type u64,
  constraint,
} from "typesol";

export interface Pool {
  admin: Pubkey;
  vault: Pubkey;
  reserve: u64;
  bump: u8;
}

export enum PoolError {
  ZeroAmount = "amount must be positive",
  NotAdmin = "only the admin withdraws",
}

/** A pool being opened. */
export interface NewPool {
  /** The pool, at ["pool", mint]. */
  pool: Init<Pool>;
  mint: Mint;
  /** Its token account, owned by the pool. */
  vault: TokenOf<TokenAccount, "mint", "pool">;
}

/** What every pool instruction needs. */
export interface PoolAccounts {
  /** The pool at ["pool", mint], holding `vault`. */
  pool: HasOne<Seeds<Mut<Pool>, ["pool", "@mint"], "bump">, "vault">;
  mint: Mint;
  vault: TokenOf<Mut<TokenAccount>, "mint", "pool">;
  tokenProgram: TokenInterface;
  /** Left out with the program id. */
  memo: AccountInfo | null;
}

/** A group's field passes to a helper as any account does. */
function credit(pool: Mut<Pool>, amount: u64): void {
  pool.reserve += amount;
}

export function open(admin: Mut<Signer>, p: NewPool, systemProgram: SystemProgram): void {
  p.pool.bump = p.pool.create(admin, ["pool", p.mint.key]);
  p.pool.admin = admin.key;
  p.pool.vault = p.vault.key;
}

/** Returns 1 when a memo account was passed. */
export function deposit(user: Signer, from: Mut<TokenAccount>, p: PoolAccounts, amount: u64): u64 {
  constraint(p.pool, amount > 0n, PoolError.ZeroAmount);
  p.tokenProgram.transferChecked(from, p.mint, p.vault, user, amount);
  credit(p.pool, amount);
  return p.memo !== null ? 1n : 0n;
}

export function withdraw(admin: Signer, p: PoolAccounts, to: Mut<TokenAccount>, amount: u64): void {
  constraint(p.pool, p.pool.admin === admin.key, PoolError.NotAdmin);
  p.tokenProgram.transferChecked(p.vault, p.mint, to, p.pool, amount, ["pool", p.mint.key, p.pool.bump]);
  p.pool.reserve -= amount;
}
