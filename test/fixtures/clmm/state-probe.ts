// Reads the Raydium CLMM port's account layouts (examples/raydium-clmm/state.ts) from accounts cloned from mainnet, for
// the comparison with the on-chain IDL in test/examples/raydium-clmm-state.test.ts. Deployed at Raydium's program id,
// so the owner checks pass.
import { type Account, type Pubkey, type i32, type i64, type i128, type u8, type u16, type u32, type u64, type u128 } from "typesol";
import {
  type AmmConfig,
  type ObservationState,
  type PoolState,
  type TickArrayBitmapExtension,
  type TickArrayState,
} from "../../../examples/raydium-clmm/state";

export interface PoolView {
  observation_key: Pubkey;
  mint_decimals_1: u8;
  tick_spacing: u16;
  liquidity: u128;
  sqrt_price_x64: u128;
  tick_current: i32;
  fee_growth_global_1_x64: u128;
  protocol_fees_token_1: u64;
  status: u8;
  fee_on: u8;
  reward_mint_0: Pubkey;
  reward_growth_2: u128;
  bitmap_word: u64;
  fund_fees_token_1: u64;
  open_time: u64;
  recent_epoch: u64;
  dynamic_last_update: u64;
  dynamic_max_volatility: u32;
}

export function pool(state: Account<PoolState>, word: u64): PoolView {
  return {
    observation_key: state.observation_key,
    mint_decimals_1: state.mint_decimals_1,
    tick_spacing: state.tick_spacing,
    liquidity: state.liquidity,
    sqrt_price_x64: state.sqrt_price_x64,
    tick_current: state.tick_current,
    fee_growth_global_1_x64: state.fee_growth_global_1_x64,
    protocol_fees_token_1: state.protocol_fees_token_1,
    status: state.status,
    fee_on: state.fee_on,
    reward_mint_0: state.reward_infos.get(0n).token_mint,
    reward_growth_2: state.reward_infos.get(2n).reward_growth_global_x64,
    bitmap_word: state.tick_array_bitmap.get(word),
    fund_fees_token_1: state.fund_fees_token_1,
    open_time: state.open_time,
    recent_epoch: state.recent_epoch,
    dynamic_last_update: state.dynamic_fee_info.last_update_timestamp,
    dynamic_max_volatility: state.dynamic_fee_info.max_volatility_accumulator,
  };
}

export interface ConfigView {
  index: u16;
  owner: Pubkey;
  protocol_fee_rate: u32;
  trade_fee_rate: u32;
  tick_spacing: u16;
  fund_fee_rate: u32;
  fund_owner: Pubkey;
}

export function config(config: Account<AmmConfig>): ConfigView {
  return {
    index: config.index,
    owner: config.owner,
    protocol_fee_rate: config.protocol_fee_rate,
    trade_fee_rate: config.trade_fee_rate,
    tick_spacing: config.tick_spacing,
    fund_fee_rate: config.fund_fee_rate,
    fund_owner: config.fund_owner,
  };
}

export interface TickView {
  start_tick_index: i32;
  initialized_tick_count: u8;
  recent_epoch: u64;
  tick: i32;
  liquidity_net: i128;
  liquidity_gross: u128;
  fee_growth_outside_0_x64: u128;
  reward_growth_outside_1: u128;
  order_phase: u64;
  unfilled_ratio_x64: u128;
}

export function tickArray(array: Account<TickArrayState>, i: u64): TickView {
  const t = array.ticks.get(i);
  return {
    start_tick_index: array.start_tick_index,
    initialized_tick_count: array.initialized_tick_count,
    recent_epoch: array.recent_epoch,
    tick: t.tick,
    liquidity_net: t.liquidity_net,
    liquidity_gross: t.liquidity_gross,
    fee_growth_outside_0_x64: t.fee_growth_outside_0_x64,
    reward_growth_outside_1: t.reward_growths_outside_x64.get(1n),
    order_phase: t.order_phase,
    unfilled_ratio_x64: t.unfilled_ratio_x64,
  };
}

export function bitmap(extension: Account<TickArrayBitmapExtension>, i: u64, j: u64): u64 {
  return extension.positive_tick_array_bitmap.get(i).get(j) ^ extension.negative_tick_array_bitmap.get(i).get(j);
}

export interface ObservationView {
  initialized: boolean;
  recent_epoch: u64;
  observation_index: u16;
  pool_id: Pubkey;
  block_timestamp: u32;
  tick_cumulative: i64;
}

export function observation(state: Account<ObservationState>, i: u64): ObservationView {
  const o = state.observations.get(i);
  return {
    initialized: state.initialized,
    recent_epoch: state.recent_epoch,
    observation_index: state.observation_index,
    pool_id: state.pool_id,
    block_timestamp: o.block_timestamp,
    tick_cumulative: o.tick_cumulative,
  };
}
