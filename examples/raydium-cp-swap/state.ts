// Account state of the Raydium CP-Swap port (programs/cp-swap/src/states/ of raydium-io/raydium-cp-swap). The layouts
// are the original's byte for byte: AmmConfig is a Borsh account of fixed size, PoolState and ObservationState are
// zero-copy (#[repr(C, packed)]), which is TypeSOL's fixed layout. Names are the original's, so its IDL is the same.
import { type FixedArray, type Pubkey, type u8, type u16, type u64, type u128 } from "typesol";

/** Holds the current owner of the factory. */
export interface AmmConfig {
  /** Bump to identify PDA */
  bump: u8;
  /** Status to control if new pool can be create */
  disable_create_pool: boolean;
  /** Config index */
  index: u16;
  /** The trade fee, denominated in hundredths of a bip (10^-6) */
  trade_fee_rate: u64;
  /** The protocol fee */
  protocol_fee_rate: u64;
  /** The fund fee, denominated in hundredths of a bip (10^-6) */
  fund_fee_rate: u64;
  /** Fee for create a new pool */
  create_pool_fee: u64;
  /** Address of the protocol fee owner */
  protocol_owner: Pubkey;
  /** Address of the fund fee owner */
  fund_owner: Pubkey;
  /** The pool creator fee, denominated in hundredths of a bip (10^-6) */
  creator_fee_rate: u64;
  /** The share of the creator fee retained by the protocol (10^-6); zero gives the creator the whole creator fee. */
  creator_fee_share_rate: u64;
  padding: FixedArray<u64, 14>;
}

export interface PoolState {
  /** Which config the pool belongs */
  amm_config: Pubkey;
  /** pool creator */
  pool_creator: Pubkey;
  /** Token A */
  token_0_vault: Pubkey;
  /** Token B */
  token_1_vault: Pubkey;
  /** Pool tokens are issued when A or B tokens are deposited. */
  lp_mint: Pubkey;
  /** Mint information for token A */
  token_0_mint: Pubkey;
  /** Mint information for token B */
  token_1_mint: Pubkey;
  /** token_0 program */
  token_0_program: Pubkey;
  /** token_1 program */
  token_1_program: Pubkey;
  /** observation account to store oracle data */
  observation_key: Pubkey;
  auth_bump: u8;
  /** Bitwise state: bit0 disables deposit, bit1 withdraw, bit2 swap. */
  status: u8;
  lp_mint_decimals: u8;
  mint_0_decimals: u8;
  mint_1_decimals: u8;
  /** True circulating supply without burns and lock ups */
  lp_supply: u64;
  /** The amounts of token_0 and token_1 that are owed to the liquidity provider. */
  protocol_fees_token_0: u64;
  protocol_fees_token_1: u64;
  fund_fees_token_0: u64;
  fund_fees_token_1: u64;
  /** The timestamp allowed for swap in the pool. */
  open_time: u64;
  /** recent epoch */
  recent_epoch: u64;
  /** Creator fee collect mode: 0 both tokens (the input's), 1 only token_0, 2 only token_1. */
  creator_fee_on: u8;
  enable_creator_fee: boolean;
  padding1: FixedArray<u8, 6>;
  creator_fees_token_0: u64;
  creator_fees_token_1: u64;
  padding: FixedArray<u64, 28>;
}

export interface Observation {
  block_timestamp: u64;
  cumulative_token_0_price_x32: u128;
  cumulative_token_1_price_x32: u128;
}

export interface ObservationState {
  initialized: boolean;
  observation_index: u16;
  pool_id: Pubkey;
  observations: FixedArray<Observation, 100>;
  last_update_timestamp: u64;
  padding: FixedArray<u64, 3>;
}

/** Marks a Token-2022 mint the admin lets pools use whatever its extensions. */
export interface SupportMintAssociated {
  bump: u8;
  mint: Pubkey;
  padding: FixedArray<u64, 8>;
}

export enum ErrorCode {
  NotApproved = "Not approved",
  InvalidOwner = "Input account owner is not the program address",
  EmptySupply = "Input token account empty",
  InvalidInput = "InvalidInput",
  IncorrectLpMint = "Address of the provided lp token mint is incorrect",
  ExceededSlippage = "Exceeds desired slippage limit",
  ZeroTradingTokens = "Given pool token amount results in zero trading tokens",
  NotSupportMint = "Not support token_2022 mint extension",
  InvalidVault = "invaild vault",
  InitLpAmountTooLess = "Init lp amount is too less(Because 100 amount lp will be locked)",
  TransferFeeCalculateNotMatch = "TransferFee calculate not match",
  MathOverflow = "Math overflow",
  InsufficientVault = "Insufficient vault",
  InvalidFeeModel = "Invalid fee model",
  NoFeeCollect = "Fee is zero",
  LamportsCalculateError = "Lamports calculate error",
}

export interface LpChangeEvent {
  pool_id: Pubkey;
  lp_amount_before: u64;
  token_0_vault_before: u64;
  token_1_vault_before: u64;
  token_0_amount: u64;
  token_1_amount: u64;
  token_0_transfer_fee: u64;
  token_1_transfer_fee: u64;
  /** 0: deposit, 1: withdraw */
  change_type: u8;
}

export interface SwapEvent {
  pool_id: Pubkey;
  input_vault_before: u64;
  output_vault_before: u64;
  input_amount: u64;
  output_amount: u64;
  input_transfer_fee: u64;
  output_transfer_fee: u64;
  base_input: boolean;
  input_mint: Pubkey;
  output_mint: Pubkey;
  trade_fee: u64;
  creator_fee: u64;
  creator_fee_on_input: boolean;
}
