// Marginfi's risk engine (programs/marginfi/src/state/marginfi_account.rs and state/premium.rs, type-crate emode.rs
// and premium.rs @ c5d440f6): an account's balances priced and weighted into assets and liabilities, the e-mode
// weights its liabilities allow, the premium its liabilities project, and the rates their snapshots move to.
//
// The banks and their oracle accounts follow the instruction's own accounts, one [bank, oracle…] group per active
// balance in balance order. Errors are values (`err`, 0 when there is none) because the original keeps some: a
// stale collateral oracle only zeroes that leg for Initial health, and the Maintenance pass that may clear an
// account's tag ignores whatever fails. Panics abort.
import {
  type Account,
  type FixedArray,
  type Mut,
  type Pubkey,
  type RemainingAccount,
  type RemainingAccounts,
  type i128,
  type i64,
  type u16,
  type u32,
  type u64,
  type u8,
  fixedArray,
  loadAccount,
  programId,
  readData,
  require,
  u64 as toU64,
  u8 as toU8,
} from "typesol";
import { ACCOUNT_IN_FLASHLOAN, EMPTY_BALANCE_THRESHOLD, ZERO_KEY, claimPremium, writeOffPremium } from "./account";
import { BANK_SAME_ASSET_EMODE_ELIGIBLE, CIRCUIT_BREAKER_ENABLED, PREMIUM_ACTIVE, cbPriceGateErr } from "./bank";
import { MarginfiError } from "./errors";
import { type Fx, I80F48_ONE, I80F48_ZERO, exp10Fx, fxFromU64, fxMul, fxToF64Bits, fxTryAdd, fxTryDiv, fxTryMul } from "./i80f48";
import { SECONDS_PER_YEAR, milliToU32, u32ToBasis, u32ToMilli } from "./interest_rate";
import {
  BIAS_HIGH,
  BIAS_LOW,
  ERR_BORSH,
  WRONG_NUMBER_OF_ORACLE_ACCOUNTS,
  type Feed,
  type PriceConf,
  feedErr,
  feedFamily,
  fixedFeed,
  loadFeed,
  oracleCount,
  priceAndConfidence,
  priceOfType,
} from "./oracle";
import { type Bank, type MarginfiAccount, type MarginfiGroup, BankOperationalState, OracleSetup, RiskTier } from "./state";

/** RequirementType */
export const REQ_INITIAL: u8 = 0n;
export const REQ_MAINTENANCE: u8 = 1n;
export const REQ_EQUITY: u8 = 2n;

/** sha256("account:Bank")[..8], little-endian. */
const BANK_DISC: u64 = 13574203538458161550n;
const U32_MAX_CONFIDENCE: u32 = 4294967295n;
const NO_INDEX: u8 = 255n;
const INVALID_BANK_ACCOUNT: u32 = 6008n;
/** PremiumScratchEntry.flags */
export const SCRATCH_ASSET: u8 = 1n;
export const SCRATCH_LIABILITY: u8 = 2n;
export const SCRATCH_PREMIUM_ACTIVE: u8 = 4n;
export const SCRATCH_UNPRICEABLE: u8 = 8n;

/** A count, or the error finding it. */
export interface Count {
  err: u32;
  n: u64;
}

/** AccountLoader::<Bank>::try_from's checks on a remaining account: owner (3007), then a discriminator (3001, 3002). */
function loaderErr(a: RemainingAccount): u32 {
  if (a.owner !== programId()) return 3007n;
  if (a.dataLen < 8n) return 3001n;
  if (readData<u64>(a, 0n) !== BANK_DISC) return 3002n;
  return 0n;
}

/** get_remaining_accounts_per_bank: the bank and its oracle accounts (AssetTagMismatch for an unknown tag). */
export function accountsPerBank(bank: Account<Bank>): Count {
  switch (bank.config.oracle_setup) {
    case OracleSetup.Fixed:
      return { err: 0n, n: 1n };
    case OracleSetup.FixedKamino:
    case OracleSetup.FixedDrift:
    case OracleSetup.FixedJuplend:
    case OracleSetup.PTFixed:
      return { err: 0n, n: 2n };
    case OracleSetup.PythMSOL:
    case OracleSetup.PythLST:
    case OracleSetup.PTPyth:
    case OracleSetup.ScopeKamino:
    case OracleSetup.ScopeJuplend:
      return { err: 0n, n: 3n };
    case OracleSetup.KaminoMSOL:
    case OracleSetup.JuplendMSOL:
    case OracleSetup.KaminoLST:
    case OracleSetup.JuplendLST:
      return { err: 0n, n: 4n };
  }
  const tag = bank.config.asset_tag;
  if (tag === 0n || tag === 1n) return { err: 0n, n: 2n };
  if (tag >= 3n && tag <= 6n) return { err: 0n, n: 3n };
  if (tag === 2n) return { err: 0n, n: 5n };
  return { err: 6047n, n: 0n };
}

/** OraclePriceFeedAdapter::try_from_bank over the bank's oracle accounts (`n` of them from `first`), as a value. */
export function feedAt(bank: Account<Bank>, rest: RemainingAccounts, first: u64, n: u64, t: i64): Feed {
  const c = oracleCount(bank, n);
  if (c !== 0n) return feedErr(c);
  if (n === 0n) return fixedFeed(bank);
  return loadFeed(bank, rest.get(first), t);
}

/** calc_value (marginfi_account.rs): amount × weight (overflow panics) × price / 10^decimals. */
export function calcValue(amount: i128, price: i128, decimals: u8, weight: i128, weighted: boolean): Fx {
  if (amount === I80F48_ZERO) return { err: 0n, v: I80F48_ZERO };
  const scale = exp10Fx(toU64(decimals));
  const w = weighted ? fxMul(amount, weight) : amount;
  const p = fxTryMul(w, price);
  if (p.err !== 0n) return p;
  return fxTryDiv(p.v, scale);
}
/** The type crate's calc_value: every overflow (and a decimals index past the table) is MathError. */
function calcValueChecked(amount: i128, price: i128, decimals: u8, weight: i128, weighted: boolean): Fx {
  if (amount === I80F48_ZERO) return { err: 0n, v: I80F48_ZERO };
  if (decimals >= 24n) return { err: 6062n, v: 0n };
  let w = amount;
  if (weighted) {
    const m = fxTryMul(amount, weight);
    if (m.err !== 0n) return m;
    w = m.v;
  }
  const p = fxTryMul(w, price);
  if (p.err !== 0n) return p;
  return fxTryDiv(p.v, exp10Fx(toU64(decimals)));
}

/** BankConfig::get_weight for assets: Initial and Maintenance weights, 1 for Equity. */
function bankAssetWeight(bank: Account<Bank>, req: u8): i128 {
  if (req === REQ_INITIAL) return bank.config.asset_weight_init.value;
  if (req === REQ_MAINTENANCE) return bank.config.asset_weight_maint.value;
  return I80F48_ONE;
}
/** BankConfig::get_weight for liabilities. */
export function liabilityWeight(bank: Account<Bank>, req: u8): i128 {
  if (req === REQ_INITIAL) return bank.config.liability_weight_init.value;
  if (req === REQ_MAINTENANCE) return bank.config.liability_weight_maint.value;
  return I80F48_ONE;
}

// ---- e-mode -----------------------------------------------------------------------------------------------------

/** ReconciledEmodeConfig: the tags every liability's config offers (ascending) and the same-asset weight. */
export interface Reconciled {
  count: u8;
  tags: FixedArray<u16, 10>;
  flags: FixedArray<u8, 10>;
  weights: FixedArray<i128, 10>;
  same: boolean;
  same_mint: Pubkey;
  same_oracle: Pubkey;
  same_family: u8;
  same_fixed: i128;
  same_weight: i128;
}

/**
 * EmodeConfigIterator + reconcile_emode_configs: walks the balances as the health pass does but stops quietly at
 * the first bank it cannot load or match. Each liability's bank config is intersected with the others' (a tag in
 * every config, its least favorable weight and flags); with same-asset leverage on, liabilities that all price one
 * asset through one feed give their collateral twin the weight `liability weight × (1 − 1 / leverage)`.
 */
export function reconcileEmode(acc: Account<MarginfiAccount>, group: Account<MarginfiGroup>, rest: RemainingAccounts, start: u64, req: u8): Reconciled {
  let leverage = I80F48_ZERO;
  if (req === REQ_INITIAL) leverage = u32ToBasis(group.same_asset_emode_init_leverage);
  else if (req === REQ_MAINTENANCE) leverage = u32ToBasis(group.same_asset_emode_maint_leverage);
  const leverageOn = req !== REQ_EQUITY && leverage > I80F48_ONE;
  const mt = fixedArray<u16, 10>(0n);
  const mw = fixedArray<i128, 10>(0n);
  const mf = fixedArray<u8, 10>(0n);
  const mc = fixedArray<u64, 10>(0n);
  let mn = 0n;
  let configs = 0n;
  let seen = false;
  let invalid = false;
  let lowestSet = false;
  let lowest = I80F48_ZERO;
  let sMint = ZERO_KEY;
  let sOracle = ZERO_KEY;
  let sFamily: u8 = 0n;
  let sFixed = I80F48_ZERO;
  let at = 0n;
  for (let i = 0n; i < 16n; i++) {
    const b = acc.lending_account.balances.get(i);
    if (b.active === 0n) continue;
    const k = start + at;
    if (k >= rest.length || loaderErr(rest.get(k)) !== 0n) break;
    const bank = loadAccount<Bank>(rest.get(k));
    if (bank.key !== b.bank_pk) break;
    const per = accountsPerBank(bank);
    if (per.err !== 0n) break;
    at += per.n;
    if (b.liability_shares.value < EMPTY_BALANCE_THRESHOLD) continue;
    if (leverageOn && !invalid) {
      // update_reconciled_same_asset_config: integration pricing never establishes the liability side.
      const s = bank.config.oracle_setup;
      const family = feedFamily(s);
      const key0 = bank.config.oracle_keys.get(0n);
      const setupOk =
        s === OracleSetup.PythPushOracle ||
        s === OracleSetup.SwitchboardPull ||
        s === OracleSetup.StakedWithPythPush ||
        s === OracleSetup.PythMSOL ||
        s === OracleSetup.PythLST ||
        s === OracleSetup.PTPyth;
      const w = liabilityWeight(bank, req);
      if (!setupOk || family === 0n || (bank.flags & BANK_SAME_ASSET_EMODE_ELIGIBLE) === 0n || key0 === ZERO_KEY) {
        invalid = true;
        lowestSet = false;
      } else if (!seen) {
        seen = true;
        sMint = bank.mint;
        sOracle = key0;
        sFamily = family;
        sFixed = bank.config.fixed_price.value;
        lowest = w;
        lowestSet = true;
      } else if (sMint !== bank.mint || sOracle !== key0 || sFamily !== family || sFixed !== bank.config.fixed_price.value) {
        invalid = true;
        lowestSet = false;
      } else if (!lowestSet || w < lowest) {
        lowest = w;
        lowestSet = true;
      }
    }
    configs += 1n;
    for (let j = 0n; j < 10n; j++) {
      const e = bank.emode.emode_config.entries.get(j);
      const tag = e.collateral_bank_emode_tag;
      if (tag === 0n) continue;
      const w = req === REQ_INITIAL ? e.asset_weight_init.value : req === REQ_MAINTENANCE ? e.asset_weight_maint.value : I80F48_ONE;
      let found = 10n;
      for (let m = 0n; m < mn; m++)
        if (mt.get(m) === tag) {
          found = m;
          break;
        }
      if (configs === 1n) {
        // The first config's entries (a repeated tag: the last one, as a map insert keeps it).
        if (found === 10n) {
          found = mn;
          mt.set(found, tag);
          mn += 1n;
        }
        mw.set(found, w);
        mf.set(found, e.flags);
        mc.set(found, 1n);
      } else if (found !== 10n && mc.get(found) === configs - 1n) {
        if (w < mw.get(found)) mw.set(found, w);
        if (e.flags < mf.get(found)) mf.set(found, e.flags);
        mc.set(found, configs);
      }
    }
  }
  // The tags every config has, ascending.
  const tags = fixedArray<u16, 10>(0n);
  const flags = fixedArray<u8, 10>(0n);
  const weights = fixedArray<i128, 10>(0n);
  let count = 0n;
  let previous: u16 = 0n;
  for (let o = 0n; o < mn; o++) {
    let best = 10n;
    for (let m = 0n; m < mn; m++)
      if (mc.get(m) === configs && mt.get(m) > previous && (best === 10n || mt.get(m) < mt.get(best))) best = m;
    if (best === 10n) break;
    tags.set(count, mt.get(best));
    flags.set(count, mf.get(best));
    weights.set(count, mw.get(best));
    previous = mt.get(best);
    count += 1n;
  }
  const same = leverageOn && !invalid && seen && lowestSet && sMint !== ZERO_KEY;
  let sameWeight = I80F48_ZERO;
  if (same) {
    // compute_same_asset_emode_weight
    const inverse = fxTryDiv(I80F48_ONE, leverage);
    const factor = I80F48_ONE - (inverse.err === 0n ? inverse.v : I80F48_ZERO);
    const w = fxTryMul(lowest, factor);
    sameWeight = w.err === 0n ? w.v : I80F48_ZERO;
  }
  return {
    count: toU8(count),
    tags,
    flags,
    weights,
    same,
    same_mint: sMint,
    same_oracle: sOracle,
    same_family: sFamily,
    same_fixed: sFixed,
    same_weight: sameWeight,
  };
}

/** Bank::get_asset_weight: the most favorable of the bank's weight, its e-mode tag's and the same-asset weight. */
export function assetWeight(bank: Account<Bank>, req: u8, r: Reconciled): i128 {
  let w = bankAssetWeight(bank, req);
  const tag = bank.emode.emode_tag;
  if (tag !== 0n)
    for (let m = 0n; m < toU64(r.count); m++)
      if (r.tags.get(m) === tag) {
        if (r.weights.get(m) > w) w = r.weights.get(m);
        break;
      }
  const state = bank.config.operational_state;
  if (
    r.same &&
    bank.mint === r.same_mint &&
    bank.config.oracle_keys.get(0n) === r.same_oracle &&
    feedFamily(bank.config.oracle_setup) === r.same_family &&
    bank.config.fixed_price.value === r.same_fixed &&
    (bank.flags & BANK_SAME_ASSET_EMODE_ELIGIBLE) !== 0n &&
    bank.config.risk_tier === RiskTier.Collateral &&
    !((state === BankOperationalState.Paused || state === BankOperationalState.ReduceOnly) && req === REQ_INITIAL) &&
    r.same_weight > w
  )
    w = r.same_weight;
  return w;
}

// ---- one balance ------------------------------------------------------------------------------------------------

/** A balance's weighted value, the price it took (biased), the price for the premium scratch, its error code. */
export interface Leg {
  err: u32;
  value: i128;
  price: i128;
  premium: i128;
  code: u32;
}

/** Bank::asset_weight_init_discount: deposits past the bank's USD cap count in proportion to it (MathError on overflow). */
function initDiscount(bank: Account<Bank>, price: i128): Fx {
  const limit = bank.config.total_asset_value_init_limit;
  if (limit === 0n) return { err: 0n, v: I80F48_ONE };
  const amount = fxTryMul(bank.total_asset_shares.value, bank.asset_share_value.value);
  if (amount.err !== 0n) return amount;
  const deposits = calcValueChecked(amount.v, price, bank.mint_decimals, I80F48_ZERO, false);
  if (deposits.err !== 0n) return deposits;
  const l = fxFromU64(limit);
  if (deposits.v > l) return fxTryDiv(l, deposits.v);
  return { err: 0n, v: I80F48_ONE };
}

/**
 * calc_weighted_asset_value_standalone: an isolated bank's collateral is worth nothing; a paused or reduce-only bank's
 * nothing for Initial (its price still taken for the premium scratch); a failed oracle skips the leg for Initial (its
 * code recorded) and fails the others; else the low-biased price × the weight (cut by the deposit cap for Initial).
 */
export function assetLeg(bank: Account<Bank>, f: Feed, req: u8, r: Reconciled, shares: i128, needPremium: boolean): Leg {
  if (bank.config.risk_tier === RiskTier.Isolated) return { err: 0n, value: 0n, price: 0n, premium: 0n, code: 0n };
  const realTime = req === REQ_MAINTENANCE;
  const state = bank.config.operational_state;
  if ((state === BankOperationalState.Paused || state === BankOperationalState.ReduceOnly) && req === REQ_INITIAL) {
    if (!needPremium || f.err !== 0n) return { err: 0n, value: 0n, price: 0n, premium: 0n, code: 0n };
    const p = priceOfType(f, realTime, BIAS_LOW, U32_MAX_CONFIDENCE);
    if (p.err !== 0n) return { err: p.err, value: 0n, price: 0n, premium: 0n, code: 0n };
    return { err: 0n, value: 0n, price: 0n, premium: p.v, code: 0n };
  }
  // A runtime error that is not a custom code records as `MarginfiError::InternalLogicError as u32`: the variant's
  // index, 0, so nothing is recorded; re-raised (Maintenance) it is MarginfiError::from(0), InternalLogicError.
  if (f.err !== 0n) {
    if (req === REQ_INITIAL) return { err: 0n, value: 0n, price: 0n, premium: 0n, code: f.err === ERR_BORSH ? 0n : f.err };
    return { err: f.err === ERR_BORSH ? 6000n : f.err, value: 0n, price: 0n, premium: 0n, code: 0n };
  }
  let w = assetWeight(bank, req, r);
  const lower = priceOfType(f, realTime, BIAS_LOW, bank.config.oracle_max_confidence);
  if (lower.err !== 0n) return { err: lower.err, value: 0n, price: 0n, premium: 0n, code: 0n };
  if (req === REQ_INITIAL) {
    const d = initDiscount(bank, lower.v);
    if (d.err !== 0n) return { err: d.err, value: 0n, price: 0n, premium: 0n, code: 0n };
    if (d.v < I80F48_ONE) {
      const m = fxTryMul(w, d.v);
      if (m.err !== 0n) return { err: m.err, value: 0n, price: 0n, premium: 0n, code: 0n };
      w = m.v;
    }
  }
  const amount = fxTryMul(shares, bank.asset_share_value.value);
  if (amount.err !== 0n) return { err: amount.err, value: 0n, price: 0n, premium: 0n, code: 0n };
  const v = calcValue(amount.v, lower.v, bank.mint_decimals, w, true);
  if (v.err !== 0n) return { err: v.err, value: 0n, price: 0n, premium: 0n, code: 0n };
  return { err: 0n, value: v.v, price: lower.v, premium: needPremium ? lower.v : 0n, code: 0n };
}

/** calc_weighted_liab_value_standalone: a failed oracle fails it; else the high-biased price × the liability weight. */
export function liabilityLeg(bank: Account<Bank>, f: Feed, req: u8, shares: i128): Leg {
  // A runtime error that is not a custom code becomes `InvalidOracleSetup as u32` (the variant's index, 25), which
  // MarginfiError::from does not know: InternalLogicError.
  if (f.err !== 0n) return { err: f.err === ERR_BORSH ? 6000n : f.err, value: 0n, price: 0n, premium: 0n, code: 0n };
  const higher = priceOfType(f, req === REQ_MAINTENANCE, BIAS_HIGH, bank.config.oracle_max_confidence);
  if (higher.err !== 0n) return { err: higher.err, value: 0n, price: 0n, premium: 0n, code: 0n };
  const amount = fxTryMul(shares, bank.liability_share_value.value);
  if (amount.err !== 0n) return { err: amount.err, value: 0n, price: 0n, premium: 0n, code: 0n };
  const v = calcValue(amount.v, higher.v, bank.mint_decimals, liabilityWeight(bank, req), true);
  if (v.err !== 0n) return { err: v.err, value: 0n, price: 0n, premium: 0n, code: 0n };
  return { err: 0n, value: v.v, price: higher.v, premium: 0n, code: 0n };
}

/** accrued_premium_total: the receivable plus simple interest at the snapshot rate since the last claim. */
function accruedPremium(liability: i128, rate: u32, outstanding: i128, elapsed: u64): Fx {
  if (rate === 0n || elapsed === 0n || liability <= I80F48_ZERO) return fxTryAdd(outstanding, I80F48_ZERO);
  const years = fxTryDiv(fxFromU64(elapsed), SECONDS_PER_YEAR);
  if (years.err !== 0n) return years;
  const a = fxTryMul(liability, u32ToMilli(rate));
  if (a.err !== 0n) return a;
  const b = fxTryMul(a.v, years.v);
  if (b.err !== 0n) return b;
  return fxTryAdd(outstanding, b.v);
}
/** premium_elapsed_seconds: since the last claim, never before the bank's premium activation; 0 for a fresh balance. */
function premiumElapsed(lastUpdate: u64, activatedAt: i64, now: u64): u64 {
  if (lastUpdate === 0n) return 0n;
  const activated = activatedAt > 0n ? toU64(activatedAt) : 0n;
  const from = lastUpdate > activated ? lastUpdate : activated;
  return now > from ? now - from : 0n;
}

// ---- the health pass --------------------------------------------------------------------------------------------

/**
 * What get_health_components gives: the totals (or the error that stopped it), what it writes into the health cache,
 * and the premium scratch (`s_*`, one entry per asset or liability leg, at most 16).
 */
export interface Health {
  err: u32;
  assets: i128;
  liabs: i128;
  err_index: u8;
  internal_err: u32;
  prices: FixedArray<u64, 16>;
  emode_boosted: boolean;
  s_count: u8;
  s_complete: boolean;
  s_value: FixedArray<i128, 16>;
  s_activated: FixedArray<i64, 16>;
  s_tag: FixedArray<u16, 16>;
  s_index: FixedArray<u8, 16>;
  s_flags: FixedArray<u8, 16>;
}

/**
 * get_health_components (live prices): each active balance's bank and oracles from `rest` (from `start`), its value
 * weighted for `req`, the premium its liability projects; with `scratch`, the legs the premium rates are weighed on.
 */
export function healthComponents(
  acc: Account<MarginfiAccount>,
  group: Account<MarginfiGroup>,
  rest: RemainingAccounts,
  start: u64,
  req: u8,
  scratch: boolean,
  t: i64,
): Health {
  const h: Health = {
    err: 0n,
    assets: I80F48_ZERO,
    liabs: I80F48_ZERO,
    err_index: NO_INDEX,
    internal_err: 0n,
    prices: fixedArray<u64, 16>(0n),
    emode_boosted: false,
    s_count: 0n,
    s_complete: false,
    s_value: fixedArray<i128, 16>(0n),
    s_activated: fixedArray<i64, 16>(0n),
    s_tag: fixedArray<u16, 16>(0n),
    s_index: fixedArray<u8, 16>(0n),
    s_flags: fixedArray<u8, 16>(0n),
  };
  if ((acc.account_flags & ACCOUNT_IN_FLASHLOAN) !== 0n) {
    h.err = 6037n;
    return h;
  }
  const r = reconcileEmode(acc, group, rest, start, req);
  const pricePremium = group.premium_settings.entry_count > 0n;
  const emodePossible = req === REQ_MAINTENANCE && (r.count > 0n || r.same);
  let collateralSeen = false;
  let unboosted = false;
  let unpriceableLeg = false;
  const now = toU64(t);
  const len = rest.length - start;
  let at = 0n;
  let pos = 0n;
  for (let i = 0n; i < 16n; i++) {
    const b = acc.lending_account.balances.get(i);
    if (b.active === 0n) continue;
    if (at >= len) {
      h.err = INVALID_BANK_ACCOUNT;
      return h;
    }
    const loadErr = loaderErr(rest.get(start + at));
    if (loadErr !== 0n) {
      h.err = loadErr;
      return h;
    }
    const bank = loadAccount<Bank>(rest.get(start + at));
    if (bank.key !== b.bank_pk) {
      h.err = INVALID_BANK_ACCOUNT;
      return h;
    }
    const per = accountsPerBank(bank);
    if (per.err !== 0n) {
      h.err = per.err;
      return h;
    }
    if (len < at + per.n) {
      h.err = WRONG_NUMBER_OF_ORACLE_ACCOUNTS;
      return h;
    }
    const f = feedAt(bank, rest, start + at + 1n, per.n - 1n, t);
    // Balance::get_side asserts the balance is not both.
    const assets = b.asset_shares.value;
    const liabs = b.liability_shares.value;
    require(assets < EMPTY_BALANCE_THRESHOLD || liabs < EMPTY_BALANCE_THRESHOLD, MarginfiError.InternalLogicError);
    const side: u8 = liabs >= EMPTY_BALANCE_THRESHOLD ? 2n : assets >= EMPTY_BALANCE_THRESHOLD ? 1n : 0n;
    const countable = bank.config.risk_tier !== RiskTier.Isolated && bank.config.asset_weight_maint.value > I80F48_ZERO;
    const needPremium = scratch && pricePremium && side === 1n && countable;
    const unpriceable = needPremium && f.err !== 0n;
    if (unpriceable) unpriceableLeg = true;
    const leg: Leg =
      side === 1n
        ? assetLeg(bank, f, req, r, assets, needPremium)
        : side === 2n
          ? liabilityLeg(bank, f, req, liabs)
          : { err: 0n, value: I80F48_ZERO, price: I80F48_ZERO, premium: I80F48_ZERO, code: 0n };
    if (leg.err !== 0n) {
      h.err = leg.err;
      return h;
    }
    if (emodePossible && assets >= EMPTY_BALANCE_THRESHOLD) {
      collateralSeen = true;
      if (assetWeight(bank, req, r) <= bankAssetWeight(bank, req)) unboosted = true;
    }
    if (leg.code !== 0n && h.err_index === NO_INDEX) {
      h.err_index = toU8(pos);
      h.internal_err = leg.code;
    }
    if (req === REQ_INITIAL) h.prices.set(pos, fxToF64Bits(leg.price));
    // premium_liability_value: the receivable a premium-active liability projects, weighted like the debt.
    let premium = I80F48_ZERO;
    if ((bank.flags & PREMIUM_ACTIVE) !== 0n && side === 2n) {
      const debt = fxTryMul(liabs, bank.liability_share_value.value);
      const total = debt.err !== 0n ? debt : accruedPremium(debt.v, b.premium_rate_snapshot, b.premium_outstanding.value, premiumElapsed(b.last_update, bank.premium_activated_at, now));
      if (total.err !== 0n) {
        h.err = total.err;
        return h;
      }
      if (total.v > I80F48_ZERO && leg.price > I80F48_ZERO) {
        const v = calcValueChecked(total.v, leg.price, bank.mint_decimals, liabilityWeight(bank, req), true);
        if (v.err !== 0n) {
          h.err = v.err;
          return h;
        }
        premium = v.v;
      }
    }
    // collect_premium_scratch_entry
    if (scratch && side !== 0n) {
      let value = I80F48_ZERO;
      let flags: u8 = 0n;
      let activated: i64 = 0n;
      if (side === 1n) {
        if (leg.premium > I80F48_ZERO && countable) {
          const amount = fxTryMul(assets, bank.asset_share_value.value);
          const usd = amount.err !== 0n ? amount : calcValue(amount.v, leg.premium, bank.mint_decimals, I80F48_ZERO, false);
          if (usd.err !== 0n) {
            h.err = usd.err;
            return h;
          }
          value = usd.v;
        }
        flags = unpriceable ? SCRATCH_ASSET | SCRATCH_UNPRICEABLE : SCRATCH_ASSET;
      } else {
        const debt = fxTryMul(liabs, bank.liability_share_value.value);
        if (debt.err !== 0n) {
          h.err = debt.err;
          return h;
        }
        value = debt.v;
        activated = bank.premium_activated_at;
        flags = (bank.flags & PREMIUM_ACTIVE) !== 0n ? SCRATCH_LIABILITY | SCRATCH_PREMIUM_ACTIVE : SCRATCH_LIABILITY;
      }
      const n = toU64(h.s_count);
      if (n < 16n) {
        h.s_value.set(n, value);
        h.s_activated.set(n, activated);
        h.s_tag.set(n, bank.premium_tag);
        h.s_index.set(n, toU8(i));
        h.s_flags.set(n, flags);
        h.s_count += 1n;
      }
    }
    const a = fxTryAdd(h.assets, side === 1n ? leg.value : I80F48_ZERO);
    if (a.err !== 0n) {
      h.err = a.err;
      return h;
    }
    const l1 = fxTryAdd(h.liabs, side === 2n ? leg.value : I80F48_ZERO);
    if (l1.err !== 0n) {
      h.err = l1.err;
      return h;
    }
    const l2 = fxTryAdd(l1.v, premium);
    if (l2.err !== 0n) {
      h.err = l2.err;
      return h;
    }
    h.assets = a.v;
    h.liabs = l2.v;
    at += per.n;
    pos += 1n;
  }
  if (scratch) h.s_complete = !unpriceableLeg;
  h.emode_boosted = collateralSeen && !unboosted;
  return h;
}

/**
 * check_account_risk_tiers: the same walk (no oracle check); an isolated liability must be the account's only one
 * (counting stops at the second isolated one).
 */
export function riskTiersErr(acc: Account<MarginfiAccount>, rest: RemainingAccounts, start: u64): u32 {
  let isolated = 0n;
  let total = 0n;
  let at = 0n;
  for (let i = 0n; i < 16n; i++) {
    const b = acc.lending_account.balances.get(i);
    if (b.active === 0n) continue;
    if (at >= rest.length - start) return INVALID_BANK_ACCOUNT;
    const loadErr = loaderErr(rest.get(start + at));
    if (loadErr !== 0n) return loadErr;
    const bank = loadAccount<Bank>(rest.get(start + at));
    if (bank.key !== b.bank_pk) return INVALID_BANK_ACCOUNT;
    const per = accountsPerBank(bank);
    if (per.err !== 0n) return per.err;
    if (b.liability_shares.value >= EMPTY_BALANCE_THRESHOLD) {
      total += 1n;
      if (bank.config.risk_tier === RiskTier.Isolated) {
        isolated += 1n;
        if (isolated > 1n) break;
      }
    }
    at += per.n;
  }
  return isolated === 0n || total === 1n ? 0n : 6029n;
}

// ---- premium snapshots ------------------------------------------------------------------------------------------

/** PremiumScratch::refresh_unavailable: an incomplete pass while the account owes a premium-active bank. */
export function premiumRefreshUnavailable(h: Health): boolean {
  if (h.s_complete) return false;
  for (let e = 0n; e < toU64(h.s_count); e++) {
    const f = h.s_flags.get(e);
    if ((f & SCRATCH_LIABILITY) !== 0n && (f & SCRATCH_PREMIUM_ACTIVE) !== 0n) return true;
  }
  return false;
}

/** MarginfiGroup::find_premium_rate: Rust's binary search over the sorted (collateral, liability) entries. */
export function findPremiumRate(group: Account<MarginfiGroup>, collateral: u16, liability: u16): u32 {
  if (collateral === 0n || liability === 0n) return 0n;
  let size = toU64(group.premium_settings.entry_count);
  if (size > 64n) size = 64n;
  if (size === 0n) return 0n;
  const target = (toU64(collateral) << 16n) | toU64(liability);
  let base = 0n;
  while (size > 1n) {
    const half = size / 2n;
    const mid = base + half;
    const e = group.premium_entries.get(mid);
    if (((toU64(e.collateral_tag) << 16n) | toU64(e.liability_tag)) <= target) base = mid;
    size -= half;
  }
  const e = group.premium_entries.get(base);
  return ((toU64(e.collateral_tag) << 16n) | toU64(e.liability_tag)) === target ? e.rate : 0n;
}

/**
 * update_premium_snapshots: each premium-active liability claims its premium at its old rate, then takes the rate
 * its collateral mix weighs to (a premium-inactive one is written off). An incomplete pass writes nothing, or with
 * `ratchet` only raises rates: to the old rate, and to the full pair rate of each collateral it could not price.
 */
export function updatePremiumSnapshots(acc: Mut<MarginfiAccount>, group: Account<MarginfiGroup>, h: Health, now: u64, ratchet: boolean): void {
  if (!h.s_complete && !ratchet) return;
  const ratcheting = !h.s_complete;
  const n = toU64(h.s_count);
  let total = I80F48_ZERO;
  for (let e = 0n; e < n; e++)
    if ((h.s_flags.get(e) & SCRATCH_ASSET) !== 0n) {
      const s = fxTryAdd(total, h.s_value.get(e));
      require(s.err === 0n, MarginfiError.MathError);
      total = s.v;
    }
  for (let e = 0n; e < n; e++) {
    if ((h.s_flags.get(e) & SCRATCH_LIABILITY) === 0n) continue;
    const i = toU64(h.s_index.get(e));
    const b = acc.lending_account.balances.get(i);
    if (b.active === 0n || b.liability_shares.value < EMPTY_BALANCE_THRESHOLD) continue;
    if ((h.s_flags.get(e) & SCRATCH_PREMIUM_ACTIVE) === 0n) {
      writeOffPremium(acc, i);
      acc.lending_account.balances.get(i).last_update = now;
      continue;
    }
    claimPremium(acc, i, h.s_value.get(e), h.s_activated.get(e), now);
    const liabilityTag = h.s_tag.get(e);
    let rate: u32 = 0n;
    if (total > I80F48_ZERO) {
      let weighted = I80F48_ZERO;
      for (let c = 0n; c < n; c++) {
        if ((h.s_flags.get(c) & SCRATCH_ASSET) === 0n || h.s_value.get(c) <= I80F48_ZERO) continue;
        const pair = findPremiumRate(group, h.s_tag.get(c), liabilityTag);
        if (pair === 0n) continue;
        const m = fxTryMul(h.s_value.get(c), u32ToMilli(pair));
        require(m.err === 0n, MarginfiError.MathError);
        const s = fxTryAdd(weighted, m.v);
        require(s.err === 0n, MarginfiError.MathError);
        weighted = s.v;
      }
      const q = fxTryDiv(weighted, total);
      require(q.err === 0n, MarginfiError.MathError);
      rate = milliToU32(q.v);
    }
    if (ratcheting) {
      const old = acc.lending_account.balances.get(i).premium_rate_snapshot;
      if (old > rate) rate = old;
      for (let c = 0n; c < n; c++)
        if ((h.s_flags.get(c) & SCRATCH_ASSET) !== 0n && (h.s_flags.get(c) & SCRATCH_UNPRICEABLE) !== 0n) {
          const pair = findPremiumRate(group, h.s_tag.get(c), liabilityTag);
          if (pair > rate) rate = pair;
        }
    }
    acc.lending_account.balances.get(i).premium_rate_snapshot = rate;
  }
}

// ---- prices by bank, the circuit-breaker gate, the health cache -------------------------------------------------

/** Where a bank's oracle accounts are in `rest`, or the error finding them. */
export interface Oracles {
  err: u32;
  first: u64;
  count: u64;
}

/** oracle_accounts_for_bank: after the first remaining account with the bank's key (BankAccountNotFound if none). */
export function oraclesOf(bank: Account<Bank>, bankKey: Pubkey, rest: RemainingAccounts, start: u64): Oracles {
  const per = accountsPerBank(bank);
  if (per.err !== 0n) return { err: per.err, first: 0n, count: 0n };
  let found = rest.length;
  for (let i = start; i < rest.length; i++)
    if (rest.get(i).key === bankKey) {
      found = i;
      break;
    }
  if (found === rest.length) return { err: 6018n, first: 0n, count: 0n };
  if (found + per.n > rest.length) return { err: WRONG_NUMBER_OF_ORACLE_ACCOUNTS, first: 0n, count: 0n };
  return { err: 0n, first: found + 1n, count: per.n - 1n };
}

/** fetch_asset_price_for_bank_low_bias: the spot price less its confidence interval. */
export function lowPrice(bank: Account<Bank>, bankKey: Pubkey, rest: RemainingAccounts, start: u64, t: i64): Fx {
  const o = oraclesOf(bank, bankKey, rest, start);
  if (o.err !== 0n) return { err: o.err, v: 0n };
  const f = feedAt(bank, rest, o.first, o.count, t);
  if (f.err !== 0n) return { err: f.err, v: 0n };
  return priceOfType(f, true, BIAS_LOW, bank.config.oracle_max_confidence);
}

/** fetch_unbiased_price_for_bank_cache: the spot price and its confidence, for the bank's price cache. */
export function cachePrice(bank: Account<Bank>, bankKey: Pubkey, rest: RemainingAccounts, start: u64, t: i64): PriceConf {
  const o = oraclesOf(bank, bankKey, rest, start);
  if (o.err !== 0n) return { err: o.err, price: 0n, conf: 0n, source_time: 0n };
  const f = feedAt(bank, rest, o.first, o.count, t);
  if (f.err !== 0n) return { err: f.err, price: 0n, conf: 0n, source_time: 0n };
  return priceAndConfidence(f, true, bank.config.oracle_max_confidence);
}

/**
 * run_cb_price_gate: every bank of the account must not be halted or circuit-broken, and each with its breaker on
 * must price (spot) within its first tier and its long window of the breaker's references.
 */
export function cbPriceGate(acc: Account<MarginfiAccount>, rest: RemainingAccounts, start: u64, t: i64): u32 {
  let at = 0n;
  for (let i = 0n; i < 16n; i++) {
    const b = acc.lending_account.balances.get(i);
    if (b.active === 0n) continue;
    if (at >= rest.length - start) return INVALID_BANK_ACCOUNT;
    const loadErr = loaderErr(rest.get(start + at));
    if (loadErr !== 0n) return loadErr;
    const bank = loadAccount<Bank>(rest.get(start + at));
    if (bank.key !== b.bank_pk) return INVALID_BANK_ACCOUNT;
    const on = (bank.flags & CIRCUIT_BREAKER_ENABLED) !== 0n;
    if ((on && bank.cb_tier > 0n && t < bank.cb_halt_ended_at) || bank.config.operational_state === BankOperationalState.CircuitBroken) return 6600n;
    const per = accountsPerBank(bank);
    if (per.err !== 0n) return per.err;
    if (on) {
      if (rest.length - start < at + per.n) return WRONG_NUMBER_OF_ORACLE_ACCOUNTS;
      const f = feedAt(bank, rest, start + at + 1n, per.n - 1n, t);
      if (f.err !== 0n) return f.err;
      const p = priceAndConfidence(f, true, bank.config.oracle_max_confidence);
      if (p.err !== 0n) return p.err;
      const g = cbPriceGateErr(bank, p.price, p.conf);
      if (g !== 0n) return g;
    }
    at += per.n;
  }
  return 0n;
}

/** The health cache's flags. */
export const HEALTH_HEALTHY: u32 = 1n;
export const HEALTH_ENGINE_OK: u32 = 2n;
const PROGRAM_VERSION: u8 = 3n;

/**
 * The account's health cache after a withdrawal or borrow: zeroed (HealthCache::zeroed), the time, the Initial pass's
 * values, prices (f64, little-endian) and first oracle error with HEALTHY (unless skipped, in a flash loan), the
 * engine marked OK, version 3.
 */
export function writeHealthCache(acc: Mut<MarginfiAccount>, h: Health, t: i64, ran: boolean): void {
  const c = acc.health_cache;
  c.asset_value.value = ran ? h.assets : I80F48_ZERO;
  c.liability_value.value = ran ? h.liabs : I80F48_ZERO;
  c.asset_value_maint.value = I80F48_ZERO;
  c.liability_value_maint.value = I80F48_ZERO;
  c.asset_value_equity.value = I80F48_ZERO;
  c.liability_value_equity.value = I80F48_ZERO;
  c.timestamp = t;
  c.flags = ran ? HEALTH_HEALTHY | HEALTH_ENGINE_OK : HEALTH_ENGINE_OK;
  c.mrgn_err = 0n;
  for (let p = 0n; p < 16n; p++) c.prices.set(p, ran ? h.prices.get(p) : 0n);
  const found = ran && h.err_index !== NO_INDEX;
  c.internal_err = found ? h.internal_err : 0n;
  c.err_index = found ? h.err_index : 0n;
  c.program_version = PROGRAM_VERSION;
  c.pad0.set(0n, 0n);
  c.pad0.set(1n, 0n);
  c.internal_liq_err = 0n;
  c.internal_bankruptcy_err = 0n;
  for (let j = 0n; j < 32n; j++) c.reserved0.set(j, 0n);
  for (let j = 0n; j < 16n; j++) c.reserved1.set(j, 0n);
}

// ---- pulse_health -----------------------------------------------------------------------------------------------

/** MarginfiError::is_oracle_error (a code MarginfiError::from does not know is InternalLogicError, not one). */
export function isOracleError(code: u32): boolean {
  switch (code) {
    case 6005n: // MissingPythOrBankAccount
    case 6006n: // MissingPythAccount
    case 6007n: // MissingBankAccount
    case 6008n: // InvalidBankAccount
    case 6048n: // StakePoolValidationFailed
    case 6049n: // SwitchboardStalePrice
    case 6050n: // PythPushStalePrice
    case 6051n: // WrongNumberOfOracleAccounts
    case 6052n: // WrongOracleAccountKeys
    case 6055n: // OracleMaxConfidenceExceeded
    case 6056n: // PythPushInsufficientVerificationLevel
    case 6059n: // SwitchboardWrongAccountOwner
    case 6060n: // PythPushInvalidAccount
    case 6061n: // SwitchboardInvalidAccount
    case 6076n: // PythPushInvalidWindowSize
    case 6092n: // ZeroSupplyInStakePool
    case 6136n: // MarinadeStateValidationFailed
    case 6137n: // ExponentVaultValidationFailed
    case 6139n: // StakePoolStale
    case 6206n: // ReserveStale
    case 6322n: // DriftSpotMarketStale
    case 6411n: // SolendReserveStale
    case 6504n: // JuplendLendingStale
    case 6800n: // ScopeInvalidAccount
    case 6801n: // ScopeInvalidEntry
    case 6802n: // ScopeStalePrice
      return true;
  }
  return false;
}

/** compute_has_isolated_liability_flag: 1 when a liability is in an isolated bank (the same walk; errors as values). */
export function hasIsolatedLiability(acc: Account<MarginfiAccount>, rest: RemainingAccounts): Count {
  let found = false;
  let at = 0n;
  for (let i = 0n; i < 16n; i++) {
    const b = acc.lending_account.balances.get(i);
    if (b.active === 0n) continue;
    if (at >= rest.length) return { err: INVALID_BANK_ACCOUNT, n: 0n };
    const loadErr = loaderErr(rest.get(at));
    if (loadErr !== 0n) return { err: loadErr, n: 0n };
    const bank = loadAccount<Bank>(rest.get(at));
    if (bank.key !== b.bank_pk) return { err: INVALID_BANK_ACCOUNT, n: 0n };
    const per = accountsPerBank(bank);
    if (per.err !== 0n) return { err: per.err, n: 0n };
    if (b.liability_shares.value >= EMPTY_BALANCE_THRESHOLD && bank.config.risk_tier === RiskTier.Isolated) found = true;
    at += per.n;
  }
  return { err: 0n, n: found ? 1n : 0n };
}
