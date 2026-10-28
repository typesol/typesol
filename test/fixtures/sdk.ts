// A small program for the generated client's runtime helpers: accounts to list and watch, log and CPI events, a
// read-only view, and remaining accounts.
import {
  type Account,
  type AccountInfo,
  type EventAuthority,
  type HasOne,
  type Init,
  type Mut,
  type Pubkey,
  type SelfProgram,
  type Signer,
  type SystemProgram,
  type u64,
  emit,
  emitCpi,
  remainingAccounts,
} from "typesol";

export interface Tally {
  owner: Pubkey;
  count: u64;
}

export interface Added {
  by: u64;
  count: u64;
}

export function open(owner: Mut<Signer>, tally: Init<Tally>, systemProgram: SystemProgram): void {
  tally.create(owner, ["tally", owner.key]);
  tally.owner = owner.key;
}

export function add(owner: Signer, tally: HasOne<Mut<Tally>, "owner">, by: u64): void {
  tally.count += by;
  emit<Added>({ by, count: tally.count });
}

export function addCpi(owner: Signer, tally: HasOne<Mut<Tally>, "owner">, eventAuthority: EventAuthority, self: SelfProgram, by: u64): void {
  tally.count += by;
  emitCpi<Added>({ by, count: tally.count }, eventAuthority, self);
}

/** The count, for a view. */
export function total(tally: Account<Tally>): u64 {
  return tally.count;
}

/** How many remaining accounts were passed. */
export function countRest(): u64 {
  return remainingAccounts().length;
}

/** `has_one = owner` with an owner that does not sign: the client can read it from the tally. */
export function poke(tally: HasOne<Mut<Tally>, "owner">, owner: AccountInfo): void {
  tally.count += 1n;
}
