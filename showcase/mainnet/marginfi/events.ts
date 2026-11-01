// Marginfi's events and the types they hold that are not account data (programs/marginfi/src/events.rs @ c5d440f6),
// generated from the on-chain IDL by `typesol port`: Borsh (@layout borsh) where they hold Options, as Anchor emits them.
// SetKeeperCloseFlagsEvent holds an Option<Vec<Pubkey>>, so it is not @layout borsh: emit writes it field by field,
// its header too.
import { type FixedArray, type Option, type Pubkey, type Vec, type f64, type i64, type u16, type u32, type u64, type u8 } from "typesol";
import { type BankOperationalState, type HealthCache, type OrderTriggerType, type RatePoint, type RiskTier, type WrappedI80F48 } from "./state";

/** AccountEventHeader */
export interface AccountEventHeader {
  signer: Option<Pubkey>;
  marginfi_account: Pubkey;
  marginfi_account_authority: Pubkey;
  marginfi_group: Pubkey;
}

/**
 * AdminCloseAccountEvent
 * @layout borsh
 */
export interface AdminCloseAccountEvent {
  header: AccountEventHeader;
  global_fee_wallet: Pubkey;
}

/** BankConfigOpt */
export interface BankConfigOpt {
  asset_weight_init: Option<WrappedI80F48>;
  asset_weight_maint: Option<WrappedI80F48>;
  liability_weight_init: Option<WrappedI80F48>;
  liability_weight_maint: Option<WrappedI80F48>;
  deposit_limit: Option<u64>;
  borrow_limit: Option<u64>;
  operational_state: Option<BankOperationalState>;
  interest_rate_config: Option<InterestRateConfigOpt>;
  risk_tier: Option<RiskTier>;
  asset_tag: Option<u8>;
  total_asset_value_init_limit: Option<u64>;
  oracle_max_confidence: Option<u32>;
  oracle_max_age: Option<u16>;
  permissionless_bad_debt_settlement: Option<boolean>;
  freeze_settings: Option<boolean>;
  tokenless_repayments_allowed: Option<boolean>;
  /** Per-bank liquidation fees, encoded as `u32_to_centi` (`u32::MAX` = 100%; 0 => default 2.5%). */
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

/** Emitted when consecutive tier-3 trips force a bank into `CircuitBroken`. */
export interface CircuitBreakerAutoBrokenEvent {
  consecutive_tier3_trips: u8;
  current_timestamp: i64;
}

/** Emitted when a halt is cleared (admin override or escalation-window expiry). */
export interface CircuitBreakerClearedEvent {
  prior_tier: u8;
  /** One of the `CB_CLEAR_REASON_*` constants. */
  reason: u8;
  current_timestamp: i64;
}

/** Emitted when the per-bank oracle circuit breaker trips or escalates a halt. */
export interface CircuitBreakerTrippedEvent {
  tier: u8;
  deviation_bps: u64;
  halt_started_at: i64;
  halt_ended_at: i64;
}

/** DeleverageEvent */
export interface DeleverageEvent {
  marginfi_account: Pubkey;
  risk_admin: Pubkey;
  deleveragee_assets_seized: f64;
  deleveragee_liability_repaid: f64;
}

/** Emitted for deleverage-only withdraw outflows. The delegate flow admin aggregates these off-chain and updates the deleverage daily withdraws via `update_deleverage_withdrawals`. */
export interface DeleverageWithdrawFlowEvent {
  group: Pubkey;
  bank: Pubkey;
  mint: Pubkey;
  /** Equity-denominated outflow value in USD, rounded to integer. */
  outflow_usd: u32;
  /** Unix timestamp when the flow was recorded */
  current_timestamp: i64;
}

/**
 * DriftClaimBadDebtEvent
 * @layout borsh
 */
export interface DriftClaimBadDebtEvent {
  header: GroupEventHeader;
  bank: Pubkey;
  claim_mint: Pubkey;
  distributor: Pubkey;
  claim_status: Pubkey;
  liquidity_vault_authority: Pubkey;
  global_fee_wallet: Pubkey;
  requested_amount: u64;
  received_amount: u64;
  swept_amount: u64;
}

/**
 * EditStakedSettingsEvent
 * @layout borsh
 */
export interface EditStakedSettingsEvent {
  group: Pubkey;
  settings: StakedSettingsEditConfig;
}

/** GroupEventHeader */
export interface GroupEventHeader {
  signer: Option<Pubkey>;
  marginfi_group: Pubkey;
}

/** HealthPulseEvent */
export interface HealthPulseEvent {
  account: Pubkey;
  health_cache: HealthCache;
}

/** InterestRateConfigOpt */
export interface InterestRateConfigOpt {
  insurance_fee_fixed_apr: Option<WrappedI80F48>;
  insurance_ir_fee: Option<WrappedI80F48>;
  protocol_fixed_fee_apr: Option<WrappedI80F48>;
  protocol_ir_fee: Option<WrappedI80F48>;
  protocol_origination_fee: Option<WrappedI80F48>;
  /** The base rate at utilization = 0 * a %, as u32, out of 1000%, e.g. 100% = 0.1 * u32::MAX */
  zero_util_rate: Option<u32>;
  /** The base rate at utilization = 100 * a %, as u32, out of 1000%, e.g. 100% = 0.1 * u32::MAX */
  hundred_util_rate: Option<u32>;
  /** The base rate at various points between 0 and 100%, exclusive. Essentially a piece-wise linear curve. * always in ascending order, e.g. points[0] = first kink point, points[1] = second kink point, and so forth. * points where util = 0 are unused */
  points: Option<FixedArray<RatePoint, 5>>;
}

/**
 * KeeperCloseOrderEvent
 * @layout borsh
 */
export interface KeeperCloseOrderEvent {
  header: AccountEventHeader;
  order: Pubkey;
}

/**
 * KeeperCloseRebalanceOrderEvent
 * @layout borsh
 */
export interface KeeperCloseRebalanceOrderEvent {
  header: AccountEventHeader;
  rebalance_order: Pubkey;
}

/**
 * LendingAccountBorrowEvent
 * @layout borsh
 */
export interface LendingAccountBorrowEvent {
  header: AccountEventHeader;
  bank: Pubkey;
  mint: Pubkey;
  amount: u64;
  share_amount: WrappedI80F48;
}

/**
 * LendingAccountDepositEvent
 * @layout borsh
 */
export interface LendingAccountDepositEvent {
  header: AccountEventHeader;
  bank: Pubkey;
  mint: Pubkey;
  amount: u64;
  share_amount: WrappedI80F48;
}

/**
 * LendingAccountLiquidateEvent
 * @layout borsh
 */
export interface LendingAccountLiquidateEvent {
  header: AccountEventHeader;
  liquidatee_marginfi_account: Pubkey;
  liquidatee_marginfi_account_authority: Pubkey;
  asset_bank: Pubkey;
  asset_mint: Pubkey;
  liability_bank: Pubkey;
  liability_mint: Pubkey;
  liquidatee_pre_health: f64;
  liquidatee_post_health: f64;
  pre_balances: LiquidationBalances;
  post_balances: LiquidationBalances;
}

/**
 * LendingAccountPremiumSettledEvent
 * @layout borsh
 */
export interface LendingAccountPremiumSettledEvent {
  header: AccountEventHeader;
  bank: Pubkey;
  mint: Pubkey;
  /** Vault-backed premium moved into `bank.collected_premium_outstanding` by a repayment or seized-collateral liquidation credit, in native token units. */
  premium_settled: f64;
  /** Premium receivable written off with no tokens (tokenless risk-admin repayment), in native token units. */
  premium_written_off: f64;
  /** Premium receivable still outstanding on the balance after this settlement. */
  premium_outstanding_remaining: f64;
}

/**
 * LendingAccountRepayEvent
 * @layout borsh
 */
export interface LendingAccountRepayEvent {
  header: AccountEventHeader;
  bank: Pubkey;
  mint: Pubkey;
  amount: u64;
  close_balance: boolean;
  share_amount: WrappedI80F48;
}

/**
 * LendingAccountWithdrawEvent
 * @layout borsh
 */
export interface LendingAccountWithdrawEvent {
  header: AccountEventHeader;
  bank: Pubkey;
  mint: Pubkey;
  amount: u64;
  close_balance: boolean;
  share_amount: WrappedI80F48;
}

/**
 * LendingPoolBankAccrueInterestEvent
 * @layout borsh
 */
export interface LendingPoolBankAccrueInterestEvent {
  header: GroupEventHeader;
  bank: Pubkey;
  mint: Pubkey;
  delta: u64;
  fees_collected: f64;
  insurance_collected: f64;
}

/**
 * LendingPoolBankCollectFeesEvent
 * @layout borsh
 */
export interface LendingPoolBankCollectFeesEvent {
  header: GroupEventHeader;
  bank: Pubkey;
  mint: Pubkey;
  group_fees_collected: f64;
  group_fees_outstanding: f64;
  insurance_fees_collected: f64;
  insurance_fees_outstanding: f64;
}

/**
 * LendingPoolBankConfigureEvent
 * @layout borsh
 */
export interface LendingPoolBankConfigureEvent {
  header: GroupEventHeader;
  bank: Pubkey;
  mint: Pubkey;
  config: BankConfigOpt;
}

/**
 * LendingPoolBankConfigureFrozenEvent
 * @layout borsh
 */
export interface LendingPoolBankConfigureFrozenEvent {
  header: GroupEventHeader;
  bank: Pubkey;
  mint: Pubkey;
  deposit_limit: u64;
  borrow_limit: u64;
}

/**
 * LendingPoolBankConfigureOracleEvent
 * @layout borsh
 */
export interface LendingPoolBankConfigureOracleEvent {
  header: GroupEventHeader;
  bank: Pubkey;
  oracle_setup: u8;
  oracle: Pubkey;
}

/**
 * LendingPoolBankCreateEvent
 * @layout borsh
 */
export interface LendingPoolBankCreateEvent {
  header: GroupEventHeader;
  bank: Pubkey;
  mint: Pubkey;
}

/**
 * LendingPoolBankHandleBankruptcyEvent
 * @layout borsh
 */
export interface LendingPoolBankHandleBankruptcyEvent {
  header: AccountEventHeader;
  bank: Pubkey;
  mint: Pubkey;
  bad_debt: f64;
  covered_amount: f64;
  socialized_amount: f64;
  /** Uncollectable premium receivable written off with the bad debt (never socialized, never covered by insurance, never credited to the bank). */
  premium_written_off: f64;
}

/**
 * LendingPoolBankPremiumConfigureEvent
 * @layout borsh
 */
export interface LendingPoolBankPremiumConfigureEvent {
  header: GroupEventHeader;
  bank: Pubkey;
  mint: Pubkey;
  premium_tag: u16;
  active: boolean;
}

/**
 * LendingPoolBankSetOraclePriceEvent
 * @layout borsh
 */
export interface LendingPoolBankSetOraclePriceEvent {
  header: GroupEventHeader;
  bank: Pubkey;
  price: WrappedI80F48;
}

/**
 * LendingPoolBankSetSameAssetEmodeEligibilityEvent
 * @layout borsh
 */
export interface LendingPoolBankSetSameAssetEmodeEligibilityEvent {
  header: GroupEventHeader;
  bank: Pubkey;
  mint: Pubkey;
  enabled: boolean;
}

/**
 * LendingPoolGroupPremiumConfigureEvent
 * @layout borsh
 */
export interface LendingPoolGroupPremiumConfigureEvent {
  header: GroupEventHeader;
  collateral_tag: u16;
  liability_tag: u16;
  old_rate: u32;
  new_rate: u32;
}

/**
 * LendingPoolPremiumFeesCollectedEvent
 * @layout borsh
 */
export interface LendingPoolPremiumFeesCollectedEvent {
  header: GroupEventHeader;
  bank: Pubkey;
  mint: Pubkey;
  /** Realized premium swept from the liquidity vault to the premium wallet ATA this call. */
  premium_collected: f64;
  /** Realized premium still awaiting sweep after this call. */
  premium_outstanding: f64;
}

/**
 * LendingPoolSuperAdminDepositEvent
 * @layout borsh
 */
export interface LendingPoolSuperAdminDepositEvent {
  header: GroupEventHeader;
  bank: Pubkey;
  mint: Pubkey;
  /** Amount requested in SPL transfer instruction. */
  transfer_amount: u64;
  /** Assumed vault inflow. Token-2022 transfer fees are not handled by this instruction path. */
  vault_inflow_amount: u64;
}

/**
 * LendingPoolSuperAdminWithdrawEvent
 * @layout borsh
 */
export interface LendingPoolSuperAdminWithdrawEvent {
  header: GroupEventHeader;
  bank: Pubkey;
  mint: Pubkey;
  vault_outflow_amount: u64;
}

/** LiquidationBalances */
export interface LiquidationBalances {
  liquidatee_asset_balance: f64;
  liquidatee_liability_balance: f64;
  liquidator_asset_balance: f64;
  liquidator_liability_balance: f64;
  liquidator_liability_bank_asset_balance: f64;
}

/** LiquidationReceiverEvent */
export interface LiquidationReceiverEvent {
  marginfi_account: Pubkey;
  liquidation_receiver: Pubkey;
  liquidatee_assets_seized: f64;
  liquidatee_liability_repaid: f64;
  lamps_fee_paid: u32;
}

/** LiquidationTagEvent */
export interface LiquidationTagEvent {
  marginfi_account: Pubkey;
  /** 0 when the tag was cleared */
  tagged_at: i64;
}

/**
 * MarginfiAccountCloseOrderEvent
 * @layout borsh
 */
export interface MarginfiAccountCloseOrderEvent {
  header: AccountEventHeader;
  order: Pubkey;
}

/**
 * MarginfiAccountCloseRebalanceOrderEvent
 * @layout borsh
 */
export interface MarginfiAccountCloseRebalanceOrderEvent {
  header: AccountEventHeader;
  rebalance_order: Pubkey;
}

/**
 * MarginfiAccountCreateEvent
 * @layout borsh
 */
export interface MarginfiAccountCreateEvent {
  header: AccountEventHeader;
}

/**
 * MarginfiAccountFreezeEvent
 * @layout borsh
 */
export interface MarginfiAccountFreezeEvent {
  header: AccountEventHeader;
  frozen: boolean;
}

/**
 * MarginfiAccountPlaceOrderEvent
 * @layout borsh
 */
export interface MarginfiAccountPlaceOrderEvent {
  header: AccountEventHeader;
  order: Pubkey;
  trigger: OrderTriggerType;
  stop_loss: WrappedI80F48;
  take_profit: WrappedI80F48;
  tags: FixedArray<u16, 2>;
}

/** MarginfiAccountPlaceRebalanceOrderEvent (a Vec<Pubkey>: written field by field, as SetKeeperCloseFlagsEvent) */
export interface MarginfiAccountPlaceRebalanceOrderEvent {
  header: AccountEventHeader;
  rebalance_order: Pubkey;
  mint: Pubkey;
  allowed_banks: Vec<Pubkey>;
  min_improvement: WrappedI80F48;
  cooldown_seconds: u64;
  amount: u64;
  keeper_tip: u64;
}

/**
 * MarginfiAccountTransferToNewAccount
 * @layout borsh
 */
export interface MarginfiAccountTransferToNewAccount {
  header: AccountEventHeader;
  old_account: Pubkey;
  old_account_authority: Pubkey;
  new_account_authority: Pubkey;
}

/** MarginfiAccountUpdateRebalanceOrderEvent (a Vec<Pubkey>: written field by field) */
export interface MarginfiAccountUpdateRebalanceOrderEvent {
  header: AccountEventHeader;
  rebalance_order: Pubkey;
  allowed_banks: Vec<Pubkey>;
  min_improvement: WrappedI80F48;
  cooldown_seconds: u64;
  amount: u64;
  keeper_tip: u64;
}

/**
 * MarginfiGroupConfigureEvent
 * @layout borsh
 */
export interface MarginfiGroupConfigureEvent {
  header: GroupEventHeader;
  admin: Option<Pubkey>;
  flags: u64;
}

/**
 * MarginfiGroupCreateEvent
 * @layout borsh
 */
export interface MarginfiGroupCreateEvent {
  header: GroupEventHeader;
}

/** Emitted when a bank-level inflow or outflow is recorded. The delegate flow admin aggregates these off-chain and updates the group rate limiter via `update_group_rate_limiter`. */
export interface RateLimitFlowEvent {
  group: Pubkey;
  bank: Pubkey;
  mint: Pubkey;
  /** 0 = outflow (withdraw/borrow), 1 = inflow (deposit/repay) */
  flow_direction: u8;
  /** Amount in native tokens */
  native_amount: u64;
  mint_decimals: u8;
  /** Unix timestamp when the flow was recorded */
  current_timestamp: i64;
}

/**
 * RebalanceExecutedEvent
 * @layout borsh
 */
export interface RebalanceExecutedEvent {
  header: AccountEventHeader;
  rebalance_order: Pubkey;
  executor: Pubkey;
  bank_count: u8;
  value_moved: WrappedI80F48;
  /** Lamports escrowed into the rebalance record, released later by `settle_rebalance_tip`. */
  tip_escrowed: u64;
}

/**
 * RebalanceFeePoolTopUpEvent
 * @layout borsh
 */
export interface RebalanceFeePoolTopUpEvent {
  header: AccountEventHeader;
  fee_pool: Pubkey;
  amount: u64;
  new_balance: u64;
}

/**
 * RebalanceFeePoolWithdrawEvent
 * @layout borsh
 */
export interface RebalanceFeePoolWithdrawEvent {
  header: AccountEventHeader;
  fee_pool: Pubkey;
  amount: u64;
  new_balance: u64;
}

/**
 * RebalanceTipSettledEvent
 * @layout borsh
 */
export interface RebalanceTipSettledEvent {
  header: AccountEventHeader;
  rebalance_order: Pubkey;
  executor: Pubkey;
  /** Whether every move's destination out-yielded its source over the settlement window. */
  realized: boolean;
  /** Lamports the executor received. Nonzero without `realized` when the escrow was forfeited because the fee pool had been drained below its rent-exempt reserve. */
  tip_paid: u64;
}

/**
 * SetGovernanceAdminEvent
 * @layout borsh
 */
export interface SetGovernanceAdminEvent {
  header: GroupEventHeader;
  previous_governance_admin: Pubkey;
  new_governance_admin: Pubkey;
}

/** StakedSettingsEditConfig */
export interface StakedSettingsEditConfig {
  oracle: Option<Pubkey>;
  asset_weight_init: Option<WrappedI80F48>;
  asset_weight_maint: Option<WrappedI80F48>;
  deposit_limit: Option<u64>;
  total_asset_value_init_limit: Option<u64>;
  oracle_max_age: Option<u16>;
  /** WARN: You almost certainly want "Collateral", using Isolated risk tier makes the asset worthless as collateral, making all outstanding accounts eligible to be liquidated, and is generally useful only when creating a staked collateral pool for rewards purposes only. */
  risk_tier: Option<RiskTier>;
}

/** SetKeeperCloseFlagsEvent */
export interface SetKeeperCloseFlagsEvent {
  header: AccountEventHeader;
  bank_keys: Option<Vec<Pubkey>>;
}
