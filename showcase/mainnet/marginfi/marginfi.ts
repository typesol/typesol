// A port of marginfi v2 (mrgnlabs/marginfi-v2, programs/marginfi @ c5d440f6, the build deployed at
// MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA), Copyright mrgnlabs, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL; this file ports the group and bank
// administration instructions so far (see docs/case-study-marginfi.md for what is and is not).
//
// A lending protocol: groups of banks, one per mint, whose deposits earn what borrowers pay on a seven-point interest
// curve; the group, insurance and program take fees from the borrowing rate.
import {
  type Account,
  type AccountInfo,
  type CloseTo,
  type SystemAccount,
  type Address,
  type Mint,
  type TokenAccount,
  type TokenInterface,
  type i128,
  type u16,
  type InstructionsSysvar,
  type HasOne,
  type Init,
  type Mut,
  type Option,
  type Pubkey,
  type Seeds,
  type Signer,
  type SystemProgram,
  type u32,
  constraint,
  currentSlot,
  emit,
  f64FromBits,
  findProgramAddress,
  invoke,
  programId,
  readData,
  readonly,
  readonlySigner,
  remainingAccounts,
  transferFeeInverse,
  writable,
  log,
  now,
  pubkey,
  require,
  i64,
  u64,
  u8,
} from "typesol";
import {
  ACCOUNT_DISABLED,
  ACCOUNT_FROZEN,
  ACCOUNT_IN_FLASHLOAN,
  DECREASE_BORROW_ONLY,
  DECREASE_WITHDRAW_ONLY,
  EMPTY_BALANCE_THRESHOLD,
  decreaseBalance,
  hasLiabilities,
  withdrawAll,
  ACCOUNT_IN_RECEIVERSHIP,
  ACCOUNT_IN_DELEVERAGE,
  ACCOUNT_IN_ORDER_EXECUTION,
  INCREASE_DEPOSIT_ONLY,
  INCREASE_REPAY_ONLY,
  balanceSide,
  claimBalancePremium,
  repayAll,
  settlePremium,
  assetTagsCompatible,
  canBeClosed,
  closeBalance,
  findBalance,
  findOrCreateBalance,
  increaseBalance,
  initMarginfiAccount,
  notFrozenForAuthority,
  signerAuthorized,
  sortBalances,
  syncBalanceDerived,
  syncIndexerFlags,
} from "./account";
import { type BankConfigCompact, type BankConfigFast } from "./args";
import {
  ASSET_TAG_JUPLEND,
  BANK_ASSET_TAG_STAKED,
  BANK_SAME_ASSET_EMODE_ELIGIBLE,
  BANK_SEED_KNOWN,
  CIRCUIT_BREAKER_ENABLED,
  FAILS_IF_PAUSED_OR_REDUCE_STATE,
  FAILS_IN_PAUSED_STATE,
  FREEZE_SETTINGS,
  IS_T22,
  TOKENLESS_REPAYMENTS_ALLOWED,
  accrueInterest,
  checkSameAssetFee,
  configureBank,
  initBank,
  recordDepositInflow,
  recordWithdrawalOutflow,
  saturatingSubI64,
  remainingDepositCapacity,
  totalLiquidationFee,
  updateBankCache,
  updateCachePrice,
  updateInterestRateConfig,
  validateBankConfig,
  validateBankState,
  validateEmodeEntries,
} from "./bank";
import { MarginfiError } from "./errors";
import {
  REQ_INITIAL,
  REQ_MAINTENANCE,
  cachePrice,
  calcValue,
  cbPriceGate,
  hasIsolatedLiability,
  healthComponents,
  isOracleError,
  REQ_EQUITY,
  HEALTH_ENGINE_OK,
  HEALTH_HEALTHY,
  premiumRefreshUnavailable,
  lowPrice,
  riskTiersErr,
  updatePremiumSnapshots,
  writeHealthCache,
} from "./risk";
import {
  type InterestRateConfigOpt,
  type LendingPoolBankConfigureEvent,
  type LendingPoolBankConfigureFrozenEvent,
  type LendingAccountDepositEvent,
  type LendingAccountPremiumSettledEvent,
  type LendingAccountRepayEvent,
  type LendingAccountWithdrawEvent,
  type LendingAccountBorrowEvent,
  type HealthPulseEvent,
  type DeleverageWithdrawFlowEvent,
  type LendingPoolBankCollectFeesEvent,
  type LendingPoolBankConfigureOracleEvent,
  type LendingPoolBankSetOraclePriceEvent,
  type LendingPoolBankCreateEvent,
  type MarginfiAccountCreateEvent,
  type MarginfiGroupConfigureEvent,
  type MarginfiGroupCreateEvent,
} from "./events";
import { I80F48_ONE, I80F48_ZERO, fxFromU64, fxInt, fxMul, fxSaturatingAdd, fxSaturatingSub, fxSub, fxToF64Bits, fxToU32Wrapping, fxToU64, fxTrySub } from "./i80f48";
import {
  ASSET_TAG_DEFAULT,
  ASSET_TAG_SOL,
  feedFamily,
  fixedFeed,
  loadFeed,
  oracleCount,
  priceAndConfidence,
  setupOf,
  validateFeedAccount,
  validateOracleCount,
  validatesFeedAccount,
} from "./oracle";
import { PROGRAM_FEES_ENABLED, basisToU32, validateInterestRateConfig } from "./interest_rate";
import { type Bank, type FeeState, type MarginfiAccount, type MarginfiGroup, type WrappedI80F48, BankOperationalState, OracleSetup, RiskTier } from "./state";

/** Anchor takes as many accounts as the runtime passes: a withdrawal's health check reads a bank and its oracle per balance. */
export const MAX_ACCOUNTS = 255n;
const SYSTEM_PROGRAM_ID = pubkey("11111111111111111111111111111111");
const MAX_PREMIUM_ENTRIES = 64n;

// ---- ix_utils.rs ---------------------------------------------------------------------------------------------------

/** check_no_durable_nonce: no System AdvanceNonceAccount (data starting 4u32) anywhere in the transaction. */
function checkNoDurableNonce(ixs: InstructionsSysvar): void {
  let advances = false;
  for (let i = 0n; i < ixs.length; i++) {
    const ix = ixs.get(i);
    if (ix.programId === SYSTEM_PROGRAM_ID && ix.dataLength >= 4n && ix.readU32(0n) === 4n) advances = true;
  }
  require(!advances, MarginfiError.DurableNonceNotAllowed);
}

// ---- group ---------------------------------------------------------------------------------------------------------

/** Create the program's one fee state, the PDA ["feestate"] (no admin check: the first caller sets it). */
export function initGlobalFeeState(
  payer: Mut<Signer>,
  fee_state: Init<FeeState>,
  system_program: SystemProgram,
  admin: Pubkey,
  fee_wallet: Pubkey,
  bank_init_flat_sol_fee: u32,
  liquidation_flat_sol_fee: u32,
  order_init_flat_sol_fee: u32,
  program_fee_fixed: WrappedI80F48,
  program_fee_rate: WrappedI80F48,
  liquidation_max_fee: WrappedI80F48,
  order_execution_max_fee: WrappedI80F48,
): void {
  const bump = fee_state.create(payer, ["feestate"], 8n + 512n);
  fee_state.global_fee_admin = admin;
  fee_state.global_fee_wallet = fee_wallet;
  fee_state.key_ = fee_state.key;
  fee_state.bank_init_flat_sol_fee = bank_init_flat_sol_fee;
  fee_state.bump_seed = bump;
  fee_state.program_fee_fixed = program_fee_fixed;
  fee_state.program_fee_rate = program_fee_rate;
  fee_state.liquidation_max_fee = liquidation_max_fee;
  fee_state.liquidation_flat_sol_fee = liquidation_flat_sol_fee;
  fee_state.order_execution_max_fee = order_execution_max_fee;
  fee_state.order_init_flat_sol_fee = order_init_flat_sol_fee;
}

/** Create a group (a new keypair account) with the signer as its admin, flow admin and governance admin. */
export function marginfiGroupInitialize(
  marginfi_group: Init<MarginfiGroup>,
  admin: Mut<Signer>,
  fee_state: Seeds<Account<FeeState>, ["feestate"]>,
  system_program: SystemProgram,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
): void {
  marginfi_group.create(admin, null);
  checkNoDurableNonce(instruction_sysvar);
  // set_initial_configuration
  marginfi_group.admin = admin.key;
  marginfi_group.delegate_flow_admin = admin.key;
  marginfi_group.governance_admin = admin.key;
  marginfi_group.group_flags |= PROGRAM_FEES_ENABLED;
  marginfi_group.emode_max_init_leverage = basisToU32(15n * I80F48_ONE);
  marginfi_group.emode_max_maint_leverage = basisToU32(20n * I80F48_ONE);
  marginfi_group.same_asset_emode_init_leverage = basisToU32(I80F48_ONE);
  marginfi_group.same_asset_emode_maint_leverage = basisToU32(I80F48_ONE);
  marginfi_group.premium_settings.entry_capacity = MAX_PREMIUM_ENTRIES;

  marginfi_group.fee_state_cache.last_update = now();
  marginfi_group.fee_state_cache.global_fee_wallet = fee_state.global_fee_wallet;
  marginfi_group.fee_state_cache.program_fee_fixed = fee_state.program_fee_fixed;
  marginfi_group.fee_state_cache.program_fee_rate = fee_state.program_fee_rate;
  marginfi_group.banks = 0n;
  emit<MarginfiGroupCreateEvent>({ header: { signer: admin.key, marginfi_group: marginfi_group.key } });
}

/** Copy the fee state's wallet, program fees and panic state into a group (permissionless, any group). */
export function propagateFeeState(fee_state: Seeds<Account<FeeState>, ["feestate"]>, marginfi_group: Mut<MarginfiGroup>): void {
  marginfi_group.fee_state_cache.global_fee_wallet = fee_state.global_fee_wallet;
  marginfi_group.fee_state_cache.program_fee_fixed = fee_state.program_fee_fixed;
  marginfi_group.fee_state_cache.program_fee_rate = fee_state.program_fee_rate;
  const t = now();
  marginfi_group.fee_state_cache.last_update = t;
  // PanicStateCache::update_from_panic_state
  marginfi_group.panic_state_cache.pause_flags = fee_state.panic_state.pause_flags;
  marginfi_group.panic_state_cache.pause_start_timestamp = fee_state.panic_state.pause_start_timestamp;
  marginfi_group.panic_state_cache.last_cache_update = t;
}

/** Set the group's fast-admin roles (admin only); `null` leaves one as it is. The emissions admin is deprecated. */
export function marginfiGroupConfigure(
  marginfi_group: HasOne<Mut<MarginfiGroup>, "admin", MarginfiError.Unauthorized>,
  admin: Signer,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  new_admin: Option<Pubkey>,
  new_curve_admin: Option<Pubkey>,
  new_limit_admin: Option<Pubkey>,
  new_flow_admin: Option<Pubkey>,
  new_emissions_admin: Option<Pubkey>,
  new_metadata_admin: Option<Pubkey>,
): void {
  checkNoDurableNonce(instruction_sysvar);
  if (new_admin !== null) marginfi_group.admin = new_admin;
  if (new_curve_admin !== null) marginfi_group.delegate_curve_admin = new_curve_admin;
  if (new_limit_admin !== null) marginfi_group.delegate_limit_admin = new_limit_admin;
  if (new_flow_admin !== null) marginfi_group.delegate_flow_admin = new_flow_admin;
  if (new_emissions_admin !== null) marginfi_group.delegate_emissions_admin = new_emissions_admin;
  if (new_metadata_admin !== null) marginfi_group.metadata_admin = new_metadata_admin;
  // finish_configure
  marginfi_group.fee_state_cache.last_update = now();
  emit<MarginfiGroupConfigureEvent>({
    header: { signer: admin.key, marginfi_group: marginfi_group.key },
    admin: new_admin,
    flags: marginfi_group.group_flags,
  });
}

// ---- banks ---------------------------------------------------------------------------------------------------------

/** The token program that owns a mint: Token-2022 banks carry IS_T22. */
const TOKEN_2022_ID = pubkey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/** The vault and vault-authority bumps a new bank stores (Anchor's ctx.bumps). */
export interface Bumps {
  liquidity_vault: u8;
  liquidity_vault_authority: u8;
  insurance_vault: u8;
  insurance_vault_authority: u8;
  fee_vault: u8;
  fee_vault_authority: u8;
}

/**
 * The body both add_bank instructions share, once their bank and vaults exist: the flat SOL fee to the fee wallet, then
 * the bank from its compact config, the group's bank count, the config's checks and the event.
 */
function addBank(
  marginfi_group: Mut<MarginfiGroup>,
  governance_admin: Signer,
  fee_payer: Mut<Signer>,
  fee_state: Account<FeeState>,
  global_fee_wallet: Mut<AccountInfo>,
  bank_mint: Mint,
  bank: Mut<Bank>,
  system_program: SystemProgram,
  instruction_sysvar: InstructionsSysvar,
  bank_config: BankConfigCompact,
  liquidity_vault: Pubkey,
  insurance_vault: Pubkey,
  fee_vault: Pubkey,
  bumps: Bumps,
  bank_seed: u64,
  seeded: boolean,
): void {
  checkNoDurableNonce(instruction_sysvar);
  const fee = fee_state.bank_init_flat_sol_fee;
  if (fee > 0n) system_program.transfer(fee_payer, global_fee_wallet, u64(fee));
  require(bank_config.asset_tag === ASSET_TAG_DEFAULT || bank_config.asset_tag === ASSET_TAG_SOL, MarginfiError.WrongAssetTagForStandardInstructions);
  const t = now();
  initBank(
    bank,
    marginfi_group.key,
    bank_config,
    bank_mint.key,
    bank_mint.decimals,
    liquidity_vault,
    insurance_vault,
    fee_vault,
    t,
    bumps.liquidity_vault,
    bumps.liquidity_vault_authority,
    bumps.insurance_vault,
    bumps.insurance_vault_authority,
    bumps.fee_vault,
    bumps.fee_vault_authority,
    bank_seed,
  );
  if (seeded) bank.flags |= BANK_SEED_KNOWN;
  if (bank_mint.tokenProgram === TOKEN_2022_ID) bank.flags |= IS_T22;
  // MarginfiGroup::add_bank: the count saturates.
  if (marginfi_group.banks < 65535n) marginfi_group.banks += 1n;
  marginfi_group.fee_state_cache.last_update = t;
  validateBankConfig(bank.config);
  emit<LendingPoolBankCreateEvent>({
    header: { signer: governance_admin.key, marginfi_group: marginfi_group.key },
    bank: bank.key,
    mint: bank_mint.key,
  });
}

/** Add a bank (a new keypair account) for a mint, with its liquidity, insurance and fee vaults. Governance admin only. */
export function lendingPoolAddBank(
  marginfi_group: HasOne<Mut<MarginfiGroup>, "governance_admin", MarginfiError.Unauthorized>,
  governance_admin: Signer,
  fee_payer: Mut<Signer>,
  fee_state: HasOne<Seeds<Account<FeeState>, ["feestate"]>, "global_fee_wallet", MarginfiError.InvalidFeeWallet>,
  global_fee_wallet: Mut<AccountInfo>,
  bank_mint: Mint,
  bank: Init<Bank>,
  liquidity_vault_authority: Seeds<AccountInfo, ["liquidity_vault_auth", "@bank"]>,
  liquidity_vault: Init<TokenAccount>,
  insurance_vault_authority: Seeds<AccountInfo, ["insurance_vault_auth", "@bank"]>,
  insurance_vault: Init<TokenAccount>,
  fee_vault_authority: Seeds<AccountInfo, ["fee_vault_auth", "@bank"]>,
  fee_vault: Init<TokenAccount>,
  token_program: TokenInterface,
  system_program: SystemProgram,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  bank_config: BankConfigCompact,
): void {
  bank.create(fee_payer, null);
  const lv = liquidity_vault.create(fee_payer, ["liquidity_vault", bank.key], bank_mint, liquidity_vault_authority.key);
  const iv = insurance_vault.create(fee_payer, ["insurance_vault", bank.key], bank_mint, insurance_vault_authority.key);
  const fv = fee_vault.create(fee_payer, ["fee_vault", bank.key], bank_mint, fee_vault_authority.key);
  const bumps: Bumps = {
    liquidity_vault: lv,
    liquidity_vault_authority: liquidity_vault_authority.pdaBump,
    insurance_vault: iv,
    insurance_vault_authority: insurance_vault_authority.pdaBump,
    fee_vault: fv,
    fee_vault_authority: fee_vault_authority.pdaBump,
  };
  addBank(
    marginfi_group,
    governance_admin,
    fee_payer,
    fee_state,
    global_fee_wallet,
    bank_mint,
    bank,
    system_program,
    instruction_sysvar,
    bank_config,
    liquidity_vault.key,
    insurance_vault.key,
    fee_vault.key,
    bumps,
    0n,
    false,
  );
}

/** lending_pool_add_bank with the bank at the PDA [group, mint, bank_seed (LE)]. Governance admin only. */
export function lendingPoolAddBankWithSeed(
  marginfi_group: HasOne<Mut<MarginfiGroup>, "governance_admin", MarginfiError.Unauthorized>,
  governance_admin: Signer,
  fee_payer: Mut<Signer>,
  fee_state: HasOne<Seeds<Account<FeeState>, ["feestate"]>, "global_fee_wallet", MarginfiError.InvalidFeeWallet>,
  global_fee_wallet: Mut<AccountInfo>,
  bank_mint: Mint,
  bank: Init<Bank>,
  liquidity_vault_authority: Seeds<AccountInfo, ["liquidity_vault_auth", "@bank"]>,
  liquidity_vault: Init<TokenAccount>,
  insurance_vault_authority: Seeds<AccountInfo, ["insurance_vault_auth", "@bank"]>,
  insurance_vault: Init<TokenAccount>,
  fee_vault_authority: Seeds<AccountInfo, ["fee_vault_auth", "@bank"]>,
  fee_vault: Init<TokenAccount>,
  token_program: TokenInterface,
  system_program: SystemProgram,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  bank_config: BankConfigCompact,
  bank_seed: u64,
): void {
  bank.create(fee_payer, [marginfi_group.key, bank_mint.key, bank_seed]);
  const lv = liquidity_vault.create(fee_payer, ["liquidity_vault", bank.key], bank_mint, liquidity_vault_authority.key);
  const iv = insurance_vault.create(fee_payer, ["insurance_vault", bank.key], bank_mint, insurance_vault_authority.key);
  const fv = fee_vault.create(fee_payer, ["fee_vault", bank.key], bank_mint, fee_vault_authority.key);
  const bumps: Bumps = {
    liquidity_vault: lv,
    liquidity_vault_authority: liquidity_vault_authority.pdaBump,
    insurance_vault: iv,
    insurance_vault_authority: insurance_vault_authority.pdaBump,
    fee_vault: fv,
    fee_vault_authority: fee_vault_authority.pdaBump,
  };
  addBank(
    marginfi_group,
    governance_admin,
    fee_payer,
    fee_state,
    global_fee_wallet,
    bank_mint,
    bank,
    system_program,
    instruction_sysvar,
    bank_config,
    liquidity_vault.key,
    insurance_vault.key,
    fee_vault.key,
    bumps,
    bank_seed,
    true,
  );
}

/** Whether the group is in a pause the fee state propagated that has not run out (6 hours). */
function protocolPaused(group: Account<MarginfiGroup>): boolean {
  const c = group.panic_state_cache;
  if ((c.pause_flags & 1n) === 0n) return false;
  const t = now();
  if (t < c.pause_start_timestamp) return true;
  return t - c.pause_start_timestamp < 21600n;
}

/** Accrue a bank's interest up to now and refresh its rate cache (permissionless). */
export function lendingPoolAccrueBankInterest(group: Account<MarginfiGroup>, bank: HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>): void {
  constraint(group, !protocolPaused(group), MarginfiError.ProtocolPaused);
  const t = now();
  accrueInterest(bank, group, bank.key, t);
  updateBankCache(bank, group, t);
}

/** fast_admin_can_transition_bank_state: the fast admin may only reduce a bank's risk. */
function fastAdminCanTransition(current: BankOperationalState, next: BankOperationalState): boolean {
  if (next === BankOperationalState.Paused) return true;
  if (next === BankOperationalState.ReduceOnly)
    return current === BankOperationalState.Operational || current === BankOperationalState.ReduceOnly || current === BankOperationalState.ReduceOnlyWithBorrowingPower;
  if (next === BankOperationalState.ReduceOnlyWithBorrowingPower)
    return current === BankOperationalState.Operational || current === BankOperationalState.ReduceOnlyWithBorrowingPower;
  return false;
}

/**
 * Change a bank's fast settings (admin only). A bank with frozen settings takes only its deposit and borrow limits;
 * otherwise each given value is applied and checked, and the event repeats the settings given.
 */
export function lendingPoolConfigureBank(
  group: HasOne<Account<MarginfiGroup>, "admin", MarginfiError.Unauthorized>,
  admin: Signer,
  bank: HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  bank_config_opt: BankConfigFast,
): void {
  checkNoDurableNonce(instruction_sysvar);
  const c = bank_config_opt;
  if (c.operational_state !== null) require(fastAdminCanTransition(bank.config.operational_state, c.operational_state), MarginfiError.InvalidFastBankOperationalState);
  if ((bank.flags & FREEZE_SETTINGS) === FREEZE_SETTINGS) {
    if (c.deposit_limit !== null) bank.config.deposit_limit = c.deposit_limit;
    if (c.borrow_limit !== null) bank.config.borrow_limit = c.borrow_limit;
    log("WARN: Only deposit+borrow limits updated. Other settings IGNORED for frozen banks!");
    emit<LendingPoolBankConfigureFrozenEvent>({
      header: { signer: admin.key, marginfi_group: group.key },
      bank: bank.key,
      mint: bank.mint,
      deposit_limit: bank.config.deposit_limit,
      borrow_limit: bank.config.borrow_limit,
    });
    return;
  }
  const t = now();
  // Turning the breaker off ends a halt: the interest up to now accrues first, without the halted time.
  if (c.circuit_breaker_enabled !== null && !c.circuit_breaker_enabled && (bank.flags & CIRCUIT_BREAKER_ENABLED) === CIRCUIT_BREAKER_ENABLED)
    accrueInterest(bank, group, bank.key, t);
  configureBank(bank, c, t);
  validateEmodeEntries(bank, totalLiquidationFee(bank), group.emode_max_init_leverage, group.emode_max_maint_leverage);
  if (c.liquidation_liquidator_fee !== null || c.liquidation_insurance_fee !== null) checkSameAssetFee(bank, group);
  emit<LendingPoolBankConfigureEvent>({
    header: { signer: admin.key, marginfi_group: group.key },
    bank: bank.key,
    mint: bank.mint,
    config: {
      asset_weight_init: null,
      asset_weight_maint: null,
      liability_weight_init: null,
      liability_weight_maint: null,
      deposit_limit: c.deposit_limit,
      borrow_limit: c.borrow_limit,
      operational_state: c.operational_state,
      interest_rate_config: c.interest_rate_config,
      risk_tier: null,
      asset_tag: null,
      total_asset_value_init_limit: c.total_asset_value_init_limit,
      oracle_max_confidence: null,
      oracle_max_age: null,
      permissionless_bad_debt_settlement: c.permissionless_bad_debt_settlement,
      freeze_settings: null,
      tokenless_repayments_allowed: null,
      liquidation_liquidator_fee: c.liquidation_liquidator_fee,
      liquidation_insurance_fee: c.liquidation_insurance_fee,
      circuit_breaker_enabled: c.circuit_breaker_enabled,
      cb_deviation_bps_tiers: c.cb_deviation_bps_tiers,
      cb_tier_durations_seconds: c.cb_tier_durations_seconds,
      cb_escalation_window_mult: c.cb_escalation_window_mult,
      cb_ema_alpha_bps: c.cb_ema_alpha_bps,
      cb_window_seconds: c.cb_window_seconds,
      cb_window_max_up_bps: c.cb_window_max_up_bps,
      cb_window_max_down_bps: c.cb_window_max_down_bps,
    },
  });
}

/** Change a bank's interest curve and fees (curve admin only); nothing on a bank with frozen settings. */
export function lendingPoolConfigureBankInterestOnly(
  group: HasOne<Account<MarginfiGroup>, "delegate_curve_admin", MarginfiError.Unauthorized>,
  delegate_curve_admin: Signer,
  bank: HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  interest_rate_config: InterestRateConfigOpt,
): void {
  checkNoDurableNonce(instruction_sysvar);
  if ((bank.flags & FREEZE_SETTINGS) === FREEZE_SETTINGS) {
    log("WARN: Bank settings frozen, did nothing.");
    return;
  }
  updateInterestRateConfig(bank, interest_rate_config);
  validateInterestRateConfig(bank.config.interest_rate_config);
}

/** Change a bank's deposit, borrow and initial-value limits (limit admin only); a frozen bank takes the first two. */
export function lendingPoolConfigureBankLimitsOnly(
  group: HasOne<Account<MarginfiGroup>, "delegate_limit_admin", MarginfiError.Unauthorized>,
  delegate_limit_admin: Signer,
  bank: HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  deposit_limit: Option<u64>,
  borrow_limit: Option<u64>,
  total_asset_value_init_limit: Option<u64>,
): void {
  checkNoDurableNonce(instruction_sysvar);
  const frozen = (bank.flags & FREEZE_SETTINGS) === FREEZE_SETTINGS;
  if (frozen) log("WARN: Bank settings frozen, only deposit/borrow limits update.");
  if (deposit_limit !== null) bank.config.deposit_limit = deposit_limit;
  if (borrow_limit !== null) bank.config.borrow_limit = borrow_limit;
  if (!frozen && total_asset_value_init_limit !== null) bank.config.total_asset_value_init_limit = total_asset_value_init_limit;
}

/** Set the token account a bank's fees are withdrawn to: one of the bank's mint (admin only). */
export function lendingPoolUpdateFeesDestinationAccount(
  group: HasOne<Account<MarginfiGroup>, "admin", MarginfiError.Unauthorized>,
  bank: HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>,
  admin: Signer,
  destination_account: TokenAccount,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
): void {
  constraint(group, !protocolPaused(group), MarginfiError.ProtocolPaused);
  constraint(destination_account, destination_account.mint === bank.mint, MarginfiError.InvalidFeesDestinationAccount);
  checkNoDurableNonce(instruction_sysvar);
  bank.fees_destination_account = destination_account.key;
}

// ---- oracles -------------------------------------------------------------------------------------------------------

/**
 * Point a bank at a price feed (governance admin only): the setup's kind of feed and its account, checked as it is set.
 * Fixed prices and Exponent PT setups go through lending_pool_set_oracle_price, Scope feeds through their own
 * instruction; a bank in same-asset e-mode keeps the same feed account and kind of feed.
 */
export function lendingPoolConfigureBankOracle(
  group: HasOne<Account<MarginfiGroup>, "governance_admin", MarginfiError.Unauthorized>,
  governance_admin: Signer,
  bank: HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  setup: u8,
  oracle: Pubkey,
): void {
  checkNoDurableNonce(instruction_sysvar);
  // A bank with frozen settings panics in the original.
  require((bank.flags & FREEZE_SETTINGS) !== FREEZE_SETTINGS, MarginfiError.InternalLogicError);
  const s = setupOf(setup);
  require(
    s !== OracleSetup.Fixed &&
      s !== OracleSetup.FixedKamino &&
      s !== OracleSetup.FixedDrift &&
      s !== OracleSetup.FixedJuplend &&
      s !== OracleSetup.PTPyth &&
      s !== OracleSetup.PTFixed,
    MarginfiError.UseSetOraclePrice,
  );
  require(s !== OracleSetup.Scope && s !== OracleSetup.ScopeKamino && s !== OracleSetup.ScopeJuplend, MarginfiError.UseConfigureBankOracleScope);
  require(
    (bank.flags & BANK_SAME_ASSET_EMODE_ELIGIBLE) !== BANK_SAME_ASSET_EMODE_ELIGIBLE ||
      (bank.config.oracle_keys.get(0n) === oracle && feedFamily(bank.config.oracle_setup) === feedFamily(s)),
    MarginfiError.BadEmodeConfig,
  );
  bank.config.oracle_setup = s;
  bank.config.oracle_keys.set(0n, oracle);
  bank.config.fixed_price.value = I80F48_ZERO;
  // mSOL and LST setups take their multiplier's account from the remaining accounts.
  const rem = remainingAccounts();
  if (s === OracleSetup.PythMSOL || s === OracleSetup.PythLST) {
    require(rem.length === 2n, MarginfiError.WrongNumberOfOracleAccounts);
    bank.config.oracle_keys.set(1n, rem.get(1n).key);
  } else if (s === OracleSetup.KaminoMSOL || s === OracleSetup.JuplendMSOL || s === OracleSetup.KaminoLST || s === OracleSetup.JuplendLST) {
    require(rem.length === 3n, MarginfiError.WrongNumberOfOracleAccounts);
    bank.config.oracle_keys.set(2n, rem.get(2n).key);
  }
  let err = validateOracleCount(bank, rem.length);
  if (err === 0n && validatesFeedAccount(bank)) err = validateFeedAccount(bank, rem.get(0n));
  require(err === 0n, err);
  emit<LendingPoolBankConfigureOracleEvent>({ header: { signer: governance_admin.key, marginfi_group: group.key }, bank: bank.key, oracle_setup: setup, oracle });
}

/**
 * Give a bank a fixed price (governance admin only; not a staked bank or one in same-asset e-mode): `Fixed` (the venue
 * kind of fixed price for a Kamino, Drift or JupLend bank), or an Exponent PT's start price in (0, 1].
 */
export function lendingPoolSetOraclePrice(
  group: HasOne<Account<MarginfiGroup>, "governance_admin", MarginfiError.Unauthorized>,
  governance_admin: Signer,
  bank: HasOne<Mut<Bank>, "group">,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  price: WrappedI80F48,
  setup: u8,
): void {
  checkNoDurableNonce(instruction_sysvar);
  // A bank with frozen settings panics in the original.
  require((bank.flags & FREEZE_SETTINGS) !== FREEZE_SETTINGS, MarginfiError.InternalLogicError);
  require((bank.flags & BANK_SAME_ASSET_EMODE_ELIGIBLE) !== BANK_SAME_ASSET_EMODE_ELIGIBLE, MarginfiError.BadEmodeConfig);
  require(bank.config.asset_tag !== BANK_ASSET_TAG_STAKED, MarginfiError.Unauthorized);
  const p = price.value;
  const s = setupOf(setup);
  const rem = remainingAccounts();
  if (s === OracleSetup.PTPyth || s === OracleSetup.PTFixed) {
    require(rem.length === (s === OracleSetup.PTPyth ? 2n : 1n), MarginfiError.WrongNumberOfOracleAccounts);
    require(p > I80F48_ZERO && p <= I80F48_ONE, MarginfiError.InvalidPtStartPrice);
    bank.config.oracle_setup = s;
    bank.config.oracle_keys.set(0n, rem.get(0n).key);
    if (s === OracleSetup.PTPyth) bank.config.oracle_keys.set(1n, rem.get(1n).key);
  } else {
    require(s === OracleSetup.Fixed, MarginfiError.InvalidOracleSetup);
    require(p >= I80F48_ZERO, MarginfiError.FixedOraclePriceNegative);
    const tag = bank.config.asset_tag;
    if (tag === ASSET_TAG_DEFAULT) bank.config.oracle_setup = OracleSetup.Fixed;
    else if (tag === 3n) bank.config.oracle_setup = OracleSetup.FixedKamino;
    else if (tag === 4n) bank.config.oracle_setup = OracleSetup.FixedDrift;
    else if (tag === ASSET_TAG_JUPLEND) bank.config.oracle_setup = OracleSetup.FixedJuplend;
    else require(false, MarginfiError.InvalidOracleSetup);
    // The other keys stay, so a venue bank can return to its setup.
    bank.config.oracle_keys.set(0n, SYSTEM_PROGRAM_ID);
  }
  bank.config.fixed_price.value = p;
  require(validatesFeedAccount(bank) === false, MarginfiError.InternalLogicError);
  const err = validateOracleCount(bank, rem.length);
  require(err === 0n, err);
  emit<LendingPoolBankSetOraclePriceEvent>({ header: { signer: governance_admin.key, marginfi_group: group.key }, bank: bank.key, price: { value: p } });
}

/**
 * Price a bank now (permissionless): its interest accrues (not while the protocol is paused), the oracle's unbiased
 * spot price and confidence go into its cache, and the circuit breaker observes them. The remaining accounts are the
 * bank's oracle accounts (none for a fixed price).
 */
export function lendingPoolPulseBankPriceCache(group: Account<MarginfiGroup>, bank: HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>): void {
  const t = now();
  if (!protocolPaused(group)) {
    accrueInterest(bank, group, bank.key, t);
    updateBankCache(bank, group, t);
  }
  const rem = remainingAccounts();
  const count = oracleCount(bank, rem.length);
  require(count === 0n, count);
  const f = rem.length === 0n ? fixedFeed(bank) : loadFeed(bank, rem.get(0n), t);
  require(f.err === 0n, f.err);
  const p = priceAndConfidence(f, true, bank.config.oracle_max_confidence);
  require(p.err === 0n, p.err);
  updateCachePrice(bank, p.price, p.conf, p.source_time, t, currentSlot());
}

// ---- marginfi accounts -------------------------------------------------------------------------------------------

const PDA_FREE_THRESHOLD: u16 = 10000n;
const TOKEN_PROGRAM_ID = pubkey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/**
 * is_allowed_cpi_for_third_party_id: ids below 10,000 are free; a registered one only through a CPI from the
 * program registered for it.
 */
function thirdPartyAllowed(ixs: InstructionsSysvar, id: u16): boolean {
  if (id < PDA_FREE_THRESHOLD) return true;
  let allowed = SYSTEM_PROGRAM_ID;
  let known = true;
  if (id === 10001n) allowed = pubkey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
  else if (id === 11111n) allowed = pubkey("AsgardVwpApNc9DgEsDAHJcvupPuRtLQSKDP9MQNw16N");
  else if (id === 11123n) allowed = pubkey("6HyT8NQDpXY5wGkvX7haQVJ5nGUBVXQSkaT6Nf7fbsuJ");
  else if (id === 11124n) allowed = pubkey("save8RQVPMWNTzU18t3GBvBkN9hT7jsGjiCQ28FpD9H");
  else known = false;
  if (!known) return false;
  const top = ixs.get(ixs.currentIndex()).programId;
  if (top === programId()) return false;
  return top === allowed;
}

/** Create a marginfi account (a new keypair account) in a group, owned by `authority`. */
export function marginfiAccountInitialize(
  marginfi_group: Account<MarginfiGroup>,
  marginfi_account: Init<MarginfiAccount>,
  authority: Signer,
  fee_payer: Mut<Signer>,
  system_program: SystemProgram,
): void {
  constraint(marginfi_group, !protocolPaused(marginfi_group), MarginfiError.ProtocolPaused);
  marginfi_account.create(fee_payer, null);
  initMarginfiAccount(marginfi_account, marginfi_group.key, authority.key, u64(now()));
  emit<MarginfiAccountCreateEvent>({
    header: { signer: authority.key, marginfi_account: marginfi_account.key, marginfi_account_authority: authority.key, marginfi_group: marginfi_group.key },
  });
}

/**
 * Create a marginfi account at the PDA ["marginfi_account", group, authority, account_index, third_party_id], so a
 * client can find it again. A registered third-party id (10,000 and up) only through that party's program.
 */
export function marginfiAccountInitializePda(
  marginfi_group: Account<MarginfiGroup>,
  marginfi_account: Init<MarginfiAccount>,
  authority: Signer,
  fee_payer: Mut<Signer>,
  instructions_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  system_program: SystemProgram,
  account_index: u16,
  third_party_id: Option<u16>,
): void {
  constraint(marginfi_group, !protocolPaused(marginfi_group), MarginfiError.ProtocolPaused);
  const bump = marginfi_account.create(fee_payer, ["marginfi_account", marginfi_group.key, authority.key, account_index, third_party_id ?? 0n]);
  if (third_party_id !== null) require(thirdPartyAllowed(instructions_sysvar, third_party_id), MarginfiError.Unauthorized);
  initMarginfiAccount(marginfi_account, marginfi_group.key, authority.key, u64(now()));
  marginfi_account.account_index = account_index;
  marginfi_account.third_party_index = third_party_id ?? 0n;
  marginfi_account.bump = bump;
  emit<MarginfiAccountCreateEvent>({
    header: { signer: authority.key, marginfi_account: marginfi_account.key, marginfi_account_authority: authority.key, marginfi_group: marginfi_group.key },
  });
}

/** Close an empty marginfi account (no balances, orders or liquidation record), its rent to the fee payer. */
export function marginfiAccountClose(
  marginfi_account: CloseTo<HasOne<Mut<MarginfiAccount>, "authority", MarginfiError.Unauthorized>, "fee_payer">,
  authority: Signer,
  fee_payer: Mut<Signer>,
  rebalance_fee_pool: Seeds<SystemAccount, ["rebalance_fee_pool", "@marginfi_account"]>,
): void {
  require((marginfi_account.account_flags & ACCOUNT_FROZEN) === 0n, MarginfiError.AccountFrozen);
  require(marginfi_account.liquidation_record === SYSTEM_PROGRAM_ID, MarginfiError.IllegalAction);
  require(marginfi_account.active_orders === 0n, MarginfiError.IllegalAction);
  require(canBeClosed(marginfi_account), MarginfiError.IllegalAction);
  require(rebalance_fee_pool.lamports === 0n, MarginfiError.IllegalAction);
}

/** Close a balance whose assets and liabilities are both below 0.0001 (after accruing the bank's interest). */
export function lendingAccountCloseBalance(
  group: Account<MarginfiGroup>,
  marginfi_account: HasOne<Mut<MarginfiAccount>, "group", MarginfiError.InvalidGroup>,
  authority: Signer,
  bank: HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>,
): void {
  constraint(marginfi_account, notFrozenForAuthority(marginfi_account, authority.key), MarginfiError.AccountFrozen);
  constraint(marginfi_account, signerAuthorized(marginfi_account, group.governance_admin, authority.key, false, false, false), MarginfiError.Unauthorized);
  constraint(bank, isMarginfiAssetTag(bank.config.asset_tag), MarginfiError.WrongAssetTagForStandardInstructions);
  require((marginfi_account.account_flags & ACCOUNT_DISABLED) === 0n, MarginfiError.AccountDisabled);
  const t = now();
  accrueInterest(bank, group, bank.key, t);
  updateBankCache(bank, group, t);
  const inReceivership = (marginfi_account.account_flags & ACCOUNT_IN_RECEIVERSHIP) !== 0n;
  const i = findBalance(marginfi_account, bank.key);
  require(i >= 0n, MarginfiError.BankAccountNotFound);
  closeBalance(marginfi_account, u64(i), bank, inReceivership);
  sortBalances(marginfi_account);
  syncIndexerFlags(marginfi_account);
  marginfi_account.last_update = u64(t);
}

/** Default, SOL and staked SOL banks: the ones the standard instructions serve (not the integrations'). */
function isMarginfiAssetTag(tag: u8): boolean {
  return tag === 0n || tag === 1n || tag === 2n;
}

/**
 * Deposit into a bank: its interest accrues, the account's balance in it grows (refused if it would repay a
 * liability, or past the deposit limit unless `deposit_up_to_limit` caps the amount), and the tokens move to the
 * liquidity vault. A Token-2022 bank takes its mint as the first remaining account and the pre-fee amount.
 */
export function lendingAccountDeposit(
  group: Account<MarginfiGroup>,
  marginfi_account: HasOne<Mut<MarginfiAccount>, "group", MarginfiError.InvalidGroup>,
  authority: Signer,
  bank: HasOne<HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>, "liquidity_vault", MarginfiError.InvalidLiquidityVault>,
  signer_token_account: Mut<AccountInfo>,
  liquidity_vault: Mut<TokenAccount>,
  token_program: TokenInterface,
  amount: u64,
  deposit_up_to_limit: Option<boolean>,
): void {
  constraint(group, !protocolPaused(group), MarginfiError.ProtocolPaused);
  constraint(marginfi_account, notFrozenForAuthority(marginfi_account, authority.key), MarginfiError.AccountFrozen);
  constraint(marginfi_account, signerAuthorized(marginfi_account, group.governance_admin, authority.key, false, false, true), MarginfiError.Unauthorized);
  constraint(bank, isMarginfiAssetTag(bank.config.asset_tag), MarginfiError.WrongAssetTagForStandardInstructions);
  constraint(bank, (bank.flags & TOKENLESS_REPAYMENTS_ALLOWED) === 0n, MarginfiError.BankReduceOnly);
  const t = now();
  // maybe_take_bank_mint: a Token-2022 bank's mint comes first among the remaining accounts.
  let decimals: u8 = 0n;
  const t22 = token_program.key !== TOKEN_PROGRAM_ID;
  if (t22) {
    require(remainingAccounts().length > 0n, MarginfiError.T22MintRequired);
    const mint = remainingAccounts().get(0n);
    const n = mint.dataLen;
    require(
      mintOk(bank.mint, mint.key, mint.owner, n, n >= 82n ? readData<u8>(mint, 45n) : 0n, n > 165n ? readData<u8>(mint, 165n) : 0n),
      MarginfiError.T22MintRequired,
    );
    decimals = readData<u8>(mint, 44n);
  }
  require(assetTagsCompatible(bank, marginfi_account), MarginfiError.AssetTagMismatch);
  validateBankState(bank, FAILS_IF_PAUSED_OR_REDUCE_STATE, findBalance(marginfi_account, bank.key) >= 0n, t);
  const flags = marginfi_account.account_flags;
  require((flags & ACCOUNT_DISABLED) === 0n && (flags & ACCOUNT_IN_RECEIVERSHIP) === 0n, MarginfiError.AccountDisabled);
  accrueInterest(bank, group, bank.key, t);
  let deposit = amount;
  if (deposit_up_to_limit !== null && deposit_up_to_limit) {
    const room = remainingDepositCapacity(bank);
    if (room < deposit) deposit = room;
  }
  if (deposit === 0n) return;
  const i = findOrCreateBalance(marginfi_account, bank, bank.key, t);
  const shares = increaseBalance(marginfi_account, i, bank, fxFromU64(deposit), INCREASE_DEPOSIT_ONLY, u64(t));
  marginfi_account.last_update = u64(t);
  recordDepositInflow(bank, group, group.key, bank.key, marginfi_account.account_flags, deposit, t);
  if (t22) {
    const mint = remainingAccounts().get(0n);
    const preFee = deposit + transferFeeInverse(mint, deposit);
    invoke(token_program, [writable(signer_token_account), readonly(mint), writable(liquidity_vault), readonlySigner(authority)], [u8(12n), preFee, decimals]);
  } else invoke(token_program, [writable(signer_token_account), writable(liquidity_vault), readonlySigner(authority)], [u8(3n), deposit]);
  updateBankCache(bank, group, t);
  emit<LendingAccountDepositEvent>({
    header: { signer: authority.key, marginfi_account: marginfi_account.key, marginfi_account_authority: marginfi_account.authority, marginfi_group: marginfi_account.group },
    bank: bank.key,
    mint: bank.mint,
    amount: deposit,
    share_amount: { value: shares },
  });
  sortBalances(marginfi_account);
  syncIndexerFlags(marginfi_account);
}

// ---- withdrawals -----------------------------------------------------------------------------------------------------

/**
 * Take a deposit out: `amount` (before a Token-2022 transfer fee), or all of it with `withdraw_all` (the balance
 * closed, the fraction of a token to the insurance fund). Then the account's health: its Initial health with the
 * banks and oracles after the instruction's accounts (one [bank, oracle] group per balance), the circuit breaker's
 * gate while it owes anything, and its premium rates; the bank's price cache last.
 */
export function lendingAccountWithdraw(
  group: Account<MarginfiGroup>,
  marginfi_account: HasOne<Mut<MarginfiAccount>, "group", MarginfiError.InvalidGroup>,
  authority: Signer,
  bank: HasOne<HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>, "liquidity_vault", MarginfiError.InvalidLiquidityVault>,
  destination_token_account: Mut<TokenAccount>,
  bank_liquidity_vault_authority: Seeds<AccountInfo, ["liquidity_vault_auth", "@bank"], "@bank.liquidity_vault_authority_bump">,
  liquidity_vault: Mut<TokenAccount>,
  token_program: TokenInterface,
  amount: u64,
  withdraw_all: Option<boolean>,
): void {
  constraint(group, !protocolPaused(group) || (marginfi_account.account_flags & ACCOUNT_IN_DELEVERAGE) !== 0n, MarginfiError.ProtocolPaused);
  constraint(marginfi_account, (marginfi_account.account_flags & ACCOUNT_DISABLED) === 0n, MarginfiError.AccountDisabled);
  constraint(marginfi_account, notFrozenForAuthority(marginfi_account, authority.key), MarginfiError.AccountFrozen);
  constraint(marginfi_account, signerAuthorized(marginfi_account, group.governance_admin, authority.key, true, true, true), MarginfiError.Unauthorized);
  constraint(bank, isMarginfiAssetTag(bank.config.asset_tag), MarginfiError.WrongAssetTagForStandardInstructions);
  constraint(
    bank,
    !((marginfi_account.account_flags & ACCOUNT_IN_RECEIVERSHIP) !== 0n && bank.config.asset_weight_init.value === I80F48_ZERO),
    MarginfiError.LiquidationPremiumTooHigh,
  );
  const t = now();
  const all = withdraw_all !== null && withdraw_all;
  // maybe_take_bank_mint: a Token-2022 bank's mint comes first among the remaining accounts; the banks and oracles
  // the health checks read come after it.
  let decimals: u8 = 0n;
  const t22 = token_program.key !== TOKEN_PROGRAM_ID;
  if (t22) {
    require(remainingAccounts().length > 0n, MarginfiError.T22MintRequired);
    const mint = remainingAccounts().get(0n);
    const n = mint.dataLen;
    require(
      mintOk(bank.mint, mint.key, mint.owner, n, n >= 82n ? readData<u8>(mint, 45n) : 0n, n > 165n ? readData<u8>(mint, 165n) : 0n),
      MarginfiError.T22MintRequired,
    );
    decimals = readData<u8>(mint, 44n);
  }
  const start: u64 = t22 ? 1n : 0n;
  // ACCOUNT_IN_RECEIVERSHIP | ACCOUNT_IN_ORDER_EXECUTION | ACCOUNT_IN_REBALANCE: the health check waits for the end
  // of the outer instruction.
  const deferred = (marginfi_account.account_flags & 400n) !== 0n;
  // Taking out a deposit from an account that owes nothing is risk-free, so a halted bank allows it.
  validateBankState(bank, FAILS_IN_PAUSED_STATE, !hasLiabilities(marginfi_account), t);
  const groupLimited = group.rate_limiter.hourly.max_outflow > 0n || group.rate_limiter.daily.max_outflow > 0n;
  let price = I80F48_ZERO;
  if (deferred || groupLimited) {
    const p = lowPrice(bank, bank.key, remainingAccounts(), start, t);
    require(p.err === 0n, p.err);
    if (deferred) require(p.v > I80F48_ZERO, MarginfiError.ZeroAssetPrice);
    price = p.v;
  }
  accrueInterest(bank, group, bank.key, t);
  const i = findBalance(marginfi_account, bank.key);
  require(i >= 0n, MarginfiError.BankAccountNotFound);
  let paid: u64 = 0n;
  let shares = I80F48_ZERO;
  if (all) {
    const w = withdrawAll(marginfi_account, u64(i), bank, (marginfi_account.account_flags & ACCOUNT_IN_RECEIVERSHIP) !== 0n);
    paid = w.amount;
    shares = w.shares;
  } else {
    paid = t22 ? amount + transferFeeInverse(remainingAccounts().get(0n), amount) : amount;
    shares = decreaseBalance(marginfi_account, u64(i), bank, fxFromU64(paid), DECREASE_WITHDRAW_ONLY, u64(t));
  }
  // After a deleverage's tokenless repayments, what is left in the vault is all there is.
  if ((bank.flags & TOKENLESS_REPAYMENTS_COMPLETE) !== 0n && liquidity_vault.amount < paid) paid = liquidity_vault.amount;
  recordWithdrawalOutflow(groupLimited, paid, price, bank, group, group.key, bank.key, marginfi_account.account_flags, t);
  if ((marginfi_account.account_flags & ACCOUNT_IN_DELEVERAGE) !== 0n) {
    // check_deleverage_withdraw_limit: the day's deleveraged value, in whole dollars (wrapped to u32), under the cap.
    const value = calcValue(fxFromU64(paid), price, bank.mint_decimals, I80F48_ZERO, false);
    require(value.err === 0n, value.err);
    const usd = fxToU32Wrapping(value.v);
    const window = group.deleverage_withdraw_window_cache;
    const today: u32 = saturatingSubI64(t, window.last_daily_reset_timestamp) >= 86400n ? 0n : window.withdrawn_today;
    const projected: u32 = today > 4294967295n - usd ? 4294967295n : today + usd;
    require(window.daily_limit === 0n || projected <= window.daily_limit, MarginfiError.DailyWithdrawalLimitExceeded);
    emit<DeleverageWithdrawFlowEvent>({ group: group.key, bank: bank.key, mint: bank.mint, outflow_usd: usd, current_timestamp: t });
  }
  marginfi_account.last_update = u64(t);
  const bump = bank.liquidity_vault_authority_bump;
  if (t22)
    invoke(
      token_program,
      [writable(liquidity_vault), readonly(remainingAccounts().get(0n)), writable(destination_token_account), readonlySigner(bank_liquidity_vault_authority)],
      [u8(12n), paid, decimals],
      ["liquidity_vault_auth", bank.key, bump],
    );
  else
    invoke(
      token_program,
      [writable(liquidity_vault), writable(destination_token_account), readonlySigner(bank_liquidity_vault_authority)],
      [u8(3n), paid],
      ["liquidity_vault_auth", bank.key, bump],
    );
  updateBankCache(bank, group, t);
  emit<LendingAccountWithdrawEvent>({
    header: { signer: authority.key, marginfi_account: marginfi_account.key, marginfi_account_authority: marginfi_account.authority, marginfi_group: marginfi_account.group },
    bank: bank.key,
    mint: bank.mint,
    amount: paid,
    close_balance: all,
    share_amount: { value: shares },
  });
  sortBalances(marginfi_account);
  syncIndexerFlags(marginfi_account);
  if (!deferred) {
    // check_account_init_health_and_clear_tag: skipped in a flash loan (checked at its end).
    const flash = (marginfi_account.account_flags & ACCOUNT_IN_FLASHLOAN) !== 0n;
    const h = healthComponents(marginfi_account, group, remainingAccounts(), start, REQ_INITIAL, true, t);
    if (!flash) {
      require(h.err === 0n, h.err);
      require(h.assets >= h.liabs, MarginfiError.RiskEngineInitRejected);
      const tiers = riskTiersErr(marginfi_account, remainingAccounts(), start);
      require(tiers === 0n, tiers);
      // A tagged account healthy at Maintenance (spot prices) loses its tag; any error there keeps it.
      if (marginfi_account.liquidation_tagged_at !== 0n) {
        const m = healthComponents(marginfi_account, group, remainingAccounts(), start, REQ_MAINTENANCE, false, t);
        if (m.err === 0n && m.assets > m.liabs) marginfi_account.liquidation_tagged_at = 0n;
      }
    }
    writeHealthCache(marginfi_account, h, t, !flash);
    if (hasLiabilities(marginfi_account)) {
      const gate = cbPriceGate(marginfi_account, remainingAccounts(), start, t);
      require(gate === 0n, gate);
    }
    updatePremiumSnapshots(marginfi_account, group, h, u64(t), true);
  }
  const p = cachePrice(bank, bank.key, remainingAccounts(), start, t);
  if (p.err === 0n) updateCachePrice(bank, p.price, p.conf, p.source_time, t, currentSlot());
}

/**
 * Borrow: `amount` (before a Token-2022 transfer fee) out of the bank's vault as a new or larger liability, plus the
 * bank's origination fee, booked to the group and the program. Then the account's health as for a withdrawal, a
 * premium-active debt needing every collateral priced, the circuit breaker's gate, the premium rates, the rate limits
 * (priced at the bank's spot price) and the bank's price cache.
 */
export function lendingAccountBorrow(
  group: Account<MarginfiGroup>,
  marginfi_account: HasOne<Mut<MarginfiAccount>, "group", MarginfiError.InvalidGroup>,
  authority: Signer,
  bank: HasOne<HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>, "liquidity_vault", MarginfiError.InvalidLiquidityVault>,
  destination_token_account: Mut<TokenAccount>,
  bank_liquidity_vault_authority: Seeds<AccountInfo, ["liquidity_vault_auth", "@bank"], "@bank.liquidity_vault_authority_bump">,
  liquidity_vault: Mut<TokenAccount>,
  token_program: TokenInterface,
  amount: u64,
): void {
  constraint(group, !protocolPaused(group), MarginfiError.ProtocolPaused);
  constraint(marginfi_account, notFrozenForAuthority(marginfi_account, authority.key), MarginfiError.AccountFrozen);
  constraint(marginfi_account, signerAuthorized(marginfi_account, group.governance_admin, authority.key, false, false, false), MarginfiError.Unauthorized);
  constraint(bank, isMarginfiAssetTag(bank.config.asset_tag), MarginfiError.WrongAssetTagForStandardInstructions);
  // A bank being deleveraged with tokenless repayments should be reduce-only; borrowing from it is refused anyway.
  constraint(bank, (bank.flags & TOKENLESS_REPAYMENTS_ALLOWED) === 0n, MarginfiError.ForbiddenIx);
  const t = now();
  // maybe_take_bank_mint, before anything else.
  let decimals: u8 = 0n;
  const t22 = token_program.key !== TOKEN_PROGRAM_ID;
  if (t22) {
    require(remainingAccounts().length > 0n, MarginfiError.T22MintRequired);
    const mint = remainingAccounts().get(0n);
    const n = mint.dataLen;
    require(
      mintOk(bank.mint, mint.key, mint.owner, n, n >= 82n ? readData<u8>(mint, 45n) : 0n, n > 165n ? readData<u8>(mint, 165n) : 0n),
      MarginfiError.T22MintRequired,
    );
    decimals = readData<u8>(mint, 44n);
  }
  const start: u64 = t22 ? 1n : 0n;
  const programFeeRate = group.fee_state_cache.program_fee_rate.value;
  const flags = marginfi_account.account_flags;
  require((flags & ACCOUNT_DISABLED) === 0n && (flags & ACCOUNT_IN_RECEIVERSHIP) === 0n, MarginfiError.AccountDisabled);
  accrueInterest(bank, group, bank.key, t);
  const groupLimited = group.rate_limiter.hourly.max_outflow > 0n || group.rate_limiter.daily.max_outflow > 0n;
  require(assetTagsCompatible(bank, marginfi_account), MarginfiError.AssetTagMismatch);
  validateBankState(bank, FAILS_IF_PAUSED_OR_REDUCE_STATE, false, t);
  const feeRate = bank.config.interest_rate_config.protocol_origination_fee.value;
  const i = findOrCreateBalance(marginfi_account, bank, bank.key, t);
  const pre = t22 ? amount + transferFeeInverse(remainingAccounts().get(0n), amount) : amount;
  // The borrower owes the amount and the origination fee, and receives the amount.
  let fee = I80F48_ZERO;
  let feeTokens: u64 = 0n;
  if (feeRate !== I80F48_ZERO) {
    fee = fxMul(fxFromU64(pre), feeRate);
    feeTokens = fxToU64(fee);
  }
  const shares = decreaseBalance(marginfi_account, i, bank, fee === I80F48_ZERO ? fxFromU64(pre) : fxFromU64(pre) + fee, DECREASE_BORROW_ONLY, u64(t));
  const owed = marginfi_account.lending_account.balances.get(i).liability_shares.value;
  require(owed <= I80F48_ZERO || owed >= EMPTY_BALANCE_THRESHOLD, MarginfiError.IllegalBalanceState);
  marginfi_account.last_update = u64(t);
  const bump = bank.liquidity_vault_authority_bump;
  if (t22)
    invoke(
      token_program,
      [writable(liquidity_vault), readonly(remainingAccounts().get(0n)), writable(destination_token_account), readonlySigner(bank_liquidity_vault_authority)],
      [u8(12n), pre, decimals],
      ["liquidity_vault_auth", bank.key, bump],
    );
  else
    invoke(
      token_program,
      [writable(liquidity_vault), writable(destination_token_account), readonlySigner(bank_liquidity_vault_authority)],
      [u8(3n), pre],
      ["liquidity_vault_auth", bank.key, bump],
    );
  emit<LendingAccountBorrowEvent>({
    header: { signer: authority.key, marginfi_account: marginfi_account.key, marginfi_account_authority: marginfi_account.authority, marginfi_group: marginfi_account.group },
    bank: bank.key,
    mint: bank.mint,
    amount: pre + feeTokens,
    share_amount: { value: shares },
  });
  // The origination fee: the program's share of it (at the group's cached program fee rate), the rest the group's.
  if (fee !== I80F48_ZERO) {
    let groupFees = bank.collected_group_fees_outstanding.value;
    if (programFeeRate !== I80F48_ZERO) {
      const programFee = fxMul(fee, programFeeRate);
      groupFees = fxSaturatingAdd(groupFees, fxSaturatingSub(fee, programFee));
      bank.collected_program_fees_outstanding.value = fxSaturatingAdd(bank.collected_program_fees_outstanding.value, programFee);
    } else groupFees = fxSaturatingAdd(groupFees, fee);
    bank.collected_group_fees_outstanding.value = groupFees;
  }
  sortBalances(marginfi_account);
  syncIndexerFlags(marginfi_account);
  if (bank.config.risk_tier === RiskTier.Isolated) marginfi_account.indexer_flags.has_isolated = 1n;
  // check_account_init_health_and_clear_tag, as a withdrawal runs it.
  const flash = (marginfi_account.account_flags & ACCOUNT_IN_FLASHLOAN) !== 0n;
  const h = healthComponents(marginfi_account, group, remainingAccounts(), start, REQ_INITIAL, true, t);
  if (!flash) {
    require(h.err === 0n, h.err);
    require(h.assets >= h.liabs, MarginfiError.RiskEngineInitRejected);
    const tiers = riskTiersErr(marginfi_account, remainingAccounts(), start);
    require(tiers === 0n, tiers);
    if (marginfi_account.liquidation_tagged_at !== 0n) {
      const m = healthComponents(marginfi_account, group, remainingAccounts(), start, REQ_MAINTENANCE, false, t);
      if (m.err === 0n && m.assets > m.liabs) marginfi_account.liquidation_tagged_at = 0n;
    }
  }
  // New premium-active debt needs a real rate: a pass that could not price some collateral cannot give one.
  require(!premiumRefreshUnavailable(h), MarginfiError.PremiumSnapshotUnavailable);
  const gate = cbPriceGate(marginfi_account, remainingAccounts(), start, t);
  require(gate === 0n, gate);
  updatePremiumSnapshots(marginfi_account, group, h, u64(t), true);
  const p = cachePrice(bank, bank.key, remainingAccounts(), start, t);
  recordWithdrawalOutflow(groupLimited, pre, p.err === 0n ? p.price : I80F48_ZERO, bank, group, group.key, bank.key, marginfi_account.account_flags, t);
  updateBankCache(bank, group, t);
  if (p.err === 0n) updateCachePrice(bank, p.price, p.conf, p.source_time, t, currentSlot());
  writeHealthCache(marginfi_account, h, t, !flash);
}

/** BANKRUPT_THRESHOLD (0.1) and TRIVIAL_BALANCE_THRESHOLD (1). */
const BANKRUPT_THRESHOLD: i128 = 28147497671066n;
const HEALTH_ORACLE_OK: u32 = 4n;
const HEALTH_EMODE_BOOSTED: u32 = 8n;

/**
 * Refresh an account's health cache and indexer flags (anyone): its Initial health (whatever it gets to when it fails:
 * the error, and whether the engine or an oracle was at fault), the premium rates when that pass was complete, its
 * Maintenance health (liquidatable or not; a healthy account loses its liquidation tag) and its equity (bankrupt or
 * not, underwater, a trivial balance), then the event with the cache.
 */
export function lendingAccountPulseHealth(marginfi_account: HasOne<Mut<MarginfiAccount>, "group", MarginfiError.InvalidGroup>, group: Account<MarginfiGroup>): void {
  const t = now();
  const flash = (marginfi_account.account_flags & ACCOUNT_IN_FLASHLOAN) !== 0n;
  // check_account_init_health: in a flash loan Ok at once, the cache untouched.
  const init = healthComponents(marginfi_account, group, remainingAccounts(), 0n, REQ_INITIAL, true, t);
  let engineErr: u32 = 0n;
  let flags: u32 = 0n;
  if (!flash) {
    if (init.err !== 0n) engineErr = init.err;
    else {
      if (init.assets >= init.liabs) {
        flags = HEALTH_HEALTHY;
        engineErr = riskTiersErr(marginfi_account, remainingAccounts(), 0n);
      } else engineErr = 6009n;
    }
  }
  updatePremiumSnapshots(marginfi_account, group, init, u64(t), false);
  // A partial pass leaves what it recorded: the first oracle error, the prices so far.
  const recorded = !flash && init.err_index !== 255n;
  const internalErr: u32 = recorded ? init.internal_err : 0n;
  let mrgnErr: u32 = 0n;
  if (engineErr === 0n) flags = flags | HEALTH_ENGINE_OK | (internalErr === 0n ? HEALTH_ORACLE_OK : 0n);
  else {
    mrgnErr = engineErr;
    if (engineErr === 6009n) flags = flags | HEALTH_ENGINE_OK;
    if (!isOracleError(engineErr) && internalErr === 0n) flags = flags | HEALTH_ORACLE_OK;
  }
  // check_pre_liquidation_condition_and_get_account_health: liquidatable when Maintenance health is not positive.
  let liqErr: u32 = 0n;
  let liquidatable: u8 = 2n;
  let assetsMaint = I80F48_ZERO;
  let liabsMaint = I80F48_ZERO;
  if (flash) liqErr = 6037n;
  else {
    const m = healthComponents(marginfi_account, group, remainingAccounts(), 0n, REQ_MAINTENANCE, false, t);
    if (m.err !== 0n) liqErr = m.err;
    else {
      assetsMaint = m.assets;
      liabsMaint = m.liabs;
      if (m.emode_boosted) flags = flags | HEALTH_EMODE_BOOSTED;
      const health = fxTrySub(m.assets, m.liabs);
      if (health.err !== 0n) liqErr = health.err;
      else if (health.v > I80F48_ZERO) {
        flags = flags | HEALTH_HEALTHY;
        liqErr = 6068n;
        liquidatable = 0n;
      } else {
        flags = flags & ~HEALTH_HEALTHY;
        liquidatable = 1n;
      }
    }
  }
  // check_account_bankrupt: equity values, bankrupt when owing more than it holds with under 0.1 in assets.
  let bankruptcyErr: u32 = 0n;
  let decisive = false;
  let assetsEquity = I80F48_ZERO;
  let liabsEquity = I80F48_ZERO;
  if (flash) bankruptcyErr = 6037n;
  else {
    const q = healthComponents(marginfi_account, group, remainingAccounts(), 0n, REQ_EQUITY, false, t);
    if (q.err !== 0n) bankruptcyErr = q.err;
    else {
      assetsEquity = q.assets;
      liabsEquity = q.liabs;
      decisive = true;
      if (!(q.liabs > I80F48_ZERO && q.assets < BANKRUPT_THRESHOLD && q.liabs > q.assets)) bankruptcyErr = 6013n;
    }
  }
  if (liquidatable === 0n) marginfi_account.liquidation_tagged_at = 0n;
  const isolated = hasIsolatedLiability(marginfi_account, remainingAccounts());
  syncBalanceDerived(marginfi_account);
  const lastUpdate = marginfi_account.last_update;
  const elapsed = saturatingSubI64(t, lastUpdate <= 9223372036854775807n ? i64(lastUpdate) : i64(lastUpdate - 9223372036854775808n) - 9223372036854775807n - 1n);
  const f = marginfi_account.indexer_flags;
  f.was_active_30d = elapsed <= 2592000n ? 1n : 0n;
  f.was_active_60d = elapsed <= 5184000n ? 1n : 0n;
  if (isolated.err === 0n) f.has_isolated = u8(isolated.n);
  if (liquidatable !== 2n) f.was_liquidatable = liquidatable;
  if (decisive) {
    f.was_underwater = assetsEquity < liabsEquity ? 1n : 0n;
    const net = fxTrySub(assetsEquity, liabsEquity);
    f.has_trivial_balance = net.err === 0n && net.v > I80F48_ZERO && net.v < I80F48_ONE ? 1n : 0n;
  }
  // The cache: HealthCache::zeroed() with what the three passes wrote.
  const c = marginfi_account.health_cache;
  c.asset_value.value = !flash && init.err === 0n ? init.assets : I80F48_ZERO;
  c.liability_value.value = !flash && init.err === 0n ? init.liabs : I80F48_ZERO;
  c.asset_value_maint.value = assetsMaint;
  c.liability_value_maint.value = liabsMaint;
  c.asset_value_equity.value = assetsEquity;
  c.liability_value_equity.value = liabsEquity;
  c.timestamp = t;
  c.flags = flags;
  c.mrgn_err = mrgnErr;
  for (let p = 0n; p < 16n; p++) c.prices.set(p, flash ? 0n : init.prices.get(p));
  c.internal_err = internalErr;
  c.err_index = recorded ? init.err_index : 0n;
  c.program_version = 3n;
  c.pad0.set(0n, 0n);
  c.pad0.set(1n, 0n);
  c.internal_liq_err = liqErr;
  c.internal_bankruptcy_err = bankruptcyErr;
  for (let j = 0n; j < 32n; j++) c.reserved0.set(j, 0n);
  for (let j = 0n; j < 16n; j++) c.reserved1.set(j, 0n);
  emit<HealthPulseEvent>({ account: marginfi_account.key, health_cache: marginfi_account.health_cache });
}

// ---- repayments and fees -------------------------------------------------------------------------------------------

const ATA_PROGRAM_ID = pubkey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/** One thousandth (0.0001 × 10) as I80F48: below it a bank's liabilities count as gone. */
const TOKENLESS_DONE_THRESHOLD: i128 = 281474976710n;
const TOKENLESS_REPAYMENTS_COMPLETE: u64 = 64n;

/**
 * maybe_take_bank_mint's checks on the first remaining account under Token-2022: the bank's mint, owned by a token
 * program, an initialized mint (with extensions: tagged a mint). `initialized` and `kind` are its bytes 45 and 165.
 */
function mintOk(bankMint: Pubkey, key: Pubkey, owner: Pubkey, n: u64, initialized: u8, kind: u8): boolean {
  if (key !== bankMint) return false;
  if (owner !== TOKEN_PROGRAM_ID && owner !== TOKEN_2022_ID) return false;
  if (n < 82n || n === 355n || (n > 82n && n <= 165n)) return false;
  return initialized === 1n && (n === 82n || kind === 1n);
}

/**
 * Lend back a liability: `amount` settles the booked premium first, then repays principal (never more than owed),
 * or `repay_all` repays all of it, rounded up, and closes the balance. The risk admin may repay a bank allowing
 * tokenless repayments with nothing (repay_all only), writing the premium off.
 */
export function lendingAccountRepay(
  group: Account<MarginfiGroup>,
  marginfi_account: HasOne<Mut<MarginfiAccount>, "group", MarginfiError.InvalidGroup>,
  authority: Signer,
  bank: HasOne<HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>, "liquidity_vault", MarginfiError.InvalidLiquidityVault>,
  signer_token_account: Mut<AccountInfo>,
  liquidity_vault: Mut<TokenAccount>,
  token_program: TokenInterface,
  amount: u64,
  repay_all: Option<boolean>,
): void {
  constraint(group, !protocolPaused(group) || (marginfi_account.account_flags & ACCOUNT_IN_DELEVERAGE) !== 0n, MarginfiError.ProtocolPaused);
  constraint(marginfi_account, notFrozenForAuthority(marginfi_account, authority.key), MarginfiError.AccountFrozen);
  constraint(marginfi_account, signerAuthorized(marginfi_account, group.governance_admin, authority.key, true, true, false), MarginfiError.Unauthorized);
  constraint(bank, isMarginfiAssetTag(bank.config.asset_tag), MarginfiError.WrongAssetTagForStandardInstructions);
  const t = now();
  const all = repay_all !== null && repay_all;
  const flags = marginfi_account.account_flags;
  require((flags & ACCOUNT_DISABLED) === 0n, MarginfiError.AccountDisabled);
  if ((flags & ACCOUNT_IN_ORDER_EXECUTION) !== 0n) require(all, MarginfiError.OrderLiabilityNotClosed);
  let decimals: u8 = 0n;
  const t22 = token_program.key !== TOKEN_PROGRAM_ID;
  if (t22) {
    require(remainingAccounts().length > 0n, MarginfiError.T22MintRequired);
    const mint = remainingAccounts().get(0n);
    const n = mint.dataLen;
    require(
      mintOk(bank.mint, mint.key, mint.owner, n, n >= 82n ? readData<u8>(mint, 45n) : 0n, n > 165n ? readData<u8>(mint, 165n) : 0n),
      MarginfiError.T22MintRequired,
    );
    decimals = readData<u8>(mint, 44n);
  }
  validateBankState(bank, FAILS_IN_PAUSED_STATE, true, t);
  accrueInterest(bank, group, bank.key, t);
  const inReceivership = (flags & ACCOUNT_IN_RECEIVERSHIP) !== 0n;
  const tokenless = authority.key === group.risk_admin && (bank.flags & TOKENLESS_REPAYMENTS_ALLOWED) !== 0n && all;
  const found = findBalance(marginfi_account, bank.key);
  require(found >= 0n, MarginfiError.BankAccountNotFound);
  const i = u64(found);
  const collectedBefore = bank.collected_premium_outstanding.value;
  claimBalancePremium(marginfi_account, i, bank, u64(t));
  const outstandingBefore = marginfi_account.lending_account.balances.get(i).premium_outstanding.value;
  let repaid = amount;
  let shares = I80F48_ZERO;
  if (all) {
    const r = repayAll(marginfi_account, i, bank, inReceivership, !tokenless, u64(t));
    repaid = r.amount;
    shares = r.shares;
  } else {
    const settled = settlePremium(marginfi_account, i, bank, fxFromU64(amount));
    shares = increaseBalance(marginfi_account, i, bank, fxSub(fxFromU64(amount), settled), INCREASE_REPAY_ONLY, u64(t));
    const left = marginfi_account.lending_account.balances.get(i).liability_shares.value;
    require(left <= I80F48_ZERO || left >= I80F48_ONE, MarginfiError.IllegalBalanceState);
    if (balanceSide(marginfi_account, i) === 0n) marginfi_account.lending_account.balances.get(i).tag = 0n;
  }
  const settledNow = fxSub(bank.collected_premium_outstanding.value, collectedBefore);
  const writtenOff = tokenless ? outstandingBefore : I80F48_ZERO;
  const remaining = marginfi_account.lending_account.balances.get(i).premium_outstanding.value;
  marginfi_account.last_update = u64(t);
  recordDepositInflow(bank, group, group.key, bank.key, marginfi_account.account_flags, repaid, t);
  if (!tokenless) {
    if (t22) {
      const mint = remainingAccounts().get(0n);
      invoke(
        token_program,
        [writable(signer_token_account), readonly(mint), writable(liquidity_vault), readonlySigner(authority)],
        [u8(12n), repaid + transferFeeInverse(mint, repaid), decimals],
      );
    } else invoke(token_program, [writable(signer_token_account), writable(liquidity_vault), readonlySigner(authority)], [u8(3n), repaid]);
  }
  const liabs = bank.total_liability_shares.value;
  if ((bank.flags & TOKENLESS_REPAYMENTS_ALLOWED) !== 0n && (liabs < 0n ? -liabs : liabs) < TOKENLESS_DONE_THRESHOLD)
    bank.flags |= TOKENLESS_REPAYMENTS_COMPLETE;
  updateBankCache(bank, group, t);
  emit<LendingAccountRepayEvent>({
    header: { signer: authority.key, marginfi_account: marginfi_account.key, marginfi_account_authority: marginfi_account.authority, marginfi_group: marginfi_account.group },
    bank: bank.key, mint: bank.mint, amount: repaid, close_balance: all, share_amount: { value: shares } });
  if (settledNow > I80F48_ZERO || writtenOff > I80F48_ZERO)
    emit<LendingAccountPremiumSettledEvent>({
      header: { signer: authority.key, marginfi_account: marginfi_account.key, marginfi_account_authority: marginfi_account.authority, marginfi_group: marginfi_account.group },
      bank: bank.key,
      mint: bank.mint,
      premium_settled: f64FromBits(fxToF64Bits(settledNow)),
      premium_written_off: f64FromBits(fxToF64Bits(writtenOff)),
      premium_outstanding_remaining: f64FromBits(fxToF64Bits(remaining)),
    });
  sortBalances(marginfi_account);
  syncIndexerFlags(marginfi_account);
}

/**
 * Move a bank's outstanding fees out of its liquidity vault, as far as the vault holds them (whole tokens): the
 * insurance fees to the insurance vault, the group's to the fee vault, the program's to the fee wallet's associated
 * token account (permissionless).
 */
export function lendingPoolCollectBankFees(
  group: Account<MarginfiGroup>,
  bank: HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>,
  liquidity_vault_authority: Seeds<AccountInfo, ["liquidity_vault_auth", "@bank"], "@bank.liquidity_vault_authority_bump">,
  liquidity_vault: Seeds<Mut<TokenAccount>, ["liquidity_vault", "@bank"], "@bank.liquidity_vault_bump">,
  insurance_vault: Seeds<Mut<TokenAccount>, ["insurance_vault", "@bank"], "@bank.insurance_vault_bump">,
  fee_vault: Seeds<Mut<TokenAccount>, ["fee_vault", "@bank"], "@bank.fee_vault_bump">,
  fee_state: Seeds<Account<FeeState>, ["feestate"]>,
  fee_ata: Mut<TokenAccount>,
  token_program: TokenInterface,
): void {
  constraint(group, !protocolPaused(group), MarginfiError.ProtocolPaused);
  const ata = findProgramAddress([fee_state.global_fee_wallet, token_program.key, bank.mint], ATA_PROGRAM_ID);
  require(fee_ata.key === ata, MarginfiError.InvalidFeeAta);
  let decimals: u8 = 0n;
  const t22 = token_program.key !== TOKEN_PROGRAM_ID;
  if (t22) {
    require(remainingAccounts().length > 0n, MarginfiError.T22MintRequired);
    const mint = remainingAccounts().get(0n);
    const n = mint.dataLen;
    require(
      mintOk(bank.mint, mint.key, mint.owner, n, n >= 82n ? readData<u8>(mint, 45n) : 0n, n > 165n ? readData<u8>(mint, 165n) : 0n),
      MarginfiError.T22MintRequired,
    );
    decimals = readData<u8>(mint, 44n);
  }
  let available = fxFromU64(liquidity_vault.amount);
  const insuranceOwed = bank.collected_insurance_fees_outstanding.value;
  const insurance = fxInt(insuranceOwed < available ? insuranceOwed : available);
  const insuranceLeft = fxSub(insuranceOwed, insurance);
  bank.collected_insurance_fees_outstanding.value = insuranceLeft;
  available = fxSub(available, insurance);
  const groupOwed = bank.collected_group_fees_outstanding.value;
  const groupFees = fxInt(groupOwed < available ? groupOwed : available);
  const groupLeft = fxSub(groupOwed, groupFees);
  available = fxSub(available, groupFees);
  // Asserts in the original (negative outstanding fees would get there).
  require(available >= I80F48_ZERO, MarginfiError.MathError);
  bank.collected_group_fees_outstanding.value = groupLeft;
  const bump = bank.liquidity_vault_authority_bump;
  if (t22)
    invoke(
      token_program,
      [writable(liquidity_vault), readonly(remainingAccounts().get(0n)), writable(fee_vault), readonlySigner(liquidity_vault_authority)],
      [u8(12n), fxToU64(groupFees), decimals],
      ["liquidity_vault_auth", bank.key, bump],
    );
  else invoke(token_program, [writable(liquidity_vault), writable(fee_vault), readonlySigner(liquidity_vault_authority)], [u8(3n), fxToU64(groupFees)], ["liquidity_vault_auth", bank.key, bump]);
  if (t22)
    invoke(
      token_program,
      [writable(liquidity_vault), readonly(remainingAccounts().get(0n)), writable(insurance_vault), readonlySigner(liquidity_vault_authority)],
      [u8(12n), fxToU64(insurance), decimals],
      ["liquidity_vault_auth", bank.key, bump],
    );
  else invoke(token_program, [writable(liquidity_vault), writable(insurance_vault), readonlySigner(liquidity_vault_authority)], [u8(3n), fxToU64(insurance)], ["liquidity_vault_auth", bank.key, bump]);
  const programOwed = bank.collected_program_fees_outstanding.value;
  const programFees = fxInt(programOwed < available ? programOwed : available);
  const programLeft = fxSub(programOwed, programFees);
  available = fxSub(available, programFees);
  require(available >= I80F48_ZERO, MarginfiError.MathError);
  bank.collected_program_fees_outstanding.value = programLeft;
  if (t22)
    invoke(
      token_program,
      [writable(liquidity_vault), readonly(remainingAccounts().get(0n)), writable(fee_ata), readonlySigner(liquidity_vault_authority)],
      [u8(12n), fxToU64(programFees), decimals],
      ["liquidity_vault_auth", bank.key, bump],
    );
  else invoke(token_program, [writable(liquidity_vault), writable(fee_ata), readonlySigner(liquidity_vault_authority)], [u8(3n), fxToU64(programFees)], ["liquidity_vault_auth", bank.key, bump]);
  emit<LendingPoolBankCollectFeesEvent>({
    header: { signer: null, marginfi_group: group.key },
    bank: bank.key,
    mint: liquidity_vault.mint,
    group_fees_collected: f64FromBits(fxToF64Bits(groupFees)),
    group_fees_outstanding: f64FromBits(fxToF64Bits(groupLeft)),
    insurance_fees_collected: f64FromBits(fxToF64Bits(insurance)),
    insurance_fees_outstanding: f64FromBits(fxToF64Bits(insuranceLeft)),
  });
}

/** Withdraw from a bank's fee vault (admin only). */
export function lendingPoolWithdrawFees(
  group: HasOne<Account<MarginfiGroup>, "admin", MarginfiError.Unauthorized>,
  bank: HasOne<Account<Bank>, "group", MarginfiError.InvalidGroup>,
  admin: Signer,
  fee_vault: Seeds<Mut<TokenAccount>, ["fee_vault", "@bank"], "@bank.fee_vault_bump">,
  fee_vault_authority: Seeds<AccountInfo, ["fee_vault_auth", "@bank"], "@bank.fee_vault_authority_bump">,
  dst_token_account: Mut<TokenAccount>,
  token_program: TokenInterface,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  amount: u64,
): void {
  constraint(group, !protocolPaused(group), MarginfiError.ProtocolPaused);
  checkNoDurableNonce(instruction_sysvar);
  let decimals: u8 = 0n;
  const t22 = token_program.key !== TOKEN_PROGRAM_ID;
  if (t22) {
    require(remainingAccounts().length > 0n, MarginfiError.T22MintRequired);
    const mint = remainingAccounts().get(0n);
    const n = mint.dataLen;
    require(
      mintOk(bank.mint, mint.key, mint.owner, n, n >= 82n ? readData<u8>(mint, 45n) : 0n, n > 165n ? readData<u8>(mint, 165n) : 0n),
      MarginfiError.T22MintRequired,
    );
    decimals = readData<u8>(mint, 44n);
  }
  if (t22)
    invoke(
      token_program,
      [writable(fee_vault), readonly(remainingAccounts().get(0n)), writable(dst_token_account), readonlySigner(fee_vault_authority)],
      [u8(12n), amount, decimals],
      ["fee_vault_auth", bank.key, bank.fee_vault_authority_bump],
    );
  else invoke(token_program, [writable(fee_vault), writable(dst_token_account), readonlySigner(fee_vault_authority)], [u8(3n), amount], ["fee_vault_auth", bank.key, bank.fee_vault_authority_bump]);
}

/** Withdraw from a bank's insurance vault (admin only). */
export function lendingPoolWithdrawInsurance(
  group: HasOne<Account<MarginfiGroup>, "admin", MarginfiError.Unauthorized>,
  bank: HasOne<Account<Bank>, "group", MarginfiError.InvalidGroup>,
  admin: Signer,
  insurance_vault: Seeds<Mut<TokenAccount>, ["insurance_vault", "@bank"], "@bank.insurance_vault_bump">,
  insurance_vault_authority: Seeds<AccountInfo, ["insurance_vault_auth", "@bank"], "@bank.insurance_vault_authority_bump">,
  dst_token_account: Mut<TokenAccount>,
  token_program: TokenInterface,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  amount: u64,
): void {
  constraint(group, !protocolPaused(group), MarginfiError.ProtocolPaused);
  checkNoDurableNonce(instruction_sysvar);
  let decimals: u8 = 0n;
  const t22 = token_program.key !== TOKEN_PROGRAM_ID;
  if (t22) {
    require(remainingAccounts().length > 0n, MarginfiError.T22MintRequired);
    const mint = remainingAccounts().get(0n);
    const n = mint.dataLen;
    require(
      mintOk(bank.mint, mint.key, mint.owner, n, n >= 82n ? readData<u8>(mint, 45n) : 0n, n > 165n ? readData<u8>(mint, 165n) : 0n),
      MarginfiError.T22MintRequired,
    );
    decimals = readData<u8>(mint, 44n);
  }
  if (t22)
    invoke(
      token_program,
      [writable(insurance_vault), readonly(remainingAccounts().get(0n)), writable(dst_token_account), readonlySigner(insurance_vault_authority)],
      [u8(12n), amount, decimals],
      ["insurance_vault_auth", bank.key, bank.insurance_vault_authority_bump],
    );
  else invoke(token_program, [writable(insurance_vault), writable(dst_token_account), readonlySigner(insurance_vault_authority)], [u8(3n), amount], ["insurance_vault_auth", bank.key, bank.insurance_vault_authority_bump]);
}

/** Send a bank's fee vault (up to `amount`) to the fees destination the admin set (permissionless). */
export function lendingPoolWithdrawFeesPermissionless(
  group: Account<MarginfiGroup>,
  bank: HasOne<HasOne<Account<Bank>, "group", MarginfiError.InvalidGroup>, "fees_destination_account", MarginfiError.InvalidFeesDestinationAccount>,
  fee_vault: Seeds<Mut<TokenAccount>, ["fee_vault", "@bank"], "@bank.fee_vault_bump">,
  fee_vault_authority: Seeds<AccountInfo, ["fee_vault_auth", "@bank"], "@bank.fee_vault_authority_bump">,
  fees_destination_account: Mut<TokenAccount>,
  token_program: TokenInterface,
  amount: u64,
): void {
  constraint(group, !protocolPaused(group), MarginfiError.ProtocolPaused);
  const held = fee_vault.amount;
  let decimals: u8 = 0n;
  const t22 = token_program.key !== TOKEN_PROGRAM_ID;
  if (t22) {
    require(remainingAccounts().length > 0n, MarginfiError.T22MintRequired);
    const mint = remainingAccounts().get(0n);
    const n = mint.dataLen;
    require(
      mintOk(bank.mint, mint.key, mint.owner, n, n >= 82n ? readData<u8>(mint, 45n) : 0n, n > 165n ? readData<u8>(mint, 165n) : 0n),
      MarginfiError.T22MintRequired,
    );
    decimals = readData<u8>(mint, 44n);
  }
  if (t22)
    invoke(
      token_program,
      [writable(fee_vault), readonly(remainingAccounts().get(0n)), writable(fees_destination_account), readonlySigner(fee_vault_authority)],
      [u8(12n), amount < held ? amount : held, decimals],
      ["fee_vault_auth", bank.key, bank.fee_vault_authority_bump],
    );
  else invoke(token_program, [writable(fee_vault), writable(fees_destination_account), readonlySigner(fee_vault_authority)], [u8(3n), amount < held ? amount : held], ["fee_vault_auth", bank.key, bank.fee_vault_authority_bump]);
}
