import { type Init, type Mut, type Option, type Pubkey, type Signer, type SystemProgram, type u64, type u8, log } from "typesol";

export interface Prefs {
  bump: u8;
  limit: Option<u64>;
  owner: Option<Pubkey>;
  hits: u64;
}

export function setup(admin: Mut<Signer>, prefs: Init<Prefs>, systemProgram: SystemProgram, limit: Option<u64>): void {
  prefs.bump = prefs.create(admin, ["prefs", admin.key]);
  prefs.limit = limit;
}

/** The stored limit, else the argument's, else 100; the fallback only runs when needed (it counts a hit). */
export function limitOr(prefs: Mut<Prefs>, fallback: Option<u64>): u64 {
  return prefs.limit ?? fallback ?? countHit(prefs);
}

function countHit(prefs: Mut<Prefs>): u64 {
  prefs.hits += 1n;
  return 100n;
}

/** An Option result: stays empty when both sides are. */
export function either(a: Option<u64>, b: Option<u64>): u64 {
  const r: Option<u64> = a ?? b;
  return r === null ? 0n : r + 1n;
}

/** Pubkeys: the stored owner, else the signer. */
export function ownerOr(prefs: Mut<Prefs>, who: Signer): Pubkey {
  return prefs.owner ?? who.key;
}

/** `x!`: the value, aborting when empty. */
export function must(a: Option<u64>): u64 {
  log(a!);
  return a! * 2n;
}

