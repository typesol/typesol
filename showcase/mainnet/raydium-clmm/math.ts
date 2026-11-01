// The math of the Raydium CLMM port (programs/amm/src/libraries/ of raydium-io/raydium-clmm @ 6d7a0f8): full_math,
// sqrt_price_math, tick_math, liquidity_math and swap_math. U128 and U256 are u128 and u256 here; where the original
// returns None or an error, these fail with the same ErrorCode. U256::as_u128 / as_u64 truncate, as low128 / low64 do.
import { AnchorError, type u32, i32, i128, mulDiv, mulDivCeil, require, u64, u128, u256 } from "typesol";
import { ErrorCode } from "./errors";

export const MIN_TICK: i32 = -443636n;
export const MAX_TICK: i32 = 443636n;
export const MIN_SQRT_PRICE_X64: u128 = 4295048016n;
export const MAX_SQRT_PRICE_X64: u128 = 79226673521066979257578248091n;
/** 2^64 (fixed_point_64::Q64). */
export const Q64: u128 = 18446744073709551616n;
export const FEE_RATE_DENOMINATOR_VALUE: u32 = 1_000_000n;
const U64_MAX: u128 = 18446744073709551615n;

/** U256::as_u128: the low 128 bits. */
export function low128(x: u256): u128 {
  return u128(x & u256(340282366920938463463374607431768211455n));
}
/** U256::as_u64: the low 64 bits. */
export function low64(x: u256): u64 {
  return u64(x & u256(18446744073709551615n));
}

// ---- full_math ----------------------------------------------------------------------------------------------------

/** u64::mul_div_floor: floor(a * b / c), CalculateOverflow when c is 0 or it does not fit in u64. */
export function mulDivFloor64(a: u64, b: u64, c: u64): u64 {
  require(c !== 0n, ErrorCode.CalculateOverflow);
  const r = (u128(a) * u128(b)) / u128(c);
  require(r <= U64_MAX, ErrorCode.CalculateOverflow);
  return u64(r);
}
/** u64::mul_div_ceil. */
export function mulDivCeil64(a: u64, b: u64, c: u64): u64 {
  require(c !== 0n, ErrorCode.CalculateOverflow);
  const r = (u128(a) * u128(b) + u128(c - 1n)) / u128(c);
  require(r <= U64_MAX, ErrorCode.CalculateOverflow);
  return u64(r);
}
/** U128::mul_div_floor (a 256-bit product). */
export function mulDivFloor128(a: u128, b: u128, c: u128): u128 {
  require(c !== 0n, ErrorCode.CalculateOverflow);
  const r = (u256(a) * u256(b)) / u256(c);
  require(r <= u256(340282366920938463463374607431768211455n), ErrorCode.CalculateOverflow);
  return u128(r);
}
/** U256::mul_div_ceil (a 512-bit product; a result beyond 256 bits fails with TypeSOL's 5100). */
export function mulDivCeil256(a: u256, b: u256, c: u256): u256 {
  require(c !== 0n, ErrorCode.CalculateOverflow);
  return mulDivCeil(a, b, c);
}
export function mulDivFloor256(a: u256, b: u256, c: u256): u256 {
  require(c !== 0n, ErrorCode.CalculateOverflow);
  return mulDiv(a, b, c);
}
/** The number of leading zero bits of a u256 (U256::leading_zeros). */
function leadingZeros256(x: u256): u64 {
  const hi = low128(x >> 128n);
  if (hi !== 0n) return 127n - msb128(hi);
  const lo = low128(x);
  return lo !== 0n ? 255n - msb128(lo) : 256n;
}
/** ceil(x * 2^shift / denom) (full_math::mul_pow2_div_ceil). */
export function mulPow2DivCeil(x: u256, shift: u64, denom: u256): u256 {
  require(denom !== 0n, ErrorCode.CalculateOverflow);
  if (leadingZeros256(x) >= shift) {
    const shifted = x << shift;
    const max = u256(115792089237316195423570985008687907853269984665640564039457584007913129639935n);
    if (shifted <= max - (denom - 1n)) return (shifted + denom - 1n) / denom;
  }
  return mulDivCeil256(x, u256(1n) << shift, denom);
}
/** floor(x * 2^shift / denom) (full_math::mul_pow2_div_floor). */
export function mulPow2DivFloor(x: u256, shift: u64, denom: u256): u256 {
  require(denom !== 0n, ErrorCode.CalculateOverflow);
  if (leadingZeros256(x) >= shift) return (x << shift) / denom;
  return mulDivFloor256(x, u256(1n) << shift, denom);
}

// ---- tick_math ----------------------------------------------------------------------------------------------------

/** 2^64 * √1.0001^tick as a Q64.64 number (tick_math::get_sqrt_price_at_tick). */
export function getSqrtPriceAtTick(tick: i32): u128 {
  require(tick >= MIN_TICK && tick <= MAX_TICK, ErrorCode.TickUpperOverflow);
  const abs = u64(tick < 0n ? -i128(tick) : i128(tick));
  let ratio: u128 = (abs & 0x1n) !== 0n ? 0xfffcb933bd6fb800n : Q64;
  if ((abs & 0x2n) !== 0n) ratio = (ratio * 0xfff97272373d4000n) >> 64n;
  if ((abs & 0x4n) !== 0n) ratio = (ratio * 0xfff2e50f5f657000n) >> 64n;
  if ((abs & 0x8n) !== 0n) ratio = (ratio * 0xffe5caca7e10f000n) >> 64n;
  if ((abs & 0x10n) !== 0n) ratio = (ratio * 0xffcb9843d60f7000n) >> 64n;
  if ((abs & 0x20n) !== 0n) ratio = (ratio * 0xff973b41fa98e800n) >> 64n;
  if ((abs & 0x40n) !== 0n) ratio = (ratio * 0xff2ea16466c9b000n) >> 64n;
  if ((abs & 0x80n) !== 0n) ratio = (ratio * 0xfe5dee046a9a3800n) >> 64n;
  if ((abs & 0x100n) !== 0n) ratio = (ratio * 0xfcbe86c7900bb000n) >> 64n;
  if ((abs & 0x200n) !== 0n) ratio = (ratio * 0xf987a7253ac65800n) >> 64n;
  if ((abs & 0x400n) !== 0n) ratio = (ratio * 0xf3392b0822bb6000n) >> 64n;
  if ((abs & 0x800n) !== 0n) ratio = (ratio * 0xe7159475a2caf000n) >> 64n;
  if ((abs & 0x1000n) !== 0n) ratio = (ratio * 0xd097f3bdfd2f2000n) >> 64n;
  if ((abs & 0x2000n) !== 0n) ratio = (ratio * 0xa9f746462d9f8000n) >> 64n;
  if ((abs & 0x4000n) !== 0n) ratio = (ratio * 0x70d869a156f31c00n) >> 64n;
  if ((abs & 0x8000n) !== 0n) ratio = (ratio * 0x31be135f97ed3200n) >> 64n;
  if ((abs & 0x10000n) !== 0n) ratio = (ratio * 0x9aa508b5b85a500n) >> 64n;
  if ((abs & 0x20000n) !== 0n) ratio = (ratio * 0x5d6af8dedc582cn) >> 64n;
  if ((abs & 0x40000n) !== 0n) ratio = (ratio * 0x2216e584f5fan) >> 64n;
  if (tick > 0n) ratio = 340282366920938463463374607431768211455n / ratio;
  return ratio;
}

/** The index of the highest set bit of a non-zero u128. */
export function msb128(x: u128): u64 {
  let n: u64 = 0n;
  let v = x;
  if (v >> 64n !== 0n) {
    v = v >> 64n;
    n += 64n;
  }
  if (v >> 32n !== 0n) {
    v = v >> 32n;
    n += 32n;
  }
  if (v >> 16n !== 0n) {
    v = v >> 16n;
    n += 16n;
  }
  if (v >> 8n !== 0n) {
    v = v >> 8n;
    n += 8n;
  }
  if (v >> 4n !== 0n) {
    v = v >> 4n;
    n += 4n;
  }
  if (v >> 2n !== 0n) {
    v = v >> 2n;
    n += 2n;
  }
  if (v >> 1n !== 0n) n += 1n;
  return n;
}

/** The greatest tick whose sqrt price is at most `sqrtPriceX64` (tick_math::get_tick_at_sqrt_price). */
export function getTickAtSqrtPrice(sqrtPriceX64: u128): i32 {
  require(sqrtPriceX64 >= MIN_SQRT_PRICE_X64 && sqrtPriceX64 < MAX_SQRT_PRICE_X64, ErrorCode.SqrtPriceX64);
  const msb = msb128(sqrtPriceX64);
  const log2pIntegerX32 = (i128(msb) - 64n) << 32n;
  let bit: i128 = 0x8000_0000_0000_0000n;
  let precision: u64 = 0n;
  let log2pFractionX64: i128 = 0n;
  let r: u128 = msb >= 64n ? sqrtPriceX64 >> (msb - 63n) : sqrtPriceX64 << (63n - msb);
  while (bit > 0n && precision < 16n) {
    r = r * r;
    const more = r >> 127n;
    r = r >> (63n + u64(more));
    log2pFractionX64 += bit * i128(more);
    bit = bit >> 1n;
    precision += 1n;
  }
  const log2pX32 = log2pIntegerX32 + (log2pFractionX64 >> 32n);
  const logSqrt10001X64 = log2pX32 * 59543866431248n;
  const tickLow = i32((logSqrt10001X64 - 184467440737095516n) >> 64n);
  const tickHigh = i32((logSqrt10001X64 + 15793534762490258745n) >> 64n);
  if (tickLow === tickHigh) return tickLow;
  return getSqrtPriceAtTick(tickHigh) <= sqrtPriceX64 ? tickHigh : tickLow;
}

// ---- sqrt_price_math ----------------------------------------------------------------------------------------------

/** √P' = √P·L / (L + Δx·√P), rounded up (sqrt_price_math::get_next_sqrt_price_from_amount_0_rounding_up). */
export function nextSqrtPriceFromAmount0RoundingUp(sqrtPriceX64: u128, liquidity: u128, amount: u64, add: boolean): u128 {
  if (amount === 0n) return sqrtPriceX64;
  const numerator1 = u256(liquidity) << 64n;
  if (add) {
    const product = u256(amount) * u256(sqrtPriceX64);
    const denominator = numerator1 + product;
    if (denominator >= numerator1) return low128(mulDivCeil256(numerator1, u256(sqrtPriceX64), denominator));
    const d = numerator1 / u256(sqrtPriceX64) + u256(amount);
    return low128(numerator1 / d + (numerator1 % d > 0n ? 1n : 0n));
  }
  const product = u256(amount) * u256(sqrtPriceX64);
  require(numerator1 >= product, ErrorCode.CalculateOverflow);
  return low128(mulDivCeil256(numerator1, u256(sqrtPriceX64), numerator1 - product));
}

/** √P' = √P ± Δy / L, rounded down (sqrt_price_math::get_next_sqrt_price_from_amount_1_rounding_down). */
export function nextSqrtPriceFromAmount1RoundingDown(sqrtPriceX64: u128, liquidity: u128, amount: u64, add: boolean): u128 {
  if (amount === 0n) return sqrtPriceX64;
  if (add) {
    const quotient = (u128(amount) << 64n) / liquidity;
    require(sqrtPriceX64 <= 340282366920938463463374607431768211455n - quotient, ErrorCode.CalculateOverflow);
    return sqrtPriceX64 + quotient;
  }
  const n = u128(amount) << 64n;
  const quotient = n / liquidity + (n % liquidity > 0n ? 1n : 0n);
  require(sqrtPriceX64 >= quotient, ErrorCode.CalculateOverflow);
  return sqrtPriceX64 - quotient;
}

export function nextSqrtPriceFromInput(sqrtPriceX64: u128, liquidity: u128, amountIn: u64, zeroForOne: boolean): u128 {
  require(sqrtPriceX64 >= MIN_SQRT_PRICE_X64 && sqrtPriceX64 < MAX_SQRT_PRICE_X64, ErrorCode.SqrtPriceX64);
  require(liquidity > 0n, ErrorCode.ZeroLiquidity);
  return zeroForOne
    ? nextSqrtPriceFromAmount0RoundingUp(sqrtPriceX64, liquidity, amountIn, true)
    : nextSqrtPriceFromAmount1RoundingDown(sqrtPriceX64, liquidity, amountIn, true);
}

export function nextSqrtPriceFromOutput(sqrtPriceX64: u128, liquidity: u128, amountOut: u64, zeroForOne: boolean): u128 {
  require(sqrtPriceX64 >= MIN_SQRT_PRICE_X64 && sqrtPriceX64 < MAX_SQRT_PRICE_X64, ErrorCode.SqrtPriceX64);
  require(liquidity > 0n, ErrorCode.ZeroLiquidity);
  return zeroForOne
    ? nextSqrtPriceFromAmount1RoundingDown(sqrtPriceX64, liquidity, amountOut, false)
    : nextSqrtPriceFromAmount0RoundingUp(sqrtPriceX64, liquidity, amountOut, false);
}

// ---- liquidity_math -----------------------------------------------------------------------------------------------

/** x + y for a signed delta (liquidity_math::add_delta). */
export function addDelta(x: u128, y: i128): u128 {
  if (y < 0n) {
    const z = x - u128(-y);
    require(x > z, ErrorCode.LiquiditySubValueErr);
    return z;
  }
  const z = x + u128(y);
  require(z >= x, ErrorCode.LiquidityAddValueErr);
  return z;
}

export function liquidityFromAmount0(sqrtA: u128, sqrtB: u128, amount0: u64): u128 {
  if (amount0 === 0n) return 0n;
  const a = sqrtA > sqrtB ? sqrtB : sqrtA;
  const b = sqrtA > sqrtB ? sqrtA : sqrtB;
  const intermediate = mulDivFloor128(a, b, Q64);
  return mulDivFloor128(u128(amount0), intermediate, b - a);
}

export function liquidityFromAmount1(sqrtA: u128, sqrtB: u128, amount1: u64): u128 {
  if (amount1 === 0n) return 0n;
  const a = sqrtA > sqrtB ? sqrtB : sqrtA;
  const b = sqrtA > sqrtB ? sqrtA : sqrtB;
  return mulDivFloor128(u128(amount1), Q64, b - a);
}

export function liquidityFromAmounts(sqrtP: u128, sqrtA: u128, sqrtB: u128, amount0: u64, amount1: u64): u128 {
  const a = sqrtA > sqrtB ? sqrtB : sqrtA;
  const b = sqrtA > sqrtB ? sqrtA : sqrtB;
  if (sqrtP <= a) return liquidityFromAmount0(a, b, amount0);
  if (sqrtP < b) {
    const l0 = liquidityFromAmount0(sqrtP, b, amount0);
    const l1 = liquidityFromAmount1(a, sqrtP, amount1);
    return l0 < l1 ? l0 : l1;
  }
  return liquidityFromAmount1(a, b, amount1);
}

export function liquidityFromSingleAmount0(sqrtP: u128, sqrtA: u128, sqrtB: u128, amount0: u64): u128 {
  const a = sqrtA > sqrtB ? sqrtB : sqrtA;
  const b = sqrtA > sqrtB ? sqrtA : sqrtB;
  if (sqrtP <= a) return liquidityFromAmount0(a, b, amount0);
  if (sqrtP < b) return liquidityFromAmount0(sqrtP, b, amount0);
  return 0n;
}

export function liquidityFromSingleAmount1(sqrtP: u128, sqrtA: u128, sqrtB: u128, amount1: u64): u128 {
  const a = sqrtA > sqrtB ? sqrtB : sqrtA;
  const b = sqrtA > sqrtB ? sqrtA : sqrtB;
  if (sqrtP <= a) return 0n;
  if (sqrtP < b) return liquidityFromAmount1(a, sqrtP, amount1);
  return liquidityFromAmount1(a, b, amount1);
}

/** Δx for a liquidity between two prices (liquidity_math::get_delta_amount_0_unsigned). */
export function deltaAmount0Unsigned(sqrtA: u128, sqrtB: u128, liquidity: u128, roundUp: boolean): u64 {
  const a = sqrtA > sqrtB ? sqrtB : sqrtA;
  const b = sqrtA > sqrtB ? sqrtA : sqrtB;
  require(a > 0n, ErrorCode.ZeroSqrtPrice);
  const numerator1 = u256(liquidity) << 64n;
  const numerator2 = u256(b - a);
  const denominator = u256(a) * u256(b);
  const result = roundUp ? mulDivCeil256(numerator1, numerator2, denominator) : mulDivFloor256(numerator1, numerator2, denominator);
  require(result <= u256(U64_MAX), ErrorCode.MaxTokenOverflow);
  return low64(result);
}

/** Δy for a liquidity between two prices (liquidity_math::get_delta_amount_1_unsigned). */
export function deltaAmount1Unsigned(sqrtA: u128, sqrtB: u128, liquidity: u128, roundUp: boolean): u64 {
  const a = sqrtA > sqrtB ? sqrtB : sqrtA;
  const b = sqrtA > sqrtB ? sqrtA : sqrtB;
  const result = roundUp ? mulDivCeil256(u256(liquidity), u256(b - a), u256(Q64)) : mulDivFloor256(u256(liquidity), u256(b - a), u256(Q64));
  require(result <= u256(U64_MAX), ErrorCode.MaxTokenOverflow);
  return low64(result);
}

export interface SwapAmounts {
  /** False where the original fails with MaxTokenOverflow (compute_swap treats it as "target not reached"). */
  fits: boolean;
  amountIn: u64;
  amountOut: u64;
}

/** Input and output amounts of a swap between two prices (liquidity_math::get_delta_amounts_for_swap). */
export function deltaAmountsForSwap(sqrtA: u128, sqrtB: u128, liquidity: u128, zeroForOne: boolean): SwapAmounts {
  const a = sqrtA > sqrtB ? sqrtB : sqrtA;
  const b = sqrtA > sqrtB ? sqrtA : sqrtB;
  require(a > 0n, ErrorCode.ZeroSqrtPrice);
  const amount1X64 = u256(liquidity) * u256(b - a);
  const product = u256(a) * u256(b);
  let amountIn: u256 = 0n;
  let amountOut: u256 = 0n;
  if (zeroForOne) {
    amountIn = mulPow2DivCeil(amount1X64, 64n, product);
    amountOut = amount1X64 >> 64n;
  } else {
    amountIn = (amount1X64 + u256(U64_MAX)) >> 64n;
    amountOut = mulPow2DivFloor(amount1X64, 64n, product);
  }
  if (amountIn > u256(U64_MAX) || amountOut > u256(U64_MAX)) return { fits: false, amountIn: 0n, amountOut: 0n };
  return { fits: true, amountIn: low64(amountIn), amountOut: low64(amountOut) };
}

export function deltaAmount0Signed(sqrtA: u128, sqrtB: u128, liquidity: i128): u64 {
  if (liquidity < 0n) return deltaAmount0Unsigned(sqrtA, sqrtB, u128(-liquidity), false);
  return deltaAmount0Unsigned(sqrtA, sqrtB, u128(liquidity), true);
}

export function deltaAmount1Signed(sqrtA: u128, sqrtB: u128, liquidity: i128): u64 {
  if (liquidity < 0n) return deltaAmount1Unsigned(sqrtA, sqrtB, u128(-liquidity), false);
  return deltaAmount1Unsigned(sqrtA, sqrtB, u128(liquidity), true);
}

export interface TokenAmounts {
  amount0: u64;
  amount1: u64;
}

/** Token amounts for a liquidity change on a position (liquidity_math::get_delta_amounts_signed). */
export function deltaAmountsSigned(tickCurrent: i32, sqrtPriceX64Current: u128, tickLower: i32, tickUpper: i32, liquidityDelta: i128): TokenAmounts {
  if (tickCurrent < tickLower)
    return { amount0: deltaAmount0Signed(getSqrtPriceAtTick(tickLower), getSqrtPriceAtTick(tickUpper), liquidityDelta), amount1: 0n };
  if (tickCurrent < tickUpper)
    return {
      amount0: deltaAmount0Signed(sqrtPriceX64Current, getSqrtPriceAtTick(tickUpper), liquidityDelta),
      amount1: deltaAmount1Signed(getSqrtPriceAtTick(tickLower), sqrtPriceX64Current, liquidityDelta),
    };
  return { amount0: 0n, amount1: deltaAmount1Signed(getSqrtPriceAtTick(tickLower), getSqrtPriceAtTick(tickUpper), liquidityDelta) };
}

// ---- swap_math ----------------------------------------------------------------------------------------------------

export interface SwapStep {
  sqrtPriceNextX64: u128;
  amountIn: u64;
  amountOut: u64;
  feeAmount: u64;
}

/** One swap step within a tick range (swap_math::compute_swap). */
export function computeSwap(
  sqrtPriceCurrentX64: u128,
  sqrtPriceTargetX64: u128,
  liquidity: u128,
  amountRemaining: u64,
  feeRate: u32,
  isBaseInput: boolean,
  zeroForOne: boolean,
  isFeeOnInput: boolean,
): SwapStep {
  const denom = u64(FEE_RATE_DENOMINATOR_VALUE);
  const keep = u64(FEE_RATE_DENOMINATOR_VALUE - feeRate);
  let forPrice: u64 = amountRemaining;
  if (isBaseInput && isFeeOnInput) forPrice = mulDivFloor64(amountRemaining, keep, denom);
  if (!isBaseInput && !isFeeOnInput) forPrice = mulDivCeil64(amountRemaining, denom, keep);

  let sqrtNext: u128 = sqrtPriceTargetX64;
  let amountIn: u64 = 0n;
  let amountOut: u64 = 0n;
  const atTarget = deltaAmountsForSwap(sqrtPriceTargetX64, sqrtPriceCurrentX64, liquidity, zeroForOne);
  const reached = atTarget.fits && forPrice >= (isBaseInput ? atTarget.amountIn : atTarget.amountOut);
  if (reached) {
    amountIn = atTarget.amountIn;
    amountOut = atTarget.amountOut;
  } else {
    sqrtNext = isBaseInput
      ? nextSqrtPriceFromInput(sqrtPriceCurrentX64, liquidity, forPrice, zeroForOne)
      : nextSqrtPriceFromOutput(sqrtPriceCurrentX64, liquidity, forPrice, zeroForOne);
    const step = deltaAmountsForSwap(sqrtNext, sqrtPriceCurrentX64, liquidity, zeroForOne);
    require(step.fits, ErrorCode.MaxTokenOverflow);
    amountIn = step.amountIn;
    amountOut = step.amountOut;
  }
  if (zeroForOne) require(sqrtNext >= sqrtPriceTargetX64, AnchorError.RequireGteViolated);
  else require(sqrtPriceTargetX64 >= sqrtNext, AnchorError.RequireGteViolated);

  let feeAmount: u64 = 0n;
  if (isBaseInput) {
    if (isFeeOnInput) {
      if (sqrtNext !== sqrtPriceTargetX64) {
        require(amountRemaining >= amountIn, ErrorCode.CalculateOverflow);
        feeAmount = amountRemaining - amountIn;
      } else feeAmount = mulDivCeil64(amountIn, u64(feeRate), keep);
    } else {
      feeAmount = mulDivCeil64(amountOut, u64(feeRate), denom);
      require(amountOut >= feeAmount, ErrorCode.CalculateOverflow);
      amountOut = amountOut - feeAmount;
      if (sqrtNext !== sqrtPriceTargetX64) amountIn = amountRemaining;
    }
  } else if (isFeeOnInput) {
    amountOut = amountOut < amountRemaining ? amountOut : amountRemaining;
    feeAmount = mulDivCeil64(amountIn, u64(feeRate), keep);
  } else {
    feeAmount = mulDivCeil64(amountOut, u64(feeRate), denom);
    require(amountOut >= feeAmount, ErrorCode.CalculateOverflow);
    const net = amountOut - feeAmount;
    if (net > amountRemaining) {
      require(amountOut >= amountRemaining, ErrorCode.CalculateOverflow);
      feeAmount = amountOut - amountRemaining;
      amountOut = amountRemaining;
    } else amountOut = net;
  }
  return { sqrtPriceNextX64: sqrtNext, amountIn, amountOut, feeAmount };
}
