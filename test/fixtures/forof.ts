import { type Account, type FixedArray, type Init, type Mut, type Pubkey, type Signer, type SystemProgram, type Vec, type u64, type u8, require } from "typesol";

export interface Entry {
  who: Pubkey;
  amount: u64;
}

export interface Ledger {
  bump: u8;
  marks: FixedArray<u64, 4>;
  entries: Vec<Entry>;
}

export function setup(admin: Mut<Signer>, ledger: Init<Ledger>, systemProgram: SystemProgram): void {
  ledger.bump = ledger.create(admin, ["ledger", admin.key]);
}

export function add(admin: Mut<Signer>, ledger: Mut<Ledger>, systemProgram: SystemProgram, who: Pubkey, amount: u64): void {
  ledger.entries.push({ who, amount }, admin);
}

/** Sum of a Vec<u64> argument, skipping zeros and stopping at the first value above `stop`. */
export function sumArg(values: Vec<u64>, stop: u64): u64 {
  let total = 0n;
  for (const v of values) {
    if (v === 0n) continue;
    if (v > stop) break;
    total += v;
  }
  return total;
}

/** Total of one account's entries (a struct reference per step). */
export function totalOf(ledger: Account<Ledger>, who: Pubkey): u64 {
  let total = 0n;
  for (const e of ledger.entries) {
    if (e.who === who) total += e.amount;
  }
  return total;
}

/** Writes through the element reference, and fills the fixed array from a nested loop. */
export function bump(ledger: Mut<Ledger>, by: u64): void {
  for (const e of ledger.entries) e.amount += by;
  let i = 0n;
  for (const m of ledger.marks) {
    let n = 0n;
    for (const e of ledger.entries) n += e.amount;
    ledger.marks.set(i, n + m + i);
    i++;
  }
}

/** Pushes while iterating: like JS, the loop sees the new length, so it stops by count. */
export function grow(admin: Mut<Signer>, ledger: Mut<Ledger>, systemProgram: SystemProgram, extra: u64): u64 {
  let steps = 0n;
  for (const e of ledger.entries) {
    steps++;
    if (steps <= extra) ledger.entries.push({ who: e.who, amount: 1n }, admin);
  }
  require(steps === ledger.entries.length, "every element was visited");
  return steps;
}
