import { type Pubkey, type Signer, type u8, type u64, require, u128 } from "typesol";
import { clampTo, maxOf } from "./arrows-lib.js";

export interface Pair {
  a: u64;
  b: u64;
}

// Top-level arrow functions and function expressions are helpers.
const double = (x: u64): u64 => x * 2n;
const isSmall = function (x: u64): boolean {
  return x < 10n;
};
const pairOf = (a: u64, b: u64): Pair => ({ a, b });
const check = (ok: boolean): void => require(ok, "check failed");

// Generic helpers: one instance per set of types.
function pick<T>(first: boolean, a: T, b: T): T {
  return first ? a : b;
}
function sum<T extends bigint>(a: T, b: T): T {
  const s: T = (a + b) as T;
  return s;
}

export function arrows(x: u64): u64 {
  // Local functions capture nothing; they can call each other and the top-level ones.
  const triple = (v: u64): u64 => v * 3n;
  const step = (v: u64): u64 => {
    if (isSmall(v)) return triple(v) + 1n;
    return double(v);
  };
  check(x !== 7n);
  const p = pairOf(step(x), triple(1n));
  return p.a * 100n + p.b;
}

export function generics(x: u64, y: u128, small: u8, who: Signer, other: Pubkey): u128 {
  const k = pick(x > 5n, who.key, other);
  require(k === (x > 5n ? who.key : other), "pick Pubkey");
  const a = sum(x, 1n);
  const b = sum<u128>(y, 2n);
  const c = maxOf(small, 3n);
  const d = maxOf(a, clampTo(x, 50n));
  return b * 1_000_000n + u128(d) * 1_000n + u128(c);
}

export function shadow(x: u64): u64 {
  // A local function hides a top-level one of the same name inside this function only.
  const double = (v: u64): u64 => v * 4n;
  return double(x) + pairOf(1n, 2n).b;
}

// Struct type arguments: written out or taken from the arguments; locals of type T are struct copies.
function swapIf<T>(flip: boolean, a: T, b: T): T {
  const kept: T = flip ? b : a;
  return kept;
}
export function structGenerics(flip: boolean, x: u64): u64 {
  const p: Pair = { a: x, b: x + 1n };
  const q: Pair = { a: 100n, b: 200n };
  const r = swapIf(flip, p, q);
  const s = swapIf<Pair>(!flip, p, q);
  return r.a * 1000n + s.b;
}

