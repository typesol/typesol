// Limit orders of the Raydium CLMM port (instructions/limit_order/ and states/limit_order.rs of raydium-io/raydium-clmm
// @ 6d7a0f8): the checks on a new order, and an order's share of what its tick filled. An order rests on one tick;
// the tick counts the orders of its current phase (`orders_amount`) and what is left of the phase a swap partly filled
// (`part_filled_orders_remaining`, with `unfilled_ratio_x64`).
import { type Account, type Mut, type u16, i32, require, u64, u128, u256 } from "typesol";
import { ErrorCode } from "./errors";
import { tickOffset } from "./liquidity";
import { MAX_TICK, MIN_TICK, Q64, getSqrtPriceAtTick, mulDivFloor128 } from "./math";
import { type LimitOrderState, type TickArrayState } from "./state";
import { limitOrderOutput, priceFromSqrt } from "./swap";

const LO_U64_MAX: u64 = 18446744073709551615n;

/** What decreasing an order did: what it had earned, paid out now, and how much of it came off. */
export interface DecreaseResult {
  settled_output_amount: u64;
  real_decrease_amount: u64;
}

/** tick_math::get_price_at_tick. */
function priceAtTick(tick: i32, roundUp: boolean): u128 {
  return priceFromSqrt(getSqrtPriceAtTick(tick), roundUp);
}

/** check_tick_index: on the far side of the price in the order's direction, on the spacing. */
export function checkTickIndex(tick: i32, zeroForOne: boolean, current: i32, spacing: u16): void {
  require(tick > MIN_TICK && tick < MAX_TICK, ErrorCode.InvalidTickIndex);
  require(tick % i32(spacing) === 0n, ErrorCode.TickAndSpacingNotMatch);
  require(!((zeroForOne && tick <= current) || (!zeroForOne && tick >= current)), ErrorCode.InvalidTickIndex);
}

/** check_limit_order_amount: the order buys at least 1 and less than u64::MAX - 2 of the other token. */
export function checkLimitOrderAmount(amount: u64, tick: i32, zeroForOne: boolean): void {
  require(amount !== 0n, ErrorCode.ZeroAmountSpecified);
  const out = zeroForOne ? mulDivFloor128(u128(amount), priceAtTick(tick, false), Q64) : mulDivFloor128(u128(amount), Q64, priceAtTick(tick, true));
  require(out >= 1n && out < u128(LO_U64_MAX - 2n), ErrorCode.InvalidLimitOrderAmount);
}

/** TickState::get_limit_order_output: what `amountIn` of an order fills to at its tick. */
function orderOutput(amountIn: u64, tick: i32, zeroForOne: boolean): u64 {
  const out = limitOrderOutput(amountIn, priceAtTick(tick, !zeroForOne), zeroForOne);
  require(out <= u128(LO_U64_MAX), ErrorCode.CalculateOverflow);
  return u64(out);
}

/**
 * LimitOrderState::settle_filled_order: the order's part of what its tick has filled since it last settled. In the
 * phase after its own, its share follows the tick's unfilled ratio (rounded against the order); two phases on, all of
 * it filled.
 */
export function settleFilledOrder(order: Mut<LimitOrderState>, array: Account<TickArrayState>, offset: u64): u64 {
  const t = array.ticks.get(offset);
  if (order.settle_base === 0n) return 0n;
  if (order.order_phase === t.order_phase) return 0n;
  const next = order.order_phase < LO_U64_MAX ? order.order_phase + 1n : LO_U64_MAX;
  if (next === t.order_phase) {
    const numerator = u256(order.settle_base) * u256(t.unfilled_ratio_x64);
    const denominator = u256(order.unfilled_ratio_x64);
    const ideal = u64((numerator / denominator) & u256(LO_U64_MAX));
    const exact = numerator % denominator === 0n;
    const filled = order.settle_base > ideal ? order.settle_base - ideal : 0n;
    if (filled === 0n) return 0n;
    const effective = exact ? filled : filled - 1n;
    const output = orderOutput(effective, t.tick, order.zero_for_one);
    const payout = output > order.settled_output ? output - order.settled_output : 0n;
    require(order.total_amount >= ideal, ErrorCode.CalculateOverflow);
    order.filled_amount = order.total_amount - ideal;
    order.settled_output = output;
    return payout;
  }
  const twoOn = order.order_phase < LO_U64_MAX - 1n ? order.order_phase + 2n : LO_U64_MAX;
  require(twoOn <= t.order_phase, ErrorCode.InvalidOrderPhase);
  const output = orderOutput(order.settle_base, t.tick, order.zero_for_one);
  const payout = output > order.settled_output ? output - order.settled_output : 0n;
  order.filled_amount = order.total_amount;
  order.settle_base = 0n;
  order.settled_output = 0n;
  return payout;
}

/** LimitOrderState::get_unfilled_amount. */
export function unfilledOf(order: Account<LimitOrderState>): u64 {
  require(order.total_amount >= order.filled_amount, ErrorCode.CalculateOverflow);
  return order.total_amount - order.filled_amount;
}

/** LimitOrderState::increase_amount: more of the same order, in the tick's current phase only. */
export function increaseOrder(order: Mut<LimitOrderState>, array: Mut<TickArrayState>, offset: u64, amount: u64): void {
  const t = array.ticks.get(offset);
  require(order.order_phase === t.order_phase, ErrorCode.InvalidOrderPhase);
  require(order.total_amount <= LO_U64_MAX - amount, ErrorCode.CalculateOverflow);
  order.total_amount += amount;
  require(order.settle_base <= LO_U64_MAX - amount, ErrorCode.CalculateOverflow);
  order.settle_base += amount;
  require(t.orders_amount <= LO_U64_MAX - amount, ErrorCode.CalculateOverflow);
  t.orders_amount += amount;
}

/** LimitOrderState::decrease_amount: settle, then take off up to `amount` of what is unfilled. */
export function decreaseOrder(order: Mut<LimitOrderState>, array: Mut<TickArrayState>, offset: u64, amount: u64): DecreaseResult {
  const settled = settleFilledOrder(order, array, offset);
  const unfilled = unfilledOf(order);
  if (unfilled === 0n) return { settled_output_amount: settled, real_decrease_amount: 0n };
  const t = array.ticks.get(offset);
  const next = order.order_phase < LO_U64_MAX ? order.order_phase + 1n : LO_U64_MAX;
  let real: u64 = 0n;
  if (order.order_phase === t.order_phase) {
    real = amount < unfilled ? amount : unfilled;
    require(t.orders_amount >= real, ErrorCode.CalculateOverflow);
    t.orders_amount -= real;
  } else {
    require(next === t.order_phase, ErrorCode.OrderAlreadyFilled);
    real = amount < unfilled ? amount : unfilled;
    if (t.part_filled_orders_remaining < real) real = t.part_filled_orders_remaining;
    t.part_filled_orders_remaining -= real;
  }
  if (real === 0n) return { settled_output_amount: settled, real_decrease_amount: 0n };
  require(order.total_amount >= real, ErrorCode.CalculateOverflow);
  order.total_amount -= real;
  if (next === t.order_phase) {
    order.settle_base = unfilledOf(order);
    order.unfilled_ratio_x64 = t.unfilled_ratio_x64;
    order.settled_output = 0n;
  } else order.settle_base = order.total_amount;
  const remaining = unfilledOf(order);
  if (remaining > 0n) checkLimitOrderAmount(remaining, order.tick_index, order.zero_for_one);
  return { settled_output_amount: settled, real_decrease_amount: real };
}

/** The offset of an order's tick in its array (TickArrayState::get_tick_offset_in_array). */
export function orderOffset(array: Account<TickArrayState>, tick: i32, spacing: u16): u64 {
  return tickOffset(array.start_tick_index, tick, spacing);
}

