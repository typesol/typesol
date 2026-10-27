import { type u64 } from "typesol";

/** A generic helper in another file. */
export function maxOf<T extends bigint>(a: T, b: T): T {
  return a > b ? a : b;
}

export const clampTo = (x: u64, hi: u64): u64 => (x > hi ? hi : x);
