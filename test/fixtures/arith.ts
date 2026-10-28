import { byteLength, require, i8, i16, i32, i64, i128, u8, u16, u32, u64, u128, isqrt, max, min, mulDiv, mulDivCeil } from "typesol";

/** Every arithmetic and comparison operator at every width, for differential fuzzing against BigInt. */
export function opU64(op: u8, a: u64, b: u64): u64 {
  if (op === 0n) return a + b;
  if (op === 1n) return a - b;
  if (op === 2n) return a * b;
  if (op === 3n) return a / b;
  if (op === 4n) return a % b;
  if (op === 5n) return cmp(a < b, a === b, a > b);
  if (a >= b) return 1n;
  return 0n;
}

export function opU32(op: u8, a: u32, b: u32): u32 {
  if (op === 0n) return a + b;
  if (op === 1n) return a - b;
  if (op === 2n) return a * b;
  if (op === 3n) return a / b;
  return a % b;
}

export function opU16(op: u8, a: u16, b: u16): u16 {
  let r: u16 = 0n;
  if (op === 0n) {
    r = a + b;
  } else if (op === 1n) {
    r = a - b;
  } else if (op === 2n) {
    r = a * b;
  } else if (op === 3n) {
    r = a / b;
  } else {
    r = a % b;
  }
  return r;
}

export function opI64(op: u8, a: i64, b: i64): i64 {
  if (op === 0n) return a + b;
  if (op === 1n) return a - b;
  if (op === 2n) return a * b;
  if (op === 3n) return a / b;
  if (op === 4n) return a % b;
  return -a;
}

/** Narrowing / sign-changing casts: kind 0 -> u8, 1 -> u16, 2 -> u32, 3 -> u64. */
export function castI64(kind: u8, x: i64): u64 {
  if (kind === 0n) return u64(u8(x));
  if (kind === 1n) return u64(u16(x));
  if (kind === 2n) return u64(u32(x));
  return u64(x);
}

export function castU64(x: u64): i64 {
  return i64(x);
}

function cmp(lt: boolean, eq: boolean, gt: boolean): u64 {
  if (lt) return 1n;
  if (eq) return 2n;
  if (gt) return 3n;
  return 0n;
}

/** ops 0..4: + - * / %, 5: &, 6: |, 7: ^, 8: <<, 9: >>, 10: ~a */
export function opU128(op: u8, a: u128, b: u128): u128 {
  if (op === 0n) return a + b;
  if (op === 1n) return a - b;
  if (op === 2n) return a * b;
  if (op === 3n) return a / b;
  if (op === 4n) return a % b;
  if (op === 5n) return a & b;
  if (op === 6n) return a | b;
  if (op === 7n) return a ^ b;
  if (op === 8n) return a << b;
  if (op === 9n) return a >> b;
  return ~a;
}

export function opI128(op: u8, a: i128, b: i128): i128 {
  if (op === 0n) return a + b;
  if (op === 1n) return a - b;
  if (op === 2n) return a * b;
  if (op === 3n) return a / b;
  if (op === 4n) return a % b;
  if (op === 5n) return a & b;
  if (op === 6n) return a | b;
  if (op === 7n) return a ^ b;
  if (op === 8n) return a << b;
  if (op === 9n) return a >> b;
  return ~a;
}

export function opI32(op: u8, a: i32, b: i32): i32 {
  let r: i32 = 0n;
  switch (op) {
    case 0n: r = a + b; break;
    case 1n: r = a - b; break;
    case 2n: r = a * b; break;
    case 3n: r = a / b; break;
    case 4n: r = a % b; break;
    case 5n: r = a & b; break;
    case 6n: r = a | b; break;
    case 7n: r = a ^ b; break;
    case 8n: r = a << b; break;
    case 9n: r = a >> b; break;
    default: r = ~a;
  }
  return r;
}

export function opI16(op: u8, a: i16, b: i16): i16 {
  if (op === 0n) return a + b;
  if (op === 1n) return a - b;
  if (op === 2n) return a * b;
  if (op === 3n) return a / b;
  if (op === 4n) return a % b;
  if (op === 5n) return a & b;
  if (op === 6n) return a | b;
  if (op === 7n) return a ^ b;
  if (op === 8n) return a << b;
  if (op === 9n) return a >> b;
  return ~a;
}

export function opI8(op: u8, a: i8, b: i8): i8 {
  let r = a;
  if (op === 0n) r += b;
  else if (op === 1n) r -= b;
  else if (op === 2n) r *= b;
  else if (op === 3n) r /= b;
  else if (op === 4n) r %= b;
  else if (op === 5n) r &= b;
  else if (op === 6n) r |= b;
  else if (op === 7n) r ^= b;
  else if (op === 8n) r <<= b;
  else if (op === 9n) r >>= b;
  else r = ~a;
  return r;
}

export function opU8(op: u8, a: u8, b: u8): u8 {
  if (op === 0n) return a + b;
  if (op === 1n) return a - b;
  if (op === 2n) return a * b;
  if (op === 3n) return a / b;
  if (op === 4n) return a % b;
  if (op === 5n) return a & b;
  if (op === 6n) return a | b;
  if (op === 7n) return a ^ b;
  if (op === 8n) return a << b;
  if (op === 9n) return a >> b;
  return ~a;
}

/** Shifts by an amount of another type. */
export function shiftMixed(a: u64, by: u8): u64 {
  return (a << by) >> by;
}

/** 0: mulDiv, 1: mulDivCeil, 2: isqrt(a), 3: min, 4: max */
export function mathU64(op: u8, a: u64, b: u64, c: u64): u64 {
  if (op === 0n) return mulDiv(a, b, c);
  if (op === 1n) return mulDivCeil(a, b, c);
  if (op === 2n) return isqrt(a);
  if (op === 3n) return min(a, b);
  return max(a, b);
}

/** 0: mulDiv, 1: mulDivCeil (u128, 256-bit intermediate) */
export function mulDiv128(op: u8, a: u128, b: u128, c: u128): u128 {
  return op === 0n ? mulDiv(a, b, c) : mulDivCeil(a, b, c);
}

export function isqrt128(a: u128): u128 {
  return isqrt(a);
}

/** Narrowing casts from i128: 0 i8, 1 i16, 2 i32, 3 i64, 4 u64, 5 u128, 6 u8 */
export function castWide(kind: u8, x: i128): i128 {
  if (kind === 0n) return i128(i8(x));
  if (kind === 1n) return i128(i16(x));
  if (kind === 2n) return i128(i32(x));
  if (kind === 3n) return i128(i64(x));
  if (kind === 4n) return i128(u64(x));
  if (kind === 5n) return i128(u128(x));
  return i128(u8(x));
}

/** 128-bit literals and text. */
export function bigText(): u64 {
  const big: u128 = 340282366920938463463374607431768211455n;
  const neg: i128 = -170141183460469231731687303715884105728n;
  const s = `${big}|${neg}`;
  require(s === "340282366920938463463374607431768211455|-170141183460469231731687303715884105728", "text");
  return byteLength(s);
}

/** a ** b at every width (checked like *; a negative exponent aborts). */
export function powU8(a: u8, b: u8): u8 {
  return a ** b;
}
export function powU16(a: u16, b: u16): u16 {
  return a ** b;
}
export function powU32(a: u32, b: u32): u32 {
  return a ** b;
}
export function powU64(a: u64, b: u64): u64 {
  return a ** b;
}
export function powU128(a: u128, b: u128): u128 {
  return a ** b;
}
export function powI8(a: i8, b: i8): i8 {
  return a ** b;
}
export function powI16(a: i16, b: i16): i16 {
  return a ** b;
}
export function powI32(a: i32, b: i32): i32 {
  return a ** b;
}
export function powI64(a: i64, b: i64): i64 {
  return a ** b;
}
export function powI128(a: i128, b: i128): i128 {
  return a ** b;
}
