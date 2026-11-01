// Marginfi's bank (programs/marginfi/src/state/bank.rs, bank_config.rs and bank_cache.rs @ c5d440f6): creating one
// from its compact config, checking a config, the interest accrual and the rate cache. Amounts and share values are
// I80F48 (showcase/mainnet/marginfi/i80f48.ts).
import {
  type Account,
  type Mut,
  type Pubkey,
  type i128,
  type i64,
  type u16,
  type u32,
  type u64,
  type u8,
  emit,
  f64FromBits,
  require,
  i128 as toI128,
  i64 as toI64,
  u32 as toU32,
  u64 as toU64,
  u8 as toU8,
} from "typesol";
import { type BankConfigCompact, type BankConfigFast } from "./args";
import { MarginfiError } from "./errors";
import {
  type CircuitBreakerAutoBrokenEvent,
  type CircuitBreakerClearedEvent,
  type CircuitBreakerTrippedEvent,
  type InterestRateConfigOpt,
  type LendingPoolBankAccrueInterestEvent,
  type RateLimitFlowEvent,
} from "./events";
import {
  I80F48_MAX,
  I80F48_ONE,
  I80F48_ZERO,
  fxAdd,
  fxDiv,
  fxMul,
  fxFromU64,
  fxSub,
  fxToF64Bits,
  fxToU64,
  exp10Fx,
  fxToI64Wrapping,
  fxToU64Wrapping,
  fxWrappingDiv,
  fxWrappingMul,
} from "./i80f48";
import { accrualChanges, calcInterestRate, milliToU32, u32ToBasis, u32ToCenti, validateInterestRateConfig } from "./interest_rate";
import { type Bank, type BankConfig, type MarginfiGroup, type RateLimitWindow, BankOperationalState, OracleSetup, RiskTier } from "./state";

/** Bank.flags */
export const CLOSE_ENABLED_FLAG: u64 = 16n;
export const IS_T22: u64 = 128n;
export const BANK_SEED_KNOWN: u64 = 256n;
const ORACLE_MIN_AGE: u16 = 10n;
export const LIQ_CACHE_LOCKED_FLAG: u8 = 1n;
const U32_MAX: u64 = 4294967295n;

export function assetAmount(bank: Mut<Bank>, shares: i128): i128 {
  return fxMul(shares, bank.asset_share_value.value);
}
export function liabilityAmount(bank: Mut<Bank>, shares: i128): i128 {
  return fxMul(shares, bank.liability_share_value.value);
}

/** BankConfig from BankConfigCompact: no oracle yet, the circuit breaker off, the seven-point curve. */
function setConfig(bank: Mut<Bank>, c: BankConfigCompact): void {
  const config = bank.config;
  config.asset_weight_init = c.asset_weight_init;
  config.asset_weight_maint = c.asset_weight_maint;
  config.liability_weight_init = c.liability_weight_init;
  config.liability_weight_maint = c.liability_weight_maint;
  config.deposit_limit = c.deposit_limit;
  const ir = config.interest_rate_config;
  const from = c.interest_rate_config;
  ir.insurance_fee_fixed_apr = from.insurance_fee_fixed_apr;
  ir.insurance_ir_fee = from.insurance_ir_fee;
  ir.protocol_fixed_fee_apr = from.protocol_fixed_fee_apr;
  ir.protocol_ir_fee = from.protocol_ir_fee;
  ir.protocol_origination_fee = from.protocol_origination_fee;
  ir.zero_util_rate = from.zero_util_rate;
  ir.hundred_util_rate = from.hundred_util_rate;
  for (let i = 0n; i < 5n; i++) ir.points.set(i, from.points.get(i));
  ir.curve_type = 1n;
  config.operational_state = c.operational_state;
  config.oracle_setup = OracleSetup.None;
  config.borrow_limit = c.borrow_limit;
  config.risk_tier = c.risk_tier;
  config.asset_tag = c.asset_tag;
  config.config_flags = c.config_flags;
  config.total_asset_value_init_limit = c.total_asset_value_init_limit;
  config.oracle_max_age = c.oracle_max_age;
  config.oracle_max_confidence = c.oracle_max_confidence;
}

/** Bank::init on a new (zeroed) bank. */
export function initBank(
  bank: Mut<Bank>,
  group: Pubkey,
  config: BankConfigCompact,
  mint: Pubkey,
  mintDecimals: u8,
  liquidityVault: Pubkey,
  insuranceVault: Pubkey,
  feeVault: Pubkey,
  timestamp: i64,
  liquidityVaultBump: u8,
  liquidityVaultAuthorityBump: u8,
  insuranceVaultBump: u8,
  insuranceVaultAuthorityBump: u8,
  feeVaultBump: u8,
  feeVaultAuthorityBump: u8,
  bankSeed: u64,
): void {
  bank.mint = mint;
  bank.mint_decimals = mintDecimals;
  bank.group = group;
  bank.asset_share_value.value = I80F48_ONE;
  bank.liability_share_value.value = I80F48_ONE;
  bank.liquidity_vault = liquidityVault;
  bank.liquidity_vault_bump = liquidityVaultBump;
  bank.liquidity_vault_authority_bump = liquidityVaultAuthorityBump;
  bank.insurance_vault = insuranceVault;
  bank.insurance_vault_bump = insuranceVaultBump;
  bank.insurance_vault_authority_bump = insuranceVaultAuthorityBump;
  bank.fee_vault = feeVault;
  bank.fee_vault_bump = feeVaultBump;
  bank.fee_vault_authority_bump = feeVaultAuthorityBump;
  bank.last_update = timestamp;
  setConfig(bank, config);
  bank.flags = CLOSE_ENABLED_FLAG;
  bank.bank_seed = bankSeed;
  bank.liquidation_liquidator_fee = 0n;
  bank.liquidation_insurance_fee = 0n;
}

/** BankConfig::validate: the weights, the interest curve, isolated banks' zero asset weights, the oracle age. */
export function validateBankConfig(config: BankConfig): void {
  const assetInit = config.asset_weight_init.value;
  const assetMaint = config.asset_weight_maint.value;
  require(assetInit >= I80F48_ZERO && assetInit <= I80F48_ONE, MarginfiError.InvalidConfig);
  require(assetMaint <= I80F48_ONE, MarginfiError.InvalidConfig);
  require(assetMaint >= assetInit, MarginfiError.InvalidConfig);
  const liabInit = config.liability_weight_init.value;
  const liabMaint = config.liability_weight_maint.value;
  require(liabInit >= I80F48_ONE, MarginfiError.InvalidConfig);
  require(liabMaint <= liabInit && liabMaint >= I80F48_ONE, MarginfiError.InvalidConfig);
  validateInterestRateConfig(config.interest_rate_config);
  if (config.risk_tier === RiskTier.Isolated) {
    require(assetInit === I80F48_ZERO, MarginfiError.InvalidConfig);
    require(assetMaint === I80F48_ZERO, MarginfiError.InvalidConfig);
  }
  require(config.oracle_max_age >= ORACLE_MIN_AGE, MarginfiError.InvalidOracleSetup);
}

/** The seconds of [from, to] the circuit breaker's recorded halt covers (none unless a halt has ended). */
function cbFrozenSeconds(bank: Mut<Bank>, from: i64, to: i64): u64 {
  if (bank.cb_halt_ended_at === 0n) return 0n;
  const start = bank.cb_halt_started_at > from ? bank.cb_halt_started_at : from;
  const end = bank.cb_halt_ended_at < to ? bank.cb_halt_ended_at : to;
  return end > start ? toU64(end - start) : 0n;
}

/**
 * Bank::accrue_interest: the share values grow by the lending and borrowing rates over the seconds since the last
 * update (less any circuit-breaker halt), and the group, insurance and program fees on the liabilities are owed.
 */
export function accrueInterest(bank: Mut<Bank>, group: Account<MarginfiGroup>, bankKey: Pubkey, timestamp: i64): void {
  // A clock behind the last update panics in the original (`try_into().unwrap()`).
  require(timestamp >= bank.last_update, MarginfiError.MathError);
  let delta = toU64(timestamp - bank.last_update);
  if (delta === 0n) return;
  const pending = bank.cb_frozen_seconds_pending;
  const halted = cbFrozenSeconds(bank, bank.last_update, timestamp);
  const frozen = pending > 18446744073709551615n - halted ? 18446744073709551615n : pending + halted;
  delta = delta > frozen ? delta - frozen : 0n;
  bank.cb_frozen_seconds_pending = 0n;
  bank.last_update = timestamp;
  if (delta === 0n) return;

  const totalAssets = assetAmount(bank, bank.total_asset_shares.value);
  const totalLiabilities = liabilityAmount(bank, bank.total_liability_shares.value);
  if (totalAssets === I80F48_ZERO || totalLiabilities === I80F48_ZERO) {
    emit<LendingPoolBankAccrueInterestEvent>({
      header: { signer: null, marginfi_group: bank.group },
      bank: bankKey,
      mint: bank.mint,
      delta,
      fees_collected: f64FromBits(0n),
      insurance_collected: f64FromBits(0n),
    });
    return;
  }
  const c = accrualChanges(
    bank.config.interest_rate_config,
    group,
    delta,
    totalAssets,
    totalLiabilities,
    bank.asset_share_value.value,
    bank.liability_share_value.value,
  );
  bank.cache.accumulated_since_last_update.value = fxMul(fxSub(c.asset_share_value, bank.asset_share_value.value), bank.total_asset_shares.value);
  bank.cache.interest_accumulated_for = toU32(delta < U32_MAX ? delta : U32_MAX);
  bank.asset_share_value.value = c.asset_share_value;
  bank.liability_share_value.value = c.liability_share_value;
  if (c.group_fees > I80F48_ZERO) bank.collected_group_fees_outstanding.value = fxAdd(c.group_fees, bank.collected_group_fees_outstanding.value);
  if (c.insurance_fees > I80F48_ZERO)
    bank.collected_insurance_fees_outstanding.value = fxAdd(c.insurance_fees, bank.collected_insurance_fees_outstanding.value);
  if (c.protocol_fees > I80F48_ZERO) bank.collected_program_fees_outstanding.value = fxAdd(c.protocol_fees, bank.collected_program_fees_outstanding.value);
  emit<LendingPoolBankAccrueInterestEvent>({
    header: { signer: null, marginfi_group: bank.group },
    bank: bankKey,
    mint: bank.mint,
    delta,
    fees_collected: f64FromBits(fxToF64Bits(c.group_fees)),
    insurance_collected: f64FromBits(fxToF64Bits(c.insurance_fees)),
  });
}

/**
 * Bank::update_bank_cache: the cached base, lending and borrowing rates at the current utilization (the bank's
 * last_update moves to now), or a reset cache that keeps the oracle price when the bank has no assets or no
 * liabilities. Nothing while a liquidation holds the cache locked.
 */
export function updateBankCache(bank: Mut<Bank>, group: Account<MarginfiGroup>, timestamp: i64): void {
  if ((bank.cache.liq_cache_flags & LIQ_CACHE_LOCKED_FLAG) !== 0n) return;
  const totalAssets = assetAmount(bank, bank.total_asset_shares.value);
  const totalLiabilities = liabilityAmount(bank, bank.total_liability_shares.value);
  if (totalAssets === I80F48_ZERO || totalLiabilities === I80F48_ZERO) {
    // reset_preserving_oracle_state: everything but the last oracle price, its time and confidence, and the multiplier.
    bank.cache.base_rate = 0n;
    bank.cache.lending_rate = 0n;
    bank.cache.borrowing_rate = 0n;
    bank.cache.interest_accumulated_for = 0n;
    bank.cache.accumulated_since_last_update.value = I80F48_ZERO;
    bank.cache.liq_cache_flags = 0n;
    for (let i = 0n; i < 7n; i++) bank.cache.cb_cache_pad.set(i, 0n);
    bank.cache.liquidation_price_rt.value = I80F48_ZERO;
    bank.cache.liquidation_price_rt_confidence.value = I80F48_ZERO;
    bank.cache.liquidation_price_twap.value = I80F48_ZERO;
    bank.cache.liquidation_price_twap_confidence.value = I80F48_ZERO;
    return;
  }
  const r = calcInterestRate(bank.config.interest_rate_config, group, fxDiv(totalLiabilities, totalAssets));
  bank.cache.base_rate = milliToU32(r.base);
  bank.cache.lending_rate = milliToU32(r.lending);
  bank.cache.borrowing_rate = milliToU32(r.borrowing);
  bank.last_update = timestamp;
}

// ---- configuration (Bank::configure and its checks) ---------------------------------------------------------------

export const PERMISSIONLESS_BAD_DEBT_SETTLEMENT_FLAG: u64 = 4n;
export const FREEZE_SETTINGS: u64 = 8n;
export const CIRCUIT_BREAKER_ENABLED: u64 = 2048n;
export const BANK_SAME_ASSET_EMODE_ELIGIBLE: u64 = 4096n;
export const ASSET_TAG_JUPLEND: u8 = 6n;
const MAX_LIQUIDATION_FEE_U32: u32 = 2147483647n;
const CB_ENABLE_MAX_PRICE_AGE_SECONDS: i64 = 30n;
/** 0.025 and 0.0001 as I80F48 (rounded to nearest, as fixed_macro's literals). */
const DEFAULT_LIQUIDATION_FEE: i128 = 7036874417766n;
const LIQUIDATION_HEALTH_GAIN_MARGIN: i128 = 28147497671n;

/** InterestRateConfig::update: each field given, and the curve is the seven-point one. */
export function updateInterestRateConfig(bank: Mut<Bank>, opt: InterestRateConfigOpt): void {
  const ir = bank.config.interest_rate_config;
  if (opt.insurance_fee_fixed_apr !== null) ir.insurance_fee_fixed_apr = opt.insurance_fee_fixed_apr;
  if (opt.insurance_ir_fee !== null) ir.insurance_ir_fee = opt.insurance_ir_fee;
  if (opt.protocol_fixed_fee_apr !== null) ir.protocol_fixed_fee_apr = opt.protocol_fixed_fee_apr;
  if (opt.protocol_ir_fee !== null) ir.protocol_ir_fee = opt.protocol_ir_fee;
  if (opt.protocol_origination_fee !== null) ir.protocol_origination_fee = opt.protocol_origination_fee;
  if (opt.zero_util_rate !== null) ir.zero_util_rate = opt.zero_util_rate;
  if (opt.hundred_util_rate !== null) ir.hundred_util_rate = opt.hundred_util_rate;
  if (opt.points !== null) for (let i = 0n; i < 5n; i++) ir.points.set(i, opt.points.get(i));
  ir.curve_type = 1n;
}

function setFlag(bank: Mut<Bank>, value: boolean, flag: u64): void {
  if (value) bank.flags |= flag;
  else bank.flags &= ~flag;
}

/** The state a circuit-broken bank's rules follow: the one it had before breaking. */
function cbEffectiveOperationalState(bank: Mut<Bank>): BankOperationalState {
  if (bank.config.operational_state !== BankOperationalState.CircuitBroken) return bank.config.operational_state;
  const pre = bank.cb_pre_break_state;
  if (pre === 3n) return BankOperationalState.KilledByBankruptcy;
  if (pre === 0n) return BankOperationalState.Paused;
  if (pre === 2n) return BankOperationalState.ReduceOnly;
  if (pre === 5n) return BankOperationalState.ReduceOnlyWithBorrowingPower;
  if (pre === 4n) return BankOperationalState.Uninitialized;
  return BankOperationalState.Operational;
}

/** reset_cb_runtime_state: the halt ends (its elapsed part is banked as frozen seconds) and the breaker's state clears. */
export function resetCbRuntimeState(bank: Mut<Bank>, timestamp: i64): void {
  bank.config.operational_state = cbEffectiveOperationalState(bank);
  const halted = cbFrozenSeconds(bank, bank.last_update, timestamp);
  const pending = bank.cb_frozen_seconds_pending;
  bank.cb_frozen_seconds_pending = pending > 18446744073709551615n - halted ? 18446744073709551615n : pending + halted;
  bank.cb_tier = 0n;
  bank.cb_halt_started_at = 0n;
  bank.cb_halt_ended_at = 0n;
  bank.cb_tier3_consecutive_trips = 0n;
  bank.cb_last_observed_slot = 0n;
  bank.cb_last_oracle_source_time = 0n;
}

/** BankConfig::validate_circuit_breaker: the sanity caps on an enabled breaker's settings. */
function validateCircuitBreaker(config: BankConfig): void {
  require(config.cb_ema_alpha_bps > 0n && config.cb_ema_alpha_bps <= 2000n, MarginfiError.CircuitBreakerInvalidConfig);
  require(config.cb_escalation_window_mult > 0n && config.cb_escalation_window_mult <= 10n, MarginfiError.CircuitBreakerInvalidConfig);
  for (let i = 0n; i < 3n; i++) {
    const dev = config.cb_deviation_bps_tiers.get(i);
    const dur = config.cb_tier_durations_seconds.get(i);
    require(dev > 0n && dev <= 5000n && dur > 0n, MarginfiError.CircuitBreakerInvalidConfig);
    if (i > 0n)
      require(dur > config.cb_tier_durations_seconds.get(i - 1n) && dev > config.cb_deviation_bps_tiers.get(i - 1n), MarginfiError.CircuitBreakerInvalidConfig);
  }
  require(config.cb_window_seconds <= 604800n, MarginfiError.CircuitBreakerInvalidConfig);
  require(config.cb_window_max_up_bps <= 10000n && config.cb_window_max_down_bps <= 10000n, MarginfiError.CircuitBreakerInvalidConfig);
}

/**
 * Bank::configure with the fast admin's settings (the governance fields are not in BankConfigFast): each given value in
 * the original's order, the checks on operational states and liquidation fees, the circuit breaker's switch, then the
 * whole config's checks.
 */
export function configureBank(bank: Mut<Bank>, c: BankConfigFast, timestamp: i64): void {
  if (c.deposit_limit !== null) bank.config.deposit_limit = c.deposit_limit;
  if (c.borrow_limit !== null) bank.config.borrow_limit = c.borrow_limit;
  if (c.operational_state !== null) {
    const next = c.operational_state;
    require(!(bank.config.asset_tag === ASSET_TAG_JUPLEND && bank.config.operational_state === BankOperationalState.Uninitialized), MarginfiError.Unauthorized);
    require(next !== BankOperationalState.KilledByBankruptcy &&
      next !== BankOperationalState.Uninitialized &&
      next !== BankOperationalState.CircuitBroken, MarginfiError.Unauthorized);
    require(bank.config.operational_state !== BankOperationalState.CircuitBroken, MarginfiError.BankCircuitBreakerHalted);
    bank.config.operational_state = next;
  }
  if (c.interest_rate_config !== null) updateInterestRateConfig(bank, c.interest_rate_config);
  if (c.total_asset_value_init_limit !== null) bank.config.total_asset_value_init_limit = c.total_asset_value_init_limit;
  if (c.liquidation_liquidator_fee !== null) {
    require(c.liquidation_liquidator_fee <= MAX_LIQUIDATION_FEE_U32, MarginfiError.InvalidConfig);
    bank.liquidation_liquidator_fee = c.liquidation_liquidator_fee;
  }
  if (c.liquidation_insurance_fee !== null) {
    require(c.liquidation_insurance_fee <= MAX_LIQUIDATION_FEE_U32, MarginfiError.InvalidConfig);
    bank.liquidation_insurance_fee = c.liquidation_insurance_fee;
  }
  if (c.permissionless_bad_debt_settlement !== null) setFlag(bank, c.permissionless_bad_debt_settlement, PERMISSIONLESS_BAD_DEBT_SETTLEMENT_FLAG);
  if (c.circuit_breaker_enabled !== null) {
    const on = c.circuit_breaker_enabled;
    const wasOn = (bank.flags & CIRCUIT_BREAKER_ENABLED) === CIRCUIT_BREAKER_ENABLED;
    if (on && !wasOn) {
      // Seeded from a warm cache: a recent, non-zero oracle price, times the bank's price multiplier.
      const last = bank.cache.last_oracle_price.value;
      require(last > I80F48_ZERO, MarginfiError.CircuitBreakerRequiresWarmCache);
      const ts = bank.cache.last_oracle_price_timestamp;
      // The age, now.saturating_sub(timestamp), must be in 0..=30: one that saturates is out of range either way.
      const saturates = ts < 0n ? timestamp > 9223372036854775807n + ts : timestamp < -9223372036854775808n + ts;
      require(!saturates && timestamp >= ts && timestamp - ts <= CB_ENABLE_MAX_PRICE_AGE_SECONDS, MarginfiError.CircuitBreakerRequiresWarmCache);
      const adjusted = fxMul(last, bank.cache.price_multiplier.value);
      if (bank.cb_reference_price.value === I80F48_ZERO) bank.cb_reference_price.value = adjusted;
      if (bank.cb_window_reference_price.value === I80F48_ZERO) {
        bank.cb_window_reference_price.value = adjusted;
        bank.cb_window_started_at = timestamp;
      }
    }
    if (!on && wasOn) resetCbRuntimeState(bank, timestamp);
    setFlag(bank, on, CIRCUIT_BREAKER_ENABLED);
  }
  if (c.cb_deviation_bps_tiers !== null) for (let i = 0n; i < 3n; i++) bank.config.cb_deviation_bps_tiers.set(i, c.cb_deviation_bps_tiers.get(i));
  if (c.cb_tier_durations_seconds !== null) for (let i = 0n; i < 3n; i++) bank.config.cb_tier_durations_seconds.set(i, c.cb_tier_durations_seconds.get(i));
  if (c.cb_escalation_window_mult !== null) bank.config.cb_escalation_window_mult = c.cb_escalation_window_mult;
  if (c.cb_ema_alpha_bps !== null) bank.config.cb_ema_alpha_bps = c.cb_ema_alpha_bps;
  if (c.cb_window_seconds !== null) bank.config.cb_window_seconds = c.cb_window_seconds;
  if (c.cb_window_max_up_bps !== null) bank.config.cb_window_max_up_bps = c.cb_window_max_up_bps;
  if (c.cb_window_max_down_bps !== null) bank.config.cb_window_max_down_bps = c.cb_window_max_down_bps;
  validateBankConfig(bank.config);
  if ((bank.flags & CIRCUIT_BREAKER_ENABLED) === CIRCUIT_BREAKER_ENABLED) validateCircuitBreaker(bank.config);
}

/** A liquidation fee as a fraction (0: the default 2.5%). */
function liquidationFeeFraction(fee: u32): i128 {
  return fee === 0n ? DEFAULT_LIQUIDATION_FEE : u32ToCenti(fee);
}
/** The liquidator's cut of a liquidation. */
export function liquidatorFee(bank: Mut<Bank>): i128 {
  return liquidationFeeFraction(bank.liquidation_liquidator_fee);
}
/** The insurance fund's cut of a liquidation. */
export function insuranceFee(bank: Mut<Bank>): i128 {
  return liquidationFeeFraction(bank.liquidation_insurance_fee);
}
/** The liquidator's and the insurance fund's cut together (a plain sum: it cannot overflow). */
export function totalLiquidationFee(bank: Mut<Bank>): i128 {
  return liquidationFeeFraction(bank.liquidation_liquidator_fee) + liquidationFeeFraction(bank.liquidation_insurance_fee);
}

/** calculate_max_leverage: 1 / (1 - CW/LW), for CW < LW. */
function maxLeverage(collateral: i128, liability: i128): i128 {
  require(liability > I80F48_ZERO, MarginfiError.BadEmodeConfig);
  require(collateral < liability, MarginfiError.BadEmodeConfig);
  const denominator = I80F48_ONE - fxDiv(collateral, liability);
  require(denominator > I80F48_ZERO, MarginfiError.BadEmodeConfig);
  return fxDiv(I80F48_ONE, denominator);
}
/** fees_fit_leverage: (fee + margin) × leverage ≤ 1 + margin. */
function feesFitLeverage(fee: i128, leverage: i128): boolean {
  return fxMul(fee + LIQUIDATION_HEALTH_GAIN_MARGIN, leverage) <= I80F48_ONE + LIQUIDATION_HEALTH_GAIN_MARGIN;
}
/** leverage_ceiling: the exclusive bound a cap encodes (0: none). */
function leverageCeiling(cap: u32): i128 {
  if (cap === 0n) return I80F48_MAX;
  return u32ToBasis(cap) + u32ToBasis(1n);
}

/** EmodeSettings::validate_entries_with_liability_weights, then check_dupes. */
export function validateEmodeEntries(bank: Mut<Bank>, totalFee: i128, maxInit: u32, maxMaint: u32): void {
  const liabInit = bank.config.liability_weight_init.value;
  const liabMaint = bank.config.liability_weight_maint.value;
  const initCeiling = leverageCeiling(maxInit);
  const maintCeiling = leverageCeiling(maxMaint);
  for (let i = 0n; i < 10n; i++) {
    const entry = bank.emode.emode_config.entries.get(i);
    if (entry.collateral_bank_emode_tag === 0n) continue;
    const assetInit = entry.asset_weight_init.value;
    const assetMaint = entry.asset_weight_maint.value;
    require(assetInit >= I80F48_ZERO, MarginfiError.BadEmodeConfig);
    require(assetMaint >= assetInit, MarginfiError.BadEmodeConfig);
    require(maxLeverage(assetInit, liabInit) < initCeiling, MarginfiError.MaxInitLeverageExceeded);
    const maint = maxLeverage(assetMaint, liabMaint);
    require(feesFitLeverage(totalFee, maint), MarginfiError.MaxMaintLeverageExceeded);
    require(maint < maintCeiling, MarginfiError.MaxMaintLeverageExceeded);
  }
  let prev: u16 = 0n;
  for (let i = 0n; i < 10n; i++) {
    const tag = bank.emode.emode_config.entries.get(i).collateral_bank_emode_tag;
    if (tag === 0n) continue;
    require(tag !== prev, MarginfiError.BadEmodeConfig);
    prev = tag;
  }
}

/** check_same_asset_fee: an eligible bank's fees must fit the group's same-asset maintenance leverage. */
export function checkSameAssetFee(bank: Mut<Bank>, group: Account<MarginfiGroup>): void {
  if ((bank.flags & BANK_SAME_ASSET_EMODE_ELIGIBLE) !== BANK_SAME_ASSET_EMODE_ELIGIBLE) return;
  const leverage = u32ToBasis(group.same_asset_emode_maint_leverage);
  if (leverage <= I80F48_ONE) return;
  require(feesFitLeverage(totalLiquidationFee(bank), leverage), MarginfiError.MaxMaintLeverageExceeded);
}

// ---- shares, limits and states (Bank's share methods, utils::validate_bank_state, the rate limiter) ---------------

export const BANK_ASSET_TAG_STAKED: u8 = 2n;
export const PREMIUM_ACTIVE: u64 = 8192n;
export const TOKENLESS_REPAYMENTS_ALLOWED: u64 = 32n;
const U64_MAX: u64 = 18446744073709551615n;

/** get_asset_shares: zero when the share value is zero. */
export function getAssetShares(bank: Mut<Bank>, value: i128): i128 {
  if (bank.asset_share_value.value === I80F48_ZERO) return I80F48_ZERO;
  return fxDiv(value, bank.asset_share_value.value);
}
export function getLiabilityShares(bank: Mut<Bank>, value: i128): i128 {
  return fxDiv(value, bank.liability_share_value.value);
}

/** change_asset_shares: a positive change must leave the deposits below the deposit limit (unless bypassed). */
export function changeAssetShares(bank: Mut<Bank>, shares: i128, bypassDepositLimit: boolean): void {
  const total = fxAdd(bank.total_asset_shares.value, shares);
  if (shares > I80F48_ZERO && bank.config.deposit_limit !== U64_MAX && !bypassDepositLimit)
    require(assetAmount(bank, total) < fxFromU64(bank.config.deposit_limit), MarginfiError.BankAssetCapacityExceeded);
  bank.total_asset_shares.value = total;
}
/** change_liability_shares: a positive change must leave the borrows below the borrow limit (unless bypassed). */
export function changeLiabilityShares(bank: Mut<Bank>, shares: i128, bypassBorrowLimit: boolean): void {
  bank.total_liability_shares.value = fxAdd(bank.total_liability_shares.value, shares);
  if (!bypassBorrowLimit && shares > I80F48_ZERO && bank.config.borrow_limit !== U64_MAX)
    require(liabilityAmount(bank, bank.total_liability_shares.value) < fxFromU64(bank.config.borrow_limit), MarginfiError.BankLiabilityCapacityExceeded);
}

/** get_remaining_deposit_capacity: what may still be deposited, one below the limit (no limit: u64::MAX). */
export function remainingDepositCapacity(bank: Mut<Bank>): u64 {
  if (bank.config.deposit_limit === U64_MAX) return U64_MAX;
  const current = assetAmount(bank, bank.total_asset_shares.value);
  const limit = fxFromU64(bank.config.deposit_limit);
  if (current >= limit) return 0n;
  return fxToU64(fxSub(fxSub(limit, current), I80F48_ONE));
}

/** is_cb_halted: the breaker is on, has tripped, and its halt has not ended. */
export function isCbHalted(bank: Mut<Bank>, timestamp: i64): boolean {
  return (bank.flags & CIRCUIT_BREAKER_ENABLED) === CIRCUIT_BREAKER_ENABLED && bank.cb_tier > 0n && timestamp < bank.cb_halt_ended_at;
}

/** utils::InstructionKind */
export const FAILS_IN_REDUCE_STATE: u8 = 1n;
export const FAILS_IN_PAUSED_STATE: u8 = 2n;
export const FAILS_IF_PAUSED_OR_REDUCE_STATE: u8 = 3n;

/**
 * validate_bank_state: a bank killed by bankruptcy or not yet initialized refuses everything; a halted or
 * circuit-broken one refuses what is not halt-safe; then the (pre-break) state's rules for this kind of instruction.
 */
export function validateBankState(bank: Mut<Bank>, kind: u8, haltSafe: boolean, timestamp: i64): void {
  const state = bank.config.operational_state;
  require(state !== BankOperationalState.KilledByBankruptcy, MarginfiError.BankKilledByBankruptcy);
  require(state !== BankOperationalState.Uninitialized, MarginfiError.BankUninitialized);
  const broken = state === BankOperationalState.CircuitBroken;
  require(haltSafe || !(broken || isCbHalted(bank, timestamp)), MarginfiError.BankCircuitBreakerHalted);
  const effective = cbEffectiveOperationalState(bank);
  require(effective !== BankOperationalState.KilledByBankruptcy, MarginfiError.BankKilledByBankruptcy);
  require(effective !== BankOperationalState.Uninitialized, MarginfiError.BankUninitialized);
  const reduce = effective === BankOperationalState.ReduceOnly || effective === BankOperationalState.ReduceOnlyWithBorrowingPower;
  if (kind === FAILS_IN_REDUCE_STATE) require(!reduce, MarginfiError.BankReduceOnly);
  else if (kind === FAILS_IN_PAUSED_STATE) require(effective !== BankOperationalState.Paused, MarginfiError.BankPaused);
  else if (kind === FAILS_IF_PAUSED_OR_REDUCE_STATE) {
    require(effective !== BankOperationalState.Paused, MarginfiError.BankPaused);
    require(!reduce, MarginfiError.BankReduceOnly);
  }
}

/** RateLimitWindow::maybe_advance_window (an enabled window): one window on, or a fresh one after two. */
function windowAdvance(w: RateLimitWindow, timestamp: i64): RateLimitWindow {
  let start = w.window_start;
  let prev = w.prev_window_outflow;
  let cur = w.cur_window_outflow;
  if (w.window_duration !== 0n) {
    const elapsed = saturatingSubI64(timestamp, start);
    if (elapsed >= 0n) {
      const e = toU64(elapsed);
      // `window_duration * 2` overflows (panics) in the original for durations past u64::MAX / 2.
      require(w.window_duration <= 9223372036854775807n, MarginfiError.MathError);
      if (e >= w.window_duration * 2n) {
        prev = 0n;
        cur = 0n;
        start = timestamp;
      } else if (e >= w.window_duration) {
        prev = cur;
        cur = 0n;
        start = saturatingAddI64(start, i64Wrap(w.window_duration));
      }
    }
  }
  return { max_outflow: w.max_outflow, window_duration: w.window_duration, window_start: start, prev_window_outflow: prev, cur_window_outflow: cur };
}
/** record_inflow (an enabled window): an inflow gives back capacity. */
function windowInflow(w: RateLimitWindow, amount: u64, timestamp: i64): RateLimitWindow {
  const a = windowAdvance(w, timestamp);
  const inflow: i64 = amount <= 9223372036854775807n ? i64Of(amount) : 9223372036854775807n;
  return {
    max_outflow: a.max_outflow,
    window_duration: a.window_duration,
    window_start: a.window_start,
    prev_window_outflow: a.prev_window_outflow,
    cur_window_outflow: saturatingSubI64(a.cur_window_outflow, inflow),
  };
}

/**
 * remaining_capacity_from_state: the cap less this window's net outflow and the last window's, weighted by the part
 * of it still inside the sliding window (a cap past i64::MAX allows nothing).
 */
function windowCapacity(max: u64, duration: u64, start: i64, prev: i64, cur: i64, timestamp: i64): i64 {
  if (max > 9223372036854775807n) return 0n;
  const m = toI64(max);
  if (duration === 0n) return m;
  const elapsed = saturatingSubI64(timestamp, start);
  if (elapsed < 0n) return 0n;
  const e = toU64(elapsed);
  if (e >= duration) return m;
  // i128 products: the full i64 range stays representable (the original saturates, which cannot happen here).
  const weighted = (toI128(prev) * toI128(duration - e)) / toI128(duration);
  const left = toI128(m) - (weighted + toI128(cur));
  if (left > 9223372036854775807n) return 9223372036854775807n;
  if (left < -9223372036854775808n) return -9223372036854775808n;
  return toI64(left);
}
/** effective_remaining_capacity: as if the window had advanced, without writing it (an overflowing span saturates). */
function windowEffectiveCapacity(w: RateLimitWindow, timestamp: i64): i64 {
  let start = w.window_start;
  let prev = w.prev_window_outflow;
  let cur = w.cur_window_outflow;
  if (w.window_duration !== 0n) {
    const elapsed = saturatingSubI64(timestamp, start);
    if (elapsed >= 0n) {
      const e = toU64(elapsed);
      const twice = w.window_duration > 9223372036854775807n ? 18446744073709551615n : w.window_duration * 2n;
      if (e >= twice) {
        start = timestamp;
        prev = 0n;
        cur = 0n;
      } else if (e >= w.window_duration) {
        start = saturatingAddI64(start, i64Wrap(w.window_duration));
        prev = cur;
        cur = 0n;
      }
    }
  }
  return windowCapacity(w.max_outflow, w.window_duration, start, prev, cur, timestamp);
}
/** RateLimitWindow::try_record_outflow (an enabled window, already checked for room): the outflow counted. */
function windowOutflow(w: RateLimitWindow, amount: u64, timestamp: i64): RateLimitWindow {
  const a = windowAdvance(w, timestamp);
  require(amount <= 9223372036854775807n, MarginfiError.InternalLogicError);
  const n = toI64(amount);
  require(n <=
    windowCapacity(a.max_outflow, a.window_duration, a.window_start, a.prev_window_outflow, a.cur_window_outflow, timestamp), MarginfiError.InternalLogicError);
  return {
    max_outflow: a.max_outflow,
    window_duration: a.window_duration,
    window_start: a.window_start,
    prev_window_outflow: a.prev_window_outflow,
    cur_window_outflow: saturatingAddI64(a.cur_window_outflow, n),
  };
}

/** GroupRateLimiter::record_inflow: each enabled window gets the inflow's capacity back. */
export function recordGroupInflow(group: Mut<MarginfiGroup>, amount: u64, timestamp: i64): void {
  if (group.rate_limiter.hourly.max_outflow > 0n) group.rate_limiter.hourly = windowInflow(group.rate_limiter.hourly, amount, timestamp);
  if (group.rate_limiter.daily.max_outflow > 0n) group.rate_limiter.daily = windowInflow(group.rate_limiter.daily, amount, timestamp);
}

/** GroupRateLimiter::try_record_outflow: the outflow must fit each enabled window (hourly first), then counts in both. */
export function recordGroupOutflow(group: Mut<MarginfiGroup>, amount: u64, timestamp: i64): void {
  const hourlyOn = group.rate_limiter.hourly.max_outflow > 0n;
  const dailyOn = group.rate_limiter.daily.max_outflow > 0n;
  if (hourlyOn) group.rate_limiter.hourly = windowAdvance(group.rate_limiter.hourly, timestamp);
  if (dailyOn) group.rate_limiter.daily = windowAdvance(group.rate_limiter.daily, timestamp);
  const fits = amount <= 9223372036854775807n;
  if (hourlyOn) {
    const w = group.rate_limiter.hourly;
    require(fits &&
      toI64(amount) <=
        windowCapacity(
          w.max_outflow,
          w.window_duration,
          w.window_start,
          w.prev_window_outflow,
          w.cur_window_outflow,
          timestamp,
        ), MarginfiError.GroupHourlyRateLimitExceeded);
  }
  if (dailyOn) {
    const w = group.rate_limiter.daily;
    require(fits &&
      toI64(amount) <=
        windowCapacity(
          w.max_outflow,
          w.window_duration,
          w.window_start,
          w.prev_window_outflow,
          w.cur_window_outflow,
          timestamp,
        ), MarginfiError.GroupDailyRateLimitExceeded);
  }
  if (hourlyOn) group.rate_limiter.hourly = windowOutflow(group.rate_limiter.hourly, amount, timestamp);
  if (dailyOn) group.rate_limiter.daily = windowOutflow(group.rate_limiter.daily, amount, timestamp);
}

/** check_utilization_ratio: a bank may not owe more than it holds. */
export function checkUtilizationRatio(bank: Mut<Bank>): void {
  require(assetAmount(bank, bank.total_asset_shares.value) >= liabilityAmount(bank, bank.total_liability_shares.value), MarginfiError.IllegalUtilizationRatio);
}

/**
 * record_withdrawal_outflow: outside flash loans, receiverships, deleverages and rebalances, a withdrawal or borrow
 * must fit the bank's hourly and daily windows (and is counted in them); with the group's limits on, its value at
 * `price` must fit the group's windows, and it is reported for the flow admin.
 */
export function recordWithdrawalOutflow(
  groupLimited: boolean,
  amount: u64,
  price: i128,
  bank: Mut<Bank>,
  group: Account<MarginfiGroup>,
  groupKey: Pubkey,
  bankKey: Pubkey,
  accountFlags: u64,
  timestamp: i64,
): void {
  // ACCOUNT_IN_FLASHLOAN | ACCOUNT_IN_RECEIVERSHIP | ACCOUNT_IN_DELEVERAGE | ACCOUNT_IN_REBALANCE
  if ((accountFlags & 306n) !== 0n) return;
  const hourlyOn = bank.rate_limiter.hourly.max_outflow > 0n;
  const dailyOn = bank.rate_limiter.daily.max_outflow > 0n;
  if (hourlyOn || dailyOn) {
    if (hourlyOn) bank.rate_limiter.hourly = windowAdvance(bank.rate_limiter.hourly, timestamp);
    if (dailyOn) bank.rate_limiter.daily = windowAdvance(bank.rate_limiter.daily, timestamp);
    const fits = amount <= 9223372036854775807n;
    if (hourlyOn) {
      const w = bank.rate_limiter.hourly;
      require(fits &&
        toI64(amount) <=
          windowCapacity(
            w.max_outflow,
            w.window_duration,
            w.window_start,
            w.prev_window_outflow,
            w.cur_window_outflow,
            timestamp,
          ), MarginfiError.BankHourlyRateLimitExceeded);
    }
    if (dailyOn) {
      const w = bank.rate_limiter.daily;
      require(fits &&
        toI64(amount) <=
          windowCapacity(
            w.max_outflow,
            w.window_duration,
            w.window_start,
            w.prev_window_outflow,
            w.cur_window_outflow,
            timestamp,
          ), MarginfiError.BankDailyRateLimitExceeded);
    }
    if (hourlyOn) bank.rate_limiter.hourly = windowOutflow(bank.rate_limiter.hourly, amount, timestamp);
    if (dailyOn) bank.rate_limiter.daily = windowOutflow(bank.rate_limiter.daily, amount, timestamp);
  }
  if (!groupLimited) return;
  require(price > I80F48_ZERO, MarginfiError.InvalidRateLimitPrice);
  require(bank.mint_decimals < 24n, MarginfiError.InternalLogicError);
  const value = fxToI64Wrapping(fxDiv(fxMul(fxFromU64(amount), price), exp10Fx(toU64(bank.mint_decimals))));
  if (group.rate_limiter.hourly.max_outflow > 0n)
    require(value <= windowEffectiveCapacity(group.rate_limiter.hourly, timestamp), MarginfiError.GroupHourlyRateLimitExceeded);
  if (group.rate_limiter.daily.max_outflow > 0n)
    require(value <= windowEffectiveCapacity(group.rate_limiter.daily, timestamp), MarginfiError.GroupDailyRateLimitExceeded);
  emit<RateLimitFlowEvent>({
    group: groupKey,
    bank: bankKey,
    mint: bank.mint,
    flow_direction: 0n,
    native_amount: amount,
    mint_decimals: bank.mint_decimals,
    current_timestamp: timestamp,
  });
}
function i64Of(n: u64): i64 {
  return toI64(n);
}
/** `as i64` on a u64: wraps past i64::MAX. */
function i64Wrap(n: u64): i64 {
  return n <= 9223372036854775807n ? toI64(n) : toI64(n - 9223372036854775808n) - 9223372036854775807n - 1n;
}
export function saturatingSubI64(a: i64, b: i64): i64 {
  if (b > 0n && a < -9223372036854775808n + b) return -9223372036854775808n;
  if (b < 0n && a > 9223372036854775807n + b) return 9223372036854775807n;
  return a - b;
}
export function saturatingAddI64(a: i64, b: i64): i64 {
  if (b > 0n && a > 9223372036854775807n - b) return 9223372036854775807n;
  if (b < 0n && a < -9223372036854775808n - b) return -9223372036854775808n;
  return a + b;
}

/**
 * record_deposit_inflow: outside flash loans, receiverships, deleverages and rebalances, a deposit gives back the
 * bank's rate-limit capacity and, when the group limits flows, is reported for the flow admin to aggregate.
 */
export function recordDepositInflow(
  bank: Mut<Bank>,
  group: Account<MarginfiGroup>,
  groupKey: Pubkey,
  bankKey: Pubkey,
  accountFlags: u64,
  amount: u64,
  timestamp: i64,
): void {
  // ACCOUNT_IN_FLASHLOAN | ACCOUNT_IN_RECEIVERSHIP | ACCOUNT_IN_DELEVERAGE | ACCOUNT_IN_REBALANCE
  if ((accountFlags & 306n) !== 0n) return;
  if (bank.rate_limiter.hourly.max_outflow > 0n) bank.rate_limiter.hourly = windowInflow(bank.rate_limiter.hourly, amount, timestamp);
  if (bank.rate_limiter.daily.max_outflow > 0n) bank.rate_limiter.daily = windowInflow(bank.rate_limiter.daily, amount, timestamp);
  if (group.rate_limiter.hourly.max_outflow > 0n || group.rate_limiter.daily.max_outflow > 0n)
    emit<RateLimitFlowEvent>({
      group: groupKey,
      bank: bankKey,
      mint: bank.mint,
      flow_direction: 1n,
      native_amount: amount,
      mint_decimals: bank.mint_decimals,
      current_timestamp: timestamp,
    });
}

// ---- the oracle price cache and the circuit breaker (state/bank.rs) ----------------------------------------------

/** Floor for the EMA reference used in deviation math: below it the breaker reseeds instead of dividing. */
const CB_MIN_REF_PRICE: i128 = 1048576n;
const CB_MIN_PULSE_SLOT_GAP: u64 = 2n;
const CB_MAX_TIER3_BEFORE_CIRCUIT_BREAK: u8 = 3n;
const CB_MAX_EMA_SHIFT_BPS_PER_PULSE: u64 = 500n;
const CB_WINDOW_SECONDS: u64 = 14400n;
const CB_WINDOW_MAX_UP_BPS: u64 = 2000n;
const CB_WINDOW_MAX_DOWN_BPS: u64 = 4000n;
const CB_CLEAR_REASON_ESCALATION_EXPIRED: u8 = 1n;
const U64_MAX_SAT: u64 = 18446744073709551615n;

/** BankOperationalState as its u8. */
function operationalStateU8(s: BankOperationalState): u8 {
  if (s === BankOperationalState.Paused) return 0n;
  if (s === BankOperationalState.Operational) return 1n;
  if (s === BankOperationalState.ReduceOnly) return 2n;
  if (s === BankOperationalState.KilledByBankruptcy) return 3n;
  if (s === BankOperationalState.Uninitialized) return 4n;
  if (s === BankOperationalState.ReduceOnlyWithBorrowingPower) return 5n;
  return 6n;
}

/** cb_deviation_bps: `(delta * 10_000 / reference).to_num::<u64>()`, the release build's wrapping `*` and `/`. */
function cbDeviationBps(delta: i128, reference: i128): u64 {
  return fxToU64Wrapping(fxWrappingDiv(fxWrappingMul(delta, fxFromU64(10000n)), reference));
}
/** cb_confidence_adjusted_deviation_bps: the move past the confidence band (plain `-` and abs, which panic on overflow). */
function cbConfidenceAdjustedDeviationBps(current: i128, reference: i128, confidence: i128): u64 {
  const d = current - reference;
  const beyond = (d < 0n ? -d : d) - (confidence > 0n ? confidence : 0n);
  return cbDeviationBps(beyond > 0n ? beyond : 0n, reference);
}
function cbTierForDeviation(bank: Mut<Bank>, bps: u64): u8 {
  for (let i = 2n; ; i--) {
    const tier = bank.config.cb_deviation_bps_tiers.get(i);
    if (tier > 0n && bps >= toU64(tier)) return toU8(i + 1n);
    if (i === 0n) return 0n;
  }
}
function orDefault(configured: u64, fallback: u64): u64 {
  return configured === 0n ? fallback : configured;
}

/**
 * trip_cb_halt: the next tier (or the breached one), a halt of that tier's duration (the frozen span of a halt it
 * replaces is banked for the next accrual), and after three tier-3 trips in a row the bank is circuit-broken.
 */
function tripCbHalt(bank: Mut<Bank>, timestamp: i64, bps: u64, breached: u8): void {
  let tier = breached;
  if (bank.cb_tier > 0n) {
    tier = bank.cb_tier + 1n;
    if (tier > 3n) tier = 3n;
  }
  const dur = toI64(bank.config.cb_tier_durations_seconds.get(toU64(tier) - 1n));
  const frozen = cbFrozenSeconds(bank, bank.last_update, timestamp);
  const pending = bank.cb_frozen_seconds_pending;
  bank.cb_frozen_seconds_pending = pending > U64_MAX_SAT - frozen ? U64_MAX_SAT : pending + frozen;
  bank.cb_tier = tier;
  bank.cb_halt_started_at = timestamp;
  bank.cb_halt_ended_at = saturatingAddI64(timestamp, dur);
  emit<CircuitBreakerTrippedEvent>({ tier, deviation_bps: bps, halt_started_at: timestamp, halt_ended_at: bank.cb_halt_ended_at });
  if (tier === 3n) {
    if (bank.cb_tier3_consecutive_trips < 255n) bank.cb_tier3_consecutive_trips += 1n;
    if (bank.cb_tier3_consecutive_trips >= CB_MAX_TIER3_BEFORE_CIRCUIT_BREAK) {
      if (bank.config.operational_state === BankOperationalState.CircuitBroken) return;
      bank.cb_pre_break_state = operationalStateU8(bank.config.operational_state);
      bank.config.operational_state = BankOperationalState.CircuitBroken;
      emit<CircuitBreakerAutoBrokenEvent>({ consecutive_tier3_trips: bank.cb_tier3_consecutive_trips, current_timestamp: timestamp });
    }
  }
}

/**
 * update_circuit_breaker: an enabled breaker that is not halted takes one observation per two slots and per oracle
 * publication. A move past a tier's deviation from the EMA reference (beyond the confidence band), or past the
 * long window's cap, halts the bank; a clean one moves the reference (at most 5% a time).
 */
function updateCircuitBreaker(bank: Mut<Bank>, timestamp: i64, slot: u64, current: i128, conf: i128, sourceTime: i64): void {
  if ((bank.flags & CIRCUIT_BREAKER_ENABLED) !== CIRCUIT_BREAKER_ENABLED) return;
  if (bank.config.operational_state === BankOperationalState.CircuitBroken) return;
  if (bank.cb_tier > 0n && timestamp < bank.cb_halt_ended_at) return;
  if (bank.cb_tier > 0n) {
    const dur = toI64(bank.config.cb_tier_durations_seconds.get(toU64(bank.cb_tier) - 1n));
    const deadline = saturatingAddI64(bank.cb_halt_ended_at, dur * toI64(bank.config.cb_escalation_window_mult));
    if (timestamp >= deadline) {
      const prior = bank.cb_tier;
      bank.cb_tier = 0n;
      bank.cb_tier3_consecutive_trips = 0n;
      emit<CircuitBreakerClearedEvent>({ prior_tier: prior, reason: CB_CLEAR_REASON_ESCALATION_EXPIRED, current_timestamp: timestamp });
    }
  }
  let reference = bank.cb_reference_price.value;
  if (reference === 0n) {
    bank.cb_reference_price.value = current;
    bank.cb_window_reference_price.value = current;
    bank.cb_window_started_at = timestamp;
    bank.cb_last_observed_slot = slot;
    if (sourceTime !== 0n) bank.cb_last_oracle_source_time = sourceTime;
    return;
  }
  const last = bank.cb_last_observed_slot;
  if (slot < (last > U64_MAX_SAT - CB_MIN_PULSE_SLOT_GAP ? U64_MAX_SAT : last + CB_MIN_PULSE_SLOT_GAP)) return;
  if (sourceTime !== 0n && sourceTime <= bank.cb_last_oracle_source_time) return;
  bank.cb_last_observed_slot = slot;
  if (sourceTime !== 0n) bank.cb_last_oracle_source_time = sourceTime;
  if (reference <= CB_MIN_REF_PRICE) {
    bank.cb_reference_price.value = current;
    bank.cb_window_reference_price.value = current;
    bank.cb_window_started_at = timestamp;
    return;
  }
  const confidence = conf > 0n ? conf : 0n;
  const deviation = cbConfidenceAdjustedDeviationBps(current, reference, confidence);
  let windowRef = bank.cb_window_reference_price.value;
  if (windowRef === 0n || windowRef <= CB_MIN_REF_PRICE) {
    bank.cb_window_reference_price.value = reference;
    bank.cb_window_started_at = timestamp;
    windowRef = reference;
  }
  if (bank.cb_window_started_at === 0n) bank.cb_window_started_at = timestamp;
  const windowSeconds = toI64(orDefault(toU64(bank.config.cb_window_seconds), CB_WINDOW_SECONDS));
  const maxUp = orDefault(toU64(bank.config.cb_window_max_up_bps), CB_WINDOW_MAX_UP_BPS);
  const maxDown = orDefault(toU64(bank.config.cb_window_max_down_bps), CB_WINDOW_MAX_DOWN_BPS);
  const expired = timestamp >= saturatingAddI64(bank.cb_window_started_at, windowSeconds);
  const up = current - windowRef - confidence;
  const down = windowRef - current - confidence;
  const upBps = cbDeviationBps(up > 0n ? up : 0n, windowRef);
  const downBps = cbDeviationBps(down > 0n ? down : 0n, windowRef);
  const windowDeviation = upBps > downBps ? upBps : downBps;
  if (upBps >= maxUp || downBps >= maxDown) {
    const tier = cbTierForDeviation(bank, windowDeviation);
    tripCbHalt(bank, timestamp, windowDeviation, tier > 0n ? tier : 1n);
    // A breach after the window ran out is a window's slow drift: the anchor creeps to the cap's edge and restarts.
    if (expired) {
      const step =
        upBps >= maxUp ? I80F48_ONE + fxWrappingDiv(fxFromU64(maxUp), fxFromU64(10000n)) : I80F48_ONE - fxWrappingDiv(fxFromU64(maxDown), fxFromU64(10000n));
      bank.cb_window_reference_price.value = fxWrappingMul(windowRef, step);
      bank.cb_window_started_at = timestamp;
    }
    return;
  }
  const breached = cbTierForDeviation(bank, deviation);
  if (breached > 0n) {
    tripCbHalt(bank, timestamp, deviation, breached);
    return;
  }
  if (expired) {
    bank.cb_window_reference_price.value = current;
    bank.cb_window_started_at = timestamp;
  }
  const alpha = fxWrappingDiv(fxFromU64(toU64(bank.config.cb_ema_alpha_bps)), fxFromU64(10000n));
  const next = fxWrappingMul(alpha, current) + fxWrappingMul(I80F48_ONE - alpha, reference);
  const maxShift = fxWrappingDiv(fxWrappingMul(reference, fxFromU64(CB_MAX_EMA_SHIFT_BPS_PER_PULSE)), fxFromU64(10000n));
  let shift = next - reference;
  const floor = -maxShift;
  if (shift < floor) shift = floor;
  if (shift > maxShift) shift = maxShift;
  reference += shift;
  bank.cb_reference_price.value = reference;
}

/**
 * Bank::cb_price_gate: an enabled breaker refuses a price that moved from its EMA reference past the first tier
 * (beyond the confidence band), or from its window reference past the long window's caps (CircuitBreakerPriceJump).
 */
export function cbPriceGateErr(bank: Account<Bank>, price: i128, conf: i128): u32 {
  if ((bank.flags & CIRCUIT_BREAKER_ENABLED) !== CIRCUIT_BREAKER_ENABLED) return 0n;
  const confidence = conf > 0n ? conf : 0n;
  const reference = bank.cb_reference_price.value;
  const threshold = bank.config.cb_deviation_bps_tiers.get(0n);
  if (reference > CB_MIN_REF_PRICE && threshold > 0n && cbConfidenceAdjustedDeviationBps(price, reference, confidence) >= toU64(threshold)) return 6604n;
  const windowRef = bank.cb_window_reference_price.value;
  if (windowRef > CB_MIN_REF_PRICE) {
    const maxUp = orDefault(toU64(bank.config.cb_window_max_up_bps), CB_WINDOW_MAX_UP_BPS);
    const maxDown = orDefault(toU64(bank.config.cb_window_max_down_bps), CB_WINDOW_MAX_DOWN_BPS);
    const up = price - windowRef - confidence;
    const down = windowRef - price - confidence;
    if (cbDeviationBps(up > 0n ? up : 0n, windowRef) >= maxUp || cbDeviationBps(down > 0n ? down : 0n, windowRef) >= maxDown) return 6604n;
  }
  return 0n;
}

/**
 * update_cache_price: the price an instruction priced the bank at (unbiased, its confidence, now), unless a receivership
 * locked the cache, then the circuit breaker's observation of it (the price multiplier is 1 for the setups ported).
 */
export function updateCachePrice(bank: Mut<Bank>, price: i128, conf: i128, sourceTime: i64, timestamp: i64, slot: u64): void {
  if ((bank.cache.liq_cache_flags & LIQ_CACHE_LOCKED_FLAG) !== 0n) return;
  bank.cache.last_oracle_price.value = price;
  bank.cache.last_oracle_price_confidence.value = conf;
  bank.cache.price_multiplier.value = I80F48_ONE;
  bank.cache.last_oracle_price_timestamp = timestamp;
  updateCircuitBreaker(bank, timestamp, slot, price, conf, sourceTime);
}

/**
 * Bank::socialize_loss: the depositors share a loss through a lower share value; one at or past the bank's deposits
 * wipes them out. Returns whether the bank is dead (a share value of 0).
 */
export function socializeLoss(bank: Mut<Bank>, loss: i128): boolean {
  const total = fxMul(bank.total_asset_shares.value, bank.asset_share_value.value);
  if (total <= loss) {
    bank.asset_share_value.value = I80F48_ZERO;
    return true;
  }
  const value = fxDiv(total - loss, bank.total_asset_shares.value);
  bank.asset_share_value.value = value;
  return value === I80F48_ZERO;
}
