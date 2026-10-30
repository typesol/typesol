// Positions and liquidity of the Raydium CLMM port (raydium-io/raydium-clmm @ 6d7a0f8): the tick array and bitmap
// functions of states/tick_array.rs, states/pool.rs and states/tickarray_bitmap_extension.rs, PoolState::
// update_reward_infos, modify_position / add_liquidity / burn_liquidity (instructions/open_position.rs,
// decrease_liquidity.rs) and PersonalPositionState's fee and reward accounting. The original copies a tick out of
// its array, changes it and writes it back; here it is changed in place, which comes to the same bytes.
import {
  AnchorError,
  type Account,
  type FixedArray,
  type Mint,
  type Mut,
  type Option,
  type Pubkey,
  type u8,
  type u16,
  currentEpoch,
  fixedArray,
  i32,
  i128,
  pubkey,
  require,
  transferFee,
  transferFeeInverse,
  u64,
  u128,
  u256,
} from "typesol";
import { ErrorCode } from "./errors";
import { MAX_TICK, MIN_TICK, Q64, addDelta, deltaAmountsSigned, getSqrtPriceAtTick, liquidityFromSingleAmount0, liquidityFromSingleAmount1, mulDivFloor128 } from "./math";
import { type PersonalPositionState, type PoolState, type TickArrayBitmapExtension, type TickArrayState } from "./state";

const MAX_U64: u64 = 18446744073709551615n;
const MAX_U128: u128 = 340282366920938463463374607431768211455n;
const MAX_I128: i128 = 170141183460469231731687303715884105727n;
const MIN_I128: i128 = -170141183460469231731687303715884105728n;
const NO_KEY = pubkey("11111111111111111111111111111111");
/** tick_array_bit_map::TICK_ARRAY_BITMAP_SIZE: the default bitmap's tick arrays on each side of 0. */
const TICK_ARRAY_BITMAP_SIZE: i32 = 512n;

/** What a liquidity change did (instructions/open_position.rs LiquidityChangeResult), and what is left to do. */
export interface LiquidityChange {
  /** add_liquidity returned at once: no liquidity and no base_flag to work it out from. */
  skipped: boolean;
  liquidity: u128;
  liquidity_before: u128;
  amount_0: u64;
  amount_1: u64;
  /** The tick array's bit in the pool's bitmap (or its extension) is to be flipped. */
  flip_lower: boolean;
  flip_upper: boolean;
  fee_growth_inside_0_x64: u128;
  fee_growth_inside_1_x64: u128;
  reward_growths_inside: FixedArray<u128, 3>;
}

/** u128::wrapping_sub. */
export function wrappingSub128(a: u128, b: u128): u128 {
  return a >= b ? a - b : MAX_U128 - (b - a) + 1n;
}
/** u128::wrapping_add. */
export function wrappingAdd128(a: u128, b: u128): u128 {
  return a <= MAX_U128 - b ? a + b : a - (MAX_U128 - b) - 1n;
}
/** U128::mul_div_floor(…).unwrap_or(0): 0 when the result does not fit. */
function mulDivFloorOr0(a: u128, b: u128, c: u128): u128 {
  const r = (u256(a) * u256(b)) / u256(c);
  return r <= u256(MAX_U128) ? u128(r) : 0n;
}
/** U128::mul_div_ceil(…).unwrap_or(0). */
function mulDivCeilOr0(a: u128, b: u128, c: u128): u128 {
  const r = (u256(a) * u256(b) + u256(c) - 1n) / u256(c);
  return r <= u256(MAX_U128) ? u128(r) : 0n;
}
/** to_underflow_u64: the value when it is below u64::MAX, else 0. */
function underflowU64(x: u128): u64 {
  return x < u128(MAX_U64) ? u64(x) : 0n;
}
function abs32(x: i32): i32 {
  return x < 0n ? -x : x;
}

// ---- tick arrays (states/tick_array.rs) ---------------------------------------------------------------------------

/** TickArrayState::tick_count: the ticks one array spans. */
export function tickCount(spacing: u16): i32 {
  return 60n * i32(spacing);
}
/** TickArrayState::get_array_start_index: the start of the array holding `tick`. */
export function arrayStartIndex(tick: i32, spacing: u16): i32 {
  const n = tickCount(spacing);
  let start = tick / n;
  if (tick < 0n && tick % n !== 0n) start = start - 1n;
  return start * n;
}
/** TickArrayState::check_is_valid_start_index. */
export function isValidStartIndex(start: i32, spacing: u16): boolean {
  if (start < MIN_TICK || start > MAX_TICK) {
    if (start > MAX_TICK) return false;
    return start === arrayStartIndex(MIN_TICK, spacing);
  }
  return start % tickCount(spacing) === 0n;
}
/** tick_array::check_tick_array_start_index. */
export function checkTickArrayStartIndex(start: i32, tick: i32, spacing: u16): void {
  require(tick >= MIN_TICK, ErrorCode.TickLowerOverflow);
  require(tick <= MAX_TICK, ErrorCode.TickUpperOverflow);
  require(tick % i32(spacing) === 0n, AnchorError.RequireEqViolated);
  require(start === arrayStartIndex(tick, spacing), AnchorError.RequireEqViolated);
}
/** TickArrayState::get_tick_offset_in_array: where `tick` is in the array starting at `start`. */
export function tickOffset(start: i32, tick: i32, spacing: u16): u64 {
  require(arrayStartIndex(tick, spacing) === start, ErrorCode.InvalidTickArray);
  return u64((tick - start) / i32(spacing));
}
/** TickArrayState::initialize, on an array just created. */
export function initTickArray(array: Mut<TickArrayState>, start: i32, pool: Account<PoolState>): void {
  array.start_tick_index = start;
  array.pool_id = pool.key;
  array.recent_epoch = currentEpoch();
}

// ---- the tick array bitmap (states/pool.rs, libraries/tick_array_bit_map.rs, states/tickarray_bitmap_extension.rs) ---

/** tick_array_bit_map::max_tick_in_tickarray_bitmap. */
function maxTickInBitmap(spacing: u16): i32 {
  return i32(spacing) * 60n * TICK_ARRAY_BITMAP_SIZE;
}
/**
 * PoolState::is_overflow_default_tickarray_bitmap for one tick: whether its array is beyond the pool's own bitmap
 * (tick_array_start_index_range), so it is marked in the TickArrayBitmapExtension.
 */
export function overflowsDefaultBitmap(tick: i32, spacing: u16): boolean {
  let max = maxTickInBitmap(spacing);
  let min = -max;
  if (max > MAX_TICK) max = arrayStartIndex(MAX_TICK, spacing) + tickCount(spacing);
  if (min < MIN_TICK) min = arrayStartIndex(MIN_TICK, spacing);
  const start = arrayStartIndex(tick, spacing);
  return start >= max || start < min;
}
/** PoolState::flip_tick_array_bit_default. */
export function flipBitDefault(pool: Mut<PoolState>, start: i32): void {
  require(isValidStartIndex(start, pool.tick_spacing), ErrorCode.InvalidTickIndex);
  const offset = u64(start / tickCount(pool.tick_spacing) + TICK_ARRAY_BITMAP_SIZE);
  const word = offset / 64n;
  pool.tick_array_bitmap.set(word, pool.tick_array_bitmap.get(word) ^ (u64(1n) << offset % 64n));
}
/** TickArrayBitmapExtension::flip_tick_array_bit. */
export function flipBitExtension(ext: Mut<TickArrayBitmapExtension>, start: i32, spacing: u16): void {
  // get_bitmap_offset: which of the 14 bitmaps.
  require(isValidStartIndex(start, spacing), ErrorCode.InvalidTickIndex);
  const bound = maxTickInBitmap(spacing);
  require(MAX_TICK > bound, AnchorError.RequireGtViolated);
  require(-bound > MIN_TICK, AnchorError.RequireGtViolated);
  require(start < -bound || start >= bound, ErrorCode.InvalidTickArrayBoundary);
  let offset = abs32(start) / bound - 1n;
  if (start < 0n && abs32(start) % bound === 0n) offset -= 1n;
  // tick_array_offset_in_bitmap: which bit of it.
  const m = abs32(start) % bound;
  let bit = m / tickCount(spacing);
  if (start < 0n && m !== 0n) bit = TICK_ARRAY_BITMAP_SIZE - bit;
  const row = u64(offset);
  const word = u64(bit) / 64n;
  const mask = u64(1n) << u64(bit) % 64n;
  if (start < 0n) ext.negative_tick_array_bitmap.get(row).set(word, ext.negative_tick_array_bitmap.get(row).get(word) ^ mask);
  else ext.positive_tick_array_bitmap.get(row).set(word, ext.positive_tick_array_bitmap.get(row).get(word) ^ mask);
}

// ---- rewards (states/pool.rs) -------------------------------------------------------------------------------------

/** PoolState::update_reward_infos: the rewards emitted up to `now`. */
export function updateRewardInfos(pool: Mut<PoolState>, now: u64): void {
  for (let i = 0n; i < 3n; i++) {
    const r = pool.reward_infos.get(i);
    if (r.token_mint === NO_KEY || r.reward_total_emitted === MAX_U64) continue;
    if (now <= r.open_time) continue;
    const latest = now < r.end_time ? now : r.end_time;
    if (pool.liquidity !== 0n) {
      const elapsed = latest > r.last_update_time ? latest - r.last_update_time : 0n;
      if (elapsed === 0n) continue;
      const emitted = mulDivCeilOr0(u128(elapsed), r.emissions_per_second_x64, Q64);
      let growth = mulDivFloorOr0(u128(elapsed), r.emissions_per_second_x64, pool.liquidity);
      const remain = MAX_U64 - r.reward_total_emitted;
      if (emitted <= u128(remain)) r.reward_total_emitted += u64(emitted);
      else {
        r.reward_total_emitted = MAX_U64;
        growth = mulDivFloorOr0(u128(remain), Q64, pool.liquidity);
      }
      r.reward_growth_global_x64 = wrappingAdd128(r.reward_growth_global_x64, growth);
    }
    r.last_update_time = latest;
    // RewardState::Opening (2) while it runs, Ended (3) at its end.
    if (latest >= r.open_time && latest < r.end_time) r.reward_state = 2n;
    else if (latest === r.end_time) r.reward_state = 3n;
  }
  pool.recent_epoch = currentEpoch();
}

// ---- ticks and positions (states/tick_array.rs, instructions/open_position.rs) ------------------------------------

/** TickState::update: the tick's liquidity after `delta`; true when it flipped between used and unused. */
function updateTick(array: Mut<TickArrayState>, offset: u64, pool: Account<PoolState>, delta: i128, upper: boolean): boolean {
  const t = array.ticks.get(offset);
  const before = t.liquidity_gross;
  const after = addDelta(before, delta);
  require(t.orders_amount <= MAX_U64 - t.part_filled_orders_remaining, ErrorCode.CalculateOverflow);
  const noUnfilledOrders = t.orders_amount + t.part_filled_orders_remaining === 0n;
  const flipped = (after === 0n) !== (before === 0n) && noUnfilledOrders;
  // By convention, all growth before a tick was initialized happened below it.
  if (before === 0n && t.tick <= pool.tick_current) {
    t.fee_growth_outside_0_x64 = pool.fee_growth_global_0_x64;
    t.fee_growth_outside_1_x64 = pool.fee_growth_global_1_x64;
    for (let i = 0n; i < 3n; i++) t.reward_growths_outside_x64.set(i, pool.reward_infos.get(i).reward_growth_global_x64);
  }
  t.liquidity_gross = after;
  // Crossing the lower tick left to right adds the liquidity, the upper one removes it.
  const subtract = upper ? delta : -delta;
  require(subtract > 0n ? t.liquidity_net >= MIN_I128 + subtract : t.liquidity_net <= MAX_I128 + subtract, ErrorCode.CalculateOverflow);
  t.liquidity_net = t.liquidity_net - subtract;
  return flipped;
}

/** TickState::clear. */
function clearTick(array: Mut<TickArrayState>, offset: u64): void {
  const t = array.ticks.get(offset);
  t.liquidity_net = 0n;
  t.liquidity_gross = 0n;
  t.fee_growth_outside_0_x64 = 0n;
  t.fee_growth_outside_1_x64 = 0n;
  for (let i = 0n; i < 3n; i++) t.reward_growths_outside_x64.set(i, 0n);
}

/**
 * modify_position: the pool's rewards brought up to date, the two ticks changed by `delta`, the fee and reward
 * growth inside the range, and the token amounts `delta` is worth. The pool's liquidity changes when the price is in
 * the range. The ticks are at `lowerOffset` / `upperOffset` of their arrays (possibly one array).
 */
function modifyPosition(
  delta: i128,
  pool: Mut<PoolState>,
  lowerArray: Mut<TickArrayState>,
  lowerOffset: u64,
  upperArray: Mut<TickArrayState>,
  upperOffset: u64,
  timestamp: u64,
  liquidity: u128,
  liquidityBefore: u128,
): LiquidityChange {
  updateRewardInfos(pool, timestamp);
  let flippedLower = false;
  let flippedUpper = false;
  if (delta !== 0n) {
    flippedLower = updateTick(lowerArray, lowerOffset, pool, delta, false);
    flippedUpper = updateTick(upperArray, upperOffset, pool, delta, true);
  }
  const lower = lowerArray.ticks.get(lowerOffset);
  const upper = upperArray.ticks.get(upperOffset);
  const lowerTick = lower.tick;
  const upperTick = upper.tick;
  const current = pool.tick_current;

  // get_fee_growth_inside
  const below0 = current >= lower.tick ? lower.fee_growth_outside_0_x64 : wrappingSub128(pool.fee_growth_global_0_x64, lower.fee_growth_outside_0_x64);
  const below1 = current >= lower.tick ? lower.fee_growth_outside_1_x64 : wrappingSub128(pool.fee_growth_global_1_x64, lower.fee_growth_outside_1_x64);
  const above0 = current < upper.tick ? upper.fee_growth_outside_0_x64 : wrappingSub128(pool.fee_growth_global_0_x64, upper.fee_growth_outside_0_x64);
  const above1 = current < upper.tick ? upper.fee_growth_outside_1_x64 : wrappingSub128(pool.fee_growth_global_1_x64, upper.fee_growth_outside_1_x64);
  const inside0 = wrappingSub128(wrappingSub128(pool.fee_growth_global_0_x64, below0), above0);
  const inside1 = wrappingSub128(wrappingSub128(pool.fee_growth_global_1_x64, below1), above1);

  // get_reward_growths_inside: 0 for rewards not set up.
  const rewards = fixedArray<u128, 3>(0n);
  for (let i = 0n; i < 3n; i++) {
    const r = pool.reward_infos.get(i);
    if (r.token_mint === NO_KEY) continue;
    const below = current >= lower.tick ? lower.reward_growths_outside_x64.get(i) : wrappingSub128(r.reward_growth_global_x64, lower.reward_growths_outside_x64.get(i));
    const above = current < upper.tick ? upper.reward_growths_outside_x64.get(i) : wrappingSub128(r.reward_growth_global_x64, upper.reward_growths_outside_x64.get(i));
    rewards.set(i, wrappingSub128(wrappingSub128(r.reward_growth_global_x64, below), above));
  }

  if (delta < 0n) {
    if (flippedLower) clearTick(lowerArray, lowerOffset);
    if (flippedUpper) clearTick(upperArray, upperOffset);
  }
  let amount0: u64 = 0n;
  let amount1: u64 = 0n;
  if (delta !== 0n) {
    const amounts = deltaAmountsSigned(current, pool.sqrt_price_x64, lowerTick, upperTick, delta);
    amount0 = amounts.amount0;
    amount1 = amounts.amount1;
    if (current >= lowerTick && current < upperTick) pool.liquidity = addDelta(pool.liquidity, delta);
  }
  return {
    skipped: false,
    liquidity,
    liquidity_before: liquidityBefore,
    amount_0: amount0,
    amount_1: amount1,
    flip_lower: flippedLower,
    flip_upper: flippedUpper,
    fee_growth_inside_0_x64: inside0,
    fee_growth_inside_1_x64: inside1,
    reward_growths_inside: rewards,
  };
}

/** i128::try_from(liquidity), CalculateOverflow when it does not fit. */
function signed(liquidity: u128): i128 {
  require(liquidity <= u128(MAX_I128), ErrorCode.CalculateOverflow);
  return i128(liquidity);
}

/**
 * add_liquidity up to the bitmap: the liquidity (worked out from one amount when it is 0 and base_flag says which),
 * the two ticks and the pool. `flip_lower` / `flip_upper` say which arrays just got their first used tick, whose bit
 * the caller flips; the rest is finishAddLiquidity.
 */
export function addLiquidityToTicks(
  pool: Mut<PoolState>,
  lowerArray: Mut<TickArrayState>,
  upperArray: Mut<TickArrayState>,
  vault0Mint: Mint,
  vault1Mint: Mint,
  requested: u128,
  baseFlag: Option<boolean>,
  amount0Max: u64,
  amount1Max: u64,
  tickLower: i32,
  tickUpper: i32,
  timestamp: u64,
): LiquidityChange {
  let liquidity = requested;
  if (liquidity === 0n) {
    // Opening a position with no liquidity (added later) does nothing here.
    if (baseFlag === null) return skippedChange();
    // The transfer fee comes off the amount first: the pool gets only what is left of it.
    const sqrtLower = getSqrtPriceAtTick(tickLower);
    const sqrtUpper = getSqrtPriceAtTick(tickUpper);
    if (baseFlag) liquidity = liquidityFromSingleAmount0(pool.sqrt_price_x64, sqrtLower, sqrtUpper, amount0Max - transferFee(vault0Mint, amount0Max));
    else liquidity = liquidityFromSingleAmount1(pool.sqrt_price_x64, sqrtLower, sqrtUpper, amount1Max - transferFee(vault1Mint, amount1Max));
  }
  require(liquidity > 0n, ErrorCode.ZeroLiquidity);
  const before = pool.liquidity;
  require(lowerArray.pool_id === pool.key, AnchorError.RequireKeysEqViolated);
  require(upperArray.pool_id === pool.key, AnchorError.RequireKeysEqViolated);
  const lowerOffset = tickOffset(lowerArray.start_tick_index, tickLower, pool.tick_spacing);
  const upperOffset = tickOffset(upperArray.start_tick_index, tickUpper, pool.tick_spacing);
  // A tick never used has tick 0 until now.
  if (lowerArray.ticks.get(lowerOffset).tick === 0n) lowerArray.ticks.get(lowerOffset).tick = tickLower;
  if (upperArray.ticks.get(upperOffset).tick === 0n) upperArray.ticks.get(upperOffset).tick = tickUpper;
  const change = modifyPosition(signed(liquidity), pool, lowerArray, lowerOffset, upperArray, upperOffset, timestamp, liquidity, before);
  // update_tick_state stamps both arrays.
  lowerArray.recent_epoch = currentEpoch();
  upperArray.recent_epoch = currentEpoch();
  // A tick newly in use: its array counts it, and an array's first one marks it in the bitmap.
  let flipLower = false;
  let flipUpper = false;
  if (change.flip_lower) {
    flipLower = lowerArray.initialized_tick_count === 0n;
    require(lowerArray.initialized_tick_count < 255n, ErrorCode.CalculateOverflow);
    lowerArray.initialized_tick_count += 1n;
  }
  if (change.flip_upper) {
    flipUpper = upperArray.initialized_tick_count === 0n;
    require(upperArray.initialized_tick_count < 255n, ErrorCode.CalculateOverflow);
    upperArray.initialized_tick_count += 1n;
  }
  return {
    skipped: false,
    liquidity,
    liquidity_before: before,
    amount_0: change.amount_0,
    amount_1: change.amount_1,
    flip_lower: flipLower,
    flip_upper: flipUpper,
    fee_growth_inside_0_x64: change.fee_growth_inside_0_x64,
    fee_growth_inside_1_x64: change.fee_growth_inside_1_x64,
    reward_growths_inside: change.reward_growths_inside,
  };
}

/** LiquidityChangeResult::default(), for add_liquidity's early return. */
function skippedChange(): LiquidityChange {
  const zeros = fixedArray<u128, 3>(0n);
  return {
    skipped: true,
    liquidity: 0n,
    liquidity_before: 0n,
    amount_0: 0n,
    amount_1: 0n,
    flip_lower: false,
    flip_upper: false,
    fee_growth_inside_0_x64: 0n,
    fee_growth_inside_1_x64: 0n,
    reward_growths_inside: zeros,
  };
}

/** burn_liquidity up to the bitmap: the ticks and pool after taking `liquidity` out; flip_* when an array emptied. */
export function burnLiquidityFromTicks(
  pool: Mut<PoolState>,
  lowerArray: Mut<TickArrayState>,
  upperArray: Mut<TickArrayState>,
  tickLower: i32,
  tickUpper: i32,
  liquidity: u128,
  timestamp: u64,
): LiquidityChange {
  require(lowerArray.pool_id === pool.key, AnchorError.RequireKeysEqViolated);
  require(upperArray.pool_id === pool.key, AnchorError.RequireKeysEqViolated);
  const before = pool.liquidity;
  const lowerOffset = tickOffset(lowerArray.start_tick_index, tickLower, pool.tick_spacing);
  const upperOffset = tickOffset(upperArray.start_tick_index, tickUpper, pool.tick_spacing);
  const change = modifyPosition(-signed(liquidity), pool, lowerArray, lowerOffset, upperArray, upperOffset, timestamp, liquidity, before);
  lowerArray.recent_epoch = currentEpoch();
  upperArray.recent_epoch = currentEpoch();
  let flipLower = false;
  let flipUpper = false;
  if (change.flip_lower) {
    require(lowerArray.initialized_tick_count > 0n, ErrorCode.CalculateOverflow);
    lowerArray.initialized_tick_count -= 1n;
    flipLower = lowerArray.initialized_tick_count === 0n;
  }
  if (change.flip_upper) {
    require(upperArray.initialized_tick_count > 0n, ErrorCode.CalculateOverflow);
    upperArray.initialized_tick_count -= 1n;
    flipUpper = upperArray.initialized_tick_count === 0n;
  }
  return {
    skipped: false,
    liquidity,
    liquidity_before: before,
    amount_0: change.amount_0,
    amount_1: change.amount_1,
    flip_lower: flipLower,
    flip_upper: flipUpper,
    fee_growth_inside_0_x64: change.fee_growth_inside_0_x64,
    fee_growth_inside_1_x64: change.fee_growth_inside_1_x64,
    reward_growths_inside: change.reward_growths_inside,
  };
}

// ---- transfer fees (util/token.rs) --------------------------------------------------------------------------------

/** get_transfer_inverse_fee: the fee to add so the pool receives `amount`, checked by computing it forward. */
export function inverseTransferFee(mint: Mint, amount: u64): u64 {
  const fee = transferFeeInverse(mint, amount);
  require(amount <= MAX_U64 - fee, ErrorCode.CalculateOverflow);
  require(transferFee(mint, amount + fee) === fee, ErrorCode.TransferFeeCalculateNotMatch);
  return fee;
}

// ---- personal positions (states/personal_position.rs) -------------------------------------------------------------

/** calculate_latest_token_fees. */
function latestTokenFees(owed: u64, last: u128, latest: u128, liquidity: u128): u64 {
  const earned = underflowU64(mulDivFloor128(wrappingSub128(latest, last), liquidity, Q64));
  require(owed <= MAX_U64 - earned, ErrorCode.CalculateOverflow);
  return owed + earned;
}

/** PersonalPositionState::update_rewards: the rewards earned since the last update (`addDelta`), then the new growth. */
function updatePositionRewards(position: Mut<PersonalPositionState>, growths: FixedArray<u128, 3>, accrue: boolean): void {
  for (let i = 0n; i < 3n; i++) {
    const r = position.reward_infos.get(i);
    if (accrue) {
      // A growth delta that overflows counts as nothing: the position loses what it earned since.
      const earned = underflowU64(mulDivFloorOr0(wrappingSub128(growths.get(i), r.growth_inside_last_x64), position.liquidity, Q64));
      require(r.reward_amount_owed <= MAX_U64 - earned, ErrorCode.CalculateOverflow);
      r.reward_amount_owed += earned;
    }
    r.growth_inside_last_x64 = growths.get(i);
  }
  position.recent_epoch = currentEpoch();
}

/** PersonalPositionState::initialize. */
export function initPosition(position: Mut<PersonalPositionState>, bump: u8, nftMint: Pubkey, pool: Pubkey, tickLower: i32, tickUpper: i32, change: LiquidityChange): void {
  position.bump.set(0n, bump);
  position.nft_mint = nftMint;
  position.pool_id = pool;
  position.tick_lower_index = tickLower;
  position.tick_upper_index = tickUpper;
  position.fee_growth_inside_0_last_x64 = change.fee_growth_inside_0_x64;
  position.fee_growth_inside_1_last_x64 = change.fee_growth_inside_1_x64;
  position.token_fees_owed_0 = 0n;
  position.token_fees_owed_1 = 0n;
  updatePositionRewards(position, change.reward_growths_inside, false);
  position.liquidity = change.liquidity;
  for (let i = 0n; i < 7n; i++) position.padding.set(i, 0n);
}

/** PersonalPositionState::increase_liquidity / decrease_liquidity: fees and rewards earned so far, then the liquidity. */
export function updatePosition(position: Mut<PersonalPositionState>, change: LiquidityChange, increase: boolean): void {
  position.token_fees_owed_0 = latestTokenFees(position.token_fees_owed_0, position.fee_growth_inside_0_last_x64, change.fee_growth_inside_0_x64, position.liquidity);
  position.token_fees_owed_1 = latestTokenFees(position.token_fees_owed_1, position.fee_growth_inside_1_last_x64, change.fee_growth_inside_1_x64, position.liquidity);
  position.fee_growth_inside_0_last_x64 = change.fee_growth_inside_0_x64;
  position.fee_growth_inside_1_last_x64 = change.fee_growth_inside_1_x64;
  updatePositionRewards(position, change.reward_growths_inside, true);
  if (increase) {
    require(position.liquidity <= MAX_U128 - change.liquidity, ErrorCode.CalculateOverflow);
    position.liquidity += change.liquidity;
  } else {
    require(position.liquidity >= change.liquidity, ErrorCode.CalculateOverflow);
    position.liquidity -= change.liquidity;
  }
}
