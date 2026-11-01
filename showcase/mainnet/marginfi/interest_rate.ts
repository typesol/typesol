// Marginfi's interest rates (programs/marginfi/src/state/interest_rate.rs and the u32 encoders of
// type-crate/src/types/interest_rate.rs @ c5d440f6): the seven-point curve, the rates and fees it gives at a
// utilization, and what an accrual over `delta` seconds does to the share values and fee counters. All I80F48
// (showcase/mainnet/marginfi/i80f48.ts); every checked operation that fails is MathError, where the original's `?` on None is.
import { type Account, type i128, type u32, type u64, type u8, i128 as toI128, require, u128, u32 as toU32 } from "typesol";
import { MarginfiError } from "./errors";
import { I80F48_ONE, I80F48_ZERO, fxAdd, fxDiv, fxFromU64, fxMul } from "./i80f48";
import { type InterestRateConfig, type MarginfiGroup } from "./state";

/** 31,536,000 seconds, as I80F48. */
export const SECONDS_PER_YEAR: i128 = 8876594865547247616000n; // 31536000n << 48n
export const U32_MAX_FX: i128 = 1208925819333154197995520n; // u32::MAX as I80F48: 4294967295n << 48n
const TEN: i128 = 2814749767106560n; // 10n << 48n
const HUNDRED: i128 = 28147497671065600n; // 100n << 48n
const INTEREST_CURVE_LEGACY: u8 = 0n;
const INTEREST_CURVE_SEVEN_POINT: u8 = 1n;
/** MarginfiGroup.group_flags: the group pays the program's fees. */
export const PROGRAM_FEES_ENABLED: u64 = 1n;

/** u32_to_centi: the truncated division util / u32::MAX on the bits. */
export function u32ToCenti(util: u32): i128 {
  return (toI128(u128(util)) << 48n) / 4294967295n;
}
/** u32_to_milli: u32_to_centi's bits times 10. */
export function u32ToMilli(rate: u32): i128 {
  return u32ToCenti(rate) * 10n;
}
/** u32_to_basis: u32_to_centi's bits times 100. */
export function u32ToBasis(v: u32): i128 {
  return u32ToCenti(v) * 100n;
}
/** clamp(v, 0, max) / max × u32::MAX, truncated (milli_to_u32 with max 10, centi 1, basis 100). */
function toU32Scaled(v: i128, max: i128): u32 {
  const clamped = v > max ? max : v < 0n ? I80F48_ZERO : v;
  const ratio = fxDiv(clamped, max);
  return toU32(u128(fxMul(ratio, U32_MAX_FX) >> 48n));
}
export function milliToU32(v: i128): u32 {
  return toU32Scaled(v, TEN);
}
export function centiToU32(v: i128): u32 {
  return toU32Scaled(v, I80F48_ONE);
}
export function basisToU32(v: i128): u32 {
  return toU32Scaled(v, HUNDRED);
}

/**
 * InterestRateCalc::lerp: start_y when the segment is empty or the target before it, end_y past it; a falling
 * segment has no rate (MathError, the caller's `ok_or_else(math_error!())`).
 */
function lerp(startX: i128, startY: i128, endX: i128, endY: i128, target: i128): i128 {
  if (endX <= startX || target <= startX) return startY;
  if (target >= endX) return endY;
  require(endY >= startY, MarginfiError.MathError);
  const proportion = fxDiv(target - startX, endX - startX);
  return startY + fxMul(endY - startY, proportion);
}

/** multipoint_curve: through (0, zero), the points with a utilization (in order), and (1, hundred); ur clamped to [0, 1]. */
export function multipointCurve(ir: InterestRateConfig, utilization: i128): i128 {
  const zero = u32ToMilli(ir.zero_util_rate);
  const hundred = u32ToMilli(ir.hundred_util_rate);
  const ur = utilization < 0n ? I80F48_ZERO : utilization > I80F48_ONE ? I80F48_ONE : utilization;
  let prevUtil: i128 = I80F48_ZERO;
  let prevRate = zero;
  for (let i = 0n; i < 5n; i++) {
    const p = ir.points.get(i);
    if (p.util === 0n) continue;
    const util = u32ToCenti(p.util);
    const rate = u32ToMilli(p.rate);
    if (ur <= util) return lerp(prevUtil, prevRate, util, rate, ur);
    prevUtil = util;
    prevRate = rate;
  }
  return lerp(prevUtil, prevRate, I80F48_ONE, hundred, ur);
}

/** ComputedInterestRates. */
export interface Rates {
  base: i128;
  lending: i128;
  borrowing: i128;
  group_fee: i128;
  insurance_fee: i128;
  protocol_fee: i128;
}

/** calc_fee_rate: the fixed fee alone when there is no rate fee, else base × rate + fixed. */
function feeRate(base: i128, rateFee: i128, fixedFee: i128): i128 {
  if (rateFee === 0n) return fixedFee;
  return fxAdd(fxMul(base, rateFee), fixedFee);
}

/** InterestRateCalc::calc_interest_rate at `utilization`, with the group's program fees when it charges them. */
export function calcInterestRate(ir: InterestRateConfig, group: Account<MarginfiGroup>, utilization: i128): Rates {
  const programFees = (group.group_flags & PROGRAM_FEES_ENABLED) !== 0n;
  const insuranceRate = ir.insurance_ir_fee.value;
  const insuranceFixed = ir.insurance_fee_fixed_apr.value;
  const groupRate = ir.protocol_ir_fee.value;
  const groupFixed = ir.protocol_fixed_fee_apr.value;
  const protocolRate = programFees ? group.fee_state_cache.program_fee_rate.value : I80F48_ZERO;
  const protocolFixed = programFees ? group.fee_state_cache.program_fee_fixed.value : I80F48_ZERO;
  // The fee sums come first and use the plain operators: an overflow panics in the original (here MathError).
  const feeIr = fxAdd(fxAdd(insuranceRate, groupRate), protocolRate);
  const feeFixed = fxAdd(fxAdd(insuranceFixed, groupFixed), protocolFixed);
  require(ir.curve_type !== INTEREST_CURVE_LEGACY, MarginfiError.InvalidConfig);
  // Any other unknown curve panics in the original.
  require(ir.curve_type === INTEREST_CURVE_SEVEN_POINT, MarginfiError.InvalidConfig);
  const base = multipointCurve(ir, utilization);
  const lending = fxMul(base, utilization);
  const borrowing = fxAdd(fxMul(base, fxAdd(I80F48_ONE, feeIr)), feeFixed);
  const groupFee = feeRate(base, groupRate, groupFixed);
  const insuranceFee = feeRate(base, insuranceRate, insuranceFixed);
  const protocolFee = feeRate(base, protocolRate, protocolFixed);
  // Asserts in the original (a negative rate panics).
  require(lending >= 0n && borrowing >= 0n && groupFee >= 0n && insuranceFee >= 0n && protocolFee >= 0n, MarginfiError.MathError);
  return { base, lending, borrowing, group_fee: groupFee, insurance_fee: insuranceFee, protocol_fee: protocolFee };
}

/** calc_accrued_interest_payment_per_period: value × (1 + apr × delta / year). */
export function accruedValue(apr: i128, delta: u64, value: i128): i128 {
  const perPeriod = fxDiv(fxMul(apr, fxFromU64(delta)), SECONDS_PER_YEAR);
  return fxMul(value, fxAdd(I80F48_ONE, perPeriod));
}
/** calc_interest_payment_for_period: value × apr × delta / year (zero for a zero apr). */
export function interestPayment(apr: i128, delta: u64, value: i128): i128 {
  if (apr === 0n) return I80F48_ZERO;
  return fxDiv(fxMul(fxMul(value, apr), fxFromU64(delta)), SECONDS_PER_YEAR);
}

/** InterestRateStateChanges. */
export interface Accrual {
  asset_share_value: i128;
  liability_share_value: i128;
  insurance_fees: i128;
  group_fees: i128;
  protocol_fees: i128;
}

/** calc_interest_rate_accrual_state_changes over `delta` seconds. */
export function accrualChanges(
  ir: InterestRateConfig,
  group: Account<MarginfiGroup>,
  delta: u64,
  totalAssets: i128,
  totalLiabilities: i128,
  assetShareValue: i128,
  liabilityShareValue: i128,
): Accrual {
  const utilization = fxDiv(totalLiabilities, totalAssets);
  const r = calcInterestRate(ir, group, utilization);
  return {
    asset_share_value: accruedValue(r.lending, delta, assetShareValue),
    liability_share_value: accruedValue(r.borrowing, delta, liabilityShareValue),
    insurance_fees: interestPayment(r.insurance_fee, delta, totalLiabilities),
    group_fees: interestPayment(r.group_fee, delta, totalLiabilities),
    protocol_fees: interestPayment(r.protocol_fee, delta, totalLiabilities),
  };
}

/** InterestRateConfig::validate_seven_point (the only curve the deployed program accepts). */
export function validateInterestRateConfig(ir: InterestRateConfig): void {
  require(ir.curve_type !== INTEREST_CURVE_LEGACY, MarginfiError.InvalidConfig);
  // Any other unknown curve panics in the original.
  require(ir.curve_type === INTEREST_CURVE_SEVEN_POINT, MarginfiError.InvalidConfig);
  const zero = ir.zero_util_rate;
  const hundred = ir.hundred_util_rate;
  let seenPadding = false;
  let prevUtil: u32 = 0n;
  let prevRate: u32 = 0n;
  let used = 0n;
  for (let i = 0n; i < 5n; i++) {
    const p = ir.points.get(i);
    if (p.util === 0n) {
      require(p.rate === 0n, MarginfiError.InvalidConfig);
      seenPadding = true;
      continue;
    }
    require(!seenPadding, MarginfiError.InvalidConfig);
    if (used > 0n) {
      require(prevUtil < p.util, MarginfiError.InvalidConfig);
      require(prevRate <= p.rate, MarginfiError.InvalidConfig);
    }
    prevUtil = p.util;
    prevRate = p.rate;
    used++;
  }
  require(zero <= hundred, MarginfiError.InvalidConfig);
  for (let i = 0n; i < 5n; i++) {
    const p = ir.points.get(i);
    if (p.util !== 0n) require(zero <= p.rate && p.rate <= hundred, MarginfiError.InvalidConfig);
  }
}
