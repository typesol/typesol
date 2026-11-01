// Marginfi's accounts (type-crate/src/types of mrgnlabs/marginfi-v2 @ c5d440f6), generated from the on-chain IDL
// (test/fixtures/marginfi/marginfi.idl.json) by `typesol port`: zero-copy #[repr(C)] structs with no implicit padding,
// so TypeSOL's fixed layout stores them byte for byte. WrappedI80F48 holds an i128 (showcase/mainnet/marginfi/i80f48.ts).
import { type FixedArray, type Pubkey, type i128, type i32, type i64, type u16, type u32, type u64, type u8 } from "typesol";

/**
 * Balance
 * @repr c
 */
export interface Balance {
  /** Whether this balance slot is in use (nonzero = active) */
  active: u8;
  /** The bank this balance corresponds to */
  bank_pk: Pubkey;
  /** Inherited from the bank when the position is first created and CANNOT BE CHANGED after that. Note that all balances created before the addition of this feature use `ASSET_TAG_DEFAULT` */
  bank_asset_tag: u8;
  /** Tag used by orders to reference this balance (0 means unused/unassigned). A tag may also have a non-zero value while having no orders. */
  tag: u16;
  /** Collateral-weighted variable-borrow premium APR snapshot for this liability position, encoded like interest-curve points via `milli_to_u32` (0-1000%). Recomputed by every oracle-carrying ix (borrow, withdraw, liquidation, order end, `pulse_health`) but not deposit/repay, which carry no oracles. 0 = no premium. */
  premium_rate_snapshot: u32;
  /** The user's asset (deposit) shares in the bank. Multiply by `bank.asset_share_value` for the token amount. */
  asset_shares: WrappedI80F48;
  /** The user's liability (borrow) shares in the bank. Multiply by `bank.liability_share_value` for the token amount. */
  liability_shares: WrappedI80F48;
  /** Accrued (materialized) variable-borrow premium owed on this liability position, in native token units. Settled (with real tokens) only on repay; written off on bankruptcy, tokenless repayment, or a liability→asset flip. */
  premium_outstanding: WrappedI80F48;
  /** Unix timestamp (u64) of the last premium accrual (claim) for this position. Set at balance creation and bumped on every `claim_premium`. */
  last_update: u64;
  /**
   * Reserved for future use
   * @idlName _padding
   */
  padding: FixedArray<u64, 1>;
}

/**
 * Bank
 * @serialization bytemuck
 * @repr c
 */
export interface Bank {
  /** The SPL token mint this bank manages */
  mint: Pubkey;
  /** Number of decimals of the `mint`. Must be < 24. */
  mint_decimals: u8;
  /** The `MarginfiGroup` this bank belongs to */
  group: Pubkey;
  /** @idlName _pad0 */
  pad0: FixedArray<u8, 7>;
  /** Monotonically increases as interest rate accumulates. For typical banks, a user's asset value in token = (number of shares the user has * asset_share_value). * A float (arbitrary decimals) * Initially 1 */
  asset_share_value: WrappedI80F48;
  /** Monotonically increases as interest rate accumulates. For typical banks, a user's liabilty value in token = (number of shares the user has * liability_share_value) * A float (arbitrary decimals) * Initially 1 */
  liability_share_value: WrappedI80F48;
  /** The SPL token account holding deposited liquidity */
  liquidity_vault: Pubkey;
  /** PDA bump for the liquidity vault */
  liquidity_vault_bump: u8;
  /** PDA bump for the liquidity vault authority */
  liquidity_vault_authority_bump: u8;
  /** The SPL token account holding insurance fund tokens */
  insurance_vault: Pubkey;
  /** PDA bump for the insurance vault */
  insurance_vault_bump: u8;
  /** PDA bump for the insurance vault authority */
  insurance_vault_authority_bump: u8;
  /** @idlName _pad1 */
  pad1: FixedArray<u8, 4>;
  /** Fees collected and pending withdraw for the `insurance_vault` */
  collected_insurance_fees_outstanding: WrappedI80F48;
  /** The SPL token account holding collected group fees */
  fee_vault: Pubkey;
  /** PDA bump for the fee vault */
  fee_vault_bump: u8;
  /** PDA bump for the fee vault authority */
  fee_vault_authority_bump: u8;
  /** @idlName _pad2 */
  pad2: FixedArray<u8, 6>;
  /** Fees collected and pending withdraw for the `fee_vault` */
  collected_group_fees_outstanding: WrappedI80F48;
  /** Sum of all liability shares held by all borrowers in this bank. Multiply by `liability_share_value` to get the total liability amount in native token units. */
  total_liability_shares: WrappedI80F48;
  /** Sum of all asset shares held by all depositors in this bank. Multiply by `asset_share_value` to get the total asset amount in native token units. * For Kamino banks, this is the quantity of collateral tokens (NOT liquidity tokens) in the bank, and also uses `mint_decimals`, though the mint itself will always show (6) decimals exactly (i.e Kamino ignores this and treats it as if it was using `mint_decimals`) */
  total_asset_shares: WrappedI80F48;
  /** Unix timestamp (i64) of the last interest accrual */
  last_update: i64;
  /** The bank's configuration parameters (weights, limits, oracle setup, interest rate config) */
  config: BankConfig;
  /** Bank flags bitfield (u64).  - Bit 0 (1): `EMISSIONS_FLAG_BORROW_ACTIVE` — borrow-side emissions are active - Bit 1 (2): `EMISSIONS_FLAG_LENDING_ACTIVE` — lending-side emissions are active - Bit 2 (4): `PERMISSIONLESS_BAD_DEBT_SETTLEMENT_FLAG` — anyone can settle bad debt - Bit 3 (8): `FREEZE_SETTINGS` — bank configuration is frozen (only limits can change) - Bit 4 (16): `CLOSE_ENABLED_FLAG` — bank can be closed (set at creation for banks >= 0.1.4) - Bit 5 (32): `TOKENLESS_REPAYMENTS_ALLOWED` — risk admin can repay debt without tokens - Bit 6 (64): `TOKENLESS_REPAYMENTS_COMPLETE` — all debt cleared, lender purge enabled - Bit 7 (128): `IS_T22` — 1 if T22, 0 if token classic - Bit 8 (256): `BANK_SEED_KNOWN` — bank is known to be PDA/seed-derived. If not set, bank may still be a PDA, but created before this flag launched (1.8 or earlier) or is a legacy keypair-based bank. - Bit 9 (512): `STAKED_ORACLE_DISABLED` — staked oracle pricing is temporarily disabled. - Bit 10 (1024): `STAKED_ORACLE_PRICE_USES_ONRAMP` — staked oracle pricing includes the SPL single-pool on-ramp account in NAV. - Bit 11 (2048): `CIRCUIT_BREAKER_ENABLED` — oracle deviation breaker active on this bank - Bit 12 (4096): `BANK_SAME_ASSET_EMODE_ELIGIBLE` — bank may participate in same-asset e-mode. - Bit 13 (8192): `PREMIUM_ACTIVE` — a liability-bank flag: balances borrowing from this bank accrue the pairwise variable-borrow premium and project it in health checks. - Bit 14 (16384): `KAMINO_MARKET_EMERGENCY` — the Kamino lending market behind this bank is in emergency mode, so the bank backs no new borrowing. */
  flags: u64;
  /** Emissions APR. Number of emitted tokens (emissions_mint) per 1e(bank.mint_decimal) tokens (bank mint) (native amount) per 1 YEAR. */
  emissions_rate: u64;
  /** Remaining emissions tokens available for distribution */
  emissions_remaining: WrappedI80F48;
  /** The SPL token mint used for emissions rewards */
  emissions_mint: Pubkey;
  /** Fees collected and pending withdraw for the `FeeState.global_fee_wallet`'s canonical ATA for `mint` */
  collected_program_fees_outstanding: WrappedI80F48;
  /** Controls this bank's emode configuration, which enables some banks to treat the assets of certain other banks more preferentially as collateral. */
  emode: EmodeSettings;
  /** Set with `update_fees_destination_account`. Fees can be withdrawn to the canonical ATA of this wallet without the admin's input (withdraw_fees_permissionless). If pubkey default, the bank doesn't support this feature, and the fees must be collected manually (withdraw_fees). */
  fees_destination_account: Pubkey;
  /** Cached bank metrics (interest rates, oracle price, etc.) */
  cache: BankCache;
  /** Number of user lending positions currently open in this bank * For banks created prior to 0.1.4, this is the number of positions opened/closed after 0.1.4 goes live, and may be negative. * For banks created in 0.1.4 or later, this is the number of positions open in total, and the bank may safely be closed if this is zero. Will never go negative. */
  lending_position_count: i32;
  /** Number of user borrowing positions currently open in this bank * For banks created prior to 0.1.4, this is the number of positions opened/closed after 0.1.4 goes live, and may be negative. * For banks created in 0.1.4 or later, this is the number of positions open in total, and the bank may safely be closed if this is zero. Will never go negative. */
  borrowing_position_count: i32;
  /** Fee the liquidator earns when liquidating against this bank's liability. Decode with `u32_to_centi` (`u32::MAX` = 100%). * 0 falls back to the default (`DEFAULT_LIQUIDATION_FEE` = 2.5%). */
  liquidation_liquidator_fee: u32;
  /** Fee routed to this bank's insurance fund on a liquidation against its liability. Decode with `u32_to_centi` (`u32::MAX` = 100%). * 0 falls back to the default (`DEFAULT_LIQUIDATION_FEE` = 2.5%). */
  liquidation_insurance_fee: u32;
  /**
   * Reserved for future use
   * @idlName _padding_0
   */
  padding_0: FixedArray<u8, 8>;
  /** Integration account slot 1 (default Pubkey for non-integrations). - Kamino: reserve - Drift: spot market - Solend: reserve - JupLend: lending state - Staked Collateral: Validator vote account */
  integration_acc_1: Pubkey;
  /** Integration account slot 2 (default Pubkey for non-integrations). - Kamino: obligation - Drift: user - Solend: obligation - JupLend: fToken vault */
  integration_acc_2: Pubkey;
  /** Integration account slot 3 (default Pubkey for non-integrations). - Drift: user stats - JupLend: withdraw intermediary ATA (ATA of liquidity_vault_authority for bank mint) */
  integration_acc_3: Pubkey;
  /** Rate limiter for controlling withdraw/borrow outflow. Tracks net outflow (outflows - inflows) in native tokens. */
  rate_limiter: BankRateLimiter;
  /** Realized variable-borrow premium sitting in the liquidity vault, pending sweep to the protocol premium wallet's canonical ATA for `mint`. Only incremented when premium tokens are actually received (repay); never by mere accrual. */
  collected_premium_outstanding: WrappedI80F48;
  /** * `0` for legacy banks created via `lending_pool_add_bank` (created via keypair, not a PDA), or pre-backfill banks (1.8 or earlier) where seed remains unknown. * Otherwise the `bank_seed: u64` argument passed when creating the bank. * Use `flags & BANK_SEED_KNOWN` to verify this value has known seed provenance. */
  bank_seed: u64;
  /** Unix-seconds when the current halt started, zero if not halted. */
  cb_halt_started_at: i64;
  /** Unix-seconds when the current halt's tier duration ends. Tier stays sticky past this for the escalation window; a fresh breach within the window ratchets to the next tier. */
  cb_halt_ended_at: i64;
  /** 0 = operational, 1..=3 = escalating halt severity. */
  cb_tier: u8;
  /** Consecutive tier-3 trips with no clean escalation-window between them. Hitting `CB_MAX_TIER3_BEFORE_CIRCUIT_BREAK` forces the bank to `CircuitBroken`. */
  cb_tier3_consecutive_trips: u8;
  /** `BankOperationalState` (as `u8`) the bank held before the breaker forced it to `CircuitBroken`. Restored by `clear_circuit_breaker`. Meaningless unless `operational_state == CircuitBroken`. */
  cb_pre_break_state: u8;
  /** @idlName _cb_pad */
  cb_pad: FixedArray<u8, 5>;
  /** Solana slot of the last counted CB observation; used for slot-level dedup. */
  cb_last_observed_slot: u64;
  /** Publisher-side timestamp of the last counted CB observation; rejects re-reads of the same publication across multiple Solana slots. Zero when the adapter doesn't expose one. */
  cb_last_oracle_source_time: i64;
  /** EMA reference price used by the circuit breaker, in the multiplier-adjusted effective-price domain the risk engine uses. Frozen while halted, zero until the first observation after enable. */
  cb_reference_price: WrappedI80F48;
  /** Long-window reference price (same multiplier-adjusted domain as `cb_reference_price`) used to catch slow oracle walking that stays below the per-observation breaker threshold. */
  cb_window_reference_price: WrappedI80F48;
  /** Unix-seconds when `cb_window_reference_price` was anchored. */
  cb_window_started_at: i64;
  /** Frozen halt seconds from halt intervals overwritten or cleared before `accrue_interest` consumed them. Non-zero only when the halt record changes without a preceding accrual, i.e. a paused pulse; the next accrual excludes these on top of the current halt. Zero normally. */
  cb_frozen_seconds_pending: u64;
  /** Tag for the group's pairwise variable-borrow premium matrix. Determines the rate other accounts pay when this bank is offered as collateral (as `collateral_tag`) and the rate this bank's borrowers pay (as `liability_tag`). * 0 = untagged: never matches any premium entry. */
  premium_tag: u16;
  /** @idlName _pad3 */
  pad3: FixedArray<u8, 6>;
  /** Unix timestamp of the most recent inactive->active `PREMIUM_ACTIVE` transition. Premium accrual is clamped to start no earlier than this, so toggling the flag off and back on can never charge for (or health-project) the deactivated window. * 0 on banks that never activated premium. */
  premium_activated_at: i64;
  /** @idlName _padding_1 */
  padding_1: FixedArray<FixedArray<u64, 8>, 32>;
}

/**
 * A read-only cache of the bank's key metrics, e.g. spot interest/fee rates.
 * @repr c
 */
export interface BankCache {
  /** Actual (spot) interest/fee rates of the bank, based on utilization * APR (annual percentage rate) values * From 0-1000%, as u32, e.g. u32::MAX = 1000%, u32::MAX/2 = 500%, etc */
  base_rate: u32;
  /** Equivalent to `base_rate` * utilization * From 0-1000%, as u32, e.g. u32::MAX = 1000%, u32::MAX/2 = 500%, etc */
  lending_rate: u32;
  /** Equivalent to `base_rate` * (1 + ir_fees) + fixed_fees * From 0-1000%, as u32, e.g. u32::MAX = 1000%, u32::MAX/2 = 500%, etc */
  borrowing_rate: u32;
  /** * in seconds */
  interest_accumulated_for: u32;
  /** equivalent to (share value increase in the last `interest_accumulated_for` seconds * shares), i.e. the delta in `asset_share_value`, in token. * Note: if the tx that triggered this cache update increased or decreased the net shares, this value still reports using the PRE-CHANGE share amount, since interest is always earned on that amount. * in token, in native decimals, as I80F48 */
  accumulated_since_last_update: WrappedI80F48;
  /** Oracle price used in the last instruction that consumed an oracle price * Only updated when instruction uses an oracle price, not updated for operations that don't require prices (e.g., deposit, repay) * Price in USD, with no price bias * Zero if never updated */
  last_oracle_price: WrappedI80F48;
  /** Unix timestamp (seconds) when last_oracle_price was last updated * Used to determine staleness of cached price * Zero if never updated */
  last_oracle_price_timestamp: i64;
  /** Confidence interval reported by the oracle when last_oracle_price was fetched * Always non-negative * Zero if never updated * Pyth: confidence * 2.12 * Switchboard: price * oracle_max_confidence / U32_MAX */
  last_oracle_price_confidence: WrappedI80F48;
  /** Liquidation cache flags, set during receivership flow. * 1 (LIQ_CACHE_LOCKED_FLAG) - We "lock" the liquidation cache when writing to it in Start Liquidate as an additional safeguard, if the liquidation prices stored here were to be edited between start and end, it would completely break the risk engine. End validates that the lock is set, panics if not, and removes it - which prevents footguns if the cache was e.g. accidently set to default. The lock is also removed when a Balance is closed via withdraw_all, repay_all, or close_balance, but only when the account has ACCOUNT_IN_RECEIVERSHIP set, so that operations on unrelated accounts sharing the same bank do not interfere with an in-progress liquidation. */
  liq_cache_flags: u8;
  /** @idlName _cb_cache_pad */
  cb_cache_pad: FixedArray<u8, 7>;
  /** For integration banks, this is the exchange rate of cToken/token or similar. The "real" price of one deposited token is `price_multiplier` * `last_oracle_price`, we split it here for consumers who are only interested in reading the oracle price and are applying the multiplier already elsewhere. */
  price_multiplier: WrappedI80F48;
  /** Cached real-time price for receivership liquidation. */
  liquidation_price_rt: WrappedI80F48;
  /** Cached real-time price confidence for receivership liquidation. */
  liquidation_price_rt_confidence: WrappedI80F48;
  /** Cached TWAP price for receivership liquidation. */
  liquidation_price_twap: WrappedI80F48;
  /** Cached TWAP price confidence for receivership liquidation. */
  liquidation_price_twap_confidence: WrappedI80F48;
}

/**
 * BankConfig
 * @repr c
 */
export interface BankConfig {
  /** Discount factor for asset values in initial margin calculation (0 to 1). E.g., 0.8 means assets count as 80% of their value for borrowing purposes. */
  asset_weight_init: WrappedI80F48;
  /** Discount factor for asset values in maintenance margin calculation (0 to 2). Used for liquidation eligibility. Generally >= asset_weight_init. */
  asset_weight_maint: WrappedI80F48;
  /** Premium factor for liability values in initial margin calculation (>= 1). E.g., 1.2 means liabilities count as 120% of their value for borrowing purposes. */
  liability_weight_init: WrappedI80F48;
  /** Premium factor for liability values in maintenance margin calculation (>= 1). Used for liquidation eligibility. Generally <= liability_weight_init. */
  liability_weight_maint: WrappedI80F48;
  /** Maximum total deposits allowed in this bank, in native token units (0 = no limit) */
  deposit_limit: u64;
  /** Interest rate model configuration */
  interest_rate_config: InterestRateConfig;
  /** Current operational state of the bank (Paused, Operational, ReduceOnly, KilledByBankruptcy) */
  operational_state: BankOperationalState;
  /** Oracle type used for price feeds */
  oracle_setup: OracleSetup;
  /** Oracle account keys (usage depends on oracle_setup type) */
  oracle_keys: FixedArray<Pubkey, 5>;
  /** CB long-window upward move cap in bps; `0` uses the `CB_WINDOW_MAX_UP_BPS` default. */
  cb_window_max_up_bps: u16;
  /** CB long-window downward move cap in bps; `0` uses the `CB_WINDOW_MAX_DOWN_BPS` default. */
  cb_window_max_down_bps: u16;
  /** @idlName _pad0 */
  pad0: FixedArray<u8, 2>;
  /** Maximum total borrows allowed in this bank, in native token units (0 = no limit) */
  borrow_limit: u64;
  /** Risk tier for this bank (Collateral or Isolated) */
  risk_tier: RiskTier;
  /** Determines what kinds of assets users of this bank can interact with. Options: * `ASSET_TAG_DEFAULT` (0) - A regular asset that can be comingled with any other regular asset or with `ASSET_TAG_SOL` * `ASSET_TAG_SOL` (1) - Accounts with a SOL position can comingle with **either** `ASSET_TAG_DEFAULT` or `ASSET_TAG_STAKED` positions, but not both * `ASSET_TAG_STAKED` (2) - Staked SOL assets. Accounts with a STAKED position can only deposit other STAKED assets or SOL (`ASSET_TAG_SOL`) and can only borrow SOL * `ASSET_TAG_KAMINO` (3) - Treated the same as `ASSET_TAG_DEFAULT` * `ASSET_TAG_DRIFT` (4) - Treated the same as `ASSET_TAG_DEFAULT` * `ASSET_TAG_SOLEND` (5) - Treated the same as `ASSET_TAG_DEFAULT` */
  asset_tag: u8;
  /** Flags for various config options * 1 - Always set if bank created in 0.1.4 or later, or if migrated to the new pyth oracle setup from a prior version. Not set in 0.1.3 or earlier banks using pyth that have not yet migrated. Does nothing for banks that use switchboard. * 2, 4, 8, 16, etc - reserved for future use. */
  config_flags: u8;
  /** @idlName _pad1 */
  pad1: FixedArray<u8, 1>;
  /** CB long-window length in seconds; `0` uses the `CB_WINDOW_SECONDS` default. */
  cb_window_seconds: u32;
  /** USD denominated limit for calculating asset value for initialization margin requirements. Example, if total SOL deposits are equal to $1M and the limit it set to $500K, then SOL assets will be discounted by 50%.  In other words the max value of liabilities that can be backed by the asset is $500K. This is useful for limiting the damage of oracle attacks.  Value is UI USD value, for example value 100 -> $100 */
  total_asset_value_init_limit: u64;
  /** Time window in seconds for the oracle price feed to be considered live. */
  oracle_max_age: u16;
  /** Entry index into the Scope `OraclePrices` price list. Only read by the Scope setups (`Scope`, `ScopeKamino`, `ScopeJuplend`); ignored (and zero) for every other setup. Occupies what was previously `_padding0`, so the layout is unchanged. */
  scope_entry_index: u16;
  /** A %, as u32, e.g. 100% = u32::MAX, 50% = u32::MAX/2, etc.  Oracle confidence configuration. Semantics depend on the oracle type: * Pyth: Maximum allowed confidence interval. Prices exceeding this threshold are rejected. - 0 defaults to 10%. * Switchboard: Confidence spread used for price biasing. - 0 disables confidence adjustment. - Non-zero: confidence = price * oracle_max_confidence / U32_MAX. - Clamped to MAX_CONF_INTERVAL (5% of price). */
  oracle_max_confidence: u32;
  /** Stored oracle price for `OracleSetup::Fixed`, otherwise does nothing */
  fixed_price: WrappedI80F48;
  /** Deviation thresholds in basis points for tiers 1/2/3, strictly monotonic. */
  cb_deviation_bps_tiers: FixedArray<u16, 3>;
  /** Halt durations in seconds for tiers 1/2/3, strictly monotonic. */
  cb_tier_durations_seconds: FixedArray<u16, 3>;
  /** Escalation window multiplier: a re-breach within `prev_tier_duration * mult` seconds after a halt ends ratchets to the next tier. */
  cb_escalation_window_mult: u8;
  /** @idlName _cb_config_pad */
  cb_config_pad: u8;
  /** EMA smoothing factor for the reference price, in basis points (e.g. 1000 = α=0.1). */
  cb_ema_alpha_bps: u16;
}

/**
 * BankMetadata
 * @serialization bytemuck
 * @repr c
 */
export interface BankMetadata {
  /** Bank this metadata corresponds to */
  bank: Pubkey;
  placeholder: u64;
  /** The token's ticker name, e.g. USDC * utf-8 */
  ticker: FixedArray<u8, 64>;
  /** The token's plain english description, e.g US Dollar Coin * utf-8 */
  description: FixedArray<u8, 128>;
  /** Reserved for future use. Room for a very small icon or something else cool */
  data_blob: FixedArray<u8, 256>;
  /** The last data byte in description (padding follows) */
  end_description_byte: u16;
  /** The last data byte in data_blob (padding follows) */
  end_data_blob: u16;
  /** The last data byte in ticker (padding follows) */
  end_ticker_byte: u8;
  bump: u8;
  /** @idlName _pad0 */
  pad0: FixedArray<u8, 2>;
}

/**
 * @repr rust
 */
export enum BankOperationalState {
  Paused,
  Operational,
  ReduceOnly,
  KilledByBankruptcy,
  Uninitialized,
  ReduceOnlyWithBorrowingPower,
  CircuitBroken,
}

/**
 * Per-bank rate limiting configuration and state. Tracks net outflow in native tokens.
 * @repr c
 */
export interface BankRateLimiter {
  /** Hourly window rate limiter (native tokens). */
  hourly: RateLimitWindow;
  /** Daily window rate limiter (native tokens). */
  daily: RateLimitWindow;
}

/**
 * An emode configuration. Each bank has one such configuration, but this may also be the intersection of many configurations (see `reconcile_emode_configs`). For example, the risk engine creates such an intersection from all the emode config of all banks the user is borrowing from.
 * @repr c
 */
export interface EmodeConfig {
  entries: FixedArray<EmodeEntry, 10>;
}

/**
 * EmodeEntry
 * @repr c
 */
export interface EmodeEntry {
  /** emode_tag of the bank(s) whose collateral you wish to treat preferentially. */
  collateral_bank_emode_tag: u16;
  /** * APPLIES_TO_ISOLATED (1) - (NOT YET IMPLEMENTED) if set, isolated banks with this tag also benefit. If not set, isolated banks continue to offer zero collateral, even if they use this tag. * 2, 4, 8, 16, 32, etc - reserved for future use */
  flags: u8;
  pad0: FixedArray<u8, 5>;
  /** Note: If set below the collateral bank's weight, does nothing. */
  asset_weight_init: WrappedI80F48;
  /** Note: If set below the collateral bank's weight, does nothing. */
  asset_weight_maint: WrappedI80F48;
}

/**
 * Controls the bank's e-mode configuration, allowing certain collateral sources to be treated more favorably as collateral when used to borrow from this bank.
 * @repr c
 */
export interface EmodeSettings {
  /** This bank's NON-unique id that other banks will use to determine what emode rate to use when this bank is offered as collateral.  For example, all stablecoin banks might share the same emode_tag, and in their entries, each such stablecoin bank will recognize that collateral sources with this "stable" tag get preferential weights. When a new stablecoin is added that is considered riskier, it may get a new, less favorable emode tag, and eventually get upgraded to the same one as the other stables  * 0 is in an invalid tag and will do nothing. */
  emode_tag: u16;
  pad0: FixedArray<u8, 6>;
  /** Unix timestamp from the system clock when emode state was last updated */
  timestamp: i64;
  /** EMODE_ON (1) - If set, at least one entry is configured 2, 4, 8, etc, Reserved for future use */
  flags: u64;
  emode_config: EmodeConfig;
}

/**
 * ExecuteOrderBalanceRecord
 * @repr c
 */
export interface ExecuteOrderBalanceRecord {
  bank: Pubkey;
  is_asset: u8;
  /** @idlName _pad0 */
  pad0: FixedArray<u8, 5>;
  tag: u16;
  shares: WrappedI80F48;
}

/**
 * ExecuteOrderRecord
 * @serialization bytemuck
 * @repr c
 */
export interface ExecuteOrderRecord {
  order: Pubkey;
  executor: Pubkey;
  balance_states: FixedArray<ExecuteOrderBalanceRecord, 14>;
  active_balance_count: u8;
  inactive_balance_count: u8;
  /** @idlName _reserved0 */
  reserved0: FixedArray<u8, 6>;
  order_start_health: WrappedI80F48;
}

/**
 * Unique per-program. The Program Owner uses this account to administrate fees collected by the protocol
 * @serialization bytemuck
 * @repr c
 */
export interface FeeState {
  /** The fee state's own key. A PDA derived from just `b"feestate"` */
  key_: Pubkey;
  /** Can modify fees, pause the protocol, etc */
  global_fee_admin: Pubkey;
  /** The base wallet for all protocol fees. All SOL fees go to this wallet. All non-SOL fees go to the cannonical ATA of this wallet for that asset. */
  global_fee_wallet: Pubkey;
  /** Flat fee in lamports paid to the global fee wallet when initiating an account transfer (anti-spam; 5,000,000 lamports ~= $0.50). A stored 0 means "use the default" (`DEFAULT_ACCOUNT_TRANSFER_FEE_LAMPORTS`), which preserves the legacy fee for FeeStates created before this field existed. */
  account_transfer_fee: u32;
  /** @idlName _placeholder0 */
  placeholder0: FixedArray<u8, 4>;
  /** Flat fee assessed when a new bank is initialized, in lamports. * In SOL, in native decimals. */
  bank_init_flat_sol_fee: u32;
  bump_seed: u8;
  /** @idlName _padding0 */
  padding0: FixedArray<u8, 3>;
  /** Liquidators can claim at this premium, when liquidating an asset in receivership liquidation, e.g. (1 + this) * amount repaid >= asset seized * A percentage */
  liquidation_max_fee: WrappedI80F48;
  /** Fee collected by the program owner from all groups * A percentage */
  program_fee_fixed: WrappedI80F48;
  /** Fee collected by the program owner from all groups * A percentage */
  program_fee_rate: WrappedI80F48;
  /** When the global admin pauses the protocol in the event of an emergency, information about the pause duration will be stored here and propagated to groups. */
  panic_state: PanicState;
  placeholder1: u64;
  /** Flat fee assessed for insurance/program use when a liquidation is executed * In SOL, in native decimals. */
  liquidation_flat_sol_fee: u32;
  /** Flat fee assessed for preventing spam use when creating an order * In SOL, in native decimals. */
  order_init_flat_sol_fee: u32;
  /** Take-profit Orders can be executed at this premium, which Keepers are allowed to keep (no pun intended) e.g. (1 + this) * amount repaid >= asset seized * A percentage */
  order_execution_max_fee: WrappedI80F48;
  /** Can pause (not unpause) the protocol, but cannot modify any fee configuration. */
  pause_delegate_admin: Pubkey;
  /** Destination wallet for swept variable-borrow premium fees. Premium collected by banks is swept (permissionlessly) to the canonical ATA of this wallet for the bank's mint. * `Pubkey::default()` = unset (sweeps are rejected until the fee admin configures it), which is what v1-sized accounts hold after `resize_global_fee_state` zero-fills them. */
  premium_wallet: Pubkey;
  /**
   * Reserved for future use. Accounts created before the struct grew to this size are v1-sized (`8 + V1_LEN` bytes) and must be grown via `resize_global_fee_state` before this program version can load them; the new bytes are zero-filled.
   * @idlName _reserved0
   */
  reserved0: FixedArray<u64, 28>;
}

/**
 * Cached fee configuration propagated from the global FeeState
 * @repr c
 */
export interface FeeStateCache {
  /** The wallet that receives program-level fees */
  global_fee_wallet: Pubkey;
  /** Fixed fee APR charged to borrowers (program-level) */
  program_fee_fixed: WrappedI80F48;
  /** Proportional fee rate on interest (program-level) */
  program_fee_rate: WrappedI80F48;
  /** Unix timestamp of the last fee state propagation */
  last_update: i64;
}

/**
 * Per-group rate limiting configuration and state. Tracks aggregate net outflow in USD.
 * @repr c
 */
export interface GroupRateLimiter {
  /** Hourly window rate limiter (USD). */
  hourly: RateLimitWindow;
  /** Daily window rate limiter (USD). */
  daily: RateLimitWindow;
}

/**
 * A read-only cache of the internal risk engine's information. Only valid in borrow/withdraw if the tx does not fail. To see the state in any context, e.g. to figure out if the risk engine is failing due to some bad price information, use `pulse_health`.
 * @repr c
 */
export interface HealthCache {
  /** Internal risk engine asset value, using initial weight (e.g. what is used for borrowing purposes), with all confidence adjustments, and other discounts on price. * Uses EMA price * In dollars */
  asset_value: WrappedI80F48;
  /** Internal risk engine liability value, using initial weight (e.g. what is used for borrowing purposes), with all confidence adjustments, and other discounts on price. * Uses EMA price * In dollars */
  liability_value: WrappedI80F48;
  /** Internal risk engine asset value, using maintenance weight (e.g. what is used for liquidation purposes), with all confidence adjustments. * Zero if the risk engine failed to load * Uses SPOT price * In dollars */
  asset_value_maint: WrappedI80F48;
  /** Internal risk engine liability value, using maintenance weight (e.g. what is used for liquidation purposes), with all confidence adjustments. * Zero if the risk engine failed to load * Uses SPOT price * In dollars */
  liability_value_maint: WrappedI80F48;
  /** The "true" value of assets without any confidence or weight adjustments. Internally, used only for bankruptcies. * Zero if the risk engine failed to load * Uses EMA price * In dollars */
  asset_value_equity: WrappedI80F48;
  /** The "true" value of liabilities without any confidence or weight adjustments. Internally, used only for bankruptcies. * Zero if the risk engine failed to load * Uses EMA price * In dollars */
  liability_value_equity: WrappedI80F48;
  /** Unix timestamp from the system clock when this cache was last updated */
  timestamp: i64;
  /** The flags that indicate the state of the health cache. This is a u32 bitfield, where each bit represents a flag.  * HEALTHY = 1 - If set, the account cannot be liquidated. If 0, the account is unhealthy and can be liquidated. * ENGINE STATUS = 2 - If set, the engine did not error during the last health pulse. If 0, the engine would have errored and this cache is likely invalid. `RiskEngineInitRejected` is ignored and will allow the flag to be set anyways. * ORACLE OK = 4 - If set, the engine did not error due to an oracle issue. If 0, engine was passed a bad bank or oracle account, or an oracle was stale. Check the order in which accounts were passed and ensure each balance has the correct banks/oracles, and that oracle cranks ran recently enough. Check `internal_err` and `err_index` for more details in some circumstances. Invalid if generated after borrow/withdraw (these instructions will ignore oracle issues if health is still satisfactory with some balance zeroed out). * EMODE BOOSTED = 8 - If set, an emode or same-asset entry weights every collateral balance above its own bank's maintenance weight. Only written by maintenance passes. * 16, 32, 64, 128, etc - reserved for future use */
  flags: u32;
  /** If the engine errored, look here for the error code. If the engine returns ok, you may also check here to see if the risk engine rejected this tx (3009). */
  mrgn_err: u32;
  /**
   * Each price corresponds to that index of Balances in the LendingAccount. Useful for debugging or liquidator consumption, to determine how a user's position is priced internally. * An f64 stored as bytes
   * @bytes
   */
  prices: FixedArray<u64, 16>;
  /** Errors in asset oracles are ignored (with prices treated as zero). If you see a zero price and the `ORACLE_OK` flag is not set, check here to see what error was ignored internally. */
  internal_err: u32;
  /** Index in `balances` where `internal_err` appeared */
  err_index: u8;
  /** Since 0.1.3, the version will be encoded here. See PROGRAM_VERSION. */
  program_version: u8;
  pad0: FixedArray<u8, 2>;
  /** Error code from the liquidation health check during the last health pulse (0 if none) */
  internal_liq_err: u32;
  /** Error code from the bankruptcy check during the last health pulse (0 if none) */
  internal_bankruptcy_err: u32;
  reserved0: FixedArray<u8, 32>;
  reserved1: FixedArray<u8, 16>;
}

/**
 * On-chain flags for indexer tranching. Each flag is a full byte so off-chain consumers can filter accounts via `memcmp`. Balance-derived flags are synced automatically on every balance-mutating instruction. Pulse-derived flags are updated in `pulse_health`.
 * @repr c
 */
export interface IndexerFlags {
  /** 1 if the account has no liabilities */
  is_lending_only: u8;
  /** 1 if the account has no balances above the dust threshold */
  is_empty: u8;
  /** 1 if the account has exactly one liability position */
  is_single_borrower: u8;
  /** 1 if the account has ever entered receivership (liquidation or deleverage), permanent. */
  has_ever_been_liquidated: u8;
  /** 1 if the account has ever been forcibly deleveraged (permanent, never unset) */
  has_ever_been_deleveraged: u8;
  /** 1 if `handle_bankruptcy` has ever been executed on this account (permanent, never unset) */
  has_been_bankrupted: u8;
  /** 1 if the account has any liability on a bank with `RiskTier::Isolated`. Note: Not authoritative due to a variety of edge cases, such as a Bank being configured from Collateral -> Isolated after the user deposits. Set at borrow time and refreshed best-effort by pulse from live bank state. Cleared by balance-derived sync only when liability count reaches zero. */
  has_isolated: u8;
  /** 1 if the account has a STAKED asset tag position */
  has_staked: u8;
  /** 1 if the account has a KAMINO asset tag position */
  has_kamino: u8;
  /** 1 if the account has a DRIFT asset tag position */
  has_drift: u8;
  /** 1 if the account has a JUPLEND asset tag position */
  has_juplend: u8;
  /** 1 if maintenance health was negative at last pulse */
  was_liquidatable: u8;
  /** 1 if equity health was negative at last pulse */
  was_underwater: u8;
  /** 1 if account was active within the last 30 days. Raised to 1 on every balance-mutating instruction; can only transition 1 → 0 at pulse time, when the elapsed-since-`last_update` check fails. Combined with `is_empty`, indicates an account pending closure. */
  was_active_30d: u8;
  /** 1 if account was active within the last 60 days. Raised to 1 on every balance-mutating instruction; can only transition 1 → 0 at pulse time, when the elapsed-since-`last_update` check fails. Combined with `is_empty`, indicates an account eligible for permissionless close. */
  was_active_60d: u8;
  /** 1 if net equity value was greater than $0 and less than $1 at last pulse */
  has_trivial_balance: u8;
  /** @idlName _pad */
  pad: FixedArray<u8, 8>;
}

/**
 * InterestRateConfig
 * @repr c
 */
export interface InterestRateConfig {
  /** DEPRECATED placeholder field. Formerly used for legacy curve math. */
  placeholder0: WrappedI80F48;
  /** DEPRECATED placeholder field. Formerly used for legacy curve math. */
  placeholder1: WrappedI80F48;
  /** DEPRECATED placeholder field. Formerly used for legacy curve math. */
  placeholder2: WrappedI80F48;
  /** Goes to insurance, funds `collected_insurance_fees_outstanding` */
  insurance_fee_fixed_apr: WrappedI80F48;
  /** Goes to insurance, funds `collected_insurance_fees_outstanding` */
  insurance_ir_fee: WrappedI80F48;
  /** Earned by the group, goes to `collected_group_fees_outstanding` */
  protocol_fixed_fee_apr: WrappedI80F48;
  /** Earned by the group, goes to `collected_group_fees_outstanding` */
  protocol_ir_fee: WrappedI80F48;
  protocol_origination_fee: WrappedI80F48;
  /** The base rate at utilization = 0 * a %, as u32, out of 1000%, e.g. 100% = 0.1 * u32::MAX */
  zero_util_rate: u32;
  /** The base rate at utilization = 100 * a %, as u32, out of 1000%, e.g. 100% = 0.1 * u32::MAX */
  hundred_util_rate: u32;
  /** The base rate at various points between 0 and 100%, exclusive. Essentially a piece-wise linear curve. * always in ascending order, e.g. points[0] = first kink point, points[1] = second kink point, and so forth. * points where util = 0 are unused */
  points: FixedArray<RatePoint, 5>;
  /** Determines which interest rate curve implementation is active. - 0 (`INTEREST_CURVE_LEGACY`) is deprecated and unsupported. - 1 (`INTEREST_CURVE_SEVEN_POINT`) is the active multi-point curve. */
  curve_type: u8;
  /** @idlName _pad0 */
  pad0: FixedArray<u8, 7>;
  /** @idlName _padding1 */
  padding1: FixedArray<u8, 32>;
  /** @idlName _padding2 */
  padding2: FixedArray<u8, 16>;
  /** @idlName _padding3 */
  padding3: FixedArray<u8, 8>;
}

/**
 * The lending account holds up to 16 balance positions for a user.
 * @repr c
 */
export interface LendingAccount {
  /** Array of balance positions (max 16). Sorted in descending order by bank_pk. */
  balances: FixedArray<Balance, 16>;
  /** Last allocated balance tag (u16), used to find the next unused tag. */
  last_tag_used: u16;
  /**
   * Reserved for future use
   * @idlName _pad1
   */
  pad1: FixedArray<u8, 6>;
  /**
   * Reserved for future use
   * @idlName _padding
   */
  padding: FixedArray<u64, 7>;
}

/**
 * LiquidationCache
 * @serialization bytemuck
 * @repr c
 */
export interface LiquidationCache {
  /** Internal risk engine asset value snapshot taken when liquidation begins, using maintenance weight with all confidence adjustments. * Uses SPOT price * In dollars */
  asset_value_maint: WrappedI80F48;
  /** Internal risk engine liability value snapshot taken when liquidation begins, using maintenance weight with all confidence adjustments. * Uses SPOT price * In dollars */
  liability_value_maint: WrappedI80F48;
  /** Actual cash value of assets pre-liquidation (inclusive of price adjustment for oracle confidence, but without any weights) * Liquidator is allowed to seize up to `liability_value_equity` - this amount * Uses EMA price * In dollars */
  asset_value_equity: WrappedI80F48;
  /** Actual cash value of liabilities pre-liquidation (inclusive of price adjustment for oracle confidence, but without any weights) * Liquidator is allowed to seize up to this amount - `asset_value_equity` * Uses EMA price * In dollars */
  liability_value_equity: WrappedI80F48;
  /** @idlName _placeholder */
  placeholder: u64;
  /** @idlName _reserved0 */
  reserved0: FixedArray<u8, 32>;
}

/**
 * Used to record key details of the last few liquidation events on the account
 * @serialization bytemuck
 * @repr c
 */
export interface LiquidationEntry {
  /** Dollar amount seized * An f64 stored as bytes */
  asset_amount_seized: FixedArray<u8, 8>;
  /** Dollar amount repaid * An f64 stored as bytes */
  liab_amount_repaid: FixedArray<u8, 8>;
  placeholder0: u64;
  timestamp: i64;
  /** @idlName _reserved0 */
  reserved0: FixedArray<u8, 16>;
}

/**
 * LiquidationRecord
 * @serialization bytemuck
 * @repr c
 */
export interface LiquidationRecord {
  /** This account's own key. A PDA derived from `marginfi_account` */
  key_: Pubkey;
  /** Account this record tracks */
  marginfi_account: Pubkey;
  /** The key that paid to create this account. At some point, we may allow this wallet to reclaim the rent paid to open a record. */
  record_payer: Pubkey;
  /** The liquidator taking receivership of the `marginfi_account` to complete a liquidation. Pays the liquidation fee. * Always pubkey default unless actively within a liquidation event. */
  liquidation_receiver: Pubkey;
  /** Basic historical data for the last few liquidation events on this account */
  entries: FixedArray<LiquidationEntry, 4>;
  cache: LiquidationCache;
  /** @idlName _reserved0 */
  reserved0: FixedArray<u8, 64>;
  /** @idlName _reserved2 */
  reserved2: FixedArray<u8, 16>;
  /** @idlName _reserved3 */
  reserved3: FixedArray<u8, 8>;
}

/**
 * MarginfiAccount
 * @serialization bytemuck
 * @repr c
 */
export interface MarginfiAccount {
  group: Pubkey;
  authority: Pubkey;
  lending_account: LendingAccount;
  /** The flags that indicate the state of the account. This is u64 bitfield, where each bit represents a flag.  Flags:MarginfiAccount - 1: `ACCOUNT_DISABLED` - Indicates that the account is disabled and no further actions can be taken on it. - 2: `ACCOUNT_IN_FLASHLOAN` - Only set when an account is within a flash loan, e.g. when start_flashloan is called, then unset when the flashloan ends. - 4: `ACCOUNT_FLAG_DEPRECATED` - Deprecated, available for future use - 8: `ACCOUNT_TRANSFER_AUTHORITY_DEPRECATED` - the admin has flagged with account to be moved, original owner can now call `set_account_transfer_authority` - 16: `ACCOUNT_IN_RECEIVERSHIP` - the account is eligible to be liquidated and has entered receivership, a liquidator is able to control borrows and withdraws until the end of the tx. This flag will only appear within a tx. - 32: `ACCOUNT_IN_DELEVERAGE - the account is being deleveraged by the risk admin - 64: `ACCOUNT_FROZEN` - the admin has frozen the account; only the group admin may perform actions until unfrozen. */
  account_flags: u64;
  /** Wallet whose canonical ATA receives off-chain emissions distributions. */
  emissions_destination_account: Pubkey;
  health_cache: HealthCache;
  /** If this account was migrated from another one, store the original account key */
  migrated_from: Pubkey;
  /** If this account has been migrated to another one, store the destination account key */
  migrated_to: Pubkey;
  /** Unix timestamp (u64) of the last account interaction. Note: Bank.last_update uses i64. */
  last_update: u64;
  /** If a PDA-based account, the account index, a seed used to derive the PDA that can be chosen arbitrarily (0.1.5 or later). Otherwise, does nothing. */
  account_index: u16;
  /** If a PDA-based account (0.1.5 or later), a "vendor specific" id. Values < PDA_FREE_THRESHOLD can be used by anyone with no restrictions. Values >= PDA_FREE_THRESHOLD can only be used by a particular program via CPI. These values require being added to a list, contact us for more details. For legacy non-pda accounts, does nothing.  Note: use a unique seed to tag accounts related to some particular program or campaign so you can easily fetch them all later. */
  third_party_index: u16;
  /** This account's bump, if a PDA-based account (0.1.5 or later). Otherwise, does nothing. */
  bump: u8;
  /** Count of how many Orders this account has active. One is added when an Order is opened, and subtracted when an Order is executed or cancelled. * Accounts cannot open more than u8::MAX orders. Sorry power users: hopefully 256 stop losses is enough for you. */
  active_orders: u8;
  /** @idlName _pad0 */
  pad0: FixedArray<u8, 2>;
  /** Stores information related to liquidations made against this account. A pda of this account's key, and "liq_record" * Typically pubkey default if this account has never been liquidated or close to liquidation * Opening this account is permissionless. Typically the liquidator pays, but e.g. we may also charge the user if they are opening a risky position on the front end. */
  liquidation_record: Pubkey;
  indexer_flags: IndexerFlags;
  /** Monotonic counter. seeding each rebalance execution's `RebalanceRecord`. */
  rebalance_execution_seq: u64;
  /** Unix timestamp when this account was tagged as unhealthy, growing the allowed liquidation premium over time. Cleared once an instruction proves the account healthy again (deposit and repay do not), restarted when a liquidation erases a material share of the health deficit or repays a material share of the debt. * 0 if not tagged */
  liquidation_tagged_at: i64;
  /** @idlName _padding0 */
  padding0: FixedArray<u64, 2>;
}

/**
 * MarginfiGroup
 * @serialization bytemuck
 * @repr c
 */
export interface MarginfiGroup {
  /** Broadly able to modify anything, and can set/remove other admins at will.  Subsequent to the release of the `governance_admin`, this role can be considered the "fast" admin, it can perform various tasks that do not require timelock sensitivity. High-risk activities like changing oracles or bank weights are now under the control of the "slow" governance admin. */
  admin: Pubkey;
  /** Bitmask for group settings flags. * Bit 0 (1): `PROGRAM_FEES_ENABLED` — If set, program-level fees are enabled. * Bits 1-63: Reserved for future use. */
  group_flags: u64;
  /** Caches information from the global `FeeState` so the FeeState can be omitted on certain ixes */
  fee_state_cache: FeeStateCache;
  /** For groups initialized in versions 0.1.2 or greater, this is an authoritative count of the number of banks under this group. For groups initialized prior to 0.1.2, a non-authoritative count of the number of banks initiated after 0.1.2 went live. */
  banks: u16;
  pad0: FixedArray<u8, 6>;
  /** This admin can configure collateral ratios above (but not below) the collateral ratio of certain banks, e.g. allow SOL to count as 90% collateral when borrowing an LST instead of the default rate. */
  emode_admin: Pubkey;
  /** Can modify the fields in `config.interest_rate_config` but nothing else, for every bank under this group */
  delegate_curve_admin: Pubkey;
  /** Can modify the `deposit_limit`, `borrow_limit`, `total_asset_value_init_limit` but nothing else, for every bank under this group */
  delegate_limit_admin: Pubkey;
  /** DEPRECATED: currently has no on-chain authority. Preserved in account layout for backward compatibility and historical metadata only. */
  delegate_emissions_admin: Pubkey;
  /** When program keeper temporarily puts the program into panic mode, information about the duration of the lockup will be available here. */
  panic_state_cache: PanicStateCache;
  /** Keeps track of the liquidity withdrawn from the group over the day as a result of deleverages. Used as a protection mechanism against too big (and unwanted) withdrawals (e.g. when the risk admin is compromised). */
  deleverage_withdraw_window_cache: WithdrawWindowCache;
  /** Can run bankruptcy and forced deleverage ixes to e.g. sunset risky/illiquid assets */
  risk_admin: Pubkey;
  /** Can modify a Bank's metadata, and nothing else. */
  metadata_admin: Pubkey;
  /** Maximum leverage allowed for emode positions (initial margin), stored as u32 basis. Use `u32_to_basis` to convert to I80F48. Range: 1-100; 0 is unset and bounds nothing. */
  emode_max_init_leverage: u32;
  /** Maximum leverage allowed for emode positions (maintenance margin), stored as u32 basis. Must be > emode_max_init_leverage. Range: 1-100; 0 is unset and bounds nothing. */
  emode_max_maint_leverage: u32;
  /** Encoded same-asset automatic emode leverage for initial margin. Decode with `u32_to_basis`. Same-asset treatment is disabled when the decoded leverage is less than or equal to 1 and also requires each participating bank to opt in. */
  same_asset_emode_init_leverage: u32;
  /** Encoded same-asset automatic emode leverage for maintenance margin. Decode with `u32_to_basis`. Ordering is validated in decoded space. Eligible banks have their liquidation fees checked against this value only when they opt in while it is enabled or when they change fees. Enabling or raising it does not re-check them, so verify every eligible bank off-chain first. */
  same_asset_emode_maint_leverage: u32;
  /** Rate limiter for controlling aggregate withdraw/borrow outflow across all banks. Tracks net outflow in USD. */
  rate_limiter: GroupRateLimiter;
  /** Last slot covered by an admin group rate limiter aggregation update. */
  rate_limiter_last_admin_update_slot: u64;
  /** Monotonic sequence number for admin group rate limiter updates. This is used to enforce strict ordering and prevent duplicate/replayed batches when slot ranges overlap or multiple updates happen in the same slot. */
  rate_limiter_last_admin_update_seq: u64;
  /** Last slot covered by an admin deleverage withdraw-limit aggregation update. */
  deleverage_withdraw_last_admin_update_slot: u64;
  /** Monotonic sequence number for admin deleverage withdraw-limit updates. */
  deleverage_withdraw_last_admin_update_seq: u64;
  /** Can modify flow-control status for the group, i.e. update the withdraw caches with flow information from banks. Typically this is a hot wallet that lives in e.g. some cron job. If compromised, flow control can be effectively disabled until the admin is restored, which does not itself compromise any funds, and is merely annoying. */
  delegate_flow_admin: Pubkey;
  /** Header for the pairwise variable-borrow premium matrix stored in `premium_entries`. Occupies the former `_padding_0`/`_padding_1` region of the v1 layout, so v1 accounts resize to a zeroed header (matrix off). */
  premium_settings: PremiumSettings;
  /** Pairwise variable-borrow premium rates, keyed by (collateral `premium_tag`, liability `premium_tag`). Live entries occupy the first `premium_settings.entry_count` slots. Read only via `find_premium_rate`. Future capacity growth carves from `_padding_2`. */
  premium_entries: FixedArray<PremiumEntry, 64>;
  /** Also called the "slow" admin. Dedicated authority for time-locked configuration. Legacy groups have this field zeroed after resize and must be bootstrapped by the fast admin with `marginfi_group_set_governance_admin` before slow-authority operations are available.  This is the first 32 bytes of post-v1 reserved space; renaming the field does not alter any serialized account bytes. */
  governance_admin: Pubkey;
  /** @idlName _padding_2 */
  padding_2: FixedArray<FixedArray<u64, 32>, 31>;
  /** @idlName _padding_3 */
  padding_3: FixedArray<u64, 28>;
}

/**
 * @repr rust
 */
export enum OracleSetup {
  None,
  PythLegacy,
  SwitchboardV2,
  PythPushOracle,
  SwitchboardPull,
  StakedWithPythPush,
  KaminoPythPush,
  KaminoSwitchboardPull,
  Fixed,
  DriftPythPull,
  DriftSwitchboardPull,
  SolendPythPull,
  SolendSwitchboardPull,
  FixedKamino,
  FixedDrift,
  JuplendPythPull,
  JuplendSwitchboardPull,
  FixedJuplend,
  Scope,
  PythMSOL,
  KaminoMSOL,
  JuplendMSOL,
  PythLST,
  KaminoLST,
  JuplendLST,
  PTPyth,
  PTFixed,
  ScopeKamino,
  ScopeJuplend,
}

/**
 * Order
 * @serialization bytemuck
 * @repr c
 */
export interface Order {
  marginfi_account: Pubkey;
  stop_loss: WrappedI80F48;
  take_profit: WrappedI80F48;
  /** Unix timestamp (seconds) when the order was created. Reads 0 for orders created before this field existed (it was previously a reserved placeholder; same 8 bytes, so layout-compatible). */
  created_at: i64;
  /** * a %, as u32, out of 100%, e.g. 50% = .5 * u32::MAX */
  max_slippage: u32;
  pad0: FixedArray<u8, 4>;
  /** Active tags (currently 2). Remaining capacity is stored in padding for layout compatibility. Padding byte `ORDER_TAG_PADDING - 1` stores the tag count for forward compatibility. (u16 * 2 = 4 bytes) */
  tags: FixedArray<u16, 2>;
  pad1: FixedArray<u8, 4>;
  /** @idlName _tags_padding */
  tags_padding: FixedArray<u8, 32>;
  /** Stop Loss (0), Take Profit (1), or Both (2) */
  trigger: OrderTriggerType;
  /** Bump to derive this pda */
  bump: u8;
  pad2: FixedArray<u8, 6>;
  /** @idlName _reserved1 */
  reserved1: FixedArray<FixedArray<u8, 32>, 4>;
}

/**
 * @repr rust
 */
export enum OrderTriggerType {
  StopLoss,
  TakeProfit,
  Both,
}

/**
 * Panic state for emergency protocol pausing
 * @repr c
 */
export interface PanicState {
  /** Whether the protocol is currently paused (1 = paused, 0 = not paused) */
  pause_flags: u8;
  /** Number of times paused today (resets every 24 hours) */
  daily_pause_count: u8;
  /** Number of consecutive pauses (resets when unpause happens) */
  consecutive_pause_count: u8;
  /** @idlName _reserved */
  reserved: FixedArray<u8, 5>;
  /** Timestamp when the current pause started (0 if not paused) * When a pause is extended before expiring, this could be in the future. */
  pause_start_timestamp: i64;
  /** Timestamp of the last daily reset (for tracking daily pause count) */
  last_daily_reset_timestamp: i64;
  /**
   * Reserved for future use (making total struct 32 bytes)
   * @idlName _reserved_space
   */
  reserved_space: FixedArray<u8, 8>;
}

/**
 * Cached panic state information for fast checking during user operations
 * @repr c
 */
export interface PanicStateCache {
  /** Whether the protocol is currently paused (1 = paused, 0 = not paused) */
  pause_flags: u8;
  /** @idlName _reserved */
  reserved: FixedArray<u8, 7>;
  /** Timestamp when the current pause started (0 if not paused) */
  pause_start_timestamp: i64;
  /** Timestamp when this cache was last updated */
  last_cache_update: i64;
}

/**
 * One pairwise variable-borrow premium rate: accounts lending collateral tagged `collateral_tag` pay an extra `rate` APR (proportional to that collateral's share of their total collateral) when borrowing from banks tagged `liability_tag`.
 * @repr c
 */
export interface PremiumEntry {
  /** `premium_tag` of the collateral bank(s) this surcharge applies to. 0 = empty slot. */
  collateral_tag: u16;
  /** `premium_tag` of the liability bank(s) this surcharge applies to. 0 = empty slot. */
  liability_tag: u16;
  /** Premium APR for this pair, encoded like interest-curve points via `milli_to_u32` (0-1000%). */
  rate: u32;
}

/**
 * Header for the group's pairwise variable-borrow premium matrix. * `entry_count > 0` is the single source of truth for whether the matrix is configured.
 * @repr c
 */
export interface PremiumSettings {
  /** Unix timestamp from the system clock when the premium matrix was last updated. */
  timestamp: i64;
  /** Number of live entries at the start of `premium_entries`. 0 = matrix off. */
  entry_count: u16;
  /** Storage capacity for entries. `MAX_PREMIUM_ENTRIES` for groups at the current account size; a future group-account resize may raise this. */
  entry_capacity: u16;
  /** @idlName _pad0 */
  pad0: FixedArray<u8, 4>;
  /**
   * Reserved for future use
   * @idlName _reserved0
   */
  reserved0: FixedArray<u64, 2>;
}

/**
 * A sliding window rate limiter that tracks net outflow over a time window. Uses weighted blend of previous and current windows for smooth transitions.  Net outflow = (withdraws + borrows) - (deposits + repays). A negative net outflow increases remaining capacity for subsequent outflows.
 * @repr c
 */
export interface RateLimitWindow {
  /** Maximum net outflow allowed per window (0 = disabled). For bank-level: denominated in native tokens. For group-level: denominated in USD. */
  max_outflow: u64;
  /** Window duration in seconds (e.g., 3600 for hourly, 86400 for daily). */
  window_duration: u64;
  /** Unix timestamp when the current window started. */
  window_start: i64;
  /** Net outflow accumulated in the previous window. Signed to allow tracking when inflows exceed outflows. */
  prev_window_outflow: i64;
  /** Net outflow accumulated in the current window. Signed to allow tracking when inflows exceed outflows. */
  cur_window_outflow: i64;
}

/**
 * RatePoint
 * @repr c
 */
export interface RatePoint {
  /** The utilization rate where `rate` applies * a %, as u32, out of 100%, e.g. 50% = .5 * u32::MAX */
  util: u32;
  /** The base rate that applies * a %, as u32, out of 1000%, e.g. 100% = 0.1 * u32::MAX */
  rate: u32;
}

/**
 * RebalanceMove
 * @repr c
 */
export interface RebalanceMove {
  src_index: u8;
  dst_index: u8;
  /** @idlName _pad0 */
  pad0: FixedArray<u8, 6>;
  amount: WrappedI80F48;
}

/**
 * RebalanceOrder
 * @serialization bytemuck
 * @repr c
 */
export interface RebalanceOrder {
  /** The marginfi account this order belongs to. */
  marginfi_account: Pubkey;
  /** The account authority (may cancel the order). */
  authority: Pubkey;
  /** The single SPL mint this order rotates across venues; every referenced bank must hold this mint. */
  mint: Pubkey;
  /** Venue allowlist: the first `allowed_bank_count` entries are the banks this order may rotate across; the rest are zero. Stored in full (not a hash) so a keeper discovers the set from a single account read and `start_rebalance` validates that every referenced bank ∈ list against on-chain state. */
  allowed_banks: FixedArray<Pubkey, 8>;
  /** Minimum required APR improvement (dst - src) to move, I80F48 (1.0 = 100%). */
  min_improvement: WrappedI80F48;
  /** Minimum wall-clock seconds between executions (anti-ping-pong cooldown). */
  cooldown_seconds: u64;
  /** Per-execution token budget: each execution may relocate at most this many underlying tokens (raw native units of the shared mint) summed across all referenced banks. `0` means no cap. */
  amount: u64;
  /** Unix timestamp (seconds) of the last successful rebalance. */
  last_exec_timestamp: u64;
  /** PDA bump. */
  bump: u8;
  /** Number of populated entries in `allowed_banks` (2..=MAX_ALLOWED_BANKS). */
  allowed_bank_count: u8;
  /** @idlName _pad0 */
  pad0: FixedArray<u8, 6>;
  /** Lamport tip a keeper earns for relocating the order's full target, paid proportionally to the tokens actually moved and drawn from the account's rebalance fee pool. 0 = no tip. */
  keeper_tip: u64;
}

/**
 * RebalanceRecord
 * @serialization bytemuck
 * @repr c
 */
export interface RebalanceRecord {
  order: Pubkey;
  /** The account the record belongs to; `settle_rebalance_tip` pays from and refunds to this account's fee pool. */
  marginfi_account: Pubkey;
  executor: Pubkey;
  /** The distinct banks this execution touches (first `ref_bank_count` entries), with start amounts and order tags. */
  ref_banks: FixedArray<RebalanceRefBank, 8>;
  /** The declared token moves (first `move_count` entries), referencing `ref_banks` by index. */
  moves: FixedArray<RebalanceMove, 8>;
  /** Snapshot of every active balance NOT in the referenced set; end verifies these unchanged. */
  balance_states: FixedArray<ExecuteOrderBalanceRecord, 15>;
  /** Per-referenced-bank supply rate captured at `start_rebalance`, before the move. `end_rebalance` requires each move's post-deposit destination rate to still beat its source's rate from here. */
  pre_rate: FixedArray<WrappedI80F48, 8>;
  /** Per-referenced-bank yield index (`asset_share_value` × venue multiplier) captured at `end_rebalance`. `settle_rebalance_tip` compares current indices against these to require the destinations actually out-yielded the sources over the settlement window. */
  move_yield_index: FixedArray<WrappedI80F48, 8>;
  /** Unix seconds when the move completed (`end_rebalance`); the settlement window opens `move_timestamp + settle_delay`. */
  move_timestamp: u64;
  /** Keeper tip escrowed into this record at `end_rebalance`, paid to `executor` on a realized settlement or refunded to the fee pool otherwise (lamports). */
  pending_tip: u64;
  /** Settlement delay in seconds, captured at `end_rebalance` from the order's cooldown at move time (clamped to [SETTLE_DELAY_MIN, SETTLE_DELAY_MAX]); */
  settle_delay: u64;
  ref_bank_count: u8;
  move_count: u8;
  active_balance_count: u8;
  /** @idlName _pad0 */
  pad0: FixedArray<u8, 5>;
}

/**
 * RebalanceRefBank
 * @repr c
 */
export interface RebalanceRefBank {
  bank: Pubkey;
  pre_underlying: WrappedI80F48;
  tag: u16;
  /** @idlName _pad0 */
  pad0: FixedArray<u8, 6>;
}

/**
 * @repr rust
 */
export enum RiskTier {
  Collateral,
  Isolated,
}

/**
 * SameAssetEmodeBank
 * @serialization bytemuck
 * @repr c
 */
export interface SameAssetEmodeBank {
  bank: Pubkey;
  /** Index into `SameAssetEmodeRegistry.groups`. */
  group_index: u8;
  /** @idlName _padding */
  padding: FixedArray<u8, 7>;
}

/**
 * SameAssetEmodeGroup
 * @serialization bytemuck
 * @repr c
 */
export interface SameAssetEmodeGroup {
  mint: Pubkey;
  /** The canonical price source, matching `Bank.config.oracle_keys[0]`. */
  oracle_key: Pubkey;
}

/**
 * Read-only archive of same-asset-emode banks. Enables the emode admin to see, at a glance, which banks are participating in same-asset-emode.
 * @serialization bytemuck
 * @repr c
 */
export interface SameAssetEmodeRegistry {
  /** @idlName _padding_0 */
  padding_0: u64;
  /** This registry's own key. */
  key_: Pubkey;
  /** Group for which this registry applies. */
  group: Pubkey;
  bank_count: u16;
  group_count: u8;
  bump: u8;
  /** @idlName _padding_1 */
  padding_1: FixedArray<u8, 4>;
  /** Describes the same-asset-emode groupings that exist */
  groups: FixedArray<SameAssetEmodeGroup, 32>;
  /** Describes which bank belongs to which group */
  banks: FixedArray<SameAssetEmodeBank, 128>;
  /** @idlName _padding_2 */
  padding_2: FixedArray<u8, 1024>;
  /** @idlName _padding_3 */
  padding_3: FixedArray<u8, 512>;
  /** @idlName _padding_4 */
  padding_4: FixedArray<u8, 256>;
}

/**
 * Unique per-group. Staked Collateral banks created under a group automatically use these settings. Groups that have not created this struct cannot create staked collateral banks. When this struct updates, changes must be permissionlessly propagated to staked collateral banks. Administrators can also edit the bank manually, i.e. with configure_bank, to temporarily make changes such as raising the deposit limit for a single bank.
 * @serialization bytemuck
 * @repr c
 */
export interface StakedSettings {
  /** This account's own key. A PDA derived from `marginfi_group` and `STAKED_SETTINGS_SEED` */
  key_: Pubkey;
  /** Group for which these settings apply */
  marginfi_group: Pubkey;
  /** Generally, the Pyth push oracle for SOL */
  oracle: Pubkey;
  asset_weight_init: WrappedI80F48;
  asset_weight_maint: WrappedI80F48;
  deposit_limit: u64;
  total_asset_value_init_limit: u64;
  oracle_max_age: u16;
  risk_tier: RiskTier;
  /** @idlName _pad0 */
  pad0: FixedArray<u8, 5>;
  /** Desired bitmask for staked-bank transition flags. These bits are copied to `Bank.flags` when staked settings are propagated or when a new staked bank is created. * Bit 9 (512): `STAKED_ORACLE_DISABLED` — staked oracle pricing is temporarily disabled. * Bit 10 (1024): `STAKED_ORACLE_PRICE_USES_ONRAMP` — staked oracle pricing includes the SPL single-pool on-ramp account in NAV. */
  flags: u64;
  /**
   * The following values are irrelevant because staked collateral positions do not support borrowing.
   * @idlName _reserved1
   */
  reserved1: FixedArray<u8, 32>;
  /** @idlName _reserved2 */
  reserved2: FixedArray<u8, 64>;
}

/**
 * Tracks deleverage withdrawal limits to protect against compromised risk admin
 * @repr c
 */
export interface WithdrawWindowCache {
  /** Maximum USD value that can be withdrawn per day via deleverage (0 = no limit) */
  daily_limit: u32;
  /** USD value withdrawn today via deleverage (approximate, rounded) */
  withdrawn_today: u32;
  /** Unix timestamp of the last daily counter reset */
  last_daily_reset_timestamp: i64;
}

/**
 * An I80F48 (showcase/mainnet/marginfi/i80f48.ts): its bits, which the IDL shows as the 16 bytes they are stored as.
 * @serialization bytemuck
 * @repr c align 8
 */
export interface WrappedI80F48 {
  /** @bytes */
  value: i128;
}
