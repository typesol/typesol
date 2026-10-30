// Account state of the Raydium CLMM port (programs/amm/src/states/ of raydium-io/raydium-clmm @ 6d7a0f8), byte for byte:
// the zero-copy accounts (PoolState, TickArrayState, TickArrayBitmapExtension, ObservationState) are
// #[repr(C, packed)], which is TypeSOL's fixed layout; the Borsh accounts (AmmConfig, PersonalPositionState,
// ProtocolPositionState) hold only fixed-size fields, so their Borsh bytes are the same packed layout. Names are the
// original's, so the account discriminators and the IDL are too.
import { type FixedArray, type Pubkey, type i32, type i64, type i128, type u8, type u16, type u32, type u64, type u128 } from "typesol";

export const REWARD_NUM = 3n;
export const TICK_ARRAY_SIZE = 60n;
export const OBSERVATION_NUM = 100n;

/** The pool's fee tier and owners (states/config.rs; Borsh). */
export interface AmmConfig {
  bump: u8;
  index: u16;
  /** Address of the protocol owner */
  owner: Pubkey;
  /** The protocol fee */
  protocol_fee_rate: u32;
  /** The trade fee, denominated in hundredths of a bip (10^-6) */
  trade_fee_rate: u32;
  /** The tick spacing */
  tick_spacing: u16;
  /** The fund fee, denominated in hundredths of a bip (10^-6) */
  fund_fee_rate: u32;
  padding_u32: u32;
  fund_owner: Pubkey;
  padding: FixedArray<u64, 3>;
}

/** A reward stream of a pool (states/pool.rs). */
export interface RewardInfo {
  /** Reward state */
  reward_state: u8;
  /** Reward open time */
  open_time: u64;
  /** Reward end time */
  end_time: u64;
  /** Reward last update time */
  last_update_time: u64;
  /** Q64.64 number indicates how many tokens per second are earned per unit of liquidity. */
  emissions_per_second_x64: u128;
  /** The total amount of reward emissioned */
  reward_total_emitted: u64;
  /** The total amount of claimed reward */
  reward_claimed: u64;
  /** Reward token mint. */
  token_mint: Pubkey;
  /** Reward vault token account. */
  token_vault: Pubkey;
  /** The owner that has permission to set reward param */
  authority: Pubkey;
  /** Q64.64 number that tracks the total tokens earned per unit of liquidity since the reward emissions were turned on. */
  reward_growth_global_x64: u128;
}

/** The dynamic fee's parameters and state (states/pool_fee.rs; 80 bytes). */
export interface DynamicFeeInfo {
  filter_period: u16;
  decay_period: u16;
  reduction_factor: u16;
  dynamic_fee_control: u32;
  max_volatility_accumulator: u32;
  tick_spacing_index_reference: i32;
  volatility_reference: u32;
  volatility_accumulator: u32;
  last_update_timestamp: u64;
  padding: FixedArray<u8, 46>;
}

/** A pool (states/pool.rs; zero-copy). */
export interface PoolState {
  /** Bump to identify PDA */
  bump: FixedArray<u8, 1>;
  amm_config: Pubkey;
  owner: Pubkey;
  /** Token pair of the pool, where token_mint_0 address < token_mint_1 address */
  token_mint_0: Pubkey;
  token_mint_1: Pubkey;
  /** Token pair vault */
  token_vault_0: Pubkey;
  token_vault_1: Pubkey;
  /** observation account key */
  observation_key: Pubkey;
  /** mint0 and mint1 decimals */
  mint_decimals_0: u8;
  mint_decimals_1: u8;
  /** The minimum number of ticks between initialized ticks */
  tick_spacing: u16;
  /** The currently in range liquidity available to the pool. */
  liquidity: u128;
  /** The current price of the pool as a sqrt(token_1/token_0) Q64.64 value */
  sqrt_price_x64: u128;
  /** The current tick of the pool, i.e. according to the last tick transition that was run. */
  tick_current: i32;
  padding3: u16;
  padding4: u16;
  /** The fee growth as a Q64.64 number, i.e. fees of token_0 and token_1 collected per unit of liquidity for the entire life of the pool. */
  fee_growth_global_0_x64: u128;
  fee_growth_global_1_x64: u128;
  /** The amounts of token_0 and token_1 that are owed to the protocol. */
  protocol_fees_token_0: u64;
  protocol_fees_token_1: u64;
  padding5: FixedArray<u128, 4>;
  /** Bitwise representation of the state of the pool: bit0 open position, bit1 decrease liquidity, bit2 collect fee, bit3 collect reward, bit4 swap, bit5 limit order. */
  status: u8;
  /** Fee collection mode: 0 the input token, 1 only token_0, 2 only token_1. */
  fee_on: u8;
  seed_index: FixedArray<u8, 2>;
  padding: FixedArray<u8, 4>;
  reward_infos: FixedArray<RewardInfo, 3>;
  /** Packed initialized tick array state */
  tick_array_bitmap: FixedArray<u64, 16>;
  padding6: FixedArray<u64, 4>;
  /** except protocol_fee and fund_fee */
  fund_fees_token_0: u64;
  fund_fees_token_1: u64;
  /** The timestamp allowed for swap in the pool. */
  open_time: u64;
  /** account recent update epoch */
  recent_epoch: u64;
  dynamic_fee_info: DynamicFeeInfo;
  padding1: FixedArray<u64, 14>;
  padding2: FixedArray<u64, 32>;
}

/** One tick of a tick array (states/tick_array.rs). */
export interface TickState {
  tick: i32;
  /** Amount of net liquidity added (subtracted) when tick is crossed from left to right (right to left) */
  liquidity_net: i128;
  /** The total position liquidity that references this tick */
  liquidity_gross: u128;
  /** Fee growth per unit of liquidity on the _other_ side of this tick (relative to the current tick) */
  fee_growth_outside_0_x64: u128;
  fee_growth_outside_1_x64: u128;
  reward_growths_outside_x64: FixedArray<u128, 3>;
  /** Limit order related fields */
  order_phase: u64;
  orders_amount: u64;
  part_filled_orders_remaining: u64;
  unfilled_ratio_x64: u128;
  padding: FixedArray<u32, 3>;
}

/** 60 consecutive ticks of a pool (states/tick_array.rs; zero-copy, 10,240 bytes with the discriminator). */
export interface TickArrayState {
  pool_id: Pubkey;
  start_tick_index: i32;
  ticks: FixedArray<TickState, 60>;
  initialized_tick_count: u8;
  /** account update recent epoch */
  recent_epoch: u64;
  padding: FixedArray<u8, 107>;
}

/** The tick array bitmap beyond the pool's own 1024 bits (states/tickarray_bitmap_extension.rs; zero-copy). */
export interface TickArrayBitmapExtension {
  pool_id: Pubkey;
  /** Packed initialized tick array state for start_tick_index is positive */
  positive_tick_array_bitmap: FixedArray<FixedArray<u64, 8>, 14>;
  /** Packed initialized tick array state for start_tick_index is negitive */
  negative_tick_array_bitmap: FixedArray<FixedArray<u64, 8>, 14>;
}

/** An observation of the price oracle (states/oracle.rs). */
export interface Observation {
  /** The block timestamp of the observation */
  block_timestamp: u32;
  /** the cumulative of tick during the duration time */
  tick_cumulative: i64;
  padding: FixedArray<u64, 4>;
}

/** The pool's price oracle (states/oracle.rs; zero-copy). */
export interface ObservationState {
  /** Whether the ObservationState is initialized */
  initialized: boolean;
  /** recent update epoch */
  recent_epoch: u64;
  /** the most-recently updated index of the observations array */
  observation_index: u16;
  /** belongs to which pool */
  pool_id: Pubkey;
  /** observation array */
  observations: FixedArray<Observation, 100>;
  padding: FixedArray<u64, 4>;
}

export interface PositionRewardInfo {
  /** Q64.64 */
  growth_inside_last_x64: u128;
  reward_amount_owed: u64;
}

/** A liquidity position, owned through its NFT (states/personal_position.rs; Borsh). */
export interface PersonalPositionState {
  /** Bump to identify PDA */
  bump: FixedArray<u8, 1>;
  /** Mint address of the tokenized position */
  nft_mint: Pubkey;
  /** The ID of the pool with which this token is connected */
  pool_id: Pubkey;
  /** The lower bound tick of the position */
  tick_lower_index: i32;
  /** The upper bound tick of the position */
  tick_upper_index: i32;
  /** The amount of liquidity owned by this position */
  liquidity: u128;
  /** The token_0 fee growth of the aggregate position as of the last action on the individual position */
  fee_growth_inside_0_last_x64: u128;
  /** The token_1 fee growth of the aggregate position as of the last action on the individual position */
  fee_growth_inside_1_last_x64: u128;
  /** The fees owed to the position owner in token_0, as of the last computation */
  token_fees_owed_0: u64;
  /** The fees owed to the position owner in token_1, as of the last computation */
  token_fees_owed_1: u64;
  reward_infos: FixedArray<PositionRewardInfo, 3>;
  /** account update recent epoch */
  recent_epoch: u64;
  padding: FixedArray<u64, 7>;
}

/** The aggregate of positions on a tick range, from earlier versions (states/protocol_position.rs; Borsh). */
export interface ProtocolPositionState {
  bump: u8;
  pool_id: Pubkey;
  tick_lower_index: i32;
  tick_upper_index: i32;
  liquidity: u128;
  fee_growth_inside_0_last_x64: u128;
  fee_growth_inside_1_last_x64: u128;
  token_fees_owed_0: u64;
  token_fees_owed_1: u64;
  reward_growth_inside: FixedArray<u128, 3>;
  recent_epoch: u64;
  padding: FixedArray<u64, 7>;
}

/** Marks a Token-2022 mint the admin lets pools use whatever its extensions (states/support_mint_associated.rs). */
export interface SupportMintAssociated {
  bump: u8;
  mint: Pubkey;
  padding: FixedArray<u64, 8>;
}

/** Emitted when a config is created or changed (states/config.rs). */
export interface ConfigChangeEvent {
  index: u16;
  owner: Pubkey;
  protocol_fee_rate: u32;
  trade_fee_rate: u32;
  tick_spacing: u16;
  fund_fee_rate: u32;
  fund_owner: Pubkey;
}

/** Emitted when a pool is created (states/pool.rs). */
export interface PoolCreatedEvent {
  token_mint_0: Pubkey;
  token_mint_1: Pubkey;
  tick_spacing: u16;
  pool_state: Pubkey;
  sqrt_price_x64: u128;
  tick: i32;
  token_vault_0: Pubkey;
  token_vault_1: Pubkey;
}

/** Emitted when a position is opened (states/personal_position.rs). */
export interface CreatePersonalPositionEvent {
  pool_state: Pubkey;
  minter: Pubkey;
  nft_owner: Pubkey;
  tick_lower_index: i32;
  tick_upper_index: i32;
  liquidity: u128;
  deposit_amount_0: u64;
  deposit_amount_1: u64;
  deposit_amount_0_transfer_fee: u64;
  deposit_amount_1_transfer_fee: u64;
}

/** Emitted when liquidity is added to a position (states/personal_position.rs). */
export interface IncreaseLiquidityEvent {
  position_nft_mint: Pubkey;
  liquidity: u128;
  amount_0: u64;
  amount_1: u64;
  amount_0_transfer_fee: u64;
  amount_1_transfer_fee: u64;
}

/** Emitted when liquidity is taken out of a position, with the fees and rewards collected (states/personal_position.rs). */
export interface DecreaseLiquidityEvent {
  position_nft_mint: Pubkey;
  liquidity: u128;
  decrease_amount_0: u64;
  decrease_amount_1: u64;
  fee_amount_0: u64;
  fee_amount_1: u64;
  reward_amounts: FixedArray<u64, 3>;
  transfer_fee_0: u64;
  transfer_fee_1: u64;
}

/** The amounts a liquidity change works out to (states/personal_position.rs). */
export interface LiquidityCalculateEvent {
  pool_liquidity: u128;
  pool_sqrt_price_x64: u128;
  pool_tick: i32;
  calc_amount_0: u64;
  calc_amount_1: u64;
  trade_fee_owed_0: u64;
  trade_fee_owed_1: u64;
  transfer_fee_0: u64;
  transfer_fee_1: u64;
}

/** Emitted when the pool's liquidity changes (states/pool.rs). */
export interface LiquidityChangeEvent {
  pool_state: Pubkey;
  tick: i32;
  tick_lower: i32;
  tick_upper: i32;
  liquidity_before: u128;
  liquidity_after: u128;
}
