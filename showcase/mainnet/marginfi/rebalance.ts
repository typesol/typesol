// Marginfi's rebalance execution helpers (programs/marginfi/src/instructions/marginfi_account/rebalance.rs,
// state/rate.rs and state/rebalance.rs @ c5d440f6): the referenced banks read from the remaining accounts, their
// supply rates, deposit room and token amounts, and the record's checks. Native banks only: a bank in a venue
// (Kamino, Drift, Solend, JupLend) prices from the venue's own state, which the port does not read yet.
import {
  type Account,
  type FixedArray,
  type Mut,
  type Pubkey,
  type RemainingAccounts,
  type i128,
  type i64,
  type u8,
  fixedArray,
  loadAccount,
  loadAccountMut,
  require,
  u64,
} from "typesol";
import { accrueInterest, updateBankCache } from "./bank";
import { MarginfiError } from "./errors";
import { I80F48_ONE, I80F48_ZERO, exp10Fx, fxAdd, fxDiv, fxFromU64, fxMul, fxSub } from "./i80f48";
import { multipointCurve } from "./interest_rate";
import { WRONG_NUMBER_OF_ORACLE_ACCOUNTS, priceAndConfidence } from "./oracle";
import { accountsPerBank, feedAt, loaderErr } from "./risk";
import { type Bank, type MarginfiAccount, type MarginfiGroup } from "./state";

const REB_U64_MAX: u64 = 18446744073709551615n;
/** I80F48::MAX: a bank without a deposit limit has room for anything. */
export const FX_MAX: i128 = 170141183460469231731687303715884105727n;

/** is_integration_asset_tag: Kamino, Drift, Solend and JupLend banks. */
export function isVenueBank(tag: u8): boolean {
  return tag === 3n || tag === 4n || tag === 5n || tag === 6n;
}

/** The referenced banks as parse_rebalance_banks finds them: each bank's account index, its oracles, and the end. */
export interface ParsedBanks {
  at: FixedArray<u64, 8>;
  first: FixedArray<u64, 8>;
  count: FixedArray<u64, 8>;
  end: u64;
}

/**
 * parse_rebalance_banks: `n` blocks of [bank, (JupLend's token reserve), (the venue's reward accounts), oracles], each
 * bank once (SameAssetAndLiabilityBanks), a bank of this program (InvalidBankAccount) in the group.
 */
export function parseBanks(rest: RemainingAccounts, group: Pubkey, n: u64, withRewards: boolean): ParsedBanks {
  const p: ParsedBanks = { at: fixedArray<u64, 8>(0n), first: fixedArray<u64, 8>(0n), count: fixedArray<u64, 8>(0n), end: 0n };
  let cursor = 0n;
  for (let i = 0n; i < n; i++) {
    require(rest.length > cursor, WRONG_NUMBER_OF_ORACLE_ACCOUNTS);
    const key = rest.get(cursor).key;
    for (let j = 0n; j < i; j++) require(rest.get(p.at.get(j)).key !== key, MarginfiError.SameAssetAndLiabilityBanks);
    require(loaderErr(rest.get(cursor)) === 0n, MarginfiError.InvalidBankAccount);
    const bank = loadAccount<Bank>(rest.get(cursor));
    p.at.set(i, cursor);
    cursor += 1n;
    require(bank.group === group, MarginfiError.InvalidGroup);
    const per = accountsPerBank(bank);
    require(per.err === 0n, per.err);
    const oracles = per.n > 0n ? per.n - 1n : 0n;
    const tag = bank.config.asset_tag;
    let extra = tag === 6n ? 1n : 0n;
    if (withRewards && tag === 3n) extra += 1n;
    if (withRewards && tag === 6n) extra += 3n;
    for (let k = 0n; k < extra; k++) {
      require(rest.length > cursor, WRONG_NUMBER_OF_ORACLE_ACCOUNTS);
      cursor += 1n;
    }
    require(rest.length >= cursor + oracles, WRONG_NUMBER_OF_ORACLE_ACCOUNTS);
    p.first.set(i, cursor);
    p.count.set(i, oracles);
    cursor += oracles;
  }
  p.end = cursor;
  return p;
}

/** accrue_native_bank: interest and the cache brought up to date (venue banks are refreshed by their venue). */
export function accrueNative(rest: RemainingAccounts, at: u64, group: Account<MarginfiGroup>, t: i64): void {
  const bank = loadAccountMut<Bank>(rest.get(at));
  if (isVenueBank(bank.config.asset_tag)) return;
  accrueInterest(bank, group, bank.key, t);
  updateBankCache(bank, group, t);
}

/**
 * venue_multiplier: 1 for a native bank, after its spot price reads (stale and wide prices refuse here too); venue
 * banks are not ported (RebalanceVenueUnsupported).
 */
export function venueMultiplier(bank: Account<Bank>, rest: RemainingAccounts, first: u64, count: u64, t: i64): i128 {
  require(!isVenueBank(bank.config.asset_tag), MarginfiError.RebalanceVenueUnsupported);
  const f = feedAt(bank, rest, first, count, t);
  require(f.err === 0n, f.err);
  const pc = priceAndConfidence(f, true, bank.config.oracle_max_confidence);
  require(pc.err === 0n, pc.err);
  return I80F48_ONE;
}

/**
 * NativeRateModel::rate_at: the lending rate after `extra` more native tokens are deposited (the curve's base rate at
 * that utilization, times it); 0 with no deposits or no borrows. Venue banks are not ported.
 */
export function supplyRate(bank: Account<Bank>, extra: u64): i128 {
  require(!isVenueBank(bank.config.asset_tag), MarginfiError.RebalanceVenueUnsupported);
  require(bank.config.interest_rate_config.curve_type === 1n, MarginfiError.InvalidConfig);
  const assets = fxAdd(fxMul(bank.total_asset_shares.value, bank.asset_share_value.value), fxFromU64(extra));
  const liabilities = fxMul(bank.total_liability_shares.value, bank.liability_share_value.value);
  if (assets === I80F48_ZERO || liabilities === I80F48_ZERO) return I80F48_ZERO;
  const utilization = fxDiv(liabilities, assets);
  return fxMul(multipointCurve(bank.config.interest_rate_config, utilization), utilization);
}

/** NativeRateModel::new's checks (the curve, the totals) without pricing anything. */
export function checkRateModel(bank: Account<Bank>): void {
  require(bank.config.interest_rate_config.curve_type === 1n, MarginfiError.InvalidConfig);
  fxMul(bank.total_asset_shares.value, bank.asset_share_value.value);
  fxMul(bank.total_liability_shares.value, bank.liability_share_value.value);
}

/** underlying_of a native amount: whole tokens (calc_value at a price of 1). */
export function whole(amount: i128, decimals: u8): i128 {
  if (amount === I80F48_ZERO) return I80F48_ZERO;
  return fxDiv(amount, exp10Fx(u64(decimals)));
}

/** to_native: whole tokens as native units, truncated (MathError when negative or past u64). */
export function toNative(decimals: u8, amount: i128): u64 {
  const v = fxMul(amount, exp10Fx(u64(decimals)));
  require(v >= I80F48_ZERO, MarginfiError.MathError);
  const n = v >> 48n;
  require(n <= 18446744073709551615n, MarginfiError.MathError);
  return u64(n);
}

/** bank_underlying: the account's deposit in the bank, in whole tokens (0 without a balance there). */
export function underlying(account: Account<MarginfiAccount>, key: Pubkey, bank: Account<Bank>): i128 {
  for (let i = 0n; i < 16n; i++) {
    const b = account.lending_account.balances.get(i);
    if (b.active !== 0n && b.bank_pk === key) return whole(fxMul(b.asset_shares.value, bank.asset_share_value.value), bank.mint_decimals);
  }
  return I80F48_ZERO;
}

/** The order tag of the account's balance in the bank (0 without one). */
export function tagIn(account: Account<MarginfiAccount>, key: Pubkey): u64 {
  for (let i = 0n; i < 16n; i++) {
    const b = account.lending_account.balances.get(i);
    if (b.active !== 0n && b.bank_pk === key) return u64(b.tag);
  }
  return 0n;
}

/** Whether the account holds an active balance in the bank (LendingAccount::get_balance). */
export function holds(account: Account<MarginfiAccount>, key: Pubkey): boolean {
  for (let i = 0n; i < 16n; i++) {
    const b = account.lending_account.balances.get(i);
    if (b.active !== 0n && b.bank_pk === key) return true;
  }
  return false;
}

/**
 * deposit_capacity_of: what a rebalance may still deliver into the bank, in whole tokens (the deposit limit's room;
 * unlimited when there is none).
 */
export function depositRoom(bank: Account<Bank>): i128 {
  if (bank.config.deposit_limit === REB_U64_MAX) return FX_MAX;
  const current = fxMul(bank.total_asset_shares.value, bank.asset_share_value.value);
  const limit = fxFromU64(bank.config.deposit_limit);
  if (current >= limit) return I80F48_ZERO;
  // (limit - current - 1).floor() as u64: MathError when it is negative.
  const room = fxSub(fxSub(limit, current), I80F48_ONE);
  const floor = room - (room & 281474976710655n);
  require(floor >= I80F48_ZERO, MarginfiError.MathError);
  return whole(floor, bank.mint_decimals);
}
