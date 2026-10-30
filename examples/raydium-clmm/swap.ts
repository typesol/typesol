// Swapping in the Raydium CLMM port (raydium-io/raydium-clmm @ 6d7a0f8): the pieces of instructions/swap.rs and
// swap_v2.rs that do not need the instruction's remaining accounts — the swap state, fee splitting, the dynamic fee
// (states/pool_fee.rs), limit orders met at a tick (TickState::match_limit_order_with_sqrt_price), the tick array
// bitmap searches (libraries/tick_array_bit_map.rs, states/tickarray_bitmap_extension.rs, PoolState) and the oracle
// (states/oracle.rs). The loop itself is swapV2 in raydium_clmm.ts. The dynamic fee's state is updated in the pool
// account in place: the original works on a copy and writes the same four fields back at the end.
import { AnchorError, type Account, type Mut, type u16, currentEpoch, i32, i64, i128, log, require, u32, u64, u128, u256 } from "typesol";
import { ErrorCode } from "./errors";
import { NO_KEY, abs32, arrayStartIndex, flipBitDefault, isValidStartIndex, maxTickInBitmap, overflowsDefaultBitmap, tickCount, wrappingAdd128, wrappingSub128 } from "./liquidity";
import { FEE_RATE_DENOMINATOR_VALUE, MAX_TICK, MIN_TICK, Q64, addDelta, computeSwap, getSqrtPriceAtTick, getTickAtSqrtPrice, mulDivCeil64, mulDivFloor128, msb128 } from "./math";
import { type AmmConfig, type ObservationState, type PoolState, type TickArrayBitmapExtension, type TickArrayState, type TickState } from "./state";

const MAX_FEE_RATE_NUMERATOR: u32 = 100_000n;
const VOLATILITY_ACCUMULATOR_SCALE: u64 = 10_000n;
const REDUCTION_FACTOR_DENOMINATOR: u64 = 10_000n;
const SWAP_U64_MAX: u64 = 18446744073709551615n;
/** A search through the tick array bitmap that found nothing (and no bounded tick). */
export const NO_ARRAY: i64 = 4294967296n;
const SWAP_U128_MAX: u128 = 340282366920938463463374607431768211455n;

/** The swap in progress (swap.rs SwapState; the dynamic fee lives in the pool). */
export interface SwapState {
  amount_specified_remaining: u64;
  amount_calculated: u64;
  sqrt_price_x64: u128;
  tick: i32;
  fee_growth_global_x64: u128;
  lp_fee: u64;
  protocol_fee: u64;
  fund_fee: u64;
  liquidity: u128;
  sqrt_price_next_x64: u128;
  tick_next: i32;
  tick_spacing_index: i32;
  /** Where the loop over tick arrays is (swap_internal's locals): the next array's first used tick is next. */
  take_first: boolean;
  first_has_pool_tick: boolean;
  /** This array has no more used ticks in the swap's direction. */
  move_on: boolean;
  /** An array was emptied whose bit is in the bitmap extension: the caller flips it. */
  ext_flip: boolean;
  ext_flip_start: i32;
}

/** A swap state held where whole new states can be stored. */
export interface SwapRun {
  s: SwapState;
}

/** A limit order filled at a tick (LimitOrderMatchResult). */
export interface LimitOrderMatch {
  amount_in: u64;
  amount_out: u64;
  amm_fee_amount: u64;
}

/** Where a search through the tick array bitmap ended: found, or where it stopped. */
export interface ArraySearch {
  found: boolean;
  start: i32;
}

// ---- fees (states/pool_fee.rs) ------------------------------------------------------------------------------------

/** PoolState::is_fee_on_input. */
export function feeOnInput(pool: Account<PoolState>, zeroForOne: boolean): boolean {
  if (pool.fee_on === 1n) return zeroForOne;
  if (pool.fee_on === 2n) return !zeroForOne;
  return true;
}
/** PoolState::is_fee_on_token0. */
export function feeOnToken0(pool: Account<PoolState>, zeroForOne: boolean): boolean {
  if (pool.fee_on === 1n) return true;
  if (pool.fee_on === 2n) return false;
  return zeroForOne;
}
/** PoolState::get_dynamic_fee_info is Some: the pool's DynamicFeeInfo is not all zeros. */
export function dynamicFeeEnabled(pool: Account<PoolState>): boolean {
  const f = pool.dynamic_fee_info;
  let any =
    f.filter_period !== 0n ||
    f.decay_period !== 0n ||
    f.reduction_factor !== 0n ||
    f.dynamic_fee_control !== 0n ||
    f.max_volatility_accumulator !== 0n ||
    f.tick_spacing_index_reference !== 0n ||
    f.volatility_reference !== 0n ||
    f.volatility_accumulator !== 0n ||
    f.last_update_timestamp !== 0n;
  for (let i = 0n; i < 46n && !any; i++) if (f.padding.get(i) !== 0n) any = true;
  return any;
}
/** tick_spacing_index_from_tick: which group of `spacing` ticks `tick` is in. */
export function tickSpacingIndex(tick: i32, spacing: u16): i32 {
  const s = i32(spacing);
  if (tick % s === 0n || tick >= 0n) return tick / s;
  return tick / s - 1n;
}
/** DynamicFeeInfo::update_reference. */
export function updateReference(pool: Mut<PoolState>, index: i32, now: u64): void {
  const f = pool.dynamic_fee_info;
  const since = now > f.last_update_timestamp ? now - f.last_update_timestamp : 0n;
  if (since < u64(f.filter_period)) return;
  f.tick_spacing_index_reference = index;
  f.volatility_reference = since < u64(f.decay_period) ? u32((u64(f.volatility_accumulator) * u64(f.reduction_factor)) / REDUCTION_FACTOR_DENOMINATOR) : 0n;
  f.last_update_timestamp = now;
}
/** DynamicFeeInfo::update_volatility_accumulator. */
export function updateVolatilityAccumulator(pool: Mut<PoolState>, index: i32): void {
  const f = pool.dynamic_fee_info;
  const delta = abs32(f.tick_spacing_index_reference - index);
  const acc = u64(f.volatility_reference) + u64(delta) * VOLATILITY_ACCUMULATOR_SCALE;
  f.volatility_accumulator = acc < u64(f.max_volatility_accumulator) ? u32(acc) : f.max_volatility_accumulator;
}
/** SwapState::get_total_fee_rate: the config's trade fee, plus the dynamic fee when the pool has one. */
export function totalFeeRate(pool: Account<PoolState>, dynamic: boolean, base: u32): u32 {
  if (!dynamic) return base;
  const f = pool.dynamic_fee_info;
  // compute_dynamic_fee_rate: control * (accumulator * spacing)^2 / (100,000 * 10,000^2), rounded up.
  const crossed = f.volatility_accumulator * u32(pool.tick_spacing);
  const squared = u64(crossed) * u64(crossed);
  const rate = mulDivCeil128(u128(f.dynamic_fee_control), u128(squared), 10_000_000_000_000n);
  const dynamicRate = rate > u128(MAX_FEE_RATE_NUMERATOR) ? MAX_FEE_RATE_NUMERATOR : u32(rate);
  const total = base + dynamicRate;
  return total < MAX_FEE_RATE_NUMERATOR ? total : MAX_FEE_RATE_NUMERATOR;
}

/** U128::mul_div_ceil, CalculateOverflow when it does not fit (or c is 0). */
function mulDivCeil128(a: u128, b: u128, c: u128): u128 {
  require(c !== 0n, ErrorCode.CalculateOverflow);
  const r = (u256(a) * u256(b) + u256(c) - 1n) / u256(c);
  require(r <= u256(SWAP_U128_MAX), ErrorCode.CalculateOverflow);
  return u128(r);
}

/** SwapState::spilt_fees into a new state: protocol and fund shares, the rest to liquidity providers (or the protocol when there are none). */
export function splitFees(s: SwapState, fee: u64, config: Account<AmmConfig>): SwapState {
  const protocol = config.protocol_fee_rate > 0n ? u64((u128(fee) * u128(config.protocol_fee_rate)) / u128(FEE_RATE_DENOMINATOR_VALUE)) : 0n;
  const fund = config.fund_fee_rate > 0n ? u64((u128(fee) * u128(config.fund_fee_rate)) / u128(FEE_RATE_DENOMINATOR_VALUE)) : 0n;
  require(s.protocol_fee <= SWAP_U64_MAX - protocol, ErrorCode.CalculateOverflow);
  require(s.fund_fee <= SWAP_U64_MAX - fund, ErrorCode.CalculateOverflow);
  require(fee >= protocol && fee - protocol >= fund, ErrorCode.CalculateOverflow);
  const remaining = fee - protocol - fund;
  let protocolFee = s.protocol_fee + protocol;
  let lpFee = s.lp_fee;
  let growth = s.fee_growth_global_x64;
  if (s.liquidity > 0n) {
    growth = wrappingAdd128(growth, mulDivFloor128(u128(remaining), Q64, s.liquidity));
    require(lpFee <= SWAP_U64_MAX - remaining, ErrorCode.CalculateOverflow);
    lpFee += remaining;
  } else {
    require(protocolFee <= SWAP_U64_MAX - remaining, ErrorCode.CalculateOverflow);
    protocolFee += remaining;
  }
  return {
    amount_specified_remaining: s.amount_specified_remaining,
    amount_calculated: s.amount_calculated,
    sqrt_price_x64: s.sqrt_price_x64,
    tick: s.tick,
    fee_growth_global_x64: growth,
    lp_fee: lpFee,
    protocol_fee: protocolFee,
    fund_fee: s.fund_fee + fund,
    liquidity: s.liquidity,
    sqrt_price_next_x64: s.sqrt_price_next_x64,
    tick_next: s.tick_next,
    tick_spacing_index: s.tick_spacing_index,
    take_first: s.take_first,
    first_has_pool_tick: s.first_has_pool_tick,
    move_on: s.move_on,
    ext_flip: s.ext_flip,
    ext_flip_start: s.ext_flip_start,
  };
}

// ---- ticks (states/tick_array.rs) ---------------------------------------------------------------------------------

/** TickState::is_initialized: liquidity or limit orders on it. */
export function tickInitialized(t: TickState): boolean {
  return t.liquidity_gross > 0n || t.orders_amount > 0n || t.part_filled_orders_remaining > 0n;
}
/** TickState::limit_order_unfilled_amount. */
export function unfilledAmount(t: TickState): u64 {
  require(t.orders_amount <= SWAP_U64_MAX - t.part_filled_orders_remaining, ErrorCode.CalculateOverflow);
  return t.orders_amount + t.part_filled_orders_remaining;
}
/** TickArrayState::next_initialized_tick: the offset of the next used tick from `tick` in the swap's direction, or -1. */
export function nextInitializedOffset(array: Account<TickArrayState>, tick: i32, spacing: u16, zeroForOne: boolean): i64 {
  if (arrayStartIndex(tick, spacing) !== array.start_tick_index) return -1n;
  const offset = i64((tick - array.start_tick_index) / i32(spacing));
  if (zeroForOne) {
    for (let i = offset; i >= 0n; i--) if (tickInitialized(array.ticks.get(u64(i)))) return i;
  } else {
    for (let i = offset + 1n; i < 60n; i++) if (tickInitialized(array.ticks.get(u64(i)))) return i;
  }
  return -1n;
}
/** TickArrayState::first_initialized_tick: the first used tick of the array in the swap's direction. */
export function firstInitializedOffset(array: Account<TickArrayState>, zeroForOne: boolean): u64 {
  if (zeroForOne) {
    for (let i: i64 = 59n; i >= 0n; i--) if (tickInitialized(array.ticks.get(u64(i)))) return u64(i);
  } else {
    for (let i = 0n; i < 60n; i++) if (tickInitialized(array.ticks.get(i))) return i;
  }
  require(false, ErrorCode.InvalidTickArray);
  return 0n;
}
/** TickState::cross: the fee and reward growth outside flip sides; returns the tick's liquidity_net. */
export function crossTick(array: Mut<TickArrayState>, offset: u64, pool: Account<PoolState>, feeGrowth0: u128, feeGrowth1: u128): i128 {
  const t = array.ticks.get(offset);
  t.fee_growth_outside_0_x64 = wrappingSub128(feeGrowth0, t.fee_growth_outside_0_x64);
  t.fee_growth_outside_1_x64 = wrappingSub128(feeGrowth1, t.fee_growth_outside_1_x64);
  for (let i = 0n; i < 3n; i++) {
    const r = pool.reward_infos.get(i);
    if (r.token_mint === NO_KEY) continue;
    t.reward_growths_outside_x64.set(i, wrappingSub128(r.reward_growth_global_x64, t.reward_growths_outside_x64.get(i)));
  }
  return t.liquidity_net;
}

// ---- limit orders (states/tick_array.rs) --------------------------------------------------------------------------

/** tick_math::get_price_from_sqrt_price: the Q64.64 price of token 0. */
export function priceFromSqrt(sqrtPriceX64: u128, roundUp: boolean): u128 {
  let prod = u256(sqrtPriceX64) * u256(sqrtPriceX64);
  if (roundUp) prod += u256(Q64 - 1n);
  const price = prod >> 64n;
  require(price <= u256(SWAP_U128_MAX), ErrorCode.CalculateOverflow);
  return u128(price);
}
/** get_limit_order_output_with_price: what `amountIn` buys at `price`. */
export function limitOrderOutput(amountIn: u64, price: u128, zeroForOne: boolean): u128 {
  return zeroForOne ? mulDivFloor128(u128(amountIn), price, Q64) : mulDivFloor128(u128(amountIn), Q64, price);
}
/** get_limit_order_input_with_price: what `amountOut` costs at `price`, rounded up. */
function limitOrderInput(amountOut: u64, price: u128, zeroForOne: boolean): u64 {
  const r = zeroForOne ? mulDivCeil128(u128(amountOut), price, Q64) : mulDivCeil128(u128(amountOut), Q64, price);
  require(r <= u128(SWAP_U64_MAX), ErrorCode.CalculateOverflow);
  return u64(r);
}
function minU64(a: u64, b: u64): u64 {
  return a < b ? a : b;
}

/** TickState::match_limit_order_with_sqrt_price: fill the tick's limit orders from what is left of the swap. */
export function matchLimitOrder(
  array: Mut<TickArrayState>,
  offset: u64,
  swapAmount: u64,
  zeroForOne: boolean,
  baseInput: boolean,
  feeRate: u32,
  isFeeOnInput: boolean,
  sqrtPriceX64: u128,
): LimitOrderMatch {
  const t = array.ticks.get(offset);
  const unfilled = unfilledAmount(t);
  if (swapAmount === 0n || unfilled === 0n) return { amount_in: 0n, amount_out: 0n, amm_fee_amount: 0n };
  const price = priceFromSqrt(sqrtPriceX64, !zeroForOne);
  const denom = u64(FEE_RATE_DENOMINATOR_VALUE);
  const keep = u64(FEE_RATE_DENOMINATOR_VALUE - feeRate);
  let amountIn: u64 = 0n;
  let amountOut: u64 = 0n;
  let fee: u64 = 0n;
  if (baseInput) {
    if (isFeeOnInput) {
      fee = mulDivCeil64(swapAmount, u64(feeRate), denom);
      amountIn = swapAmount - fee;
    } else amountIn = swapAmount;
    const matched = limitOrderOutput(amountIn, price, zeroForOne);
    if (matched > u128(unfilled)) {
      // The orders run out first: buy all of them.
      amountOut = unfilled;
      amountIn = limitOrderInput(unfilled, price, !zeroForOne);
      if (isFeeOnInput) fee = mulDivCeil64(amountIn, u64(feeRate), keep);
    } else amountOut = u64(matched);
  } else {
    const net = minU64(swapAmount, unfilled);
    amountOut = isFeeOnInput ? net : minU64(mulDivCeil64(net, denom, keep), unfilled);
    amountIn = limitOrderInput(amountOut, price, !zeroForOne);
    if (isFeeOnInput) fee = mulDivCeil64(amountIn, u64(feeRate), keep);
  }
  // Partly filled orders go first.
  let fromPartFilled: u64 = 0n;
  if (t.part_filled_orders_remaining > 0n) {
    fromPartFilled = minU64(t.part_filled_orders_remaining, amountOut);
    if (fromPartFilled > 0n)
      t.unfilled_ratio_x64 = mulDivFloor128(t.unfilled_ratio_x64, u128(t.part_filled_orders_remaining - fromPartFilled), u128(t.part_filled_orders_remaining));
    t.part_filled_orders_remaining = t.part_filled_orders_remaining - fromPartFilled;
  }
  const rest = amountOut > fromPartFilled ? amountOut - fromPartFilled : 0n;
  if (rest > 0n) {
    require(t.part_filled_orders_remaining === 0n, AnchorError.RequireEqViolated);
    require(t.orders_amount >= rest, ErrorCode.InvalidLimitOrderAmount);
    // A new phase: the rest of the orders become partly filled.
    t.order_phase = t.order_phase < SWAP_U64_MAX ? t.order_phase + 1n : SWAP_U64_MAX;
    t.unfilled_ratio_x64 = mulDivFloor128(Q64, u128(t.orders_amount - rest), u128(t.orders_amount));
    t.part_filled_orders_remaining = t.orders_amount - rest;
    t.orders_amount = 0n;
  }
  if (!isFeeOnInput) {
    fee = mulDivCeil64(amountOut, u64(feeRate), denom);
    require(amountOut >= fee, ErrorCode.CalculateOverflow);
    amountOut = amountOut - fee;
  }
  return { amount_in: amountIn, amount_out: amountOut, amm_fee_amount: fee };
}

// ---- the tick array bitmap: finding the next used array ----------------------------------------------------------

/** The index of the lowest set bit of a non-zero u64. */
function lsb64(x: u64): u64 {
  let n: u64 = 0n;
  let v = x;
  if ((v & 0xffffffffn) === 0n) {
    v = v >> 32n;
    n += 32n;
  }
  if ((v & 0xffffn) === 0n) {
    v = v >> 16n;
    n += 16n;
  }
  if ((v & 0xffn) === 0n) {
    v = v >> 8n;
    n += 8n;
  }
  if ((v & 0xfn) === 0n) {
    v = v >> 4n;
    n += 4n;
  }
  if ((v & 0x3n) === 0n) {
    v = v >> 2n;
    n += 2n;
  }
  if ((v & 0x1n) === 0n) n += 1n;
  return n;
}
/** The bits of `w` at or below `bit`. */
function bitsAtOrBelow(w: u64, bit: u64): u64 {
  return bit === 63n ? w : w & ((u64(1n) << (bit + 1n)) - 1n);
}
/** The bits of `w` at or above `bit`. */
function bitsAtOrAbove(w: u64, bit: u64): u64 {
  return (w >> bit) << bit;
}

/** In the pool's 1024-bit bitmap: the highest set bit at or below `pos`, or -1. */
function poolHighestAtOrBelow(pool: Account<PoolState>, pos: u64): i64 {
  for (let w = i64(pos / 64n); w >= 0n; w--) {
    let word = pool.tick_array_bitmap.get(u64(w));
    if (u64(w) === pos / 64n) word = bitsAtOrBelow(word, pos % 64n);
    if (word !== 0n) return w * 64n + i64(msb128(u128(word)));
  }
  return -1n;
}
/** In the pool's bitmap: the lowest set bit at or above `pos`, or -1. */
function poolLowestAtOrAbove(pool: Account<PoolState>, pos: u64): i64 {
  for (let w = pos / 64n; w < 16n; w++) {
    let word = pool.tick_array_bitmap.get(w);
    if (w === pos / 64n) word = bitsAtOrAbove(word, pos % 64n);
    if (word !== 0n) return i64(w * 64n + lsb64(word));
  }
  return -1n;
}

/** check_current_tick_array_is_initialized: whether the array holding the pool's tick is marked, and its start. */
export function currentArrayInBitmap(pool: Account<PoolState>): ArraySearch {
  const tick = pool.tick_current;
  require(tick >= MIN_TICK && tick <= MAX_TICK, ErrorCode.InvalidTickIndex);
  const multiplier = tickCount(pool.tick_spacing);
  let compressed = tick / multiplier + 512n;
  if (tick < 0n && tick % multiplier !== 0n) compressed -= 1n;
  const pos = u64(abs32(compressed));
  const word = pool.tick_array_bitmap.get(pos / 64n);
  return { found: ((word >> pos % 64n) & 1n) === 1n, start: (compressed - 512n) * multiplier };
}

/** tick_array_bit_map::next_initialized_tick_array_start_index: the next marked array in the pool's own bitmap. */
export function nextArrayInBitmap(pool: Account<PoolState>, last: i32, zeroForOne: boolean): ArraySearch {
  const spacing = pool.tick_spacing;
  require(isValidStartIndex(last, spacing), ErrorCode.InvalidTickArrayBoundary);
  const boundary = maxTickInBitmap(spacing);
  const next = zeroForOne ? last - tickCount(spacing) : last + tickCount(spacing);
  if (next < -boundary || next >= boundary) return { found: false, start: last };
  const multiplier = tickCount(spacing);
  let compressed = next / multiplier + 512n;
  if (next < 0n && next % multiplier !== 0n) compressed -= 1n;
  const pos = u64(abs32(compressed));
  if (zeroForOne) {
    const bit = poolHighestAtOrBelow(pool, pos);
    return bit >= 0n ? { found: true, start: (i32(bit) - 512n) * multiplier } : { found: false, start: -boundary };
  }
  const bit = poolLowestAtOrAbove(pool, pos);
  return bit >= 0n ? { found: true, start: (i32(bit) - 512n) * multiplier } : { found: false, start: boundary - tickCount(spacing) };
}

/** TickArrayBitmapExtension::get_bitmap_offset: which of its 14 bitmaps holds `start`. */
function extensionRow(start: i32, spacing: u16): u64 {
  require(isValidStartIndex(start, spacing), ErrorCode.InvalidTickIndex);
  const bound = maxTickInBitmap(spacing);
  require(MAX_TICK > bound, AnchorError.RequireGtViolated);
  require(-bound > MIN_TICK, AnchorError.RequireGtViolated);
  require(start < -bound || start >= bound, ErrorCode.InvalidTickArrayBoundary);
  let offset = abs32(start) / bound - 1n;
  if (start < 0n && abs32(start) % bound === 0n) offset -= 1n;
  return u64(offset);
}
/** TickArrayBitmapExtension::tick_array_offset_in_bitmap. */
function extensionBit(start: i32, spacing: u16): u64 {
  const m = abs32(start) % maxTickInBitmap(spacing);
  let bit = m / tickCount(spacing);
  if (start < 0n && m !== 0n) bit = 512n - bit;
  return u64(bit);
}
function extensionWord(ext: Account<TickArrayBitmapExtension>, negative: boolean, row: u64, w: u64): u64 {
  return negative ? ext.negative_tick_array_bitmap.get(row).get(w) : ext.positive_tick_array_bitmap.get(row).get(w);
}

/** TickArrayBitmapExtension::check_tick_array_is_initialized. */
export function arrayInExtension(ext: Account<TickArrayBitmapExtension>, start: i32, spacing: u16): ArraySearch {
  const row = extensionRow(start, spacing);
  const bit = extensionBit(start, spacing);
  const word = extensionWord(ext, start < 0n, row, bit / 64n);
  return { found: ((word >> bit % 64n) & 1n) === 1n, start };
}

/** TickArrayBitmapExtension::next_initialized_tick_array_from_one_bitmap. */
export function nextArrayInExtension(ext: Account<TickArrayBitmapExtension>, last: i32, spacing: u16, zeroForOne: boolean): ArraySearch {
  const multiplier = tickCount(spacing);
  const next = zeroForOne ? last - multiplier : last + multiplier;
  if (next < arrayStartIndex(MIN_TICK, spacing) || next > arrayStartIndex(MAX_TICK, spacing)) return { found: false, start: next };
  const row = extensionRow(next, spacing);
  const negative = next < 0n;
  // get_bitmap_tick_boundary: the ticks this bitmap covers.
  const span = maxTickInBitmap(spacing);
  let m = abs32(next) / span;
  if (next < 0n && abs32(next) % span !== 0n) m += 1n;
  const low = negative ? -(span * m) : span * m;
  const high = low + span;
  const bit = extensionBit(next, spacing);
  if (zeroForOne) {
    for (let w = i64(bit / 64n); w >= 0n; w--) {
      let word = extensionWord(ext, negative, row, u64(w));
      if (u64(w) === bit / 64n) word = bitsAtOrBelow(word, bit % 64n);
      if (word !== 0n) return { found: true, start: next - i32(i64(bit) - (w * 64n + i64(msb128(u128(word))))) * multiplier };
    }
    return { found: false, start: low };
  }
  for (let w = bit / 64n; w < 8n; w++) {
    let word = extensionWord(ext, negative, row, w);
    if (w === bit / 64n) word = bitsAtOrAbove(word, bit % 64n);
    if (word !== 0n) return { found: true, start: next + i32(w * 64n + lsb64(word) - bit) * multiplier };
  }
  return { found: false, start: high - multiplier };
}

// ---- the oracle (states/oracle.rs) --------------------------------------------------------------------------------

/** ObservationState::update: a new observation at most every 15 seconds. */
export function updateObservation(obs: Mut<ObservationState>, timestamp: u32, tick: i32): void {
  const index = obs.observation_index;
  if (!obs.initialized) {
    obs.initialized = true;
    obs.observations.get(index).block_timestamp = timestamp;
    obs.observations.get(index).tick_cumulative = 0n;
    return;
  }
  const last = obs.observations.get(index);
  const elapsed = timestamp > last.block_timestamp ? timestamp - last.block_timestamp : 0n;
  if (elapsed < 15n) return;
  const lastCumulative = last.tick_cumulative;
  const next = index === 99n ? 0n : index + 1n;
  obs.observations.get(next).block_timestamp = timestamp;
  // i64::wrapping_add of tick * elapsed (at most about 1.9e15, so never saturating).
  const sum = i128(lastCumulative) + i128(tick) * i128(elapsed);
  const wrapped = sum > 9223372036854775807n ? sum - 18446744073709551616n : sum < -9223372036854775808n ? sum + 18446744073709551616n : sum;
  obs.observations.get(next).tick_cumulative = i64(wrapped);
  obs.observation_index = next;
}

/** The pool's fees after the swap (PoolState::update_fee). */
export function updatePoolFees(pool: Mut<PoolState>, s: SwapState, zeroForOne: boolean): void {
  if (feeOnToken0(pool, zeroForOne)) {
    if (s.lp_fee > 0n) pool.fee_growth_global_0_x64 = s.fee_growth_global_x64;
    if (s.protocol_fee > 0n) {
      require(pool.protocol_fees_token_0 <= SWAP_U64_MAX - s.protocol_fee, ErrorCode.CalculateOverflow);
      pool.protocol_fees_token_0 += s.protocol_fee;
    }
    if (s.fund_fee > 0n) {
      require(pool.fund_fees_token_0 <= SWAP_U64_MAX - s.fund_fee, ErrorCode.CalculateOverflow);
      pool.fund_fees_token_0 += s.fund_fee;
    }
  } else {
    if (s.lp_fee > 0n) pool.fee_growth_global_1_x64 = s.fee_growth_global_x64;
    if (s.protocol_fee > 0n) {
      require(pool.protocol_fees_token_1 <= SWAP_U64_MAX - s.protocol_fee, ErrorCode.CalculateOverflow);
      pool.protocol_fees_token_1 += s.protocol_fee;
    }
    if (s.fund_fee > 0n) {
      require(pool.fund_fees_token_1 <= SWAP_U64_MAX - s.fund_fee, ErrorCode.CalculateOverflow);
      pool.fund_fees_token_1 += s.fund_fee;
    }
  }
}

/** get_spacing_bounded_price's tick: the edge of the current tick spacing group, logged as the original logs it. */
export function spacingBound(pool: Account<PoolState>, s: SwapState, zeroForOne: boolean): i32 {
  const spacing = i32(pool.tick_spacing);
  const index = zeroForOne ? s.tick_spacing_index : s.tick_spacing_index + 1n;
  // saturating_mul / saturating_add on i32, then clamped to the tick range.
  const wide = i64(index) * i64(spacing);
  const bounded = wide > 2147483647n ? 2147483647n : wide < -2147483648n ? -2147483648n : wide;
  log(`state.tick:${s.tick}, state.tick_spacing_index:${s.tick_spacing_index}, bounded_tick:${bounded}`);
  return i32(bounded < i64(MIN_TICK) ? i64(MIN_TICK) : bounded > i64(MAX_TICK) ? i64(MAX_TICK) : bounded);
}


/** SwapState::new: the pool's price, liquidity and the fee growth of the token fees are taken in. */
export function newSwapRun(pool: Account<PoolState>, amount: u64, zeroForOne: boolean, firstHasPoolTick: boolean): SwapRun {
  return {
    s: {
      amount_specified_remaining: amount,
      amount_calculated: 0n,
      sqrt_price_x64: pool.sqrt_price_x64,
      tick: pool.tick_current,
      fee_growth_global_x64: feeOnToken0(pool, zeroForOne) ? pool.fee_growth_global_0_x64 : pool.fee_growth_global_1_x64,
      lp_fee: 0n,
      protocol_fee: 0n,
      fund_fee: 0n,
      liquidity: pool.liquidity,
      sqrt_price_next_x64: 0n,
      tick_next: 0n,
      tick_spacing_index: 0n,
      take_first: false,
      first_has_pool_tick: firstHasPoolTick,
      move_on: false,
      ext_flip: false,
      ext_flip_start: 0n,
    },
  };
}

/** A copy of a swap state, to change. */
function copySwapState(s: SwapState): SwapState {
  return {
    amount_specified_remaining: s.amount_specified_remaining,
    amount_calculated: s.amount_calculated,
    sqrt_price_x64: s.sqrt_price_x64,
    tick: s.tick,
    fee_growth_global_x64: s.fee_growth_global_x64,
    lp_fee: s.lp_fee,
    protocol_fee: s.protocol_fee,
    fund_fee: s.fund_fee,
    liquidity: s.liquidity,
    sqrt_price_next_x64: s.sqrt_price_next_x64,
    tick_next: s.tick_next,
    tick_spacing_index: s.tick_spacing_index,
    take_first: s.take_first,
    first_has_pool_tick: s.first_has_pool_tick,
    move_on: s.move_on,
    ext_flip: s.ext_flip,
    ext_flip_start: s.ext_flip_start,
  };
}

/**
 * The swap loop over one tick array (swap_internal's while loop while it stays in this array): ticks crossed, limit
 * orders filled, the dynamic fee stepped. Returns the new state; `move_on` when the array has no more used ticks in
 * the swap's direction, `ext_flip` when an array was emptied whose bit is in the extension (the caller flips it).
 */
export function swapInArray(
  pool_state: Mut<PoolState>,
  amm_config: Account<AmmConfig>,
  array: Mut<TickArrayState>,
  from: SwapState,
  limit: u128,
  zeroForOne: boolean,
  baseInput: boolean,
  isFeeOnInput: boolean,
  dynamic: boolean,
): SwapState {
  const st = copySwapState(from);
  const spacing = pool_state.tick_spacing;
  /** SwapState::apply_swap_amounts. */
  const apply = (amountIn: u64, amountOut: u64, fee: u64): void => {
    let consumed = amountIn;
    if (isFeeOnInput) {
      require(amountIn <= 18446744073709551615n - fee, ErrorCode.CalculateOverflow);
      consumed = amountIn + fee;
    }
    const spent = baseInput ? consumed : amountOut;
    const got = baseInput ? amountOut : consumed;
    require(st.amount_specified_remaining >= spent, ErrorCode.CalculateOverflow);
    st.amount_specified_remaining -= spent;
    require(st.amount_calculated <= 18446744073709551615n - got, ErrorCode.CalculateOverflow);
    st.amount_calculated += got;
    const split = splitFees(st, fee, amm_config);
    st.fee_growth_global_x64 = split.fee_growth_global_x64;
    st.lp_fee = split.lp_fee;
    st.protocol_fee = split.protocol_fee;
    st.fund_fee = split.fund_fee;
  };

  while (st.amount_specified_remaining !== 0n && st.sqrt_price_x64 !== limit && !st.move_on) {
    // The next tick with liquidity or orders: in this array, the first of it, or the next marked array's.
    let offset: i64 = -1n;
    if (st.take_first) {
      offset = i64(firstInitializedOffset(array, zeroForOne));
      st.take_first = false;
    } else {
      offset = nextInitializedOffset(array, st.tick, spacing, zeroForOne);
      if (offset < 0n) {
        if (!st.first_has_pool_tick) {
          st.first_has_pool_tick = true;
          offset = i64(firstInitializedOffset(array, zeroForOne));
        } else st.move_on = true;
      }
    }
    if (st.move_on) break;
    const slot = u64(offset);
    require(tickInitialized(array.ticks.get(slot)), AnchorError.RequireEqViolated);
    // get_target_price_based_on_next_tick
    const tickNext = array.ticks.get(slot).tick;
    st.tick_next = tickNext < MIN_TICK ? MIN_TICK : tickNext > MAX_TICK ? MAX_TICK : tickNext;
    st.sqrt_price_next_x64 = getSqrtPriceAtTick(st.tick_next);
    const target = (zeroForOne && st.sqrt_price_next_x64 < limit) || (!zeroForOne && st.sqrt_price_next_x64 > limit) ? limit : st.sqrt_price_next_x64;
    if (zeroForOne) {
      require(st.tick >= st.tick_next, AnchorError.RequireGteViolated);
      require(st.sqrt_price_x64 >= st.sqrt_price_next_x64, AnchorError.RequireGteViolated);
      require(st.sqrt_price_x64 >= target, AnchorError.RequireGteViolated);
    } else {
      require(st.tick_next > st.tick, AnchorError.RequireGtViolated);
      require(st.sqrt_price_next_x64 >= st.sqrt_price_x64, AnchorError.RequireGteViolated);
      require(target >= st.sqrt_price_x64, AnchorError.RequireGteViolated);
    }
    let liquidityNext = st.liquidity;
    let stepDone = false;
    while (!stepDone) {
      if (dynamic) updateVolatilityAccumulator(pool_state, st.tick_spacing_index);
      const feeRate = totalFeeRate(pool_state, dynamic, amm_config.trade_fee_rate);
      // get_spacing_bounded_price: with a dynamic fee, one tick spacing group at a time.
      let skipped = true;
      let bounded = target;
      let boundedTick: i64 = NO_ARRAY;
      if (dynamic && st.liquidity !== 0n && pool_state.dynamic_fee_info.volatility_accumulator !== pool_state.dynamic_fee_info.max_volatility_accumulator) {
        skipped = false;
        const edge = spacingBound(pool_state, st, zeroForOne);
        const edgePrice = getSqrtPriceAtTick(edge);
        if (zeroForOne ? target <= edgePrice : target >= edgePrice) {
          bounded = edgePrice;
          boundedTick = i64(edge);
        }
      }
      let reached = bounded;
      if (st.sqrt_price_x64 !== bounded) {
        const step = computeSwap(st.sqrt_price_x64, bounded, st.liquidity, st.amount_specified_remaining, feeRate, baseInput, zeroForOne, isFeeOnInput);
        reached = step.sqrtPriceNextX64;
        apply(step.amountIn, step.amountOut, step.feeAmount);
      }
      const unfilledBefore = unfilledAmount(array.ticks.get(slot));
      if (st.sqrt_price_next_x64 === reached) {
        // At the tick: its limit orders, then crossing it.
        const filled = matchLimitOrder(array, slot, st.amount_specified_remaining, zeroForOne, baseInput, feeRate, isFeeOnInput, st.sqrt_price_next_x64);
        if (filled.amount_in !== 0n || filled.amount_out !== 0n || filled.amm_fee_amount !== 0n) apply(filled.amount_in, filled.amount_out, filled.amm_fee_amount);
        if (!tickInitialized(array.ticks.get(slot))) {
          require(array.initialized_tick_count > 0n, ErrorCode.CalculateOverflow);
          array.initialized_tick_count -= 1n;
          if (array.initialized_tick_count === 0n) {
            // In the extension: left to the caller, which holds the remaining accounts (nothing below reads it).
            if (overflowsDefaultBitmap(array.start_tick_index, spacing)) {
              st.ext_flip = true;
              st.ext_flip_start = array.start_tick_index;
            } else flipBitDefault(pool_state, array.start_tick_index);
          }
        }
        const t = array.ticks.get(slot);
        const hasOrders = t.orders_amount > 0n || t.part_filled_orders_remaining > 0n;
        if (t.liquidity_gross > 0n && !hasOrders) {
          const onToken0 = feeOnToken0(pool_state, zeroForOne);
          const net = crossTick(
            array,
            slot,
            pool_state,
            onToken0 ? st.fee_growth_global_x64 : pool_state.fee_growth_global_0_x64,
            onToken0 ? pool_state.fee_growth_global_1_x64 : st.fee_growth_global_x64,
          );
          liquidityNext = addDelta(st.liquidity, zeroForOne ? -net : net);
        }
        array.recent_epoch = currentEpoch();
        st.tick = (zeroForOne && !hasOrders) || (!zeroForOne && hasOrders) ? st.tick_next - 1n : st.tick_next;
      } else if (st.sqrt_price_x64 !== reached) {
        st.tick = boundedTick !== NO_ARRAY && reached === bounded ? i32(boundedTick) : getTickAtSqrtPrice(reached);
      }
      st.sqrt_price_x64 = reached;
      // update_dynamic_fee_index
      if (dynamic) {
        if (skipped) {
          const tickIndex = st.sqrt_price_x64 === st.sqrt_price_next_x64 ? st.tick_next : st.tick;
          let index = tickSpacingIndex(tickIndex, spacing);
          if (!zeroForOne && tickIndex % i32(spacing) === 0n) index = index - 1n;
          st.tick_spacing_index = index;
          if (pool_state.dynamic_fee_info.volatility_accumulator !== pool_state.dynamic_fee_info.max_volatility_accumulator)
            updateVolatilityAccumulator(pool_state, st.tick_spacing_index);
        }
        st.tick_spacing_index = zeroForOne ? st.tick_spacing_index - 1n : st.tick_spacing_index + 1n;
      }
      if (st.amount_specified_remaining === 0n || st.sqrt_price_x64 === target) {
        const unfilledAfter = unfilledAmount(array.ticks.get(slot));
        if (st.amount_specified_remaining !== 0n && unfilledAfter !== unfilledBefore) require(unfilledAfter === 0n, AnchorError.RequireEqViolated);
        stepDone = true;
      }
    }
    st.liquidity = liquidityNext;
  }
  return st;
}
