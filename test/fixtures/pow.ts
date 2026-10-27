import { type i64, type u128, type u64, type u8 } from "typesol";

export function powU64(b: u64, e: u64): u64 {
  return b ** e;
}
export function powU8(b: u8, e: u8): u8 {
  return b ** e;
}
export function powI64(b: i64, e: i64): i64 {
  return b ** e;
}
export function powU128(b: u128, e: u64): u128 {
  return b ** e;
}
/** Literal exponents unroll at compile time. */
export function cube(b: u64): u64 {
  return b ** 3n + 2n ** 10n + b ** 0n;
}
export function tenTo18(): u128 {
  const ten: u128 = 10n;
  return ten ** 18n;
}
