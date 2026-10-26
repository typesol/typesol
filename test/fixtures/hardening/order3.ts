// Evaluation order of equals/assignments, helper snapshots in loops, 128-bit constant seeds.
import { type Init, type Mut, type Signer, type SystemProgram, type Pubkey, type u64, type u128, type FixedArray, emit } from "typesol";

export type Action = { kind: "Deposit"; amount: u64 } | { kind: "Pause" };
export interface P {
  x: u64;
  y: u64;
}
export interface Big {
  vals: FixedArray<u64, 128>;
}
export interface Holder {
  owner: Pubkey;
  act: Action;
  i: u64;
  pts: FixedArray<P, 3>;
  total: u64;
  big: Big;
}
export interface Ev {
  act: Action;
  n: u64;
}
export interface Box {
  v: u64;
}
const BIG: u128 = 5n;

function setOwner(h: Mut<Holder>, next: Pubkey): Pubkey {
  h.owner = next;
  return next;
}
function pause(h: Mut<Holder>): u64 {
  h.act = { kind: "Pause" };
  return 7n;
}
function nextI(h: Mut<Holder>): u64 {
  h.i += 1n;
  return 9n;
}
function addFirst(b: Big, h: Mut<Holder>): void {
  h.total += b.vals.get(0n);
}

export function init(payer: Mut<Signer>, h: Init<Holder>, systemProgram: SystemProgram): void {
  h.create(payer, ["h"]);
  h.owner = payer.key;
  h.act = { kind: "Deposit", amount: 42n };
  h.big.vals.set(0n, 1n);
}

/** compares the old owner with next (1 only when they were already equal). */
export function eq(h: Mut<Holder>, next: Pubkey): u64 {
  if (h.owner.equals(setOwner(h, next))) return 1n;
  return 0n;
}

/** the event carries the action as it was before pause() ran. */
export function ev(h: Mut<Holder>): void {
  emit<Ev>({ act: h.act, n: pause(h) });
}

/** the target element (i = 0) is chosen before the right side changes i. */
export function idx(h: Mut<Holder>): u64 {
  h.pts.get(h.i).x = nextI(h);
  return h.pts.get(0n).x;
}

/** a helper taking a struct copy in a loop reuses one buffer instead of taking new heap every pass. */
export function spin(h: Mut<Holder>, n: u64): u64 {
  for (let i = 0n; i < n; i++) addFirst(h.big, h);
  return h.total;
}

/** a u128 constant seed is 16 bytes in the PDA and in the IDL. */
export function boxed(payer: Mut<Signer>, b: Init<Box>, systemProgram: SystemProgram): void {
  b.create(payer, ["box", BIG]);
}
