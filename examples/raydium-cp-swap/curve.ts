// The constant-product curve and fees of the Raydium CP-Swap port (programs/cp-swap/src/curve/). Where the original's
// math returns None, its callers turn that into ZeroTradingTokens, so these helpers fail with it directly.
import { type u64, require, u128 } from "typesol";
import { ErrorCode } from "./state";

export const FEE_RATE_DENOMINATOR_VALUE = 1_000_000n;

function ceilDiv(amount: u128, numerator: u128, denominator: u128): u128 {
  require(denominator !== 0n, ErrorCode.ZeroTradingTokens);
  return (amount * numerator + denominator - 1n) / denominator;
}
function floorDiv(amount: u128, numerator: u128, denominator: u128): u128 {
  require(denominator !== 0n, ErrorCode.ZeroTradingTokens);
  return (amount * numerator) / denominator;
}

export function tradingFee(amount: u128, rate: u64): u128 {
  return ceilDiv(amount, u128(rate), FEE_RATE_DENOMINATOR_VALUE);
}
export function protocolFee(amount: u128, rate: u64): u128 {
  return floorDiv(amount, u128(rate), FEE_RATE_DENOMINATOR_VALUE);
}
export function creatorFee(amount: u128, rate: u64): u128 {
  return ceilDiv(amount, u128(rate), FEE_RATE_DENOMINATOR_VALUE);
}
/** The creator's part of a fee charged at trade + creator rates. */
export function splitCreatorFee(totalFee: u128, tradeRate: u64, creatorRate: u64): u128 {
  return floorDiv(totalFee, u128(creatorRate), u128(tradeRate + creatorRate));
}
/** The amount before a fee at `rate` that leaves `postFeeAmount`. */
export function preFeeAmount(postFeeAmount: u128, rate: u64): u128 {
  if (rate === 0n) return postFeeAmount;
  const denominator = FEE_RATE_DENOMINATOR_VALUE - u128(rate);
  return (postFeeAmount * FEE_RATE_DENOMINATOR_VALUE + denominator - 1n) / denominator;
}

export interface SwapResult {
  new_input_vault_amount: u128;
  new_output_vault_amount: u128;
  input_amount: u128;
  output_amount: u128;
  trade_fee: u128;
  protocol_fee: u128;
  fund_fee: u128;
  creator_fee: u128;
}

/** Subtract fees and calculate how much destination token will be provided given an amount of source token. */
export function curveSwapBaseInput(
  input_amount: u128,
  input_vault_amount: u128,
  output_vault_amount: u128,
  trade_fee_rate: u64,
  creator_fee_rate: u64,
  protocol_fee_rate: u64,
  fund_fee_rate: u64,
  is_creator_fee_on_input: boolean,
): SwapResult {
  let creator_fee: u128 = 0n;
  let trade_fee: u128 = 0n;
  let input_amount_less_fees: u128 = 0n;
  if (is_creator_fee_on_input) {
    const total_fee = tradingFee(input_amount, trade_fee_rate + creator_fee_rate);
    creator_fee = splitCreatorFee(total_fee, trade_fee_rate, creator_fee_rate);
    trade_fee = total_fee - creator_fee;
    input_amount_less_fees = input_amount - total_fee;
  } else {
    trade_fee = tradingFee(input_amount, trade_fee_rate);
    input_amount_less_fees = input_amount - trade_fee;
  }
  const protocol_fee = protocolFee(trade_fee, protocol_fee_rate);
  const fund_fee = protocolFee(trade_fee, fund_fee_rate);
  // (x + delta_x) * (y - delta_y) = x * y
  const output_amount_swapped = (input_amount_less_fees * output_vault_amount) / (input_vault_amount + input_amount_less_fees);
  let output_amount = output_amount_swapped;
  if (!is_creator_fee_on_input) {
    creator_fee = creatorFee(output_amount_swapped, creator_fee_rate);
    output_amount = output_amount_swapped - creator_fee;
  }
  return {
    new_input_vault_amount: input_vault_amount + input_amount_less_fees,
    new_output_vault_amount: output_vault_amount - output_amount_swapped,
    input_amount,
    output_amount,
    trade_fee,
    protocol_fee,
    fund_fee,
    creator_fee,
  };
}

export function curveSwapBaseOutput(
  output_amount: u128,
  input_vault_amount: u128,
  output_vault_amount: u128,
  trade_fee_rate: u64,
  creator_fee_rate: u64,
  protocol_fee_rate: u64,
  fund_fee_rate: u64,
  is_creator_fee_on_input: boolean,
): SwapResult {
  let creator_fee: u128 = 0n;
  let trade_fee: u128 = 0n;
  let actual_output_amount = output_amount;
  if (!is_creator_fee_on_input) {
    const out_amount_with_creator_fee = preFeeAmount(output_amount, creator_fee_rate);
    creator_fee = out_amount_with_creator_fee - output_amount;
    actual_output_amount = out_amount_with_creator_fee;
  }
  // delta_x = (x * delta_y) / (y - delta_y), rounded up.
  const numerator = input_vault_amount * actual_output_amount;
  const denominator = output_vault_amount - actual_output_amount;
  let input_amount_swapped = numerator / denominator;
  if (numerator % denominator !== 0n) input_amount_swapped += 1n;
  let input_amount: u128 = 0n;
  if (is_creator_fee_on_input) {
    const input_amount_with_fee = preFeeAmount(input_amount_swapped, trade_fee_rate + creator_fee_rate);
    const total_fee = input_amount_with_fee - input_amount_swapped;
    creator_fee = splitCreatorFee(total_fee, trade_fee_rate, creator_fee_rate);
    trade_fee = total_fee - creator_fee;
    input_amount = input_amount_with_fee;
  } else {
    const input_amount_with_fee = preFeeAmount(input_amount_swapped, trade_fee_rate);
    trade_fee = input_amount_with_fee - input_amount_swapped;
    input_amount = input_amount_with_fee;
  }
  return {
    new_input_vault_amount: input_vault_amount + input_amount_swapped,
    new_output_vault_amount: output_vault_amount - actual_output_amount,
    input_amount,
    output_amount,
    trade_fee,
    protocol_fee: protocolFee(trade_fee, protocol_fee_rate),
    fund_fee: protocolFee(trade_fee, fund_fee_rate),
    creator_fee,
  };
}

export interface TradingTokens {
  token_0_amount: u128;
  token_1_amount: u128;
}

/** The trading tokens for `lp_token_amount` pool tokens, rounded down (withdraw) or up (deposit). */
export function lpTokensToTradingTokens(
  lp_token_amount: u128,
  lp_token_supply: u128,
  token_0_vault_amount: u128,
  token_1_vault_amount: u128,
  ceiling: boolean,
): TradingTokens {
  require(lp_token_supply !== 0n, ErrorCode.ZeroTradingTokens);
  let token_0_amount = (lp_token_amount * token_0_vault_amount) / lp_token_supply;
  let token_1_amount = (lp_token_amount * token_1_vault_amount) / lp_token_supply;
  if (ceiling) {
    // No ceiling for 0: a tiny deposit worth less than one token is refused later rather than charged one.
    if ((lp_token_amount * token_0_vault_amount) % lp_token_supply > 0n && token_0_amount > 0n) token_0_amount += 1n;
    if ((lp_token_amount * token_1_vault_amount) % lp_token_supply > 0n && token_1_amount > 0n) token_1_amount += 1n;
  }
  return { token_0_amount, token_1_amount };
}
