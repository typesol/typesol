// Marginfi's bank (programs/marginfi/src/state/bank.rs, bank_config.rs and bank_cache.rs @ c5d440f6): creating one
// from its compact config, checking a config, the interest accrual and the rate cache. Amounts and share values are
// I80F48 (examples/marginfi/i80f48.ts).
import { type Account, type Mut, type Pubkey, type i128, type i64, type u16, type u32, type u64, type u8, emit, f64FromBits, require, u32 as toU32, u64 as toU64 } from "typesol";
import { type BankConfigCompact, type BankConfigFast } from "./args";
import { MarginfiError } from "./errors";
import { type InterestRateConfigOpt, type LendingPoolBankAccrueInterestEvent } from "./events";
import { I80F48_MAX, I80F48_ONE, I80F48_ZERO, fxAdd, fxDiv, fxMul, fxSub, fxToF64Bits } from "./i80f48";
import { accrualChanges, calcInterestRate, milliToU32, u32ToBasis, u32ToCenti, validateInterestRateConfig } from "./interest_rate";
import { type Bank, type BankConfig, type MarginfiGroup, BankOperationalState, OracleSetup, RiskTier } from "./state";

/** Bank.flags */
export const CLOSE_ENABLED_FLAG: u64 = 16n;
export const IS_T22: u64 = 128n;
export const BANK_SEED_KNOWN: u64 = 256n;
const ORACLE_MIN_AGE: u16 = 10n;
const LIQ_CACHE_LOCKED_FLAG: u8 = 1n;
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
const BANK_SAME_ASSET_EMODE_ELIGIBLE: u64 = 4096n;
const ASSET_TAG_JUPLEND: u8 = 6n;
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
function resetCbRuntimeState(bank: Mut<Bank>, timestamp: i64): void {
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
      require(
        dur > config.cb_tier_durations_seconds.get(i - 1n) && dev > config.cb_deviation_bps_tiers.get(i - 1n),
        MarginfiError.CircuitBreakerInvalidConfig,
      );
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
    require(
      !(bank.config.asset_tag === ASSET_TAG_JUPLEND && bank.config.operational_state === BankOperationalState.Uninitialized),
      MarginfiError.Unauthorized,
    );
    require(
      next !== BankOperationalState.KilledByBankruptcy && next !== BankOperationalState.Uninitialized && next !== BankOperationalState.CircuitBroken,
      MarginfiError.Unauthorized,
    );
    require(bank.config.operational_state !== BankOperationalState.CircuitBroken, MarginfiError.BankCircuitBreakerHalted);
    bank.config.operational_state = next;
  }
  if (c.interest_rate_config !== null) {
    const opt: InterestRateConfigOpt = c.interest_rate_config;
    updateInterestRateConfig(bank, opt);
  }
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
  if (c.cb_tier_durations_seconds !== null)
    for (let i = 0n; i < 3n; i++) bank.config.cb_tier_durations_seconds.set(i, c.cb_tier_durations_seconds.get(i));
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
