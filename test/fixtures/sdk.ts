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
  type Seeds,
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

/** A PDA seeded from the tally's fields (Anchor `seeds = [b"stash", tally.owner, tally.count]`). */
export function stash(tally: Account<Tally>, stash: Seeds<AccountInfo, ["stash", "@tally.owner", "@tally.count"]>): u64 {
  return tally.count;
}

export interface Slot {
  owner: Pubkey;
  id: u64;
}

export function openSlot(owner: Mut<Signer>, slot: Init<Slot>, systemProgram: SystemProgram, id: u64): void {
  slot.create(owner, ["slot", owner.key, id]);
  slot.owner = owner.key;
  slot.id = id;
}

/** A PDA seeded from its own fields (Anchor `seeds = [b"slot", slot.owner, slot.id]`): the client derives it from the values. */
export function slotId(slot: Seeds<Account<Slot>, ["slot", "@slot.owner", "@slot.id"]>): u64 {
  return slot.id;
}
