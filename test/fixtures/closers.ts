// do … while, **=, switch on 128-bit integers, ?. and an explicit token program in mint.create.
import {
  type Account,
  type Init,
  type Mint,
  type Mut,
  type Option,
  type Signer,
  type SystemProgram,
  type Token2022Program,
  type TokenProgram,
  u64,
  type u128,
  type u16,
} from "typesol";

export interface Point {
  x: u16;
  y: u16;
}

export interface Box {
  n: u64;
  home: Option<Point>;
}

export function setup(payer: Mut<Signer>, box: Init<Box>, systemProgram: SystemProgram, n: u64, withHome: boolean): void {
  box.create(payer, ["box", payer.key]);
  box.n = n;
  if (withHome) box.home = { x: 3n, y: 4n };
}

/** Digits of n (at least one): a do … while runs its body before the test. */
export function digits(n: u64): u64 {
  let d = 0n;
  let v = n;
  do {
    d += 1n;
    v /= 10n;
    if (v === 5n) continue; // continue goes to the test
  } while (v > 0n);
  return d;
}

export function cube(x: u64): u64 {
  let v = x;
  v **= 3n;
  return v;
}

export function grade(score: u128): u64 {
  switch (score) {
    case 0n:
      return 0n;
    case 340282366920938463463374607431768211455n:
      return 9n;
    case 100000000000000000000000n:
    case 7n:
      return 7n;
    default:
      return 1n;
  }
}

/** ?. on an optional account and on an Option<struct>: null when absent. */
export function peek(payer: Signer, box: Account<Box> | null, other: Account<Box>): u64 {
  const n = box?.n ?? 100n;
  const x = u64(other.home?.x ?? 50n);
  return n * 1000n + x;
}

/** Two token programs in one instruction: the mint names which one. */
export function makeMint22(payer: Mut<Signer>, mint: Init<Mint>, tokenProgram: TokenProgram, token2022: Token2022Program, systemProgram: SystemProgram): void {
  mint.create(payer, ["m22", payer.key], 2n, payer.key, null, token2022);
}


