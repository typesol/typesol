// I80F48, the fixed-point number Marginfi keeps its amounts, prices and rates in (the `fixed` crate, 1.28.0): an i128
// holding the value times 2^48. Each operation here gives the bits `fixed` gives, measured against it
// (test/verification/fuzz-i80f48.test.ts):
// - products round toward −∞ (the 256-bit product shifted right 48 bits);
// - quotients round toward zero;
// - conversions to integers round toward −∞;
// - conversions to f64 round to the nearest double, ties to even.
// The checked forms (Marginfi's `checked_mul(…).ok_or(MathError)`) fail with MathError where `fixed` returns None; the
// fxTry forms return that error as a value (the risk engine records some errors instead of failing), and the wrapping
// forms give the bits `*`, `/` and `from_num` give in the release build (they only debug_assert on overflow).
import { type i128, type i64, type u32, type u64, i128 as toI128, require, u128, u256, u64 as toU64 } from "typesol";
import { MarginfiError } from "./errors";

export const I80F48_ONE: i128 = 281474976710656n;
export const I80F48_ZERO: i128 = 0n;
export const I80F48_MAX: i128 = 170141183460469231731687303715884105727n;
export const I80F48_MIN: i128 = -170141183460469231731687303715884105728n;
const FRAC_MASK: i128 = 281474976710655n;
const TWO_127: u256 = 170141183460469231731687303715884105728n;
const MASK_128: u256 = 340282366920938463463374607431768211455n;
const MATH_ERROR: u32 = 6062n;

/** An I80F48 or the error computing it (0 when there is none). */
export interface Fx {
  err: u32;
  v: i128;
}

/** |x| as a u256 (i128::MIN included). */
function magnitude(x: i128): u256 {
  return x >= 0n ? u256(u128(x)) : u256(u128(-(x + 1n))) + 1n;
}
/** The i128 with this magnitude and sign; MathError when it does not fit. */
function signed(m: u256, negative: boolean): i128 {
  if (negative) {
    require(m <= TWO_127, MarginfiError.MathError);
    if (m === 0n) return 0n;
    return -toI128(u128(m - 1n)) - 1n;
  }
  require(m < TWO_127, MarginfiError.MathError);
  return toI128(u128(m));
}

/** ±m modulo 2^128, as an i128: the bits a wrapping operation keeps. */
function wrap128(m: u256, negative: boolean): i128 {
  let r = m & MASK_128;
  if (negative && r !== 0n) r = MASK_128 - r + 1n;
  if (r < TWO_127) return toI128(u128(r));
  return -toI128(u128(MASK_128 - r)) - 1n;
}
/** Whether the i128 with this magnitude and sign exists. */
function fits(m: u256, negative: boolean): boolean {
  return negative ? m <= TWO_127 : m < TWO_127;
}

/** checked_add. */
export function fxAdd(a: i128, b: i128): i128 {
  require(b >= 0n ? a <= I80F48_MAX - b : a >= I80F48_MIN - b, MarginfiError.MathError);
  return a + b;
}
/** checked_sub. */
export function fxSub(a: i128, b: i128): i128 {
  require(b >= 0n ? a >= I80F48_MIN + b : a <= I80F48_MAX + b, MarginfiError.MathError);
  return a - b;
}
/** saturating_add. */
export function fxSaturatingAdd(a: i128, b: i128): i128 {
  if (b >= 0n && a > I80F48_MAX - b) return I80F48_MAX;
  if (b < 0n && a < I80F48_MIN - b) return I80F48_MIN;
  return a + b;
}
/** saturating_sub. */
export function fxSaturatingSub(a: i128, b: i128): i128 {
  if (b >= 0n && a < I80F48_MIN + b) return I80F48_MIN;
  if (b < 0n && a > I80F48_MAX + b) return I80F48_MAX;
  return a - b;
}

/** checked_mul: the product's 48 extra fraction bits dropped, toward −∞. */
export function fxMul(a: i128, b: i128): i128 {
  const negative = a < 0n !== b < 0n;
  const p = magnitude(a) * magnitude(b);
  let q = p >> 48n;
  if (negative && (p & u256(u128(FRAC_MASK))) !== 0n) q += 1n;
  return signed(q, negative && p !== 0n);
}
/** saturating_mul. */
export function fxSaturatingMul(a: i128, b: i128): i128 {
  const negative = a < 0n !== b < 0n;
  const p = magnitude(a) * magnitude(b);
  let q = p >> 48n;
  if (negative && (p & u256(u128(FRAC_MASK))) !== 0n) q += 1n;
  if (negative && p !== 0n) return q > TWO_127 ? I80F48_MIN : signed(q, true);
  return q >= TWO_127 ? I80F48_MAX : signed(q, false);
}
/** checked_div: MathError on a zero divisor or a quotient that does not fit; rounds toward zero. */
export function fxDiv(a: i128, b: i128): i128 {
  require(b !== 0n, MarginfiError.MathError);
  const negative = a < 0n !== b < 0n;
  const q = (magnitude(a) << 48n) / magnitude(b);
  return signed(q, negative && q !== 0n);
}

/** checked_mul, its overflow returned. */
export function fxTryMul(a: i128, b: i128): Fx {
  const negative = a < 0n !== b < 0n;
  const p = magnitude(a) * magnitude(b);
  let q = p >> 48n;
  if (negative && (p & u256(u128(FRAC_MASK))) !== 0n) q += 1n;
  if (!fits(q, negative && p !== 0n)) return { err: MATH_ERROR, v: 0n };
  return { err: 0n, v: wrap128(q, negative) };
}
/** checked_div, its zero divisor or overflow returned. */
export function fxTryDiv(a: i128, b: i128): Fx {
  if (b === 0n) return { err: MATH_ERROR, v: 0n };
  const negative = a < 0n !== b < 0n;
  const q = (magnitude(a) << 48n) / magnitude(b);
  if (!fits(q, negative && q !== 0n)) return { err: MATH_ERROR, v: 0n };
  return { err: 0n, v: wrap128(q, negative) };
}
/** checked_add, its overflow returned. */
export function fxTryAdd(a: i128, b: i128): Fx {
  if (b >= 0n ? a > I80F48_MAX - b : a < I80F48_MIN - b) return { err: MATH_ERROR, v: 0n };
  return { err: 0n, v: a + b };
}
/** checked_sub, its overflow returned. */
export function fxTrySub(a: i128, b: i128): Fx {
  if (b >= 0n ? a < I80F48_MIN + b : a > I80F48_MAX + b) return { err: MATH_ERROR, v: 0n };
  return { err: 0n, v: a - b };
}
/** `a * b`: the product rounded toward −∞, its bits past 128 dropped. */
export function fxWrappingMul(a: i128, b: i128): i128 {
  const negative = a < 0n !== b < 0n;
  const p = magnitude(a) * magnitude(b);
  let q = p >> 48n;
  if (negative && (p & u256(u128(FRAC_MASK))) !== 0n) q += 1n;
  return wrap128(q, negative);
}
/** `a / b`: the quotient toward zero, its bits past 128 dropped; a zero divisor panics. */
export function fxWrappingDiv(a: i128, b: i128): i128 {
  require(b !== 0n, MarginfiError.MathError);
  return wrap128((magnitude(a) << 48n) / magnitude(b), a < 0n !== b < 0n);
}

/** checked_abs (MathError for the most negative value). */
export function fxAbs(a: i128): i128 {
  require(a !== I80F48_MIN, MarginfiError.MathError);
  return a < 0n ? -a : a;
}
/** unsigned_abs: the U80F48 bits of |a|. */
export function fxUnsignedAbs(a: i128): u128 {
  return u128(magnitude(a));
}
export function fxMin(a: i128, b: i128): i128 {
  return a < b ? a : b;
}
export function fxMax(a: i128, b: i128): i128 {
  return a > b ? a : b;
}
export function fxClamp(a: i128, lo: i128, hi: i128): i128 {
  return a < lo ? lo : a > hi ? hi : a;
}

/** int(): the integer part, toward −∞ (the fraction bits cleared). */
export function fxInt(a: i128): i128 {
  return (a >> 48n) << 48n;
}
/** frac(): what int() drops, in [0, 1). */
export function fxFrac(a: i128): i128 {
  return a & FRAC_MASK;
}
/** checked_ceil. */
export function fxCeil(a: i128): i128 {
  if ((a & FRAC_MASK) === 0n) return a;
  return fxAdd(fxInt(a), I80F48_ONE);
}
/** checked_round: to the nearest integer, ties away from zero. */
export function fxRound(a: i128): i128 {
  const f = a & FRAC_MASK;
  const half: i128 = 140737488355328n;
  if (f === 0n) return a;
  if (f > half || (f === half && a > 0n)) return fxAdd(fxInt(a), I80F48_ONE);
  return fxInt(a);
}

/** from_num of an integer. */
export function fxFromU64(n: u64): i128 {
  return toI128(u128(n)) << 48n;
}
/** from_num of an i64. */
export function fxFromI64(n: i64): i128 {
  return toI128(n) * I80F48_ONE;
}
/** from_num of an i128 (Switchboard's results): the value's bits past 128 dropped, as the release build does. */
export function fxFromI128Wrapping(n: i128): i128 {
  return wrap128(magnitude(n) << 48n, n < 0n);
}
/** to_num::<u64>: toward −∞, then wrapped to 64 bits. */
export function fxToU64Wrapping(a: i128): u64 {
  // The integer part is in [-2^79, 2^79); adding 2^80 keeps it modulo 2^64 and makes it positive.
  return toU64(u128((a >> 48n) + 1208925819614629174706176n) & 18446744073709551615n);
}
/** checked_to_num::<u64> (to_num where Marginfi unwraps it): toward −∞; MathError when out of range. */
export function fxToU64(a: i128): u64 {
  const n = a >> 48n;
  require(n >= 0n && n <= 18446744073709551615n, MarginfiError.MathError);
  return toU64(u128(n));
}

/**
 * to_num::<f64>, as the bits of the double (Borsh writes an f64 as its 8 IEEE bytes, little-endian): the value
 * a / 2^48 rounded to 53 significant bits, ties to even.
 */
export function fxToF64Bits(a: i128): u64 {
  if (a === 0n) return 0n;
  const sign: u64 = a < 0n ? 9223372036854775808n : 0n;
  const m = magnitude(a);
  let bits: u64 = 0n;
  let rest = m;
  while (rest > 0n) {
    rest = rest >> 1n;
    bits += 1n;
  }
  let mantissa: u256 = 0n;
  if (bits <= 53n) mantissa = m << (53n - bits);
  else {
    const shift = bits - 53n;
    mantissa = m >> shift;
    const dropped = m - (mantissa << shift);
    const half = u256(1n) << (shift - 1n);
    if (dropped > half || (dropped === half && (mantissa & 1n) === 1n)) mantissa += 1n;
    if (mantissa === u256(1n) << 53n) {
      mantissa = mantissa >> 1n;
      bits += 1n;
    }
  }
  // The leading bit is bit (bits - 1) of a / 2^48, so the exponent is bits - 1 - 48; biased by 1023.
  const exponent: u64 = bits + 974n;
  return sign | (exponent << 52n) | toU64(u128(mantissa - (u256(1n) << 52n)));
}
