// Marginfi's instruction argument types (type-crate/src/types of mrgnlabs/marginfi-v2 @ c5d440f6), as the on-chain IDL
// (test/fixtures/marginfi/marginfi.idl.json) describes them: Borsh on the wire, as Anchor decodes them.
import { type FixedArray, type Option, type u16, type u32, type u64, type u8 } from "typesol";
import { type InterestRateConfigOpt } from "./events";
import { type BankOperationalState, type RatePoint, type RiskTier, type WrappedI80F48 } from "./state";

/**
 * InterestRateConfigCompact
 * @repr c
 */
export interface InterestRateConfigCompact {
  insurance_fee_fixed_apr: WrappedI80F48;
  insurance_ir_fee: WrappedI80F48;
  protocol_fixed_fee_apr: WrappedI80F48;
  protocol_ir_fee: WrappedI80F48;
  protocol_origination_fee: WrappedI80F48;
  /** The base rate at utilization = 0: a %, as u32, out of 1000% (100% = 0.1 * u32::MAX). */
  zero_util_rate: u32;
  /** The base rate at utilization = 100: a %, as u32, out of 1000%. */
  hundred_util_rate: u32;
  /** The curve's points between 0 and 100%, in ascending order; points with util = 0 are unused. */
  points: FixedArray<RatePoint, 5>;
}

/**
 * BankConfigCompact
 * @repr c
 */
export interface BankConfigCompact {
  asset_weight_init: WrappedI80F48;
  asset_weight_maint: WrappedI80F48;
  liability_weight_init: WrappedI80F48;
  liability_weight_maint: WrappedI80F48;
  deposit_limit: u64;
  interest_rate_config: InterestRateConfigCompact;
  operational_state: BankOperationalState;
  borrow_limit: u64;
  risk_tier: RiskTier;
  /** What kinds of assets users of this bank can interact with (ASSET_TAG_DEFAULT 0, ASSET_TAG_SOL 1, …). */
  asset_tag: u8;
  /** Flags for config options (1: the bank uses the 0.1.4 oracle setup). */
  config_flags: u8;
  /** @idlName _pad0 */
  pad0: FixedArray<u8, 5>;
  /** USD limit on the asset value counted for initial margin. */
  total_asset_value_init_limit: u64;
  /** Seconds the oracle price is considered live. */
  oracle_max_age: u16;
  /** A %, as u32 (100% = u32::MAX): the oracle confidence setting. */
  oracle_max_confidence: u32;
}

/**
 * The bank settings the fast admin may change: `null` leaves one as it is. `operational_state` may only make a
 * risk-reducing transition (to Paused from any settable state; ReduceOnly / ReduceOnlyWithBorrowingPower from
 * Operational or each other as the original allows).
 * @layout borsh
 */
export interface BankConfigFast {
  deposit_limit: Option<u64>;
  borrow_limit: Option<u64>;
  operational_state: Option<BankOperationalState>;
  interest_rate_config: Option<InterestRateConfigOpt>;
  total_asset_value_init_limit: Option<u64>;
  permissionless_bad_debt_settlement: Option<boolean>;
  liquidation_liquidator_fee: Option<u32>;
  liquidation_insurance_fee: Option<u32>;
  circuit_breaker_enabled: Option<boolean>;
  cb_deviation_bps_tiers: Option<FixedArray<u16, 3>>;
  cb_tier_durations_seconds: Option<FixedArray<u16, 3>>;
  cb_escalation_window_mult: Option<u8>;
  cb_ema_alpha_bps: Option<u16>;
  cb_window_seconds: Option<u32>;
  cb_window_max_up_bps: Option<u16>;
  cb_window_max_down_bps: Option<u16>;
}

/**
 * Configuration fields controlled by the slow, timelocked governance admin.
 *
 * `operational_state`, when present, may only restore a bank to `Operational`.
 * @layout borsh
 */
export interface BankConfigGov {
  asset_weight_init: Option<WrappedI80F48>;
  asset_weight_maint: Option<WrappedI80F48>;
  liability_weight_init: Option<WrappedI80F48>;
  liability_weight_maint: Option<WrappedI80F48>;
  operational_state: Option<BankOperationalState>;
  risk_tier: Option<RiskTier>;
  asset_tag: Option<u8>;
  oracle_max_confidence: Option<u32>;
  oracle_max_age: Option<u16>;
  tokenless_repayments_allowed: Option<boolean>;
  freeze_settings: Option<boolean>;
}

/**
 * OrderTrigger: when an order may run, at the net value (assets minus liabilities, in equity terms) of its two
 * balances.
 * @repr c
 */
export type OrderTrigger =
  | { kind: "StopLoss"; threshold: WrappedI80F48; max_slippage: u32 }
  | { kind: "TakeProfit"; threshold: WrappedI80F48; max_slippage: u32 }
  | { kind: "Both"; stop_loss: WrappedI80F48; take_profit: WrappedI80F48; max_slippage: u32 };
