// Exposes the Raydium CLMM port's math (examples/raydium-clmm/math.ts) as instructions, for the BigInt comparison in
// test/examples/raydium-clmm-math.test.ts.
import { type i32, type u32, type u64, type u128 } from "typesol";
import {
  type SwapAmounts,
  type SwapStep,
  computeSwap,
  deltaAmount0Unsigned,
  deltaAmount1Unsigned,
  deltaAmountsForSwap,
  getSqrtPriceAtTick,
  getTickAtSqrtPrice,
  liquidityFromAmounts,
  nextSqrtPriceFromInput,
  nextSqrtPriceFromOutput,
} from "../../../examples/raydium-clmm/math";

export function sqrtAt(tick: i32): u128 {
  return getSqrtPriceAtTick(tick);
}
export function tickAt(price: u128): i32 {
  return getTickAtSqrtPrice(price);
}
export function nextFromInput(price: u128, liquidity: u128, amount: u64, zeroForOne: boolean): u128 {
  return nextSqrtPriceFromInput(price, liquidity, amount, zeroForOne);
}
export function nextFromOutput(price: u128, liquidity: u128, amount: u64, zeroForOne: boolean): u128 {
  return nextSqrtPriceFromOutput(price, liquidity, amount, zeroForOne);
}
export function delta0(a: u128, b: u128, liquidity: u128, roundUp: boolean): u64 {
  return deltaAmount0Unsigned(a, b, liquidity, roundUp);
}
export function delta1(a: u128, b: u128, liquidity: u128, roundUp: boolean): u64 {
  return deltaAmount1Unsigned(a, b, liquidity, roundUp);
}
export function swapAmounts(a: u128, b: u128, liquidity: u128, zeroForOne: boolean): SwapAmounts {
  return deltaAmountsForSwap(a, b, liquidity, zeroForOne);
}
export function liquidity(price: u128, a: u128, b: u128, amount0: u64, amount1: u64): u128 {
  return liquidityFromAmounts(price, a, b, amount0, amount1);
}
export function step(current: u128, target: u128, liquidity: u128, remaining: u64, feeRate: u32, baseInput: boolean, zeroForOne: boolean, feeOnInput: boolean): SwapStep {
  return computeSwap(current, target, liquidity, remaining, feeRate, baseInput, zeroForOne, feeOnInput);
}
