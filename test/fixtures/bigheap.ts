import { type u64, byteLength } from "typesol";

/** Clients must add ComputeBudget requestHeapFrame(64 * 1024) to transactions that use more than 32 KiB. */
const HEAP_SIZE_KIB = 64n;

/** Builds a string of 2^rounds bytes on the heap by doubling (every step allocates a new copy). */
export function grow(rounds: u64): u64 {
  let s = "x";
  for (let i = 0n; i < rounds; i++) s = s + s;
  return byteLength(s) + HEAP_SIZE_KIB * 0n;
}
