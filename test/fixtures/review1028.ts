// Regressions from the 2026-10-28 review of struct-returning helpers, for-of and **.
import { type Init, type Mut, type Signer, type SystemProgram, type u64, type u8 } from "typesol";

export interface Pos {
  amount: u64;
  n: u64;
}
export interface S {
  bump: u8;
  x: u64;
  pos: Pos;
}

export function setup(admin: Mut<Signer>, s: Init<S>, systemProgram: SystemProgram): void {
  s.bump = s.create(admin, ["s", admin.key]);
  s.x = 3n;
  s.pos = { amount: 7n, n: 1n };
}

function mk(a: u64): Pos {
  return { amount: a, n: a + 1n };
}

/** A ternary between helper results: each branch's struct must outlive its block. */
export function pick(c: boolean): u64 {
  const o = c ? mk(1n) : mk(5n);
  const p = c ? mk(2n) : mk(3n);
  return o.amount * 100n + p.n;
}

function bumpX(s: Mut<S>): u64 {
  s.x += 1n;
  return 2n;
}

/** JS reads the base (3) before the exponent's helper changes it: 3 ** 2. */
export function pw(s: Mut<S>): u64 {
  return s.x ** bumpX(s);
}

function next(s: Mut<S>, p: Pos): Pos {
  s.pos.n += 1n;
  return { amount: p.amount + 1n, n: p.n };
}

/** A helper taking an account and a struct, bound without a type: built once, not three times. */
export function chained(s: Mut<S>): u64 {
  const r = next(s, s.pos);
  return r.amount;
}
