// A marginfi account's lending balances (programs/marginfi/src/state/marginfi_account.rs, premium.rs and the type
// crate's user_account.rs @ c5d440f6): finding or opening a balance in a bank, moving shares in and out of it,
// closing it, the order balances are kept in and the flags indexers read. Amounts and shares are I80F48.
import { type Account, type Mut, type Pubkey, type i128, type i32, type i64, type u16, type u64, type u8, i64 as toI64, pubkey, require, u64 as toU64 } from "typesol";
import {
  BANK_ASSET_TAG_STAKED,
  LIQ_CACHE_LOCKED_FLAG,
  PREMIUM_ACTIVE,
  assetAmount,
  changeAssetShares,
  changeLiabilityShares,
  checkUtilizationRatio,
  getAssetShares,
  getLiabilityShares,
  liabilityAmount,
} from "./bank";
import { MarginfiError } from "./errors";
import { I80F48_ONE, I80F48_ZERO, fxAbs, fxAdd, fxCeil, fxDiv, fxFromU64, fxInt, fxMul, fxSub, fxToU64 } from "./i80f48";
import { SECONDS_PER_YEAR, u32ToMilli } from "./interest_rate";
import { type Bank, type Balance, type MarginfiAccount } from "./state";

/** MarginfiAccount.account_flags */
export const ACCOUNT_DISABLED: u64 = 1n;
export const ACCOUNT_IN_FLASHLOAN: u64 = 2n;
export const ACCOUNT_IN_RECEIVERSHIP: u64 = 16n;
export const ACCOUNT_IN_DELEVERAGE: u64 = 32n;
export const ACCOUNT_FROZEN: u64 = 64n;
export const ACCOUNT_IN_ORDER_EXECUTION: u64 = 128n;
export const ACCOUNT_IN_REBALANCE: u64 = 256n;
export const ACCOUNT_IN_RISK_ADMIN_LIQUIDATION: u64 = 512n;

/** 0.0001 and 1 as I80F48: below the first an amount counts as zero, below the second a balance side as empty. */
export const ZERO_AMOUNT_THRESHOLD: i128 = 28147497671n;
export const EMPTY_BALANCE_THRESHOLD: i128 = 281474976710656n;
const MAX_COSTLY_POSITIONS = 4n;
export const ZERO_KEY = pubkey("11111111111111111111111111111111");

/** How a balance may grow: BalanceIncreaseType. */
export const INCREASE_ANY: u8 = 0n;
export const INCREASE_REPAY_ONLY: u8 = 1n;
export const INCREASE_DEPOSIT_ONLY: u8 = 2n;
export const INCREASE_BYPASS_DEPOSIT_LIMIT: u8 = 3n;

/** |x| < 0.0001 (`abs` panics on the most negative value in the original; here MathError). */
export function isZeroWithTolerance(x: i128): boolean {
  return fxAbs(x) < ZERO_AMOUNT_THRESHOLD;
}

/** MarginfiAccount::initialize. */
export function initMarginfiAccount(account: Mut<MarginfiAccount>, group: Pubkey, authority: Pubkey, timestamp: u64): void {
  account.authority = authority;
  account.group = group;
  account.last_update = timestamp;
  account.indexer_flags.is_empty = 1n;
  account.indexer_flags.was_active_30d = 1n;
  account.indexer_flags.was_active_60d = 1n;
  account.active_orders = 0n;
}

/**
 * is_signer_authorized: a rebalance or order execution may let any keeper act (where the instruction allows it),
 * receivership anyone but the owner; a frozen account only the governance admin; otherwise only its authority.
 */
export function signerAuthorized(
  account: Account<MarginfiAccount>,
  frozenAdmin: Pubkey,
  signer: Pubkey,
  allowReceivership: boolean,
  allowOrderExecution: boolean,
  allowRebalance: boolean,
): boolean {
  const flags = account.account_flags;
  if (allowRebalance && (flags & ACCOUNT_IN_REBALANCE) !== 0n) return true;
  if (allowReceivership && (flags & ACCOUNT_IN_RECEIVERSHIP) !== 0n) return account.authority !== signer;
  if (allowOrderExecution && (flags & ACCOUNT_IN_ORDER_EXECUTION) !== 0n) return true;
  if ((flags & ACCOUNT_FROZEN) !== 0n) return frozenAdmin === signer;
  return account.authority === signer;
}

/** account_not_frozen_for_authority: a frozen account's own authority is refused (AccountFrozen, not Unauthorized). */
export function notFrozenForAuthority(account: Account<MarginfiAccount>, signer: Pubkey): boolean {
  return !((account.account_flags & ACCOUNT_FROZEN) !== 0n && account.authority === signer);
}

/** The index of the active balance in `bank`, or -1. */
export function findBalance(account: Mut<MarginfiAccount>, bank: Pubkey): i64 {
  for (let i = 0n; i < 16n; i++) {
    const b = account.lending_account.balances.get(i);
    if (b.active !== 0n && b.bank_pk === bank) return toI64(i);
  }
  return -1n;
}

/**
 * BankAccountWrapper::find_or_create: the active balance in `bank`, or a new one in the first free slot (at most
 * four staked or integration positions, 16 balances in all).
 */
export function findOrCreateBalance(account: Mut<MarginfiAccount>, bank: Mut<Bank>, bankKey: Pubkey, timestamp: i64): u64 {
  const found = findBalance(account, bankKey);
  if (found >= 0n) return toU64(found);
  const tag = bank.config.asset_tag;
  if (costly(tag)) {
    let count = 0n;
    for (let i = 0n; i < 16n; i++) {
      const b = account.lending_account.balances.get(i);
      if (b.active !== 0n && costly(b.bank_asset_tag)) count++;
    }
    require(count < MAX_COSTLY_POSITIONS, MarginfiError.CostlyPositionLimitExceeded);
  }
  let empty = 16n;
  for (let i = 0n; i < 16n && empty === 16n; i++) if (account.lending_account.balances.get(i).active === 0n) empty = i;
  require(empty < 16n, MarginfiError.LendingAccountBalanceSlotsFull);
  const b = account.lending_account.balances.get(empty);
  b.active = 1n;
  b.bank_pk = bankKey;
  b.bank_asset_tag = tag;
  b.tag = 0n;
  b.premium_rate_snapshot = 0n;
  b.asset_shares.value = I80F48_ZERO;
  b.liability_shares.value = I80F48_ZERO;
  b.premium_outstanding.value = I80F48_ZERO;
  b.last_update = toU64(timestamp);
  b.padding.set(0n, 0n);
  return empty;
}
/** Staked SOL and the integration banks (Kamino, Drift, Solend, JupLend) each cost several accounts per position. */
function costly(tag: u8): boolean {
  return tag === BANK_ASSET_TAG_STAKED || (tag >= 3n && tag <= 6n);
}

/** Balance::claim_premium: the premium accrued at the balance's snapshot rate since its last update, booked. */
export function claimPremium(account: Mut<MarginfiAccount>, i: u64, liability: i128, activatedAt: i64, now: u64): void {
  const b = account.lending_account.balances.get(i);
  let elapsed = 0n;
  if (b.last_update !== 0n) {
    const activated = activatedAt > 0n ? toU64(activatedAt) : 0n;
    const start = b.last_update > activated ? b.last_update : activated;
    elapsed = now > start ? now - start : 0n;
  }
  const rate = b.premium_rate_snapshot;
  let pending = I80F48_ZERO;
  if (rate !== 0n && elapsed !== 0n && liability > I80F48_ZERO) {
    const years = fxDiv(fxFromU64(elapsed), SECONDS_PER_YEAR);
    pending = fxMul(fxMul(liability, u32ToMilli(rate)), years);
  }
  b.premium_outstanding.value = fxAdd(b.premium_outstanding.value, pending);
  b.last_update = now;
}
export function writeOffPremium(account: Mut<MarginfiAccount>, i: u64): void {
  const b = account.lending_account.balances.get(i);
  b.premium_outstanding.value = I80F48_ZERO;
  b.premium_rate_snapshot = 0n;
}

/**
 * BankAccountWrapper::increase_balance_internal: `amount` repays the balance's liability first, then adds assets;
 * `kind` limits it to one side (repay-only, deposit-only) or lets it past the deposit limit. Returns the shares
 * moved: liability shares burned for a repayment, asset shares minted otherwise.
 */
export function increaseBalance(account: Mut<MarginfiAccount>, i: u64, bank: Mut<Bank>, amount: i128, kind: u8, now: u64): i128 {
  const before = account.lending_account.balances.get(i);
  const hadAssets = before.asset_shares.value > ZERO_AMOUNT_THRESHOLD;
  const hadLiabs = before.liability_shares.value > ZERO_AMOUNT_THRESHOLD;
  const currentLiability = liabilityAmount(bank, before.liability_shares.value);
  const stalePremium = before.premium_outstanding.value !== I80F48_ZERO || before.premium_rate_snapshot !== 0n;
  // Premium at the debt before the change, or a stale receivable written off.
  if ((bank.flags & PREMIUM_ACTIVE) !== 0n && hadLiabs) claimPremium(account, i, currentLiability, bank.premium_activated_at, now);
  else if (stalePremium) writeOffPremium(account, i);
  const b = account.lending_account.balances.get(i);

  let liabilityDecrease = currentLiability < amount ? currentLiability : amount;
  const over = fxSub(amount, currentLiability);
  let assetIncrease = over > I80F48_ZERO ? over : I80F48_ZERO;
  if (kind === INCREASE_REPAY_ONLY) {
    require(isZeroWithTolerance(assetIncrease), MarginfiError.OperationRepayOnly);
    assetIncrease = I80F48_ZERO;
  } else if (kind === INCREASE_DEPOSIT_ONLY) {
    require(isZeroWithTolerance(liabilityDecrease), MarginfiError.OperationDepositOnly);
    liabilityDecrease = I80F48_ZERO;
  }
  let assetShares = I80F48_ZERO;
  if (assetIncrease > I80F48_ZERO) {
    assetShares = getAssetShares(bank, assetIncrease);
    b.asset_shares.value = fxAdd(b.asset_shares.value, assetShares);
    changeAssetShares(bank, assetShares, kind === INCREASE_BYPASS_DEPOSIT_LIMIT);
  }
  let liabilityShares = I80F48_ZERO;
  if (liabilityDecrease > I80F48_ZERO) {
    liabilityShares = getLiabilityShares(bank, liabilityDecrease);
    b.liability_shares.value = fxAdd(b.liability_shares.value, -liabilityShares);
    changeLiabilityShares(bank, -liabilityShares, true);
  }
  const hasAssets = b.asset_shares.value > ZERO_AMOUNT_THRESHOLD;
  const hasLiabs = b.liability_shares.value > ZERO_AMOUNT_THRESHOLD;
  if (!hadAssets && hasAssets) bank.lending_position_count = saturatingAdd(bank.lending_position_count);
  if (hadAssets && !hasAssets) bank.lending_position_count = saturatingSub(bank.lending_position_count);
  if (!hadLiabs && hasLiabs) bank.borrowing_position_count = saturatingAdd(bank.borrowing_position_count);
  if (hadLiabs && !hasLiabs) bank.borrowing_position_count = saturatingSub(bank.borrowing_position_count);
  if (hadLiabs && b.liability_shares.value < EMPTY_BALANCE_THRESHOLD) writeOffPremium(account, i);
  return kind === INCREASE_REPAY_ONLY ? liabilityShares : assetShares;
}
function saturatingAdd(n: i32): i32 {
  return n < 2147483647n ? n + 1n : n;
}
function saturatingSub(n: i32): i32 {
  return n > -2147483648n ? n - 1n : n;
}

/**
 * BankAccountWrapper::close_balance: refused while either side holds 0.0001 or more; dust asset shares go to the
 * insurance fund, dust liability shares leave the bank's totals as bad debt.
 */
export function closeBalance(account: Mut<MarginfiAccount>, i: u64, bank: Mut<Bank>, inReceivership: boolean): void {
  const b = account.lending_account.balances.get(i);
  const liability = liabilityAmount(bank, b.liability_shares.value);
  const assets = fxMul(b.asset_shares.value, bank.asset_share_value.value);
  require(isZeroWithTolerance(liability), MarginfiError.IllegalBalanceState);
  require(isZeroWithTolerance(assets), MarginfiError.IllegalBalanceState);
  closeBalanceInternal(account, i, bank, inReceivership, assets);
}

/** close_balance_internal, once the caller has checked the balance may close. */
export function closeBalanceInternal(account: Mut<MarginfiAccount>, i: u64, bank: Mut<Bank>, inReceivership: boolean, insuranceFee: i128): void {
  const b = account.lending_account.balances.get(i);
  const assetShares = b.asset_shares.value;
  const liabilityShares = b.liability_shares.value;
  const hadAssets = assetShares > ZERO_AMOUNT_THRESHOLD;
  const hadLiabs = liabilityShares > ZERO_AMOUNT_THRESHOLD;
  emptyBalance(account, i);
  if (inReceivership) bank.cache.liq_cache_flags &= ~LIQ_CACHE_LOCKED_FLAG;
  if (insuranceFee > I80F48_ZERO) bank.collected_insurance_fees_outstanding.value = fxAdd(bank.collected_insurance_fees_outstanding.value, insuranceFee);
  changeAssetShares(bank, -assetShares, false);
  changeLiabilityShares(bank, -liabilityShares, true);
  if (hadAssets) bank.lending_position_count = saturatingSub(bank.lending_position_count);
  if (hadLiabs) bank.borrowing_position_count = saturatingSub(bank.borrowing_position_count);
}

/** Balance::empty_deactivated. */
function emptyBalance(account: Mut<MarginfiAccount>, i: u64): void {
  const b = account.lending_account.balances.get(i);
  b.active = 0n;
  b.bank_pk = ZERO_KEY;
  b.bank_asset_tag = 0n;
  b.tag = 0n;
  b.premium_rate_snapshot = 0n;
  b.asset_shares.value = I80F48_ZERO;
  b.liability_shares.value = I80F48_ZERO;
  b.premium_outstanding.value = I80F48_ZERO;
  b.last_update = 0n;
  b.padding.set(0n, 0n);
}

/** Swap two balances, field by field. */
function swapBalances(account: Mut<MarginfiAccount>, i: u64, j: u64): void {
  const a = account.lending_account.balances.get(i);
  const b = account.lending_account.balances.get(j);
  const active = a.active;
  const key = a.bank_pk;
  const assetTag = a.bank_asset_tag;
  const tag = a.tag;
  const rate = a.premium_rate_snapshot;
  const assets = a.asset_shares.value;
  const liabilities = a.liability_shares.value;
  const premium = a.premium_outstanding.value;
  const updated = a.last_update;
  const pad = a.padding.get(0n);
  a.active = b.active;
  a.bank_pk = b.bank_pk;
  a.bank_asset_tag = b.bank_asset_tag;
  a.tag = b.tag;
  a.premium_rate_snapshot = b.premium_rate_snapshot;
  a.asset_shares.value = b.asset_shares.value;
  a.liability_shares.value = b.liability_shares.value;
  a.premium_outstanding.value = b.premium_outstanding.value;
  a.last_update = b.last_update;
  a.padding.set(0n, b.padding.get(0n));
  b.active = active;
  b.bank_pk = key;
  b.bank_asset_tag = assetTag;
  b.tag = tag;
  b.premium_rate_snapshot = rate;
  b.asset_shares.value = assets;
  b.liability_shares.value = liabilities;
  b.premium_outstanding.value = premium;
  b.last_update = updated;
  b.padding.set(0n, pad);
}

/** LendingAccount::sort_balances: by bank key, highest first (a stable sort: equal keys keep their order). */
export function sortBalances(account: Mut<MarginfiAccount>): void {
  for (let i = 1n; i < 16n; i++)
    for (let j = i; j > 0n && account.lending_account.balances.get(j - 1n).bank_pk.compare(account.lending_account.balances.get(j).bank_pk) < 0n; j--)
      swapBalances(account, j - 1n, j);
}

/** Balance::get_side: 0 none, 1 assets, 2 liabilities. Both sides at 1 share or more trips the original's assert. */
export function balanceSide(account: Mut<MarginfiAccount>, i: u64): u8 {
  const b = account.lending_account.balances.get(i);
  const assets = b.asset_shares.value;
  const liabilities = b.liability_shares.value;
  require(assets < EMPTY_BALANCE_THRESHOLD || liabilities < EMPTY_BALANCE_THRESHOLD, MarginfiError.InternalLogicError);
  if (liabilities >= EMPTY_BALANCE_THRESHOLD) return 2n;
  if (assets >= EMPTY_BALANCE_THRESHOLD) return 1n;
  return 0n;
}

/** MarginfiAccount::sync_indexer_flags: what the balances say about the account, and that it was active now. */
export function syncIndexerFlags(account: Mut<MarginfiAccount>): void {
  syncBalanceDerived(account);
  const f = account.indexer_flags;
  f.was_active_30d = 1n;
  f.was_active_60d = 1n;
  if (f.is_lending_only === 1n && (account.account_flags & ACCOUNT_IN_RECEIVERSHIP) === 0n) account.liquidation_tagged_at = 0n;
}

/** IndexerFlags::sync_balance_derived: emptiness, lending only, one borrow, the kinds of positions. */
export function syncBalanceDerived(account: Mut<MarginfiAccount>): void {
  let liabilities = 0n;
  let any = false;
  let staked = false;
  let kamino = false;
  let drift = false;
  let juplend = false;
  for (let i = 0n; i < 16n; i++) {
    if (account.lending_account.balances.get(i).active === 0n) continue;
    if (balanceSide(account, i) === 0n) continue;
    const b = account.lending_account.balances.get(i);
    any = true;
    if (b.liability_shares.value >= EMPTY_BALANCE_THRESHOLD && liabilities < 255n) liabilities++;
    const tag = b.bank_asset_tag;
    if (tag === BANK_ASSET_TAG_STAKED) staked = true;
    else if (tag === 3n) kamino = true;
    else if (tag === 4n) drift = true;
    else if (tag === 6n) juplend = true;
  }
  const f = account.indexer_flags;
  f.is_empty = any ? 0n : 1n;
  f.is_lending_only = any && liabilities === 0n ? 1n : 0n;
  f.is_single_borrower = liabilities === 1n ? 1n : 0n;
  f.has_staked = staked ? 1n : 0n;
  f.has_kamino = kamino ? 1n : 0n;
  f.has_drift = drift ? 1n : 0n;
  f.has_juplend = juplend ? 1n : 0n;
  if (liabilities === 0n) f.has_isolated = 0n;
}

/** MarginfiAccount::can_be_closed: no balance with a side, not disabled, frozen, in a flash loan or receivership. */
export function canBeClosed(account: Mut<MarginfiAccount>): boolean {
  // Every balance, inactive ones too, in order; the first with a side or liability shares settles it (the original's
  // `all` stops there, so a later balance that would trip get_side's assert is never looked at).
  let empty = true;
  for (let i = 0n; i < 16n && empty; i++)
    if (balanceSide(account, i) !== 0n || account.lending_account.balances.get(i).liability_shares.value > I80F48_ZERO) empty = false;
  const flags = account.account_flags;
  return (flags & ACCOUNT_DISABLED) === 0n && empty && (flags & ACCOUNT_IN_FLASHLOAN) === 0n && (flags & ACCOUNT_IN_RECEIVERSHIP) === 0n && (flags & ACCOUNT_FROZEN) === 0n;
}

/**
 * validate_asset_tags: default-like assets (default and the integrations) and staked SOL never share an account;
 * SOL goes with either. An active balance with a tag the original does not know panics there.
 */
export function assetTagsCompatible(bank: Mut<Bank>, account: Mut<MarginfiAccount>): boolean {
  let hasDefault = false;
  let hasStaked = false;
  for (let i = 0n; i < 16n; i++) {
    const b = account.lending_account.balances.get(i);
    if (b.active === 0n) continue;
    const tag = b.bank_asset_tag;
    require(tag <= 6n, MarginfiError.InternalLogicError);
    if (tag === BANK_ASSET_TAG_STAKED) hasStaked = true;
    else if (tag !== 1n) hasDefault = true;
  }
  const bankTag = bank.config.asset_tag;
  const defaultLike = bankTag === 0n || (bankTag >= 3n && bankTag <= 6n);
  if (defaultLike && hasStaked) return false;
  if (bankTag === BANK_ASSET_TAG_STAKED && hasDefault) return false;
  return true;
}

/**
 * BankAccountWrapper::claim_premium: the premium accrued since the balance's last update, booked; written off instead
 * on a bank without active premiums or a balance without a liability.
 */
export function claimBalancePremium(account: Mut<MarginfiAccount>, i: u64, bank: Mut<Bank>, now: u64): void {
  const b = account.lending_account.balances.get(i);
  const shares = b.liability_shares.value;
  const stale = b.premium_outstanding.value !== I80F48_ZERO || b.premium_rate_snapshot !== 0n;
  if ((bank.flags & PREMIUM_ACTIVE) === 0n || shares <= ZERO_AMOUNT_THRESHOLD) {
    if (stale) writeOffPremium(account, i);
    return;
  }
  const liability = liabilityAmount(bank, shares);
  claimPremium(account, i, liability, bank.premium_activated_at, now);
}

/** settle_premium: up to `max` of the booked premium moves to the bank's collected premium. Returns what moved. */
export function settlePremium(account: Mut<MarginfiAccount>, i: u64, bank: Mut<Bank>, max: i128): i128 {
  const b = account.lending_account.balances.get(i);
  const outstanding = b.premium_outstanding.value;
  const lower = outstanding < max ? outstanding : max;
  const settled = lower > I80F48_ZERO ? lower : I80F48_ZERO;
  if (settled > I80F48_ZERO) {
    b.premium_outstanding.value = fxSub(outstanding, settled);
    bank.collected_premium_outstanding.value = fxAdd(bank.collected_premium_outstanding.value, settled);
  }
  return settled;
}

/** What repay_all owes and burns: the token amount (rounded up) and the liability shares the balance held. */
export interface Repaid {
  amount: u64;
  shares: i128;
}

/**
 * BankAccountWrapper::repay_all: the whole liability (with the booked premium, unless written off) rounded up to a
 * token; the rounding and any asset dust go to the insurance fund, and the balance closes.
 */
export function repayAll(account: Mut<MarginfiAccount>, i: u64, bank: Mut<Bank>, inReceivership: boolean, settle: boolean, now: u64): Repaid {
  claimBalancePremium(account, i, bank, now);
  const b = account.lending_account.balances.get(i);
  const shares = b.liability_shares.value;
  const liability = liabilityAmount(bank, shares);
  const assets = fxMul(b.asset_shares.value, bank.asset_share_value.value);
  require(liability > ZERO_AMOUNT_THRESHOLD, MarginfiError.NoLiabilityFound);
  require(isZeroWithTolerance(assets), MarginfiError.NoLiabilityFound);
  const premium = b.premium_outstanding.value;
  let owed = liability;
  if (settle && premium > I80F48_ZERO) {
    bank.collected_premium_outstanding.value = fxAdd(bank.collected_premium_outstanding.value, premium);
    owed = fxAdd(liability, premium);
  }
  const rounded = fxCeil(owed);
  const insurance = fxAdd(fxSub(rounded, owed), assets);
  closeBalanceInternal(account, i, bank, inReceivership, insurance);
  return { amount: fxToU64(rounded), shares };
}

/** BalanceDecreaseType */
export const DECREASE_WITHDRAW_ONLY: u8 = 0n;
export const DECREASE_BORROW_ONLY: u8 = 1n;
export const DECREASE_BYPASS_BORROW_LIMIT: u8 = 2n;

/**
 * BankAccountWrapper::decrease_balance_internal: `amount` comes out of the balance's assets first, then becomes a
 * liability; `kind` limits it to one side (withdraw-only, borrow-only) or lets it past the borrow limit (and the
 * utilization check). The premium is claimed at the debt before the change. Returns the shares moved: asset shares
 * burned for a withdrawal, liability shares minted otherwise.
 */
export function decreaseBalance(account: Mut<MarginfiAccount>, i: u64, bank: Mut<Bank>, amount: i128, kind: u8, now: u64): i128 {
  const before = account.lending_account.balances.get(i);
  const hadAssets = before.asset_shares.value > ZERO_AMOUNT_THRESHOLD;
  const hadLiabs = before.liability_shares.value > ZERO_AMOUNT_THRESHOLD;
  const liabilityShares0 = before.liability_shares.value;
  const stalePremium = before.premium_outstanding.value !== I80F48_ZERO || before.premium_rate_snapshot !== 0n;
  if ((bank.flags & PREMIUM_ACTIVE) !== 0n && hadLiabs) claimPremium(account, i, liabilityAmount(bank, liabilityShares0), bank.premium_activated_at, now);
  else if (stalePremium) writeOffPremium(account, i);
  const b = account.lending_account.balances.get(i);
  const current = assetAmount(bank, b.asset_shares.value);
  let assetDecrease = current < amount ? current : amount;
  const over = fxSub(amount, current);
  let liabilityIncrease = over > I80F48_ZERO ? over : I80F48_ZERO;
  if (kind === DECREASE_WITHDRAW_ONLY) {
    require(isZeroWithTolerance(liabilityIncrease), MarginfiError.OperationWithdrawOnly);
    liabilityIncrease = I80F48_ZERO;
  } else if (kind === DECREASE_BORROW_ONLY) {
    require(isZeroWithTolerance(assetDecrease), MarginfiError.OperationBorrowOnly);
    assetDecrease = I80F48_ZERO;
  }
  let assetShares = I80F48_ZERO;
  if (assetDecrease > I80F48_ZERO) {
    assetShares = getAssetShares(bank, assetDecrease);
    // A share value past 2^48 would let a tiny withdrawal burn no shares.
    require(assetShares > I80F48_ZERO, MarginfiError.IllegalBalanceState);
    b.asset_shares.value = fxAdd(b.asset_shares.value, -assetShares);
    changeAssetShares(bank, -assetShares, false);
  }
  let liabilityShares = I80F48_ZERO;
  if (liabilityIncrease > I80F48_ZERO) {
    liabilityShares = getLiabilityShares(bank, liabilityIncrease);
    b.liability_shares.value = fxAdd(b.liability_shares.value, liabilityShares);
    changeLiabilityShares(bank, liabilityShares, kind === DECREASE_BYPASS_BORROW_LIMIT);
  }
  if (kind !== DECREASE_BYPASS_BORROW_LIMIT) checkUtilizationRatio(bank);
  const hasAssets = b.asset_shares.value > ZERO_AMOUNT_THRESHOLD;
  const hasLiabs = b.liability_shares.value > ZERO_AMOUNT_THRESHOLD;
  if (!hadAssets && hasAssets) bank.lending_position_count = saturatingAdd(bank.lending_position_count);
  if (hadAssets && !hasAssets) bank.lending_position_count = saturatingSub(bank.lending_position_count);
  if (!hadLiabs && hasLiabs) bank.borrowing_position_count = saturatingAdd(bank.borrowing_position_count);
  if (hadLiabs && !hasLiabs) bank.borrowing_position_count = saturatingSub(bank.borrowing_position_count);
  return kind === DECREASE_WITHDRAW_ONLY ? assetShares : liabilityShares;
}

/**
 * BankAccountWrapper::withdraw_all: the whole deposit (more than 0.0001, with no liability left), its whole tokens
 * paid out and the fraction to the insurance fund, the balance closed. Returns the tokens and the shares burned.
 */
export function withdrawAll(account: Mut<MarginfiAccount>, i: u64, bank: Mut<Bank>, inReceivership: boolean): Repaid {
  const b = account.lending_account.balances.get(i);
  const shares = b.asset_shares.value;
  const current = assetAmount(bank, shares);
  const liability = liabilityAmount(bank, b.liability_shares.value);
  require(current > ZERO_AMOUNT_THRESHOLD, MarginfiError.NoAssetFound);
  require(isZeroWithTolerance(liability), MarginfiError.NoAssetFound);
  const whole = fxInt(current);
  const fraction = fxSub(current, whole);
  closeBalanceInternal(account, i, bank, inReceivership, fraction);
  checkUtilizationRatio(bank);
  return { amount: fxToU64(whole), shares };
}

/** LendingAccount::has_liabilities: an active balance owing a share or more. */
export function hasLiabilities(account: Account<MarginfiAccount>): boolean {
  for (let i = 0n; i < 16n; i++) {
    const b = account.lending_account.balances.get(i);
    if (b.active !== 0n && b.liability_shares.value >= EMPTY_BALANCE_THRESHOLD) return true;
  }
  return false;
}

/** BankAccountWrapper::write_off_premium: the booked premium forgiven (and the rate cleared); returns what it was. */
export function writeOffPremiumAmount(account: Mut<MarginfiAccount>, i: u64): i128 {
  const was = account.lending_account.balances.get(i).premium_outstanding.value;
  writeOffPremium(account, i);
  return was;
}
