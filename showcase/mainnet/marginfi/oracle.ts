// Marginfi's price adapter (programs/marginfi/src/state/price.rs @ c5d440f6) for the setups a bank of the default, SOL
// or staked kind prices with: a Pyth push feed (PriceUpdateV2, Borsh), a Switchboard pull feed (PullFeedAccountData,
// fixed offsets) and a fixed price. Setups that need another program's state for a multiplier (Kamino, Drift, Solend,
// JupLend, mSOL, LST, Exponent PT, Scope, staked SOL pricing) are not ported: the port aborts where it would read them.
//
// Errors are values here (`err`, 0 when there is none), as the original's are `Result`s its risk engine sometimes keeps
// instead of returning; the instructions fail with them (`require(r.err === 0n, r.err)`). Panics abort.
import {
  type Account,
  type RemainingAccount,
  type i128,
  type i32,
  type i64,
  type u32,
  type u64,
  type u8,
  i64 as toI64,
  pubkey,
  readData,
  require,
  u64 as toU64,
} from "typesol";
import { ASSET_TAG_JUPLEND, BANK_ASSET_TAG_STAKED, saturatingAddI64, saturatingSubI64 } from "./bank";
import { MarginfiError } from "./errors";
import { type Fx, exp10Fx, fxFromI128Wrapping, fxFromI64, fxFromU64, fxMin, fxTryAdd, fxTryDiv, fxTryMul, fxTrySub } from "./i80f48";
import { U32_MAX_FX } from "./interest_rate";
import { type Bank, OracleSetup } from "./state";

/** Bank.config.asset_tag */
export const ASSET_TAG_DEFAULT: u8 = 0n;
export const ASSET_TAG_SOL: u8 = 1n;
const ASSET_TAG_KAMINO: u8 = 3n;
const ASSET_TAG_DRIFT: u8 = 4n;
const ASSET_TAG_SOLEND: u8 = 5n;

/** A Pyth account that does not Borsh-decode: the original fails with ProgramError::BorshIoError (not a custom code). */
export const ERR_BORSH: u32 = 1n;
export const WRONG_NUMBER_OF_ORACLE_ACCOUNTS: u32 = 6051n;
const WRONG_ORACLE_ACCOUNT_KEYS: u32 = 6052n;
const INVALID_ORACLE_SETUP: u32 = 6025n;
const ORACLE_NOT_SETUP: u32 = 6031n;

const SWITCHBOARD_PULL_ID = pubkey("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");
/** sha256("account:PriceUpdateV2")[..8] and PullFeedAccountData's discriminator, as little-endian u64s. */
const PRICE_UPDATE_V2_DISC: u64 = 14840625886530892066n;
const PULL_FEED_DISC: u64 = 2944183222661815236n;
/** CONF_INTERVAL_MULTIPLE (2.12) and MAX_CONF_INTERVAL (0.05). */
const CONF_INTERVAL_MULTIPLE: i128 = 596726950626591n;
const MAX_CONF_INTERVAL: i128 = 14073748835533n;
/** The default maximum Pyth confidence: u32::MAX / 10 (10%). */
const DEFAULT_MAX_CONFIDENCE: u32 = 429496729n;

/** OracleSetup as its u8 (the instruction arguments' form); 29 and up are not setups. */
export function setupOf(n: u8): OracleSetup {
  switch (n) {
    case 0n:
      return OracleSetup.None;
    case 1n:
      return OracleSetup.PythLegacy;
    case 2n:
      return OracleSetup.SwitchboardV2;
    case 3n:
      return OracleSetup.PythPushOracle;
    case 4n:
      return OracleSetup.SwitchboardPull;
    case 5n:
      return OracleSetup.StakedWithPythPush;
    case 6n:
      return OracleSetup.KaminoPythPush;
    case 7n:
      return OracleSetup.KaminoSwitchboardPull;
    case 8n:
      return OracleSetup.Fixed;
    case 9n:
      return OracleSetup.DriftPythPull;
    case 10n:
      return OracleSetup.DriftSwitchboardPull;
    case 11n:
      return OracleSetup.SolendPythPull;
    case 12n:
      return OracleSetup.SolendSwitchboardPull;
    case 13n:
      return OracleSetup.FixedKamino;
    case 14n:
      return OracleSetup.FixedDrift;
    case 15n:
      return OracleSetup.JuplendPythPull;
    case 16n:
      return OracleSetup.JuplendSwitchboardPull;
    case 17n:
      return OracleSetup.FixedJuplend;
    case 18n:
      return OracleSetup.Scope;
    case 19n:
      return OracleSetup.PythMSOL;
    case 20n:
      return OracleSetup.KaminoMSOL;
    case 21n:
      return OracleSetup.JuplendMSOL;
    case 22n:
      return OracleSetup.PythLST;
    case 23n:
      return OracleSetup.KaminoLST;
    case 24n:
      return OracleSetup.JuplendLST;
    case 25n:
      return OracleSetup.PTPyth;
    case 26n:
      return OracleSetup.PTFixed;
    case 27n:
      return OracleSetup.ScopeKamino;
    case 28n:
      return OracleSetup.ScopeJuplend;
  }
  // OracleSetup::from_u8(..).unwrap_or_else(|| panic!("unsupported oracle type")); here InternalLogicError.
  require(false, MarginfiError.InternalLogicError);
  return OracleSetup.None;
}

/**
 * OracleSetup::feed_family: the kind of feed oracle_keys[0] is (0 when it names no feed another setup could share):
 * 1 Pyth push, 2 staked Pyth push, 3 Switchboard pull, 4 mSOL, 5 LST, 6 PT on Pyth.
 */
export function feedFamily(s: OracleSetup): u8 {
  switch (s) {
    case OracleSetup.PythPushOracle:
    case OracleSetup.KaminoPythPush:
    case OracleSetup.DriftPythPull:
    case OracleSetup.SolendPythPull:
    case OracleSetup.JuplendPythPull:
      return 1n;
    case OracleSetup.StakedWithPythPush:
      return 2n;
    case OracleSetup.SwitchboardPull:
    case OracleSetup.KaminoSwitchboardPull:
    case OracleSetup.DriftSwitchboardPull:
    case OracleSetup.SolendSwitchboardPull:
    case OracleSetup.JuplendSwitchboardPull:
      return 3n;
    case OracleSetup.PythMSOL:
    case OracleSetup.KaminoMSOL:
    case OracleSetup.JuplendMSOL:
      return 4n;
    case OracleSetup.PythLST:
    case OracleSetup.KaminoLST:
    case OracleSetup.JuplendLST:
      return 5n;
    case OracleSetup.PTPyth:
      return 6n;
  }
  return 0n;
}

/** The asset tag a venue setup belongs to (its validation's first check); 255 for the setups ported here. */
function venueTag(s: OracleSetup): u8 {
  switch (s) {
    case OracleSetup.KaminoPythPush:
    case OracleSetup.KaminoSwitchboardPull:
    case OracleSetup.FixedKamino:
    case OracleSetup.ScopeKamino:
    case OracleSetup.KaminoMSOL:
    case OracleSetup.KaminoLST:
      return ASSET_TAG_KAMINO;
    case OracleSetup.DriftPythPull:
    case OracleSetup.DriftSwitchboardPull:
    case OracleSetup.FixedDrift:
      return ASSET_TAG_DRIFT;
    case OracleSetup.SolendPythPull:
    case OracleSetup.SolendSwitchboardPull:
      return ASSET_TAG_SOLEND;
    case OracleSetup.JuplendPythPull:
    case OracleSetup.JuplendSwitchboardPull:
    case OracleSetup.FixedJuplend:
    case OracleSetup.ScopeJuplend:
    case OracleSetup.JuplendMSOL:
    case OracleSetup.JuplendLST:
      return ASSET_TAG_JUPLEND;
    case OracleSetup.PythMSOL:
    case OracleSetup.PythLST:
    case OracleSetup.PTPyth:
    case OracleSetup.PTFixed:
      return ASSET_TAG_DEFAULT;
  }
  return 255n;
}

/** Whether this setup reads its feed account (oracle_keys[0]) and nothing else. */
function readsOneFeed(s: OracleSetup): boolean {
  return s === OracleSetup.PythPushOracle || s === OracleSetup.SwitchboardPull || s === OracleSetup.StakedWithPythPush;
}

// ---- validation (OraclePriceFeedAdapter::validate_bank_config, the light form configure_bank_oracle uses) ----------

/**
 * What validation decides before reading an account: the asset tag, then the number of accounts. 0 means the setup
 * reads the one account given (validateFeedAccount next).
 */
export function validateOracleCount(bank: Account<Bank>, n: u64): u32 {
  const s = bank.config.oracle_setup;
  const tag = bank.config.asset_tag;
  if (s === OracleSetup.None) return ORACLE_NOT_SETUP;
  // Both panic as deprecated in the original.
  require(s !== OracleSetup.PythLegacy && s !== OracleSetup.SwitchboardV2, MarginfiError.InternalLogicError);
  if (s === OracleSetup.PythPushOracle || s === OracleSetup.SwitchboardPull) {
    if (tag !== ASSET_TAG_DEFAULT && tag !== ASSET_TAG_SOL) return INVALID_ORACLE_SETUP;
    return n === 1n ? 0n : WRONG_NUMBER_OF_ORACLE_ACCOUNTS;
  }
  if (s === OracleSetup.StakedWithPythPush) {
    if (tag !== BANK_ASSET_TAG_STAKED) return INVALID_ORACLE_SETUP;
    return n === 1n ? 0n : WRONG_NUMBER_OF_ORACLE_ACCOUNTS;
  }
  if (s === OracleSetup.Fixed) {
    if (tag !== ASSET_TAG_DEFAULT) return INVALID_ORACLE_SETUP;
    return n === 0n ? 0n : WRONG_NUMBER_OF_ORACLE_ACCOUNTS;
  }
  if (s === OracleSetup.Scope && tag !== ASSET_TAG_DEFAULT && tag !== ASSET_TAG_SOL) return INVALID_ORACLE_SETUP;
  if (s !== OracleSetup.Scope && tag !== venueTag(s)) return INVALID_ORACLE_SETUP;
  require(false, "TypeSOL port: this oracle setup's validation is not ported");
  return 0n;
}

/** Whether validation goes on to read one feed account (after validateOracleCount passed). */
export function validatesFeedAccount(bank: Account<Bank>): boolean {
  return readsOneFeed(bank.config.oracle_setup);
}

/** The feed account's checks: its key, then a Pyth update's discriminator and Borsh form or a Switchboard feed's. */
export function validateFeedAccount(bank: Account<Bank>, a: RemainingAccount): u32 {
  if (a.key !== bank.config.oracle_keys.get(0n)) return WRONG_ORACLE_ACCOUNT_KEYS;
  if (bank.config.oracle_setup === OracleSetup.SwitchboardPull) return switchboardAccountErr(a);
  return pythAccountErr(a);
}

// ---- reading feeds ----------------------------------------------------------------------------------------------

/** One feed as loaded (OraclePriceFeedAdapter): Pyth's spot and EMA pairs, or a Switchboard or fixed price. */
export interface Feed {
  err: u32;
  /** 3 Pyth push, 4 Switchboard pull, 8 fixed */
  kind: u8;
  price: i64;
  conf: u64;
  ema_price: i64;
  ema_conf: u64;
  exponent: i32;
  publish_time: i64;
  /** Switchboard's or the fixed price, as I80F48 bits */
  value: i128;
  source_time: i64;
}

/** OraclePriceWithConfidence */
export interface PriceConf {
  err: u32;
  price: i128;
  conf: i128;
  source_time: i64;
}

export function feedErr(err: u32): Feed {
  return { err, kind: 0n, price: 0n, conf: 0n, ema_price: 0n, ema_conf: 0n, exponent: 0n, publish_time: 0n, value: 0n, source_time: 0n };
}

/**
 * load_oracle_context's checks before an account is read: no setup, the number of accounts. 0 means the setup
 * reads the one account given (loadFeed next); a fixed price needs none (fixedFeed).
 */
export function oracleCount(bank: Account<Bank>, n: u64): u32 {
  const s = bank.config.oracle_setup;
  if (s === OracleSetup.None) return ORACLE_NOT_SETUP;
  // Both panic as deprecated in the original.
  require(s !== OracleSetup.PythLegacy && s !== OracleSetup.SwitchboardV2, MarginfiError.InternalLogicError);
  if (s === OracleSetup.PythPushOracle || s === OracleSetup.SwitchboardPull) return n === 1n ? 0n : WRONG_NUMBER_OF_ORACLE_ACCOUNTS;
  if (s === OracleSetup.Fixed) return n === 0n ? 0n : WRONG_NUMBER_OF_ORACLE_ACCOUNTS;
  require(false, "TypeSOL port: this oracle setup's pricing is not ported");
  return 0n;
}

/** The fixed price (`Fixed`): never negative. */
export function fixedFeed(bank: Account<Bank>): Feed {
  const v = bank.config.fixed_price.value;
  if (v < 0n) return feedErr(6100n);
  return { err: 0n, kind: 8n, price: 0n, conf: 0n, ema_price: 0n, ema_conf: 0n, exponent: 0n, publish_time: 0n, value: v, source_time: 0n };
}

/** A Pyth or Switchboard feed for the bank, read from its account: the key, the account, then its age. */
export function loadFeed(bank: Account<Bank>, a: RemainingAccount, t: i64): Feed {
  if (a.key !== bank.config.oracle_keys.get(0n)) return feedErr(WRONG_ORACLE_ACCOUNT_KEYS);
  const maxAge = toI64(bank.config.oracle_max_age);
  if (bank.config.oracle_setup === OracleSetup.SwitchboardPull) {
    const e = switchboardAccountErr(a);
    if (e !== 0n) return feedErr(e);
    const updated = readData<i64>(a, 2216n);
    if (saturatingSubI64(t, updated) > maxAge) return feedErr(6049n);
    return {
      err: 0n,
      kind: 4n,
      price: 0n,
      conf: 0n,
      ema_price: 0n,
      ema_conf: 0n,
      exponent: 0n,
      publish_time: 0n,
      value: readData<i128>(a, 2264n),
      source_time: updated,
    };
  }
  const e = pythAccountErr(a);
  if (e !== 0n) return feedErr(e);
  // Only a fully verified update is accepted (MIN_PYTH_PUSH_VERIFICATION_LEVEL), then its age.
  if (readData<u8>(a, 40n) === 0n) return feedErr(6056n);
  const publish = readData<i64>(a, 93n);
  if (saturatingAddI64(publish, maxAge) < t) return feedErr(6050n);
  return {
    err: 0n,
    kind: 3n,
    price: readData<i64>(a, 73n),
    conf: readData<u64>(a, 81n),
    ema_price: readData<i64>(a, 109n),
    ema_conf: readData<u64>(a, 117n),
    exponent: readData<i32>(a, 89n),
    publish_time: publish,
    value: 0n,
    source_time: publish,
  };
}

/**
 * load_price_update_v2_checked: at least the discriminator, then a Borsh PriceUpdateV2: write authority (32), a
 * verification level (1 = Full, or 0 = Partial and its signature count), the price message (84) and the posted slot.
 */
export function pythAccountErr(a: RemainingAccount): u32 {
  if (a.dataLen < 8n || readData<u64>(a, 0n) !== PRICE_UPDATE_V2_DISC) return 6060n;
  if (a.dataLen < 41n) return ERR_BORSH;
  const level = readData<u8>(a, 40n);
  if (level > 1n) return ERR_BORSH;
  return a.dataLen < (level === 1n ? 133n : 134n) ? ERR_BORSH : 0n;
}

/** SwitchboardPullPriceFeed::check_ais: the owner, then PullFeedAccountData::parse (discriminator, 3,200 bytes). */
function switchboardAccountErr(a: RemainingAccount): u32 {
  if (a.owner !== SWITCHBOARD_PULL_ID) return 6059n;
  if (a.dataLen < 3208n || readData<u64>(a, 0n) !== PULL_FEED_DISC) return 6061n;
  return 0n;
}

// ---- prices (PriceAdapter) --------------------------------------------------------------------------------------

/** pyth_price_components_to_i80f48: x scaled by 10^exponent (|exponent| of 24 or more panics, indexing EXP_10_I80F48). */
function pythScaled(x: i128, exponent: i32): Fx {
  const scale = exp10Fx(toU64(exponent < 0n ? -toI64(exponent) : toI64(exponent)));
  if (exponent === 0n) return { err: 0n, v: x };
  if (exponent < 0n) return fxTryDiv(x, scale);
  return fxTryMul(x, scale);
}

/** The feed's price, spot (RealTime) or EMA (TimeWeighted), without a bias. */
function rawPrice(f: Feed, realTime: boolean): Fx {
  if (f.kind === 3n) return pythScaled(fxFromI64(realTime ? f.price : f.ema_price), f.exponent);
  if (f.kind === 4n) return fxTryDiv(fxFromI128Wrapping(f.value), 281474976710656000000000000000000n);
  return { err: 0n, v: f.value };
}

/**
 * The confidence interval: Pyth's (2.12 × its confidence, failing past the bank's maximum or 10% of the price, then at
 * most 5%), Switchboard's (the configured share of the price, at most 5%; none when 0), none for a fixed price.
 */
function confidence(f: Feed, realTime: boolean, maxConfidence: u32): Fx {
  if (f.kind === 4n) {
    if (maxConfidence === 0n) return { err: 0n, v: 0n };
    const p = rawPrice(f, realTime);
    if (p.err !== 0n) return p;
    const scaled = fxTryMul(p.v, fxFromU64(toU64(maxConfidence)));
    if (scaled.err !== 0n) return scaled;
    const c = fxTryDiv(scaled.v, U32_MAX_FX);
    if (c.err !== 0n) return c;
    const cap = fxTryMul(p.v, MAX_CONF_INTERVAL);
    if (cap.err !== 0n) return cap;
    return { err: 0n, v: fxMin(c.v, cap.v) };
  }
  if (f.kind !== 3n) return { err: 0n, v: 0n };
  const raw = pythScaled(fxFromU64(realTime ? f.conf : f.ema_conf), f.exponent);
  if (raw.err !== 0n) return raw;
  const c = fxTryMul(raw.v, CONF_INTERVAL_MULTIPLE);
  if (c.err !== 0n) return c;
  const p = pythScaled(fxFromI64(realTime ? f.price : f.ema_price), f.exponent);
  if (p.err !== 0n) return p;
  const scaled = fxTryMul(p.v, fxFromU64(toU64(maxConfidence > 0n ? maxConfidence : DEFAULT_MAX_CONFIDENCE)));
  if (scaled.err !== 0n) return scaled;
  const max = fxTryDiv(scaled.v, U32_MAX_FX);
  if (max.err !== 0n) return max;
  if (c.v > max.v) return { err: 6055n, v: 0n };
  const cap = fxTryMul(p.v, MAX_CONF_INTERVAL);
  if (cap.err !== 0n) return cap;
  // assert!s in the original (a tiny negative price with no confidence reaches the first).
  require(cap.v >= 0n && c.v >= 0n, MarginfiError.InternalLogicError);
  return { err: 0n, v: fxMin(c.v, cap.v) };
}

/** PriceBias */
export const BIAS_NONE: u8 = 0n;
export const BIAS_LOW: u8 = 1n;
export const BIAS_HIGH: u8 = 2n;

/** get_price_of_type: the price, less (Low) or plus (High) the confidence interval. */
export function priceOfType(f: Feed, realTime: boolean, bias: u8, maxConfidence: u32): Fx {
  const p = rawPrice(f, realTime);
  if (p.err !== 0n || bias === BIAS_NONE || f.kind === 8n) return p;
  const c = confidence(f, realTime, maxConfidence);
  if (c.err !== 0n) return c;
  return bias === BIAS_LOW ? fxTrySub(p.v, c.v) : fxTryAdd(p.v, c.v);
}

/** get_price_and_confidence_of_type: the confidence interval first (it may fail), then the unbiased price. */
export function priceAndConfidence(f: Feed, realTime: boolean, maxConfidence: u32): PriceConf {
  const c = confidence(f, realTime, maxConfidence);
  if (c.err !== 0n) return { err: c.err, price: 0n, conf: 0n, source_time: 0n };
  const p = rawPrice(f, realTime);
  if (p.err !== 0n) return { err: p.err, price: 0n, conf: 0n, source_time: 0n };
  return { err: 0n, price: p.v, conf: c.v, source_time: f.source_time };
}
