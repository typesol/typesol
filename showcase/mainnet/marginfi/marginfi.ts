// A port of marginfi v2 (mrgnlabs/marginfi-v2, programs/marginfi @ c5d440f6, the build deployed at
// MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA), Copyright mrgnlabs, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL; this file holds the instructions ported
// so far: group and bank administration, oracles, accounts, deposits, withdrawals, borrows, repayments, fees, health
// pulses, liquidation records, bankruptcy, classic and receivership liquidation, deleverage and flash loans
// (see docs/case-study-marginfi.md for what is and is not).
//
// A lending protocol: groups of banks, one per mint, whose deposits earn what borrowers pay on a seven-point interest
// curve; the group, insurance and program take fees from the borrowing rate.
import {
  type Account,
  type AccountInfo,
  type CloseTo,
  type FixedArray,
  AnchorError,
  type Dup,
  type RemainingAccounts,
  type SystemAccount,
  type Address,
  type Mint,
  type TokenAccount,
  type TokenInterface,
  type i128,
  u16,
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
  fixedArray,
  loadAccountMut,
  stackHeight,
  emit,
  f64FromBits,
  findProgramAddress,
  invoke,
  programId,
  readData,
  readonly,
  readonlySigner,
  remainingAccounts,
  transferFee,
  transferFeeInverse,
  transferFeeBasisPoints,
  transferHookProgram,
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
  ZERO_KEY,
  ACCOUNT_DISABLED,
  ACCOUNT_FROZEN,
  ACCOUNT_IN_FLASHLOAN,
  ACCOUNT_IN_REBALANCE,
  ACCOUNT_IN_RISK_ADMIN_LIQUIDATION,
  DECREASE_BYPASS_BORROW_LIMIT,
  INCREASE_BYPASS_DEPOSIT_LIMIT,
  claimPremium,
  isZeroWithTolerance,
  purgeBalance,
  ZERO_AMOUNT_THRESHOLD,
  writeOffPremiumAmount,
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
  refreshIndexerFlags,
  clearLendingAccount,
} from "./account";
import { type BankConfigCompact, type BankConfigFast, type BankConfigGov } from "./args";
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
  PREMIUM_ACTIVE,
  accrueInterest,
  checkSameAssetFee,
  configureBank,
  initBank,
  recordDepositInflow,
  recordWithdrawalOutflow,
  socializeLoss,
  PERMISSIONLESS_BAD_DEBT_SETTLEMENT_FLAG,
  saturatingSubI64,
  remainingDepositCapacity,
  totalLiquidationFee,
  updateBankCache,
  updateCachePrice,
  recordGroupInflow,
  recordGroupOutflow,
  saturatingAddI64,
  assetAmount,
  liabilityAmount,
  liquidatorFee,
  insuranceFee,
  updateInterestRateConfig,
  validateBankConfig,
  validateBankState,
  validateEmodeEntries,
  configureBankGov,
  resetCbRuntimeState,
  CLOSE_ENABLED_FLAG,
} from "./bank";
import { MarginfiError } from "./errors";
import {
  REQ_INITIAL,
  REQ_MAINTENANCE,
  cachedHealthComponents,
  clearLiquidationLocks,
  lockLiquidationPrices,
  tagAdjustedPremium,
  type Moved,
  accountsPerBank,
  anyBankHalted,
  calcAmount,
  feedAt,
  liabilityBalanceErr,
  maxPremiumRate,
  tagAfterLiquidation,
  cachePrice,
  calcValue,
  cbPriceGate,
  bankruptcy,
  preLiquidation,
  resetHealthCache,
  BANKRUPT_THRESHOLD,
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
  type LendingPoolBankSetSameAssetEmodeEligibilityEvent,
  type LendingPoolBankConfigureEvent,
  type LendingPoolBankConfigureFrozenEvent,
  type LendingAccountDepositEvent,
  type LendingAccountPremiumSettledEvent,
  type LendingAccountRepayEvent,
  type LendingAccountWithdrawEvent,
  type LendingAccountBorrowEvent,
  type LendingAccountLiquidateEvent,
  type LiquidationReceiverEvent,
  type LendingPoolPremiumFeesCollectedEvent,
  type CircuitBreakerClearedEvent,
  type LendingPoolBankPremiumConfigureEvent,
  type SetGovernanceAdminEvent,
  type LendingPoolGroupPremiumConfigureEvent,
  type AdminCloseAccountEvent,
  type MarginfiAccountTransferToNewAccount,
  type MarginfiAccountFreezeEvent,
  type DeleverageEvent,
  type HealthPulseEvent,
  type LiquidationTagEvent,
  type LendingPoolBankHandleBankruptcyEvent,
  type DeleverageWithdrawFlowEvent,
  type LendingPoolBankCollectFeesEvent,
  type LendingPoolBankConfigureOracleEvent,
  type LendingPoolBankSetOraclePriceEvent,
  type LendingPoolBankCreateEvent,
  type MarginfiAccountCreateEvent,
  type MarginfiGroupConfigureEvent,
  type MarginfiGroupCreateEvent,
} from "./events";
import {
  I80F48_ONE,
  I80F48_ZERO,
  fxAdd,
  fxDiv,
  fxFrac,
  fxFromU64,
  fxInt,
  fxMul,
  fxSaturatingAdd,
  fxCeil,
  fxSaturatingSub,
  fxSub,
  fxToF64Bits,
  fxToU32Wrapping,
  fxToU64,
  fxTryAdd,
  fxTryMul,
  fxTrySub,
  fxWrappingMul,
  fxAbs,
} from "./i80f48";
import {
  ASSET_TAG_DEFAULT,
  ASSET_TAG_SOL,
  BIAS_HIGH,
  priceOfType,
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
import { PROGRAM_FEES_ENABLED, basisToU32, u32ToBasis, validateInterestRateConfig } from "./interest_rate";
import {
  type EmodeEntry,
  type Bank,
  type FeeState,
  type LiquidationRecord,
  type MarginfiAccount,
  type MarginfiGroup,
  type SameAssetEmodeRegistry,
  type WrappedI80F48,
  BankOperationalState,
  OracleSetup,
  RiskTier,
} from "./state";

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
    return (
      current === BankOperationalState.Operational ||
      current === BankOperationalState.ReduceOnly ||
      current === BankOperationalState.ReduceOnlyWithBorrowingPower
    );
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
  if (c.operational_state !== null)
    require(fastAdminCanTransition(bank.config.operational_state, c.operational_state), MarginfiError.InvalidFastBankOperationalState);
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
  require(s !== OracleSetup.Fixed &&
    s !== OracleSetup.FixedKamino &&
    s !== OracleSetup.FixedDrift &&
    s !== OracleSetup.FixedJuplend &&
    s !== OracleSetup.PTPyth &&
    s !== OracleSetup.PTFixed, MarginfiError.UseSetOraclePrice);
  require(s !== OracleSetup.Scope && s !== OracleSetup.ScopeKamino && s !== OracleSetup.ScopeJuplend, MarginfiError.UseConfigureBankOracleScope);
  require((bank.flags & BANK_SAME_ASSET_EMODE_ELIGIBLE) !== BANK_SAME_ASSET_EMODE_ELIGIBLE ||
    (bank.config.oracle_keys.get(0n) === oracle && feedFamily(bank.config.oracle_setup) === feedFamily(s)), MarginfiError.BadEmodeConfig);
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
  emit<LendingPoolBankConfigureOracleEvent>({
    header: { signer: governance_admin.key, marginfi_group: group.key },
    bank: bank.key,
    oracle_setup: setup,
    oracle,
  });
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
  refreshIndexerFlags(marginfi_account);
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
    require(mintOk(
      bank.mint,
      mint.key,
      mint.owner,
      n,
      n >= 82n ? readData<u8>(mint, 45n) : 0n,
      n > 165n ? readData<u8>(mint, 165n) : 0n,
    ), MarginfiError.T22MintRequired);
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
    header: {
      signer: authority.key,
      marginfi_account: marginfi_account.key,
      marginfi_account_authority: marginfi_account.authority,
      marginfi_group: marginfi_account.group,
    },
    bank: bank.key,
    mint: bank.mint,
    amount: deposit,
    share_amount: { value: shares },
  });
  sortBalances(marginfi_account);
  refreshIndexerFlags(marginfi_account);
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
    require(mintOk(
      bank.mint,
      mint.key,
      mint.owner,
      n,
      n >= 82n ? readData<u8>(mint, 45n) : 0n,
      n > 165n ? readData<u8>(mint, 165n) : 0n,
    ), MarginfiError.T22MintRequired);
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
    header: {
      signer: authority.key,
      marginfi_account: marginfi_account.key,
      marginfi_account_authority: marginfi_account.authority,
      marginfi_group: marginfi_account.group,
    },
    bank: bank.key,
    mint: bank.mint,
    amount: paid,
    close_balance: all,
    share_amount: { value: shares },
  });
  sortBalances(marginfi_account);
  refreshIndexerFlags(marginfi_account);
  if (!deferred) {
    // check_account_init_health_and_clear_tag: skipped in a flash loan (checked at its end).
    const flash = (marginfi_account.account_flags & ACCOUNT_IN_FLASHLOAN) !== 0n;
    const h = healthComponents(marginfi_account, group, remainingAccounts(), start, remainingAccounts().length, REQ_INITIAL, false, true, t);
    if (!flash) {
      require(h.err === 0n, h.err);
      require(h.assets >= h.liabs, MarginfiError.RiskEngineInitRejected);
      const tiers = riskTiersErr(marginfi_account, remainingAccounts(), start, remainingAccounts().length);
      require(tiers === 0n, tiers);
      // A tagged account healthy at Maintenance (spot prices) loses its tag; any error there keeps it.
      if (marginfi_account.liquidation_tagged_at !== 0n) {
        const m = healthComponents(marginfi_account, group, remainingAccounts(), start, remainingAccounts().length, REQ_MAINTENANCE, false, false, t);
        if (m.err === 0n && m.assets > m.liabs) marginfi_account.liquidation_tagged_at = 0n;
      }
    }
    writeHealthCache(marginfi_account, h, t, !flash);
    if (hasLiabilities(marginfi_account)) {
      const gate = cbPriceGate(marginfi_account, remainingAccounts(), start, remainingAccounts().length, t);
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
    require(mintOk(
      bank.mint,
      mint.key,
      mint.owner,
      n,
      n >= 82n ? readData<u8>(mint, 45n) : 0n,
      n > 165n ? readData<u8>(mint, 165n) : 0n,
    ), MarginfiError.T22MintRequired);
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
    header: {
      signer: authority.key,
      marginfi_account: marginfi_account.key,
      marginfi_account_authority: marginfi_account.authority,
      marginfi_group: marginfi_account.group,
    },
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
  refreshIndexerFlags(marginfi_account);
  if (bank.config.risk_tier === RiskTier.Isolated) marginfi_account.indexer_flags.has_isolated = 1n;
  // check_account_init_health_and_clear_tag, as a withdrawal runs it.
  const flash = (marginfi_account.account_flags & ACCOUNT_IN_FLASHLOAN) !== 0n;
  const h = healthComponents(marginfi_account, group, remainingAccounts(), start, remainingAccounts().length, REQ_INITIAL, false, true, t);
  if (!flash) {
    require(h.err === 0n, h.err);
    require(h.assets >= h.liabs, MarginfiError.RiskEngineInitRejected);
    const tiers = riskTiersErr(marginfi_account, remainingAccounts(), start, remainingAccounts().length);
    require(tiers === 0n, tiers);
    if (marginfi_account.liquidation_tagged_at !== 0n) {
      const m = healthComponents(marginfi_account, group, remainingAccounts(), start, remainingAccounts().length, REQ_MAINTENANCE, false, false, t);
      if (m.err === 0n && m.assets > m.liabs) marginfi_account.liquidation_tagged_at = 0n;
    }
  }
  // New premium-active debt needs a real rate: a pass that could not price some collateral cannot give one.
  require(!premiumRefreshUnavailable(h), MarginfiError.PremiumSnapshotUnavailable);
  const gate = cbPriceGate(marginfi_account, remainingAccounts(), start, remainingAccounts().length, t);
  require(gate === 0n, gate);
  updatePremiumSnapshots(marginfi_account, group, h, u64(t), true);
  const p = cachePrice(bank, bank.key, remainingAccounts(), start, t);
  recordWithdrawalOutflow(groupLimited, pre, p.err === 0n ? p.price : I80F48_ZERO, bank, group, group.key, bank.key, marginfi_account.account_flags, t);
  updateBankCache(bank, group, t);
  if (p.err === 0n) updateCachePrice(bank, p.price, p.conf, p.source_time, t, currentSlot());
  writeHealthCache(marginfi_account, h, t, !flash);
}

const HEALTH_ORACLE_OK: u32 = 4n;
const HEALTH_EMODE_BOOSTED: u32 = 8n;

/**
 * Refresh an account's health cache and indexer flags (anyone): its Initial health (whatever it gets to when it fails:
 * the error, and whether the engine or an oracle was at fault), the premium rates when that pass was complete, its
 * Maintenance health (liquidatable or not; a healthy account loses its liquidation tag) and its equity (bankrupt or
 * not, underwater, a trivial balance), then the event with the cache.
 */
export function lendingAccountPulseHealth(
  marginfi_account: HasOne<Mut<MarginfiAccount>, "group", MarginfiError.InvalidGroup>,
  group: Account<MarginfiGroup>,
): void {
  const t = now();
  const flash = (marginfi_account.account_flags & ACCOUNT_IN_FLASHLOAN) !== 0n;
  // check_account_init_health: in a flash loan Ok at once, the cache untouched.
  const init = healthComponents(marginfi_account, group, remainingAccounts(), 0n, remainingAccounts().length, REQ_INITIAL, false, true, t);
  let engineErr: u32 = 0n;
  let flags: u32 = 0n;
  if (!flash) {
    if (init.err !== 0n) engineErr = init.err;
    else {
      if (init.assets >= init.liabs) {
        flags = HEALTH_HEALTHY;
        engineErr = riskTiersErr(marginfi_account, remainingAccounts(), 0n, remainingAccounts().length);
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
    const m = healthComponents(marginfi_account, group, remainingAccounts(), 0n, remainingAccounts().length, REQ_MAINTENANCE, false, false, t);
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
    const q = healthComponents(marginfi_account, group, remainingAccounts(), 0n, remainingAccounts().length, REQ_EQUITY, false, false, t);
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
  const elapsed = saturatingSubI64(
    t,
    lastUpdate <= 9223372036854775807n ? i64(lastUpdate) : i64(lastUpdate - 9223372036854775808n) - 9223372036854775807n - 1n,
  );
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

// ---- liquidation records and bankruptcy ----------------------------------------------------------------------------

/**
 * Tag an account (anyone): at or below zero Maintenance health (with debt) it is tagged from now on, which lets the
 * liquidation premium grow; healthy again, a tagged account loses its tag. The account's banks and oracles follow.
 */
export function marginfiAccountTagLiqRecord(
  marginfi_account: HasOne<Mut<MarginfiAccount>, "group", MarginfiError.InvalidGroup>,
  group: Account<MarginfiGroup>,
): void {
  constraint(
    marginfi_account,
    (marginfi_account.account_flags &
      (ACCOUNT_DISABLED | ACCOUNT_IN_FLASHLOAN | ACCOUNT_IN_RECEIVERSHIP | ACCOUNT_IN_DELEVERAGE | ACCOUNT_IN_ORDER_EXECUTION | ACCOUNT_IN_REBALANCE)) ===
      0n,
    MarginfiError.UnexpectedLiquidationState,
  );
  constraint(group, !protocolPaused(group), MarginfiError.ProtocolPaused);
  const t = now();
  const m = preLiquidation(marginfi_account, group, remainingAccounts(), 0n, remainingAccounts().length, t);
  require(m.err === 0n, m.err);
  if (m.health > I80F48_ZERO || m.liabs === I80F48_ZERO) {
    require(marginfi_account.liquidation_tagged_at !== 0n, MarginfiError.HealthyAccount);
    marginfi_account.liquidation_tagged_at = 0n;
  } else {
    require(marginfi_account.liquidation_tagged_at === 0n, MarginfiError.AccountAlreadyTagged);
    marginfi_account.liquidation_tagged_at = t;
  }
  emit<LiquidationTagEvent>({ marginfi_account: marginfi_account.key, tagged_at: marginfi_account.liquidation_tagged_at });
}

/** Create an account's liquidation record, at ["liq_record", account] (anyone pays for it). */
export function marginfiAccountInitLiqRecord(
  marginfi_account: Mut<MarginfiAccount>,
  fee_payer: Mut<Signer>,
  liquidation_record: Init<LiquidationRecord>,
  system_program: SystemProgram,
): void {
  liquidation_record.create(fee_payer, ["liq_record", marginfi_account.key]);
  liquidation_record.key_ = liquidation_record.key;
  liquidation_record.record_payer = fee_payer.key;
  liquidation_record.marginfi_account = marginfi_account.key;
  marginfi_account.liquidation_record = liquidation_record.key;
}

/** Close an account's liquidation record, its rent back to who paid: unused, or idle for 60 days. */
export function marginfiAccountCloseLiqRecord(
  marginfi_account: HasOne<Mut<MarginfiAccount>, "liquidation_record", MarginfiError.InvalidLiquidationRecord>,
  liquidation_record: CloseTo<HasOne<Mut<LiquidationRecord>, "marginfi_account", MarginfiError.InvalidLiquidationRecord>, "record_payer">,
  record_payer: Mut<AccountInfo>,
): void {
  constraint(
    marginfi_account,
    (marginfi_account.account_flags & ACCOUNT_IN_RECEIVERSHIP) === 0n && (marginfi_account.account_flags & ACCOUNT_IN_DELEVERAGE) === 0n,
    MarginfiError.IllegalAction,
  );
  constraint(liquidation_record, liquidation_record.liquidation_receiver === SYSTEM_PROGRAM_ID, MarginfiError.IllegalAction);
  constraint(record_payer, liquidation_record.record_payer === record_payer.key, MarginfiError.Unauthorized);
  let last: i64 = 0n;
  for (let i = 0n; i < 4n; i++) {
    const ts = liquidation_record.entries.get(i).timestamp;
    if (ts > last) last = ts;
  }
  if (last > 0n) require(saturatingSubI64(now(), last) >= 5184000n, MarginfiError.IllegalAction);
  marginfi_account.liquidation_record = SYSTEM_PROGRAM_ID;
}

/**
 * Settle a bankrupt account's debt in a bank (the admin or risk admin; anyone where the bank allows it): the insurance
 * fund covers what it can, the bank's depositors share the rest (a bank whose deposits it exceeds is killed), and the
 * account is disabled. The account's banks and oracles follow (after a Token-2022 bank's mint).
 */
export function lendingPoolHandleBankruptcy(
  group: Account<MarginfiGroup>,
  signer: Signer,
  bank: HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>,
  marginfi_account: HasOne<Mut<MarginfiAccount>, "group", MarginfiError.InvalidGroup>,
  liquidity_vault: Seeds<Mut<AccountInfo>, ["liquidity_vault", "@bank"], "@bank.liquidity_vault_bump">,
  insurance_vault: Seeds<Mut<TokenAccount>, ["insurance_vault", "@bank"], "@bank.insurance_vault_bump">,
  insurance_vault_authority: Seeds<AccountInfo, ["insurance_vault_auth", "@bank"], "@bank.insurance_vault_authority_bump">,
  token_program: TokenInterface,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
): void {
  constraint(group, !protocolPaused(group) || signer.key === group.admin || signer.key === group.risk_admin, MarginfiError.ProtocolPaused);
  constraint(bank, isMarginfiAssetTag(bank.config.asset_tag), MarginfiError.WrongAssetTagForStandardInstructions);
  constraint(marginfi_account, (marginfi_account.account_flags & ACCOUNT_IN_RECEIVERSHIP) === 0n, MarginfiError.UnexpectedLiquidationState);
  constraint(marginfi_account, (marginfi_account.account_flags & ACCOUNT_IN_FLASHLOAN) === 0n, MarginfiError.AccountInFlashloan);
  checkNoDurableNonce(instruction_sysvar);
  const t = now();
  const admin = signer.key === group.risk_admin || signer.key === group.admin;
  if ((bank.flags & PERMISSIONLESS_BAD_DEBT_SETTLEMENT_FLAG) === PERMISSIONLESS_BAD_DEBT_SETTLEMENT_FLAG)
    validateBankState(bank, FAILS_IN_PAUSED_STATE, false, t);
  else {
    validateBankState(bank, 0n, true, t);
    require(admin, MarginfiError.Unauthorized);
  }
  // maybe_take_bank_mint
  let decimals: u8 = 0n;
  const t22 = token_program.key !== TOKEN_PROGRAM_ID;
  if (t22) {
    require(remainingAccounts().length > 0n, MarginfiError.T22MintRequired);
    const mint = remainingAccounts().get(0n);
    const n = mint.dataLen;
    require(mintOk(
      bank.mint,
      mint.key,
      mint.owner,
      n,
      n >= 82n ? readData<u8>(mint, 45n) : 0n,
      n > 165n ? readData<u8>(mint, 165n) : 0n,
    ), MarginfiError.T22MintRequired);
    decimals = readData<u8>(mint, 44n);
  }
  const start: u64 = t22 ? 1n : 0n;
  // The breaker's gate, unless an admin settles; then the equity check on the bank before its interest accrues.
  if (!admin) {
    const gate = cbPriceGate(marginfi_account, remainingAccounts(), start, remainingAccounts().length, t);
    require(gate === 0n, gate);
  }
  const q = bankruptcy(marginfi_account, group, remainingAccounts(), start, remainingAccounts().length, t);
  require(q.err === 0n, q.err);
  const p = cachePrice(bank, bank.key, remainingAccounts(), start, t);
  resetHealthCache(marginfi_account, t, 3n, HEALTH_ENGINE_OK);
  marginfi_account.health_cache.asset_value_equity.value = q.assets;
  marginfi_account.health_cache.liability_value_equity.value = q.liabs;
  accrueInterest(bank, group, bank.key, t);
  const found = findBalance(marginfi_account, bank.key);
  require(found >= 0n, MarginfiError.LendingAccountBalanceNotFound);
  const i = u64(found);
  const badDebt = fxMul(marginfi_account.lending_account.balances.get(i).liability_shares.value, bank.liability_share_value.value);
  require(badDebt > ZERO_AMOUNT_THRESHOLD, MarginfiError.BalanceNotBadDebt);
  // The insurance fund, net of a Token-2022 transfer fee.
  let held = insurance_vault.amount;
  if (t22) held = held - transferFee(remainingAccounts().get(0n), held);
  const available = fxFromU64(held);
  const covered = badDebt < available ? badDebt : available;
  const rest = fxSub(badDebt, covered);
  const socialized = rest > I80F48_ZERO ? rest : I80F48_ZERO;
  const coveredTokens = fxToU64(fxCeil(covered));
  const pre = t22 ? coveredTokens + transferFeeInverse(remainingAccounts().get(0n), coveredTokens) : coveredTokens;
  const bump = bank.insurance_vault_authority_bump;
  if (t22)
    invoke(
      token_program,
      [writable(insurance_vault), readonly(remainingAccounts().get(0n)), writable(liquidity_vault), readonlySigner(insurance_vault_authority)],
      [u8(12n), pre, decimals],
      ["insurance_vault_auth", bank.key, bump],
    );
  else
    invoke(
      token_program,
      [writable(insurance_vault), writable(liquidity_vault), readonlySigner(insurance_vault_authority)],
      [u8(3n), pre],
      ["insurance_vault_auth", bank.key, bump],
    );
  const kill = socializeLoss(bank, socialized);
  claimBalancePremium(marginfi_account, i, bank, u64(t));
  const writtenOff = writeOffPremiumAmount(marginfi_account, i);
  increaseBalance(marginfi_account, i, bank, badDebt, INCREASE_REPAY_ONLY, u64(t));
  updateBankCache(bank, group, t);
  if (p.err === 0n) updateCachePrice(bank, p.price, p.conf, p.source_time, t, currentSlot());
  marginfi_account.account_flags |= ACCOUNT_DISABLED;
  marginfi_account.indexer_flags.has_been_bankrupted = 1n;
  marginfi_account.last_update = u64(t);
  if (kill) bank.config.operational_state = BankOperationalState.KilledByBankruptcy;
  emit<LendingPoolBankHandleBankruptcyEvent>({
    header: {
      signer: signer.key,
      marginfi_account: marginfi_account.key,
      marginfi_account_authority: marginfi_account.authority,
      marginfi_group: marginfi_account.group,
    },
    bank: bank.key,
    mint: bank.mint,
    bad_debt: f64FromBits(fxToF64Bits(badDebt)),
    covered_amount: f64FromBits(fxToF64Bits(covered)),
    socialized_amount: f64FromBits(fxToF64Bits(socialized)),
    premium_written_off: f64FromBits(fxToF64Bits(writtenOff)),
  });
}

/**
 * validate_bank_asset_tags: a liquidation never pays default-like assets (default and the integrations) for staked
 * SOL debt or the other way round; SOL goes with either.
 */
function bankTagsCompatible(a: Mut<Bank>, b: Mut<Bank>): boolean {
  const ta = a.config.asset_tag;
  const tb = b.config.asset_tag;
  const da = ta === 0n || (ta >= 3n && ta <= 6n);
  const db = tb === 0n || (tb >= 3n && tb <= 6n);
  return !((da && tb === BANK_ASSET_TAG_STAKED) || (ta === BANK_ASSET_TAG_STAKED && db));
}

/**
 * check_post_liquidation_condition_and_get_account_health, then the liquidatee's premium snapshots from the new
 * collateral mix (no ratchet: a third party picked its oracles). The liability must still be there and the account
 * still at or below zero at Maintenance, but better than before. Returns its health.
 */
function liquidateeAfter(
  acc: Mut<MarginfiAccount>,
  group: Account<MarginfiGroup>,
  rest: RemainingAccounts,
  start: u64,
  liabBank: Pubkey,
  pre: i128,
  t: i64,
): i128 {
  require((acc.account_flags & ACCOUNT_IN_FLASHLOAN) === 0n, MarginfiError.AccountInFlashloan);
  const e = liabilityBalanceErr(acc, liabBank, 6069n, 6070n);
  require(e === 0n, e);
  const h = healthComponents(acc, group, rest, start, rest.length, REQ_MAINTENANCE, false, true, t);
  require(h.err === 0n, h.err);
  const health = fxTrySub(h.assets, h.liabs);
  require(health.err === 0n, health.err);
  require(health.v <= I80F48_ZERO, MarginfiError.TooSevereLiquidation);
  require(health.v > pre, MarginfiError.WorseHealthPostLiquidation);
  updatePremiumSnapshots(acc, group, h, u64(t), false);
  return health.v;
}

/**
 * The liquidator's Initial health over its own window (skipped in a flash loan), its tag cleared when healthy at
 * Maintenance, its premium snapshots ratcheted; a premium-active debt it just took on that the pass could not price
 * is raised to the highest rate configured for its tag (the time since its last update claimed at the old rate).
 */
function liquidatorAfter(
  acc: Mut<MarginfiAccount>,
  group: Account<MarginfiGroup>,
  rest: RemainingAccounts,
  start: u64,
  end: u64,
  liab: Mut<Bank>,
  t: i64,
): void {
  const flash = (acc.account_flags & ACCOUNT_IN_FLASHLOAN) !== 0n;
  const h = healthComponents(acc, group, rest, start, end, REQ_INITIAL, false, true, t);
  if (!flash) {
    require(h.err === 0n, h.err);
    require(h.assets >= h.liabs, MarginfiError.RiskEngineInitRejected);
    const tiers = riskTiersErr(acc, rest, start, end);
    require(tiers === 0n, tiers);
    if (acc.liquidation_tagged_at !== 0n) {
      const m = healthComponents(acc, group, rest, start, end, REQ_MAINTENANCE, false, false, t);
      if (m.err === 0n && m.assets > m.liabs) acc.liquidation_tagged_at = 0n;
    }
  }
  updatePremiumSnapshots(acc, group, h, u64(t), true);
  if (h.s_complete || (liab.flags & PREMIUM_ACTIVE) === 0n) return;
  const found = findBalance(acc, liab.key);
  if (found < 0n) return;
  const i = u64(found);
  const b = acc.lending_account.balances.get(i);
  const seed = maxPremiumRate(group, liab.premium_tag);
  if (b.liability_shares.value < EMPTY_BALANCE_THRESHOLD || b.premium_rate_snapshot >= seed) return;
  const owed = fxTryMul(b.liability_shares.value, liab.liability_share_value.value);
  require(owed.err === 0n, owed.err);
  claimPremium(acc, i, owed.v, liab.premium_activated_at, u64(t));
  acc.lending_account.balances.get(i).premium_rate_snapshot = seed;
}

/**
 * Liquidate (classic): the liquidator takes `asset_amount` of the liquidatee's collateral in `asset_bank` at a discount
 * and takes on the liquidatee's debt in `liab_bank` worth it, less the insurance fund's cut, which the liability
 * bank's vault pays to its insurance vault. The remaining accounts: a Token-2022 liability bank's mint; the asset
 * bank's oracles (only their count matters), the liability bank's oracles; the liquidator's [bank, oracles…] groups
 * after the liquidation (`liquidator_accounts` of them), then the liquidatee's (`liquidatee_accounts`), last.
 */
export function lendingAccountLiquidate(
  group: Account<MarginfiGroup>,
  asset_bank: Dup<HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>>,
  liab_bank: Dup<HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>>,
  liquidator_marginfi_account: Dup<HasOne<Mut<MarginfiAccount>, "group", MarginfiError.InvalidGroup>>,
  authority: Signer,
  liquidatee_marginfi_account: Dup<HasOne<Mut<MarginfiAccount>, "group", MarginfiError.InvalidGroup>>,
  bank_liquidity_vault_authority: Seeds<AccountInfo, ["liquidity_vault_auth", "@liab_bank"], "@liab_bank.liquidity_vault_authority_bump">,
  bank_liquidity_vault: Seeds<Mut<TokenAccount>, ["liquidity_vault", "@liab_bank"], "@liab_bank.liquidity_vault_bump">,
  bank_insurance_vault: Seeds<Mut<AccountInfo>, ["insurance_vault", "@liab_bank"], "@liab_bank.insurance_vault_bump">,
  token_program: TokenInterface,
  asset_amount: u64,
  liquidatee_accounts: u8,
  liquidator_accounts: u8,
): void {
  constraint(group, !protocolPaused(group), MarginfiError.ProtocolPaused);
  constraint(liab_bank, isMarginfiAssetTag(liab_bank.config.asset_tag), MarginfiError.WrongAssetTagForStandardInstructions);
  constraint(liquidator_marginfi_account, (liquidator_marginfi_account.account_flags & ACCOUNT_IN_RECEIVERSHIP) === 0n, MarginfiError.ForbiddenIx);
  constraint(liquidator_marginfi_account, notFrozenForAuthority(liquidator_marginfi_account, authority.key), MarginfiError.AccountFrozen);
  constraint(
    liquidator_marginfi_account,
    signerAuthorized(liquidator_marginfi_account, group.governance_admin, authority.key, false, false, false),
    MarginfiError.Unauthorized,
  );
  constraint(liquidatee_marginfi_account, (liquidatee_marginfi_account.account_flags & ACCOUNT_IN_RECEIVERSHIP) === 0n, MarginfiError.ForbiddenIx);
  require(asset_amount > 0n, MarginfiError.ZeroLiquidationAmount);
  require(asset_bank.key !== liab_bank.key, MarginfiError.SameAssetAndLiabilityBanks);
  // The original's second load_mut of one account fails here (AccountBorrowFailed, not a custom code).
  require(liquidator_marginfi_account.key !== liquidatee_marginfi_account.key, 2040n);
  const t = now();
  const ts = u64(t);
  // maybe_take_bank_mint (the liability bank's), before anything else.
  let decimals: u8 = 0n;
  const t22 = token_program.key !== TOKEN_PROGRAM_ID;
  if (t22) {
    require(remainingAccounts().length > 0n, MarginfiError.T22MintRequired);
    const mint = remainingAccounts().get(0n);
    const n = mint.dataLen;
    require(mintOk(
      liab_bank.mint,
      mint.key,
      mint.owner,
      n,
      n >= 82n ? readData<u8>(mint, 45n) : 0n,
      n > 165n ? readData<u8>(mint, 165n) : 0n,
    ), MarginfiError.T22MintRequired);
    decimals = readData<u8>(mint, 44n);
  }
  const start: u64 = t22 ? 1n : 0n;
  const len = remainingAccounts().length;
  accrueInterest(asset_bank, group, asset_bank.key, t);
  accrueInterest(liab_bank, group, liab_bank.key, t);
  // The liquidatee's accounts are the last `liquidatee_accounts` (more than there are panics).
  require(u64(liquidatee_accounts) <= len - start, MarginfiError.InternalLogicError);
  const liqe = len - u64(liquidatee_accounts);
  sortBalances(liquidatee_marginfi_account);
  const halted = anyBankHalted(liquidatee_marginfi_account, remainingAccounts(), liqe, len, t);
  require(halted.err === 0n, halted.err);
  const cbAdmin = halted.n !== 0n;
  // A halted bank leaves liquidation to the admins; otherwise the breaker's gate first, as for a borrow.
  if (cbAdmin) require(authority.key === group.risk_admin || authority.key === group.admin, MarginfiError.CircuitBreakerAdminOnly);
  else {
    const gate = cbPriceGate(liquidatee_marginfi_account, remainingAccounts(), liqe, len, t);
    require(gate === 0n, gate);
  }
  require(bankTagsCompatible(asset_bank, liab_bank), MarginfiError.AssetTagMismatch);
  validateBankState(asset_bank, FAILS_IN_PAUSED_STATE, cbAdmin, t);
  validateBankState(liab_bank, FAILS_IN_PAUSED_STATE, cbAdmin, t);
  require(assetTagsCompatible(liab_bank, liquidatee_marginfi_account), MarginfiError.AssetTagMismatch);
  require(assetTagsCompatible(liab_bank, liquidator_marginfi_account), MarginfiError.AssetTagMismatch);
  require(assetTagsCompatible(asset_bank, liquidator_marginfi_account), MarginfiError.AssetTagMismatch);

  // check_pre_liquidation_condition_and_get_account_health: a debt in the liability bank, unhealthy at Maintenance.
  require((liquidatee_marginfi_account.account_flags & ACCOUNT_IN_FLASHLOAN) === 0n, MarginfiError.AccountInFlashloan);
  const owing = liabilityBalanceErr(liquidatee_marginfi_account, liab_bank.key, 6066n, 6067n);
  require(owing === 0n, owing);
  const before = preLiquidation(liquidatee_marginfi_account, group, remainingAccounts(), liqe, len, t);
  require(before.err === 0n, before.err);
  require(before.health <= I80F48_ZERO, MarginfiError.HealthyAccount);
  const assetCache = cachePrice(asset_bank, asset_bank.key, remainingAccounts(), liqe, t);
  const liabCache = cachePrice(liab_bank, liab_bank.key, remainingAccounts(), liqe, t);

  // Prices: the asset's spot less its confidence (found by key), the liability's plus it (its oracles after the
  // asset bank's count of them).
  const amount = fxFromU64(asset_amount);
  const assetPer = accountsPerBank(asset_bank);
  require(assetPer.err === 0n, assetPer.err);
  const assetPrice = lowPrice(asset_bank, asset_bank.key, remainingAccounts(), start, t);
  require(assetPrice.err === 0n, assetPrice.err);
  require(assetPrice.v > I80F48_ZERO, MarginfiError.ZeroAssetPrice);
  const liabPer = accountsPerBank(liab_bank);
  require(liabPer.err === 0n, liabPer.err);
  const liabFirst = start + assetPer.n - 1n;
  require(liabFirst + liabPer.n - 1n <= len, MarginfiError.InternalLogicError);
  const feed = feedAt(liab_bank, remainingAccounts(), liabFirst, liabPer.n - 1n, t);
  require(feed.err === 0n, feed.err);
  const liabPrice = priceOfType(feed, true, BIAS_HIGH, liab_bank.config.oracle_max_confidence);
  require(liabPrice.err === 0n, liabPrice.err);
  require(liabPrice.v > I80F48_ZERO, MarginfiError.ZeroLiabilityPrice);

  // The liquidator pays the asset's value less its cut; the liquidatee is credited that less the insurance fund's.
  const liquidatorCut = liquidatorFee(liab_bank);
  const insuranceCut = insuranceFee(liab_bank);
  const finalDiscount = fxSub(I80F48_ONE, fxAdd(insuranceCut, liquidatorCut));
  const liquidatorDiscount = fxSub(I80F48_ONE, liquidatorCut);
  const paidValue = calcValue(amount, assetPrice.v, asset_bank.mint_decimals, liquidatorDiscount, true);
  require(paidValue.err === 0n, paidValue.err);
  const paid = calcAmount(paidValue.v, liabPrice.v, liab_bank.mint_decimals);
  require(paid.err === 0n, paid.err);
  const creditedValue = calcValue(amount, assetPrice.v, asset_bank.mint_decimals, finalDiscount, true);
  require(creditedValue.err === 0n, creditedValue.err);
  const credited = calcAmount(creditedValue.v, liabPrice.v, liab_bank.mint_decimals);
  require(credited.err === 0n, credited.err);
  const insurance = fxSub(paid.v, credited.v);
  const repaidMaint = calcValue(credited.v, liabPrice.v, liab_bank.mint_decimals, liab_bank.config.liability_weight_maint.value, true);
  require(repaidMaint.err === 0n, repaidMaint.err);
  // The original asserts it (a panic).
  require(insurance >= I80F48_ZERO, MarginfiError.InternalLogicError);

  // The liquidator takes on the debt: out of its deposit in the liability bank first, then borrowed.
  const r = findOrCreateBalance(liquidator_marginfi_account, liab_bank, liab_bank.key, t);
  const rLiabPre = liabilityAmount(liab_bank, liquidator_marginfi_account.lending_account.balances.get(r).liability_shares.value);
  const rLiabAssetPre = assetAmount(liab_bank, liquidator_marginfi_account.lending_account.balances.get(r).asset_shares.value);
  decreaseBalance(liquidator_marginfi_account, r, liab_bank, paid.v, DECREASE_BYPASS_BORROW_LIMIT, ts);
  const rLiabPost = liabilityAmount(liab_bank, liquidator_marginfi_account.lending_account.balances.get(r).liability_shares.value);
  const rLiabAssetPost = assetAmount(liab_bank, liquidator_marginfi_account.lending_account.balances.get(r).asset_shares.value);
  // The liquidatee gives up the collateral.
  const foundAsset = findBalance(liquidatee_marginfi_account, asset_bank.key);
  require(foundAsset >= 0n, MarginfiError.BankAccountNotFound);
  const e = u64(foundAsset);
  const eAssetPre = assetAmount(asset_bank, liquidatee_marginfi_account.lending_account.balances.get(e).asset_shares.value);
  require(eAssetPre >= amount, MarginfiError.OverliquidationAttempt);
  decreaseBalance(liquidatee_marginfi_account, e, asset_bank, amount, DECREASE_BYPASS_BORROW_LIMIT, ts);
  const eAssetPost = assetAmount(asset_bank, liquidatee_marginfi_account.lending_account.balances.get(e).asset_shares.value);
  // The liquidator receives it: its premium owed in that bank settled first, as a repayment would.
  const a = findOrCreateBalance(liquidator_marginfi_account, asset_bank, asset_bank.key, t);
  const rAssetPre = assetAmount(asset_bank, liquidator_marginfi_account.lending_account.balances.get(a).asset_shares.value);
  claimBalancePremium(liquidator_marginfi_account, a, asset_bank, ts);
  const settled = settlePremium(liquidator_marginfi_account, a, asset_bank, amount);
  const credit = fxTrySub(amount, settled);
  require(credit.err === 0n, credit.err);
  if (credit.v > I80F48_ZERO) increaseBalance(liquidator_marginfi_account, a, asset_bank, credit.v, INCREASE_BYPASS_DEPOSIT_LIMIT, ts);
  const rAssetPost = assetAmount(asset_bank, liquidator_marginfi_account.lending_account.balances.get(a).asset_shares.value);
  const premiumLeft = liquidator_marginfi_account.lending_account.balances.get(a).premium_outstanding.value;
  liquidator_marginfi_account.last_update = ts;
  const fee = fxToU64(insurance);
  const dust = fxFrac(insurance);
  // The liquidatee's debt is repaid by what it is credited; the insurance fund's cut leaves the vault.
  const foundLiab = findBalance(liquidatee_marginfi_account, liab_bank.key);
  require(foundLiab >= 0n, MarginfiError.BankAccountNotFound);
  const l = u64(foundLiab);
  const eLiabPre = liabilityAmount(liab_bank, liquidatee_marginfi_account.lending_account.balances.get(l).liability_shares.value);
  increaseBalance(liquidatee_marginfi_account, l, liab_bank, credited.v, INCREASE_REPAY_ONLY, ts);
  const eLiabPost = liabilityAmount(liab_bank, liquidatee_marginfi_account.lending_account.balances.get(l).liability_shares.value);
  liquidatee_marginfi_account.last_update = ts;
  const bump = liab_bank.liquidity_vault_authority_bump;
  if (t22)
    invoke(
      token_program,
      [writable(bank_liquidity_vault), readonly(remainingAccounts().get(0n)), writable(bank_insurance_vault), readonlySigner(bank_liquidity_vault_authority)],
      [u8(12n), fee, decimals],
      ["liquidity_vault_auth", liab_bank.key, bump],
    );
  else
    invoke(
      token_program,
      [writable(bank_liquidity_vault), writable(bank_insurance_vault), readonlySigner(bank_liquidity_vault_authority)],
      [u8(3n), fee],
      ["liquidity_vault_auth", liab_bank.key, bump],
    );
  const outstanding = fxTryAdd(liab_bank.collected_insurance_fees_outstanding.value, dust);
  require(outstanding.err === 0n, outstanding.err);
  liab_bank.collected_insurance_fees_outstanding.value = outstanding.v;
  updateBankCache(asset_bank, group, t);
  if (assetCache.err === 0n) updateCachePrice(asset_bank, assetCache.price, assetCache.conf, assetCache.source_time, t, currentSlot());
  updateBankCache(liab_bank, group, t);
  if (liabCache.err === 0n) updateCachePrice(liab_bank, liabCache.price, liabCache.conf, liabCache.source_time, t, currentSlot());

  // The liquidator's accounts end where the liquidatee's begin (more than there are panics).
  require(u64(liquidator_accounts) <= liqe - start, MarginfiError.InternalLogicError);
  const liqr = liqe - u64(liquidator_accounts);
  const after = liquidateeAfter(liquidatee_marginfi_account, group, remainingAccounts(), liqe, liab_bank.key, before.health, t);
  liquidatee_marginfi_account.liquidation_tagged_at = tagAfterLiquidation(
    liquidatee_marginfi_account.liquidation_tagged_at,
    before.health,
    after,
    before.liabs,
    repaidMaint.v,
    t,
  );
  liquidatee_marginfi_account.indexer_flags.has_ever_been_liquidated = 1n;
  refreshIndexerFlags(liquidatee_marginfi_account);
  sortBalances(liquidator_marginfi_account);
  refreshIndexerFlags(liquidator_marginfi_account);
  liquidatorAfter(liquidator_marginfi_account, group, remainingAccounts(), liqr, liqe, liab_bank, t);
  if (!cbAdmin) {
    const gate = cbPriceGate(liquidator_marginfi_account, remainingAccounts(), liqr, liqe, t);
    require(gate === 0n, gate);
  }
  liquidatee_marginfi_account.account_flags &= ~ACCOUNT_IN_RISK_ADMIN_LIQUIDATION;
  liquidator_marginfi_account.account_flags &= ~ACCOUNT_IN_RISK_ADMIN_LIQUIDATION;
  if (settled > I80F48_ZERO)
    emit<LendingAccountPremiumSettledEvent>({
      header: {
        signer: authority.key,
        marginfi_account: liquidator_marginfi_account.key,
        marginfi_account_authority: liquidator_marginfi_account.authority,
        marginfi_group: group.key,
      },
      bank: asset_bank.key,
      mint: asset_bank.mint,
      premium_settled: f64FromBits(fxToF64Bits(settled)),
      premium_written_off: f64FromBits(0n),
      premium_outstanding_remaining: f64FromBits(fxToF64Bits(premiumLeft)),
    });
  emit<LendingAccountLiquidateEvent>({
    header: {
      signer: authority.key,
      marginfi_account: liquidator_marginfi_account.key,
      marginfi_account_authority: liquidator_marginfi_account.authority,
      marginfi_group: group.key,
    },
    liquidatee_marginfi_account: liquidatee_marginfi_account.key,
    liquidatee_marginfi_account_authority: liquidatee_marginfi_account.authority,
    asset_bank: asset_bank.key,
    asset_mint: asset_bank.mint,
    liability_bank: liab_bank.key,
    liability_mint: liab_bank.mint,
    liquidatee_pre_health: f64FromBits(fxToF64Bits(before.health)),
    liquidatee_post_health: f64FromBits(fxToF64Bits(after)),
    pre_balances: {
      liquidatee_asset_balance: f64FromBits(fxToF64Bits(eAssetPre)),
      liquidatee_liability_balance: f64FromBits(fxToF64Bits(eLiabPre)),
      liquidator_asset_balance: f64FromBits(fxToF64Bits(rAssetPre)),
      liquidator_liability_balance: f64FromBits(fxToF64Bits(rLiabPre)),
      liquidator_liability_bank_asset_balance: f64FromBits(fxToF64Bits(rLiabAssetPre)),
    },
    post_balances: {
      liquidatee_asset_balance: f64FromBits(fxToF64Bits(eAssetPost)),
      liquidatee_liability_balance: f64FromBits(fxToF64Bits(eLiabPost)),
      liquidator_asset_balance: f64FromBits(fxToF64Bits(rAssetPost)),
      liquidator_liability_balance: f64FromBits(fxToF64Bits(rLiabPost)),
      liquidator_liability_bank_asset_balance: f64FromBits(fxToF64Bits(rLiabAssetPost)),
    },
  });
}

// ---- receivership --------------------------------------------------------------------------------------------------

const COMPUTE_BUDGET_ID = pubkey("ComputeBudget111111111111111111111111111111");
const KAMINO_ID = pubkey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const DRIFT_ID = pubkey("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH");
const JUPLEND_EARN_ID = pubkey("jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9");
const JUP_ID = pubkey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const TITAN_ID = pubkey("T1TANpTeScyeqVzzgNViGDNrkQ6qHz9KrSBS4aNXvGT");
/** Anchor discriminators (the first 8 data bytes, little-endian). */
const IX_START_LIQUIDATION: u64 = 1567154542508400116n;
const IX_END_LIQUIDATION: u64 = 13264989748540476270n;
const IX_START_DELEVERAGE: u64 = 13958599354534758922n;
const IX_END_DELEVERAGE: u64 = 15120388232899595890n;
const IX_INIT_LIQUIDATION_RECORD: u64 = 622899259392316908n;
const IX_WITHDRAW: u64 = 13889333050519210020n;
const IX_REPAY: u64 = 10929448902254711119n;
const IX_KAMINO_WITHDRAW: u64 = 14474677870094017991n;
const IX_DRIFT_WITHDRAW: u64 = 9937955327405865814n;
const IX_JUPLEND_WITHDRAW: u64 = 15995463394970674421n;
const KAMINO_REFRESH_RESERVE: u64 = 7357132811377760770n;
const KAMINO_REFRESH_RESERVES_BATCH: u64 = 10663623015593045648n;
const KAMINO_REFRESH_OBLIGATION: u64 = 6433603826306221089n;
const DRIFT_UPDATE_SPOT_MARKET_CUMULATIVE_INTEREST: u64 = 16256769382033368615n;
const JUPLEND_UPDATE_RATE: u64 = 12889817017388228888n;
/** LIQUIDATION_CLOSEOUT_DOLLAR_THRESHOLD (5) and LIQUIDATION_BONUS_FEE_MINIMUM (0.05). */
const CLOSEOUT_THRESHOLD: i128 = 1407374883553280n;
const BONUS_FEE_MINIMUM: i128 = 14073748835533n;

/** An instruction that may come before the start: an integration's refresh, or creating the liquidation record. */
function allowedBeforeStart(program: Pubkey, d: u64): boolean {
  if (program === KAMINO_ID) return d === KAMINO_REFRESH_RESERVE || d === KAMINO_REFRESH_RESERVES_BATCH || d === KAMINO_REFRESH_OBLIGATION;
  if (program === DRIFT_ID) return d === DRIFT_UPDATE_SPOT_MARKET_CUMULATIVE_INTEREST;
  if (program === JUPLEND_EARN_ID) return d === JUPLEND_UPDATE_RATE;
  return program === programId() && d === IX_INIT_LIQUIDATION_RECORD;
}

/**
 * validate_instructions: only allowed programs in the transaction (ForbiddenIx); the start first but for compute
 * budget and refresh instructions (StartNotFirst), once (StartRepeats); the end last (EndNotLast); this program only
 * for the start, the end, the record, withdrawals and repayments (ForbiddenIx); not called through CPI.
 */
function validateReceivership(ixs: InstructionsSysvar, start: u64, end: u64): void {
  const n = ixs.length;
  for (let i = 0n; i < n; i++) {
    const p = ixs.get(i).programId;
    require(p === COMPUTE_BUDGET_ID ||
      p === programId() ||
      p === KAMINO_ID ||
      p === DRIFT_ID ||
      p === JUPLEND_EARN_ID ||
      p === JUP_ID ||
      p === TITAN_ID ||
      p === ATA_PROGRAM_ID, MarginfiError.ForbiddenIx);
  }
  let seen = false;
  for (let i = 0n; i < n; i++) {
    const ix = ixs.get(i);
    if (ix.programId === COMPUTE_BUDGET_ID) continue;
    require(ix.dataLength >= 8n, MarginfiError.StartNotFirst);
    const d = ix.readU64(0n);
    const isStart = ix.programId === programId() && d === start;
    if (!seen) {
      require(isStart || allowedBeforeStart(ix.programId, d), MarginfiError.StartNotFirst);
      seen = isStart;
    } else require(!isStart, MarginfiError.StartRepeats);
  }
  require(seen, MarginfiError.StartNotFirst);
  const last = ixs.get(n - 1n);
  require(last.dataLength >= 8n, MarginfiError.EndNotLast);
  require(last.programId === programId(), MarginfiError.EndNotLast);
  require(last.readU64(0n) === end, MarginfiError.EndNotLast);
  for (let i = 0n; i < n; i++) {
    const ix = ixs.get(i);
    if (ix.programId !== programId()) continue;
    // A malformed instruction of this program: the original panics.
    require(ix.dataLength >= 8n, MarginfiError.InternalLogicError);
    const d = ix.readU64(0n);
    require(d === start ||
      d === end ||
      d === IX_INIT_LIQUIDATION_RECORD ||
      d === IX_WITHDRAW ||
      d === IX_REPAY ||
      d === IX_KAMINO_WITHDRAW ||
      d === IX_DRIFT_WITHDRAW ||
      d === IX_JUPLEND_WITHDRAW, MarginfiError.ForbiddenIx);
  }
  require(stackHeight() === 1n, MarginfiError.NotAllowedInCPI);
  const current = ixs.currentIndex();
  require(ixs.get(current).programId === programId(), MarginfiError.NotAllowedInCPI);
  require(current < n - 1n, MarginfiError.StartNotFirst);
}

/**
 * start_receivership: Maintenance health at the prices taken (unhealthy, unless `ignoreHealthy`), then equity; the
 * banks' prices locked; the health cache as those passes leave it (no time, no version, no ENGINE_OK); the account
 * in receivership; the record's snapshot of both.
 */
function startReceivership(
  acc: Mut<MarginfiAccount>,
  group: Account<MarginfiGroup>,
  record: Mut<LiquidationRecord>,
  rest: RemainingAccounts,
  ignoreHealthy: boolean,
  t: i64,
): void {
  const m = healthComponents(acc, group, rest, 0n, rest.length, REQ_MAINTENANCE, true, false, t);
  require(m.err === 0n, m.err);
  const health = fxTrySub(m.assets, m.liabs);
  require(health.err === 0n, health.err);
  const healthy = health.v > I80F48_ZERO;
  require(!healthy || ignoreHealthy, MarginfiError.HealthyAccount);
  const q = healthComponents(acc, group, rest, 0n, rest.length, REQ_EQUITY, true, false, t);
  require(q.err === 0n, q.err);
  lockLiquidationPrices(acc, rest, t);
  resetHealthCache(acc, 0n, 0n, (healthy ? HEALTH_HEALTHY : 0n) | (m.emode_boosted ? HEALTH_EMODE_BOOSTED : 0n));
  acc.health_cache.asset_value_maint.value = m.assets;
  acc.health_cache.liability_value_maint.value = m.liabs;
  acc.health_cache.asset_value_equity.value = q.assets;
  acc.health_cache.liability_value_equity.value = q.liabs;
  acc.account_flags |= ACCOUNT_IN_RECEIVERSHIP;
  acc.indexer_flags.has_ever_been_liquidated = 1n;
  record.cache.asset_value_maint.value = m.assets;
  record.cache.liability_value_maint.value = m.liabs;
  record.cache.asset_value_equity.value = q.assets;
  record.cache.liability_value_equity.value = q.liabs;
}

/**
 * end_receivership: the account's health at the locked prices (healthy only below the close-out threshold, or when
 * `belowCloseout` says so), the locks cleared, its premium rates from the new mix; with `capped`, health may fall by no
 * more than the value taken out and a solvent account stays solvent, else it may not fall at all; out of
 * receivership, its tag after it, the record's newest entry (the oldest rotated out, its unused bytes kept).
 */
function endReceivership(
  acc: Mut<MarginfiAccount>,
  group: Account<MarginfiGroup>,
  record: Mut<LiquidationRecord>,
  rest: RemainingAccounts,
  belowCloseout: boolean,
  capped: boolean,
  t: i64,
): Moved {
  const preEquityAssets = record.cache.asset_value_equity.value;
  const preEquityLiabs = record.cache.liability_value_equity.value;
  const preHealth = fxSub(record.cache.asset_value_maint.value, record.cache.liability_value_maint.value);
  const m = cachedHealthComponents(acc, group, rest, 0n, rest.length, REQ_MAINTENANCE, false, t);
  require(m.err === 0n, m.err);
  const post = fxTrySub(m.assets, m.liabs);
  require(post.err === 0n, post.err);
  const healthy = post.v > I80F48_ZERO;
  require(!healthy || belowCloseout, MarginfiError.HealthyAccount);
  const q = cachedHealthComponents(acc, group, rest, 0n, rest.length, REQ_EQUITY, true, t);
  require(q.err === 0n, q.err);
  clearLiquidationLocks(acc, rest);
  resetHealthCache(acc, 0n, 0n, (healthy ? HEALTH_HEALTHY : 0n) | (m.emode_boosted ? HEALTH_EMODE_BOOSTED : 0n));
  acc.health_cache.asset_value_maint.value = m.assets;
  acc.health_cache.liability_value_maint.value = m.liabs;
  acc.health_cache.asset_value_equity.value = q.assets;
  acc.health_cache.liability_value_equity.value = q.liabs;
  updatePremiumSnapshots(acc, group, q, u64(t), false);
  const seized = fxSub(preEquityAssets, q.assets);
  const repaid = fxSub(preEquityLiabs, q.liabs);
  if (capped) {
    // Health may fall by no more than what was taken out, and a solvent account stays solvent.
    const net = fxSub(seized, repaid);
    const extracted = net > I80F48_ZERO ? net : I80F48_ZERO;
    require(fxSub(preHealth, post.v) <= extracted, MarginfiError.WorseHealthPostLiquidation);
    require(!(preEquityAssets >= preEquityLiabs && q.assets < q.liabs), MarginfiError.WorseHealthPostLiquidation);
  } else require(preHealth <= post.v, MarginfiError.WorseHealthPostLiquidation);
  acc.account_flags &= ~(ACCOUNT_IN_RECEIVERSHIP | ACCOUNT_IN_RISK_ADMIN_LIQUIDATION);
  record.liquidation_receiver = SYSTEM_PROGRAM_ID;
  acc.liquidation_tagged_at = tagAfterLiquidation(acc.liquidation_tagged_at, preHealth, post.v, preEquityLiabs, repaid, t);
  // entries.rotate_left(1), then the newest entry's amounts and time.
  const oldPlaceholder = record.entries.get(0n).placeholder0;
  const oldReserved = fixedArray<u8, 16>(0n);
  for (let k = 0n; k < 16n; k++) oldReserved.set(k, record.entries.get(0n).reserved0.get(k));
  for (let j = 0n; j < 3n; j++) {
    for (let k = 0n; k < 8n; k++) {
      record.entries.get(j).asset_amount_seized.set(k, record.entries.get(j + 1n).asset_amount_seized.get(k));
      record.entries.get(j).liab_amount_repaid.set(k, record.entries.get(j + 1n).liab_amount_repaid.get(k));
    }
    record.entries.get(j).placeholder0 = record.entries.get(j + 1n).placeholder0;
    record.entries.get(j).timestamp = record.entries.get(j + 1n).timestamp;
    for (let k = 0n; k < 16n; k++) record.entries.get(j).reserved0.set(k, record.entries.get(j + 1n).reserved0.get(k));
  }
  const seizedBits = fxToF64Bits(seized);
  const repaidBits = fxToF64Bits(repaid);
  for (let k = 0n; k < 8n; k++) {
    record.entries.get(3n).asset_amount_seized.set(k, u8((seizedBits >> (8n * k)) & 255n));
    record.entries.get(3n).liab_amount_repaid.set(k, u8((repaidBits >> (8n * k)) & 255n));
  }
  record.entries.get(3n).placeholder0 = oldPlaceholder;
  record.entries.get(3n).timestamp = t;
  for (let k = 0n; k < 16n; k++) record.entries.get(3n).reserved0.set(k, oldReserved.get(k));
  return { seized, repaid };
}

/**
 * Start a receivership liquidation (anyone): an account unhealthy at Maintenance is put in receivership until the
 * transaction's last instruction, `end_liquidation`; meanwhile the receiver withdraws and repays for it. Its health
 * and the prices taken are kept (the banks' prices locked) for the end to compare against. The account's banks and
 * oracles follow; its banks must be writable.
 */
export function startLiquidation(
  marginfi_account: HasOne<HasOne<Mut<MarginfiAccount>, "liquidation_record", MarginfiError.InvalidLiquidationRecord>, "group", MarginfiError.InvalidGroup>,
  liquidation_record: Mut<LiquidationRecord>,
  group: Account<MarginfiGroup>,
  liquidation_receiver: AccountInfo,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
): void {
  constraint(
    marginfi_account,
    (marginfi_account.account_flags &
      (ACCOUNT_IN_RECEIVERSHIP | ACCOUNT_IN_DELEVERAGE | ACCOUNT_IN_FLASHLOAN | ACCOUNT_DISABLED | ACCOUNT_IN_ORDER_EXECUTION)) ===
      0n,
    MarginfiError.UnexpectedLiquidationState,
  );
  const t = now();
  const len = remainingAccounts().length;
  liquidation_record.liquidation_receiver = liquidation_receiver.key;
  if (liquidation_receiver.isSigner && liquidation_receiver.key === group.risk_admin) marginfi_account.account_flags |= ACCOUNT_IN_RISK_ADMIN_LIQUIDATION;
  const halted = anyBankHalted(marginfi_account, remainingAccounts(), 0n, len, t);
  require(halted.err === 0n, halted.err);
  require(halted.n === 0n, MarginfiError.CircuitBreakerAdminOnly);
  const gate = cbPriceGate(marginfi_account, remainingAccounts(), 0n, len, t);
  require(gate === 0n, gate);
  startReceivership(marginfi_account, group, liquidation_record, remainingAccounts(), false, t);
  validateReceivership(instruction_sysvar, IX_START_LIQUIDATION, IX_END_LIQUIDATION);
}

/**
 * End a receivership liquidation (the receiver): the account's health at the prices start locked (its banks follow,
 * one account each), which may fall by no more than the value taken out and may not turn solvent into insolvent;
 * the seized collateral within the premium (the fee state's, at least 5%, grown by the tag unless e-mode or bad debt
 * fixes it); the record's latest entry; the flat SOL fee to the global fee wallet (from `fee_payer` if passed).
 */
export function endLiquidation(
  marginfi_account: HasOne<HasOne<Mut<MarginfiAccount>, "liquidation_record", MarginfiError.InvalidLiquidationRecord>, "group", MarginfiError.InvalidGroup>,
  liquidation_record: HasOne<Mut<LiquidationRecord>, "liquidation_receiver", MarginfiError.InvalidLiquidationReceiver>,
  group: Account<MarginfiGroup>,
  liquidation_receiver: Mut<Signer>,
  fee_state: Seeds<HasOne<Account<FeeState>, "global_fee_wallet", MarginfiError.InvalidFeeWallet>, ["feestate"]>,
  global_fee_wallet: Mut<AccountInfo>,
  system_program: SystemProgram,
  fee_payer: Mut<Signer> | null,
): void {
  constraint(
    marginfi_account,
    (marginfi_account.account_flags & ACCOUNT_IN_RECEIVERSHIP) !== 0n &&
      (marginfi_account.account_flags & (ACCOUNT_IN_DELEVERAGE | ACCOUNT_IN_FLASHLOAN | ACCOUNT_DISABLED | ACCOUNT_IN_ORDER_EXECUTION)) === 0n,
    MarginfiError.UnexpectedLiquidationState,
  );
  require(stackHeight() === 1n, MarginfiError.NotAllowedInCPI);
  const t = now();
  const preEquityAssets = liquidation_record.cache.asset_value_equity.value;
  const inBadDebt = preEquityAssets < liquidation_record.cache.liability_value_equity.value;
  const taggedAt = marginfi_account.liquidation_tagged_at;
  const emodeBoosted = (marginfi_account.health_cache.flags & HEALTH_EMODE_BOOSTED) !== 0n;
  const moved = endReceivership(marginfi_account, group, liquidation_record, remainingAccounts(), preEquityAssets < CLOSEOUT_THRESHOLD, true, t);
  // The premium the receiver may have taken.
  const maxFee = fee_state.liquidation_max_fee.value;
  const base = maxFee > BONUS_FEE_MINIMUM ? maxFee : BONUS_FEE_MINIMUM;
  const premium = emodeBoosted || inBadDebt ? base : tagAdjustedPremium(base, taggedAt, t);
  require(moved.seized <= fxWrappingMul(moved.repaid, fxAdd(I80F48_ONE, premium)), MarginfiError.LiquidationPremiumTooHigh);
  const fee = fee_state.liquidation_flat_sol_fee;
  if (fee > 0n) {
    if (fee_payer !== null) system_program.transfer(fee_payer, global_fee_wallet, u64(fee));
    else system_program.transfer(liquidation_receiver, global_fee_wallet, u64(fee));
  }
  emit<LiquidationReceiverEvent>({
    marginfi_account: marginfi_account.key,
    liquidation_receiver: liquidation_receiver.key,
    liquidatee_assets_seized: f64FromBits(fxToF64Bits(moved.seized)),
    liquidatee_liability_repaid: f64FromBits(fxToF64Bits(moved.repaid)),
    lamps_fee_paid: fee,
  });
}

/**
 * Start a deleverage (the risk admin): any account, healthy or not, is put in receivership with the risk admin as its
 * receiver until `end_deleverage`; no circuit-breaker checks. As start_liquidation otherwise.
 */
export function startDeleverage(
  marginfi_account: HasOne<HasOne<Mut<MarginfiAccount>, "liquidation_record">, "group", MarginfiError.InvalidGroup>,
  liquidation_record: Mut<LiquidationRecord>,
  group: HasOne<Account<MarginfiGroup>, "risk_admin">,
  risk_admin: Signer,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
): void {
  constraint(
    marginfi_account,
    (marginfi_account.account_flags &
      (ACCOUNT_IN_RECEIVERSHIP | ACCOUNT_IN_DELEVERAGE | ACCOUNT_IN_FLASHLOAN | ACCOUNT_DISABLED | ACCOUNT_IN_ORDER_EXECUTION)) ===
      0n,
    MarginfiError.UnexpectedLiquidationState,
  );
  checkNoDurableNonce(instruction_sysvar);
  const t = now();
  liquidation_record.liquidation_receiver = risk_admin.key;
  marginfi_account.account_flags |= ACCOUNT_IN_DELEVERAGE;
  marginfi_account.indexer_flags.has_ever_been_deleveraged = 1n;
  startReceivership(marginfi_account, group, liquidation_record, remainingAccounts(), true, t);
  validateReceivership(instruction_sysvar, IX_START_DELEVERAGE, IX_END_DELEVERAGE);
}

/** End a deleverage (the risk admin): the account's health at the locked prices may not have fallen. */
export function endDeleverage(
  marginfi_account: HasOne<HasOne<Mut<MarginfiAccount>, "liquidation_record">, "group", MarginfiError.InvalidGroup>,
  liquidation_record: Mut<LiquidationRecord>,
  group: HasOne<Account<MarginfiGroup>, "risk_admin">,
  risk_admin: Signer,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
): void {
  constraint(
    marginfi_account,
    (marginfi_account.account_flags & ACCOUNT_IN_RECEIVERSHIP) !== 0n &&
      (marginfi_account.account_flags & ACCOUNT_IN_DELEVERAGE) !== 0n &&
      (marginfi_account.account_flags & (ACCOUNT_IN_FLASHLOAN | ACCOUNT_DISABLED | ACCOUNT_IN_ORDER_EXECUTION)) === 0n,
    MarginfiError.UnexpectedLiquidationState,
  );
  constraint(liquidation_record, liquidation_record.liquidation_receiver === risk_admin.key, MarginfiError.Unauthorized);
  checkNoDurableNonce(instruction_sysvar);
  require(stackHeight() === 1n, MarginfiError.NotAllowedInCPI);
  const t = now();
  marginfi_account.account_flags &= ~ACCOUNT_IN_DELEVERAGE;
  const moved = endReceivership(marginfi_account, group, liquidation_record, remainingAccounts(), true, false, t);
  emit<DeleverageEvent>({
    marginfi_account: marginfi_account.key,
    risk_admin: risk_admin.key,
    deleveragee_assets_seized: f64FromBits(fxToF64Bits(moved.seized)),
    deleveragee_liability_repaid: f64FromBits(fxToF64Bits(moved.repaid)),
  });
}

/**
 * Purge a balance (the risk admin) in a bank whose tokenless repayments are complete: what is left of the deposit is
 * written off, the balance closed (its bank's price lock cleared in receivership). Refused while it owes more than
 * dust.
 */
export function purgeDeleverageBalance(
  group: HasOne<Account<MarginfiGroup>, "risk_admin", MarginfiError.Unauthorized>,
  marginfi_account: HasOne<Mut<MarginfiAccount>, "group", MarginfiError.InvalidGroup>,
  risk_admin: Signer,
  bank: HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
): void {
  constraint(bank, (bank.flags & TOKENLESS_REPAYMENTS_COMPLETE) !== 0n, MarginfiError.ForbiddenIx);
  checkNoDurableNonce(instruction_sysvar);
  const found = findBalance(marginfi_account, bank.key);
  require(found >= 0n, MarginfiError.BankAccountNotFound);
  const i = u64(found);
  const owed = marginfi_account.lending_account.balances.get(i).liability_shares.value;
  require(fxAbs(owed) <= ZERO_AMOUNT_THRESHOLD, MarginfiError.OperationWithdrawOnly);
  purgeBalance(marginfi_account, i, bank, (marginfi_account.account_flags & ACCOUNT_IN_RECEIVERSHIP) !== 0n);
  sortBalances(marginfi_account);
  refreshIndexerFlags(marginfi_account);
  marginfi_account.last_update = u64(now());
}

/** Mark a bank's tokenless repayments complete (the risk admin), when they are allowed, to purge what dust is left. */
export function lendingPoolForceTokenlessRepayComplete(
  group: HasOne<Account<MarginfiGroup>, "risk_admin", MarginfiError.Unauthorized>,
  risk_admin: Signer,
  bank: HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
): void {
  checkNoDurableNonce(instruction_sysvar);
  if ((bank.flags & TOKENLESS_REPAYMENTS_ALLOWED) !== 0n) bank.flags |= TOKENLESS_REPAYMENTS_COMPLETE;
}

/** Set the group's daily limit on deleverage withdrawals, in whole dollars (the admin or the limit admin). */
export function configureDeleverageWithdrawalLimit(
  marginfi_group: Mut<MarginfiGroup>,
  admin: Signer,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  limit: u32,
): void {
  constraint(marginfi_group, admin.key === marginfi_group.admin || admin.key === marginfi_group.delegate_limit_admin, MarginfiError.Unauthorized);
  checkNoDurableNonce(instruction_sysvar);
  require(limit > 0n, MarginfiError.ZeroWithdrawalLimit);
  marginfi_group.deleverage_withdraw_window_cache.daily_limit = limit;
  marginfi_group.deleverage_withdraw_window_cache.last_daily_reset_timestamp = now();
}

/**
 * Record deleverage withdrawals (the delegate flow admin), aggregated off-chain from the withdrawal events: in order of
 * sequence and slots, recent, past the day's limit refused.
 */
export function updateDeleverageWithdrawals(
  marginfi_group: HasOne<Mut<MarginfiGroup>, "delegate_flow_admin", MarginfiError.Unauthorized>,
  delegate_flow_admin: Signer,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  outflow_usd: u32,
  update_seq: u64,
  event_start_slot: u64,
  event_end_slot: u64,
): void {
  checkNoDurableNonce(instruction_sysvar);
  require(outflow_usd > 0n, MarginfiError.DeleverageWithdrawalUpdateEmpty);
  require(event_start_slot <= event_end_slot, MarginfiError.DeleverageWithdrawalUpdateInvalidSlotRange);
  require(event_start_slot > marginfi_group.deleverage_withdraw_last_admin_update_slot, MarginfiError.DeleverageWithdrawalUpdateOutOfOrderSlot);
  const slot = currentSlot();
  require(event_end_slot <= slot, MarginfiError.DeleverageWithdrawalUpdateFutureSlot);
  require(slot - event_end_slot <= 1500n, MarginfiError.DeleverageWithdrawalUpdateStale);
  const last = marginfi_group.deleverage_withdraw_last_admin_update_seq;
  require(update_seq === (last === 18446744073709551615n ? last : last + 1n), MarginfiError.DeleverageWithdrawalUpdateOutOfOrderSeq);
  // update_withdrawn_equity: the day's total (reset after a day), saturating, under the limit (0: none).
  const t = now();
  const window = marginfi_group.deleverage_withdraw_window_cache;
  const elapsed = saturatingSubI64(t, window.last_daily_reset_timestamp) >= 86400n;
  const today: u32 = elapsed ? 0n : window.withdrawn_today;
  const projected: u32 = today > 4294967295n - outflow_usd ? 4294967295n : today + outflow_usd;
  if (elapsed) {
    window.withdrawn_today = 0n;
    window.last_daily_reset_timestamp = t;
  }
  window.withdrawn_today = projected;
  require(window.daily_limit === 0n || projected <= window.daily_limit, MarginfiError.DailyWithdrawalLimitExceeded);
  marginfi_group.deleverage_withdraw_last_admin_update_slot = event_end_slot;
  marginfi_group.deleverage_withdraw_last_admin_update_seq = update_seq;
}

// ---- flash loans ---------------------------------------------------------------------------------------------------

const IX_END_FLASHLOAN: u64 = 11243239327675284585n;

/**
 * Start a flash loan (the account's authority): until `lending_account_end_flashloan` at `end_index`, which must
 * name this account first, the account's withdrawals and borrows skip their health checks. Top-level only.
 */
export function lendingAccountStartFlashloan(
  marginfi_account: HasOne<Mut<MarginfiAccount>, "authority", MarginfiError.Unauthorized>,
  authority: Signer,
  ixs_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  end_index: u64,
): void {
  constraint(
    marginfi_account,
    (marginfi_account.account_flags &
      (ACCOUNT_IN_FLASHLOAN | ACCOUNT_IN_DELEVERAGE | ACCOUNT_IN_RECEIVERSHIP | ACCOUNT_DISABLED | ACCOUNT_FROZEN | ACCOUNT_IN_ORDER_EXECUTION)) ===
      0n,
    MarginfiError.IllegalFlashloan,
  );
  const current = ixs_sysvar.currentIndex();
  require(ixs_sysvar.get(current).programId === programId(), MarginfiError.NotAllowedInCPI);
  require(current < end_index, MarginfiError.IllegalFlashloan);
  require(stackHeight() === 1n, MarginfiError.NotAllowedInCPI);
  // Past the transaction's last instruction the original fails reading it (InvalidArgument, not a custom code).
  const end = ixs_sysvar.get(end_index);
  // Under 8 bytes of data the original panics slicing the discriminator.
  require(end.dataLength >= 8n, MarginfiError.InternalLogicError);
  require(end.readU64(0n) === IX_END_FLASHLOAN, MarginfiError.IllegalFlashloan);
  require(end.programId === programId(), MarginfiError.IllegalFlashloan);
  require(end.accountsLength > 0n, MarginfiError.IllegalFlashloan);
  require(end.accountKey(0n) === marginfi_account.key, MarginfiError.IllegalFlashloan);
  marginfi_account.account_flags |= ACCOUNT_IN_FLASHLOAN;
}

/**
 * End a flash loan (the account's authority): the account's Initial health as after a withdrawal (its banks and
 * oracles follow), its tag cleared when healthy at Maintenance, its premium rates (every collateral priced when it
 * owes a premium-active bank), the circuit breaker's gate while it owes anything.
 */
export function lendingAccountEndFlashloan(
  marginfi_account: HasOne<HasOne<Mut<MarginfiAccount>, "group", MarginfiError.InvalidGroup>, "authority", MarginfiError.Unauthorized>,
  group: Account<MarginfiGroup>,
  authority: Signer,
): void {
  constraint(
    marginfi_account,
    (marginfi_account.account_flags & ACCOUNT_IN_FLASHLOAN) !== 0n &&
      (marginfi_account.account_flags & (ACCOUNT_IN_DELEVERAGE | ACCOUNT_IN_RECEIVERSHIP | ACCOUNT_DISABLED | ACCOUNT_FROZEN | ACCOUNT_IN_ORDER_EXECUTION)) ===
        0n,
    MarginfiError.IllegalFlashloan,
  );
  require(stackHeight() === 1n, MarginfiError.NotAllowedInCPI);
  marginfi_account.account_flags &= ~ACCOUNT_IN_FLASHLOAN;
  const t = now();
  const len = remainingAccounts().length;
  // check_account_init_health_and_clear_tag (no health cache).
  const h = healthComponents(marginfi_account, group, remainingAccounts(), 0n, len, REQ_INITIAL, false, true, t);
  require(h.err === 0n, h.err);
  require(h.assets >= h.liabs, MarginfiError.RiskEngineInitRejected);
  const tiers = riskTiersErr(marginfi_account, remainingAccounts(), 0n, len);
  require(tiers === 0n, tiers);
  if (marginfi_account.liquidation_tagged_at !== 0n) {
    const m = healthComponents(marginfi_account, group, remainingAccounts(), 0n, len, REQ_MAINTENANCE, false, false, t);
    if (m.err === 0n && m.assets > m.liabs) marginfi_account.liquidation_tagged_at = 0n;
  }
  require(!premiumRefreshUnavailable(h), MarginfiError.PremiumSnapshotUnavailable);
  updatePremiumSnapshots(marginfi_account, group, h, u64(t), true);
  if (hasLiabilities(marginfi_account)) {
    const gate = cbPriceGate(marginfi_account, remainingAccounts(), 0n, len, t);
    require(gate === 0n, gate);
  }
}

// ---- account administration ----------------------------------------------------------------------------------------

/** Freeze an account (the admin) or unfreeze it (the governance admin): a frozen account answers only to the latter. */
export function marginfiAccountSetFreeze(
  group: Account<MarginfiGroup>,
  marginfi_account: HasOne<Mut<MarginfiAccount>, "group", MarginfiError.InvalidGroup>,
  admin: Signer,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  frozen: boolean,
): void {
  checkNoDurableNonce(instruction_sysvar);
  require(admin.key === (frozen ? group.admin : group.governance_admin), MarginfiError.Unauthorized);
  if (frozen) marginfi_account.account_flags |= ACCOUNT_FROZEN;
  else marginfi_account.account_flags &= ~ACCOUNT_FROZEN;
  marginfi_account.last_update = u64(now());
  emit<MarginfiAccountFreezeEvent>({
    header: { signer: admin.key, marginfi_account: marginfi_account.key, marginfi_account_authority: marginfi_account.authority, marginfi_group: group.key },
    frozen,
  });
}

/** Where the account's emissions go (its authority; not while frozen). */
export function marginfiAccountUpdateEmissionsDestinationAccount(
  marginfi_account: Mut<MarginfiAccount>,
  authority: Signer,
  destination_account: AccountInfo,
): void {
  constraint(authority, authority.key === marginfi_account.authority, AnchorError.ConstraintAddress);
  require((marginfi_account.account_flags & ACCOUNT_FROZEN) === 0n, MarginfiError.AccountFrozen);
  marginfi_account.emissions_destination_account = destination_account.key;
}

/** Recompute the balance-derived indexer flags of the marginfi accounts that follow (anyone). */
export function syncIndexerFlags(payer: Mut<Signer>): void {
  for (let i = 0n; i < remainingAccounts().length; i++) {
    const account = loadAccountMut<MarginfiAccount>(remainingAccounts().get(i));
    syncBalanceDerived(account);
  }
}

/** DEFAULT_ACCOUNT_TRANSFER_FEE_LAMPORTS: the fee state's account transfer fee when it stores 0. */
const DEFAULT_ACCOUNT_TRANSFER_FEE: u64 = 5000000n;

/**
 * The checks and moves a transfer to a new account shares: the fee wallet the group caches (paid the fee state's
 * transfer fee), the old account free to move; the new account the old one's balances, flags and tag under its new
 * authority, the old one emptied, disabled and pointing at it.
 */
function transferStateChecks(old: Mut<MarginfiAccount>): void {
  const flags = old.account_flags;
  require((flags & ACCOUNT_IN_FLASHLOAN) === 0n, MarginfiError.AccountInFlashloan);
  require((flags & ACCOUNT_IN_RECEIVERSHIP) === 0n, MarginfiError.ForbiddenIx);
  require((flags & ACCOUNT_IN_ORDER_EXECUTION) === 0n, MarginfiError.ForbiddenIx);
  require(old.active_orders === 0n, MarginfiError.IllegalAction);
  require(old.migrated_to === SYSTEM_PROGRAM_ID, MarginfiError.AccountAlreadyMigrated);
  require((flags & ACCOUNT_DISABLED) === 0n, MarginfiError.AccountDisabled);
}
function migrate(to: Mut<MarginfiAccount>, old: Mut<MarginfiAccount>, newAuthority: Pubkey, timestamp: u64): void {
  initMarginfiAccount(to, old.group, newAuthority, timestamp);
  to.lending_account = old.lending_account;
  to.emissions_destination_account = old.emissions_destination_account;
  to.account_flags = old.account_flags;
  to.migrated_from = old.key;
  to.indexer_flags = old.indexer_flags;
  to.liquidation_tagged_at = old.liquidation_tagged_at;
  refreshIndexerFlags(to);
  old.migrated_to = to.key;
  old.last_update = timestamp;
  clearLendingAccount(old);
  old.account_flags |= ACCOUNT_DISABLED;
  refreshIndexerFlags(old);
}

/**
 * Move an account to a new one under a new authority (its authority, or the governance admin when frozen), for the
 * fee state's transfer fee: the new account takes its balances, flags and tag; the old one is emptied and disabled.
 */
export function transferToNewAccount(
  group: Account<MarginfiGroup>,
  old_marginfi_account: HasOne<Mut<MarginfiAccount>, "group", MarginfiError.InvalidGroup>,
  new_marginfi_account: Init<MarginfiAccount>,
  authority: Signer,
  fee_payer: Mut<Signer>,
  new_authority: AccountInfo,
  global_fee_wallet: Mut<AccountInfo>,
  fee_state: Seeds<Account<FeeState>, ["feestate"]>,
  system_program: SystemProgram,
): void {
  constraint(group, !protocolPaused(group), MarginfiError.ProtocolPaused);
  constraint(old_marginfi_account, notFrozenForAuthority(old_marginfi_account, authority.key), MarginfiError.AccountFrozen);
  constraint(
    old_marginfi_account,
    signerAuthorized(old_marginfi_account, group.governance_admin, authority.key, false, false, false),
    MarginfiError.Unauthorized,
  );
  new_marginfi_account.create(fee_payer, null);
  require(global_fee_wallet.key === group.fee_state_cache.global_fee_wallet, MarginfiError.InvalidFeeAta);
  const fee = fee_state.account_transfer_fee;
  system_program.transfer(fee_payer, global_fee_wallet, fee === 0n ? DEFAULT_ACCOUNT_TRANSFER_FEE : u64(fee));
  transferStateChecks(old_marginfi_account);
  migrate(new_marginfi_account, old_marginfi_account, new_authority.key, u64(now()));
  emit<MarginfiAccountTransferToNewAccount>({
    header: { signer: authority.key, marginfi_account: new_marginfi_account.key, marginfi_account_authority: new_authority.key, marginfi_group: group.key },
    old_account: old_marginfi_account.key,
    old_account_authority: authority.key,
    new_account_authority: new_authority.key,
  });
}

/** transfer_to_new_account, the new account at the PDA marginfi_account_initialize_pda uses. */
export function transferToNewAccountPda(
  group: Account<MarginfiGroup>,
  old_marginfi_account: HasOne<Mut<MarginfiAccount>, "group", MarginfiError.InvalidGroup>,
  new_marginfi_account: Init<MarginfiAccount>,
  authority: Signer,
  fee_payer: Mut<Signer>,
  new_authority: AccountInfo,
  global_fee_wallet: Mut<AccountInfo>,
  fee_state: Seeds<Account<FeeState>, ["feestate"]>,
  instructions_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  system_program: SystemProgram,
  account_index: u16,
  third_party_id: Option<u16>,
): void {
  constraint(group, !protocolPaused(group), MarginfiError.ProtocolPaused);
  constraint(old_marginfi_account, notFrozenForAuthority(old_marginfi_account, authority.key), MarginfiError.AccountFrozen);
  constraint(
    old_marginfi_account,
    signerAuthorized(old_marginfi_account, group.governance_admin, authority.key, false, false, false),
    MarginfiError.Unauthorized,
  );
  const bump = new_marginfi_account.create(fee_payer, ["marginfi_account", group.key, new_authority.key, account_index, third_party_id ?? 0n]);
  require(global_fee_wallet.key === group.fee_state_cache.global_fee_wallet, MarginfiError.InvalidFeeAta);
  const fee = fee_state.account_transfer_fee;
  system_program.transfer(fee_payer, global_fee_wallet, fee === 0n ? DEFAULT_ACCOUNT_TRANSFER_FEE : u64(fee));
  transferStateChecks(old_marginfi_account);
  if (third_party_id !== null) require(thirdPartyAllowed(instructions_sysvar, third_party_id), MarginfiError.Unauthorized);
  migrate(new_marginfi_account, old_marginfi_account, new_authority.key, u64(now()));
  new_marginfi_account.account_index = account_index;
  new_marginfi_account.third_party_index = third_party_id ?? 0n;
  new_marginfi_account.bump = bump;
  emit<MarginfiAccountTransferToNewAccount>({
    header: { signer: authority.key, marginfi_account: new_marginfi_account.key, marginfi_account_authority: new_authority.key, marginfi_group: group.key },
    old_account: old_marginfi_account.key,
    old_account_authority: authority.key,
    new_account_authority: new_authority.key,
  });
}

/**
 * Close an account (anyone), its rent to the global fee wallet: empty and idle for 60 days, no deleverage, order,
 * liquidation record or rebalance fee pool left.
 */
export function adminCloseAccount(
  group: Account<MarginfiGroup>,
  marginfi_account: CloseTo<HasOne<Mut<MarginfiAccount>, "group", MarginfiError.InvalidGroup>, "global_fee_wallet">,
  global_fee_wallet: Mut<AccountInfo>,
  rebalance_fee_pool: Seeds<SystemAccount, ["rebalance_fee_pool", "@marginfi_account"]>,
): void {
  constraint(global_fee_wallet, global_fee_wallet.key === group.fee_state_cache.global_fee_wallet, MarginfiError.InvalidGlobalFeeWallet);
  const idle = saturatingSubI64(now(), i64(marginfi_account.last_update)) > 5184000n;
  require(canBeClosed(marginfi_account) && idle, MarginfiError.IllegalAction);
  const flags = marginfi_account.account_flags;
  require((flags & ACCOUNT_IN_DELEVERAGE) === 0n &&
    (flags & ACCOUNT_IN_ORDER_EXECUTION) === 0n &&
    marginfi_account.active_orders === 0n &&
    marginfi_account.liquidation_record === SYSTEM_PROGRAM_ID, MarginfiError.IllegalAction);
  require(rebalance_fee_pool.lamports === 0n, MarginfiError.IllegalAction);
  emit<AdminCloseAccountEvent>({
    header: { signer: null, marginfi_account: marginfi_account.key, marginfi_account_authority: marginfi_account.authority, marginfi_group: group.key },
    global_fee_wallet: global_fee_wallet.key,
  });
}

// ---- fee state, panic pause, governance --------------------------------------------------------------------------

/** Turn the program's fees on or off for a group (the global fee admin). */
export function configGroupFee(
  marginfi_group: Mut<MarginfiGroup>,
  global_fee_admin: Signer,
  fee_state: Seeds<HasOne<Account<FeeState>, "global_fee_admin", MarginfiError.Unauthorized>, ["feestate"]>,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  enable_program_fee: boolean,
): void {
  if (enable_program_fee) marginfi_group.group_flags |= PROGRAM_FEES_ENABLED;
  else marginfi_group.group_flags &= ~PROGRAM_FEES_ENABLED;
  marginfi_group.fee_state_cache.last_update = now();
}

/** Edit the fee state (the global fee admin): each field given replaces the stored one. */
export function editGlobalFeeState(
  global_fee_admin: Signer,
  fee_state: Seeds<HasOne<Mut<FeeState>, "global_fee_admin", MarginfiError.Unauthorized>, ["feestate"]>,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  admin: Option<Pubkey>,
  fee_wallet: Option<Pubkey>,
  bank_init_flat_sol_fee: Option<u32>,
  liquidation_flat_sol_fee: Option<u32>,
  order_init_flat_sol_fee: Option<u32>,
  program_fee_fixed: Option<WrappedI80F48>,
  program_fee_rate: Option<WrappedI80F48>,
  liquidation_max_fee: Option<WrappedI80F48>,
  order_execution_max_fee: Option<WrappedI80F48>,
  pause_delegate_admin: Option<Pubkey>,
  account_transfer_fee: Option<u32>,
): void {
  if (admin !== null) fee_state.global_fee_admin = admin;
  if (fee_wallet !== null) fee_state.global_fee_wallet = fee_wallet;
  if (bank_init_flat_sol_fee !== null) fee_state.bank_init_flat_sol_fee = bank_init_flat_sol_fee;
  if (program_fee_fixed !== null) fee_state.program_fee_fixed.value = program_fee_fixed.value;
  if (program_fee_rate !== null) fee_state.program_fee_rate.value = program_fee_rate.value;
  if (liquidation_max_fee !== null) fee_state.liquidation_max_fee.value = liquidation_max_fee.value;
  if (liquidation_flat_sol_fee !== null) fee_state.liquidation_flat_sol_fee = liquidation_flat_sol_fee;
  if (order_execution_max_fee !== null) fee_state.order_execution_max_fee.value = order_execution_max_fee.value;
  if (order_init_flat_sol_fee !== null) fee_state.order_init_flat_sol_fee = order_init_flat_sol_fee;
  if (pause_delegate_admin !== null) fee_state.pause_delegate_admin = pause_delegate_admin;
  if (account_transfer_fee !== null) fee_state.account_transfer_fee = account_transfer_fee;
}

/** Where premium fees go (the global fee admin). */
export function editFeeStatePremium(
  global_fee_admin: Signer,
  fee_state: Seeds<HasOne<Mut<FeeState>, "global_fee_admin", MarginfiError.Unauthorized>, ["feestate"]>,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  premium_wallet: Pubkey,
): void {
  fee_state.premium_wallet = premium_wallet;
}

/** PanicState: paused, for 6 hours a pause; at most 3 a day and 4 in a row. */
const PAUSED: u8 = 1n;
const PAUSE_SECONDS: i64 = 21600n;
function pauseExpired(fs: Mut<FeeState>, t: i64): boolean {
  const p = fs.panic_state;
  if ((p.pause_flags & PAUSED) === 0n) return true;
  if (t < p.pause_start_timestamp) return false;
  return t - p.pause_start_timestamp >= PAUSE_SECONDS;
}
function unpause(fs: Mut<FeeState>): void {
  fs.panic_state.pause_flags &= ~PAUSED;
  fs.panic_state.pause_start_timestamp = 0n;
  fs.panic_state.consecutive_pause_count = 0n;
}
function unpauseIfExpired(fs: Mut<FeeState>, t: i64): void {
  if ((fs.panic_state.pause_flags & PAUSED) !== 0n && pauseExpired(fs, t)) unpause(fs);
}

/**
 * Pause the protocol for 6 hours (the global fee admin or the pause delegate): an expired pause cleared first, a
 * running one extended; refused past 3 pauses a day or 4 in a row.
 */
export function panicPause(
  pause_authority: Signer,
  fee_state: Seeds<Mut<FeeState>, ["feestate"]>,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
): void {
  constraint(
    fee_state,
    pause_authority.key === fee_state.global_fee_admin ||
      (fee_state.pause_delegate_admin !== SYSTEM_PROGRAM_ID && pause_authority.key === fee_state.pause_delegate_admin),
    MarginfiError.Unauthorized,
  );
  const t = now();
  unpauseIfExpired(fee_state, t);
  // PanicState::pause
  unpauseIfExpired(fee_state, t);
  if (saturatingSubI64(t, fee_state.panic_state.last_daily_reset_timestamp) >= 86400n) {
    fee_state.panic_state.daily_pause_count = 0n;
    fee_state.panic_state.last_daily_reset_timestamp = t;
  }
  const daily = t - fee_state.panic_state.last_daily_reset_timestamp >= 86400n ? 0n : fee_state.panic_state.daily_pause_count;
  require(fee_state.panic_state.consecutive_pause_count < 4n && daily < 3n, MarginfiError.PauseLimitExceeded);
  const running = (fee_state.panic_state.pause_flags & PAUSED) !== 0n && !pauseExpired(fee_state, t);
  fee_state.panic_state.pause_start_timestamp = running ? saturatingAddI64(fee_state.panic_state.pause_start_timestamp, PAUSE_SECONDS) : t;
  fee_state.panic_state.pause_flags |= PAUSED;
  const dailyCount = fee_state.panic_state.daily_pause_count;
  fee_state.panic_state.daily_pause_count = dailyCount === 255n ? 255n : dailyCount + 1n;
  const consecutive = fee_state.panic_state.consecutive_pause_count;
  fee_state.panic_state.consecutive_pause_count = consecutive === 255n ? 255n : consecutive + 1n;
}

/** Lift a pause (the global fee admin). */
export function panicUnpause(
  global_fee_admin: Mut<Signer>,
  fee_state: Seeds<HasOne<Mut<FeeState>, "global_fee_admin", MarginfiError.Unauthorized>, ["feestate"]>,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
): void {
  const t = now();
  require((fee_state.panic_state.pause_flags & PAUSED) !== 0n, MarginfiError.ProtocolNotPaused);
  unpauseIfExpired(fee_state, t);
  if ((fee_state.panic_state.pause_flags & PAUSED) !== 0n) unpause(fee_state);
}

/** Lift a pause that has run its 6 hours (anyone). */
export function panicUnpausePermissionless(fee_state: Seeds<Mut<FeeState>, ["feestate"]>): void {
  const t = now();
  require((fee_state.panic_state.pause_flags & PAUSED) !== 0n, MarginfiError.ProtocolNotPaused);
  require(pauseExpired(fee_state, t), MarginfiError.PauseLimitExceeded);
  unpause(fee_state);
}

/** validate_and_apply_emode_leverage: a leverage from 1 to 100, stored as basis points of u32::MAX. */
function emodeLeverage(v: i128): u32 {
  require(v >= I80F48_ONE && v <= 28147497671065600n, MarginfiError.BadEmodeConfig);
  return basisToU32(v);
}

/**
 * Configure a group's governance roles and e-mode leverage caps (the governance admin): the caps both set or both
 * unset, init below maintenance; the same for same-asset e-mode.
 */
export function marginfiGroupConfigureGov(
  marginfi_group: HasOne<Mut<MarginfiGroup>, "governance_admin", MarginfiError.Unauthorized>,
  governance_admin: Signer,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  new_admin: Option<Pubkey>,
  new_emode_admin: Option<Pubkey>,
  new_risk_admin: Option<Pubkey>,
  emode_max_init_leverage: Option<WrappedI80F48>,
  emode_max_maint_leverage: Option<WrappedI80F48>,
  same_asset_emode_init_leverage: Option<WrappedI80F48>,
  same_asset_emode_maint_leverage: Option<WrappedI80F48>,
): void {
  checkNoDurableNonce(instruction_sysvar);
  if (new_admin !== null) marginfi_group.admin = new_admin;
  if (new_emode_admin !== null) marginfi_group.emode_admin = new_emode_admin;
  if (new_risk_admin !== null) marginfi_group.risk_admin = new_risk_admin;
  if (emode_max_init_leverage !== null) marginfi_group.emode_max_init_leverage = emodeLeverage(emode_max_init_leverage.value);
  if (emode_max_maint_leverage !== null) marginfi_group.emode_max_maint_leverage = emodeLeverage(emode_max_maint_leverage.value);
  const init = marginfi_group.emode_max_init_leverage;
  const maint = marginfi_group.emode_max_maint_leverage;
  const capsSet = init !== 0n || maint !== 0n;
  require(!(capsSet && (init === 0n || maint === 0n)), MarginfiError.BadEmodeConfig);
  require(!(capsSet && u32ToBasis(init) >= u32ToBasis(maint)), MarginfiError.BadEmodeConfig);
  if (same_asset_emode_init_leverage !== null) marginfi_group.same_asset_emode_init_leverage = emodeLeverage(same_asset_emode_init_leverage.value);
  if (same_asset_emode_maint_leverage !== null) marginfi_group.same_asset_emode_maint_leverage = emodeLeverage(same_asset_emode_maint_leverage.value);
  const sameInit = u32ToBasis(marginfi_group.same_asset_emode_init_leverage);
  const sameMaint = u32ToBasis(marginfi_group.same_asset_emode_maint_leverage);
  require(sameInit > I80F48_ONE === sameMaint > I80F48_ONE, MarginfiError.BadEmodeConfig);
  require(!(sameInit > I80F48_ONE && sameInit >= sameMaint), MarginfiError.BadEmodeConfig);
  marginfi_group.fee_state_cache.last_update = now();
  emit<MarginfiGroupConfigureEvent>({
    header: { signer: governance_admin.key, marginfi_group: marginfi_group.key },
    admin: new_admin,
    flags: marginfi_group.group_flags,
  });
}

/** Set a group's governance admin (the admin the first time, the governance admin after). */
export function marginfiGroupSetGovernanceAdmin(
  marginfi_group: Mut<MarginfiGroup>,
  signer: Signer,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  new_governance_admin: Pubkey,
): void {
  checkNoDurableNonce(instruction_sysvar);
  require(new_governance_admin !== SYSTEM_PROGRAM_ID, MarginfiError.InvalidGovernanceAdmin);
  const previous = marginfi_group.governance_admin;
  require(signer.key === (previous === SYSTEM_PROGRAM_ID ? marginfi_group.admin : previous), MarginfiError.Unauthorized);
  marginfi_group.governance_admin = new_governance_admin;
  emit<SetGovernanceAdminEvent>({
    header: { signer: signer.key, marginfi_group: marginfi_group.key },
    previous_governance_admin: previous,
    new_governance_admin,
  });
}

/** Set a bank's hourly and daily outflow limits, in its tokens (the admin or the limit admin). */
export function configureBankRateLimits(
  group: Account<MarginfiGroup>,
  admin: Signer,
  bank: HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  hourly_max_outflow: Option<u64>,
  daily_max_outflow: Option<u64>,
): void {
  constraint(group, admin.key === group.admin || admin.key === group.delegate_limit_admin, MarginfiError.Unauthorized);
  checkNoDurableNonce(instruction_sysvar);
  const t = now();
  if (hourly_max_outflow !== null) {
    require(hourly_max_outflow <= 9223372036854775807n, MarginfiError.InvalidConfig);
    bank.rate_limiter.hourly = { max_outflow: hourly_max_outflow, window_duration: 3600n, window_start: t, prev_window_outflow: 0n, cur_window_outflow: 0n };
  }
  if (daily_max_outflow !== null) {
    require(daily_max_outflow <= 9223372036854775807n, MarginfiError.InvalidConfig);
    bank.rate_limiter.daily = { max_outflow: daily_max_outflow, window_duration: 86400n, window_start: t, prev_window_outflow: 0n, cur_window_outflow: 0n };
  }
}

/** Set a group's hourly and daily outflow limits, in dollars (the admin or the limit admin). */
export function configureGroupRateLimits(
  marginfi_group: Mut<MarginfiGroup>,
  admin: Signer,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  hourly_max_outflow_usd: Option<u64>,
  daily_max_outflow_usd: Option<u64>,
): void {
  constraint(marginfi_group, admin.key === marginfi_group.admin || admin.key === marginfi_group.delegate_limit_admin, MarginfiError.Unauthorized);
  checkNoDurableNonce(instruction_sysvar);
  const t = now();
  if (hourly_max_outflow_usd !== null) {
    require(hourly_max_outflow_usd <= 9223372036854775807n, MarginfiError.InvalidConfig);
    marginfi_group.rate_limiter.hourly = {
      max_outflow: hourly_max_outflow_usd,
      window_duration: 3600n,
      window_start: t,
      prev_window_outflow: 0n,
      cur_window_outflow: 0n,
    };
  }
  if (daily_max_outflow_usd !== null) {
    require(daily_max_outflow_usd <= 9223372036854775807n, MarginfiError.InvalidConfig);
    marginfi_group.rate_limiter.daily = {
      max_outflow: daily_max_outflow_usd,
      window_duration: 86400n,
      window_start: t,
      prev_window_outflow: 0n,
      cur_window_outflow: 0n,
    };
  }
}

/**
 * Record the group's flows (the flow admin), aggregated off-chain from the flow events: in sequence and slot order, at
 * most 1,500 slots old; an inflow gives capacity back, an outflow must fit the group's windows.
 */
export function updateGroupRateLimiter(
  marginfi_group: HasOne<Mut<MarginfiGroup>, "delegate_flow_admin", MarginfiError.Unauthorized>,
  delegate_flow_admin: Signer,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  outflow_usd: Option<u64>,
  inflow_usd: Option<u64>,
  update_seq: u64,
  event_start_slot: u64,
  event_end_slot: u64,
): void {
  checkNoDurableNonce(instruction_sysvar);
  require(outflow_usd !== null || inflow_usd !== null, MarginfiError.GroupRateLimiterUpdateEmpty);
  require(event_start_slot <= event_end_slot, MarginfiError.GroupRateLimiterUpdateInvalidSlotRange);
  require(event_start_slot > marginfi_group.rate_limiter_last_admin_update_slot, MarginfiError.GroupRateLimiterUpdateOutOfOrderSlot);
  const slot = currentSlot();
  require(event_end_slot <= slot, MarginfiError.GroupRateLimiterUpdateFutureSlot);
  require(slot - event_end_slot <= 1500n, MarginfiError.GroupRateLimiterUpdateStale);
  const last = marginfi_group.rate_limiter_last_admin_update_seq;
  require(update_seq === (last === 18446744073709551615n ? last : last + 1n), MarginfiError.GroupRateLimiterUpdateOutOfOrderSeq);
  const t = now();
  if (inflow_usd !== null) {
    require(inflow_usd <= 9223372036854775807n, MarginfiError.InvalidConfig);
    recordGroupInflow(marginfi_group, inflow_usd, t);
  }
  if (outflow_usd !== null) recordGroupOutflow(marginfi_group, outflow_usd, t);
  marginfi_group.rate_limiter_last_admin_update_slot = event_end_slot;
  marginfi_group.rate_limiter_last_admin_update_seq = update_seq;
}

/**
 * Set, change or remove (rate 0) the premium rate for a pair of collateral and liability tags (the admin): the
 * matrix stays sorted by (collateral, liability), at most 64 entries.
 */
export function lendingPoolConfigureGroupPremium(
  group: HasOne<Mut<MarginfiGroup>, "admin", MarginfiError.Unauthorized>,
  admin: Signer,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  collateral_tag: u16,
  liability_tag: u16,
  rate: u32,
): void {
  checkNoDurableNonce(instruction_sysvar);
  require(collateral_tag !== 0n && liability_tag !== 0n, MarginfiError.PremiumEntryInvalid);
  require(rate <= 429496729n, MarginfiError.PremiumEntryInvalid);
  let count = u64(group.premium_settings.entry_count);
  if (count > 64n) count = 64n;
  const target = (u64(collateral_tag) << 16n) | u64(liability_tag);
  let at = 0n;
  while (at < count) {
    const e = group.premium_entries.get(at);
    if (((u64(e.collateral_tag) << 16n) | u64(e.liability_tag)) >= target) break;
    at++;
  }
  const found = at < count && group.premium_entries.get(at).collateral_tag === collateral_tag && group.premium_entries.get(at).liability_tag === liability_tag;
  let old: u32 = 0n;
  if (rate > 0n) {
    if (found) old = group.premium_entries.get(at).rate;
    else {
      require(count < 64n, MarginfiError.PremiumMatrixFull);
      for (let j = count; j > at; j--) {
        group.premium_entries.get(j).collateral_tag = group.premium_entries.get(j - 1n).collateral_tag;
        group.premium_entries.get(j).liability_tag = group.premium_entries.get(j - 1n).liability_tag;
        group.premium_entries.get(j).rate = group.premium_entries.get(j - 1n).rate;
      }
      count++;
    }
    group.premium_entries.get(at).collateral_tag = collateral_tag;
    group.premium_entries.get(at).liability_tag = liability_tag;
    group.premium_entries.get(at).rate = rate;
  } else {
    require(found, MarginfiError.PremiumEntryNotFound);
    old = group.premium_entries.get(at).rate;
    for (let j = at; j + 1n < count; j++) {
      group.premium_entries.get(j).collateral_tag = group.premium_entries.get(j + 1n).collateral_tag;
      group.premium_entries.get(j).liability_tag = group.premium_entries.get(j + 1n).liability_tag;
      group.premium_entries.get(j).rate = group.premium_entries.get(j + 1n).rate;
    }
    group.premium_entries.get(count - 1n).collateral_tag = 0n;
    group.premium_entries.get(count - 1n).liability_tag = 0n;
    group.premium_entries.get(count - 1n).rate = 0n;
    count--;
  }
  group.premium_settings.entry_count = u16(count);
  group.premium_settings.entry_capacity = 64n;
  group.premium_settings.timestamp = now();
  emit<LendingPoolGroupPremiumConfigureEvent>({
    header: { signer: admin.key, marginfi_group: group.key },
    collateral_tag,
    liability_tag,
    old_rate: old,
    new_rate: rate,
  });
}

// ---- bank administration -------------------------------------------------------------------------------------------

/**
 * Set a bank's e-mode tag and entries (the governance admin): the entries sorted by collateral tag (stably), their
 * padding cleared, checked against the bank's liability weights and the group's leverage caps; e-mode on when any
 * entry is set.
 */
export function lendingPoolConfigureBankEmode(
  group: HasOne<Account<MarginfiGroup>, "governance_admin", MarginfiError.Unauthorized>,
  governance_admin: Signer,
  bank: HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  emode_tag: u16,
  entries: FixedArray<EmodeEntry, 10>,
): void {
  checkNoDurableNonce(instruction_sysvar);
  // sort_by_key is stable: insertion sort of the entries' indices by tag.
  const order = fixedArray<u8, 10>(0n);
  for (let i = 0n; i < 10n; i++) order.set(i, u8(i));
  for (let i = 1n; i < 10n; i++)
    for (let j = i; j > 0n && entries.get(u64(order.get(j - 1n))).collateral_bank_emode_tag > entries.get(u64(order.get(j))).collateral_bank_emode_tag; j--) {
      const swap = order.get(j);
      order.set(j, order.get(j - 1n));
      order.set(j - 1n, swap);
    }
  bank.emode.emode_tag = emode_tag;
  let any = false;
  for (let i = 0n; i < 10n; i++) {
    const from = u64(order.get(i));
    const to = bank.emode.emode_config.entries.get(i);
    to.collateral_bank_emode_tag = entries.get(from).collateral_bank_emode_tag;
    to.flags = entries.get(from).flags;
    for (let k = 0n; k < 5n; k++) to.pad0.set(k, 0n);
    to.asset_weight_init.value = entries.get(from).asset_weight_init.value;
    to.asset_weight_maint.value = entries.get(from).asset_weight_maint.value;
    if (to.collateral_bank_emode_tag !== 0n) any = true;
  }
  bank.emode.timestamp = now();
  validateEmodeEntries(bank, totalLiquidationFee(bank), group.emode_max_init_leverage, group.emode_max_maint_leverage);
  if (any) bank.emode.flags |= 1n;
  else bank.emode.flags &= ~1n;
}

/** Copy one bank's e-mode settings to another (the governance admin), checked against the destination's weights. */
export function lendingPoolCloneEmode(
  group: HasOne<Account<MarginfiGroup>, "governance_admin", MarginfiError.Unauthorized>,
  governance_admin: Signer,
  copy_from_bank: HasOne<Account<Bank>, "group", MarginfiError.InvalidGroup>,
  copy_to_bank: HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
): void {
  checkNoDurableNonce(instruction_sysvar);
  copy_to_bank.emode = copy_from_bank.emode;
  validateEmodeEntries(copy_to_bank, totalLiquidationFee(copy_to_bank), group.emode_max_init_leverage, group.emode_max_maint_leverage);
}

/** Tag a bank's premium rates and turn them on or off (the admin); off forgives what its borrowers owe in premium. */
export function lendingPoolConfigureBankPremium(
  group: HasOne<Account<MarginfiGroup>, "admin", MarginfiError.Unauthorized>,
  admin: Signer,
  bank: HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  premium_tag: u16,
  active: boolean,
): void {
  checkNoDurableNonce(instruction_sysvar);
  bank.premium_tag = premium_tag;
  const was = (bank.flags & PREMIUM_ACTIVE) !== 0n;
  if (active) {
    bank.flags |= PREMIUM_ACTIVE;
    if (!was) bank.premium_activated_at = now();
  } else {
    if (was) log("WARNING: premium deactivation forgives all unpaid premium on this bank");
    bank.flags &= ~PREMIUM_ACTIVE;
  }
  emit<LendingPoolBankPremiumConfigureEvent>({
    header: { signer: admin.key, marginfi_group: group.key },
    bank: bank.key,
    mint: bank.mint,
    premium_tag,
    active,
  });
}

/**
 * Clear a bank's circuit breaker (the admin or the risk admin): interest accrued up to now, the halt and its tier
 * reset; with `reseed_reference`, the breaker's references too.
 */
export function lendingPoolClearCircuitBreaker(
  group: Account<MarginfiGroup>,
  authority: Signer,
  bank: HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  reseed_reference: boolean,
): void {
  checkNoDurableNonce(instruction_sysvar);
  require(authority.key === group.admin || authority.key === group.risk_admin, MarginfiError.Unauthorized);
  const t = now();
  accrueInterest(bank, group, bank.key, t);
  const prior = bank.cb_tier;
  resetCbRuntimeState(bank, t);
  if (reseed_reference) {
    bank.cb_reference_price.value = I80F48_ZERO;
    bank.cb_window_reference_price.value = I80F48_ZERO;
    bank.cb_window_started_at = 0n;
  }
  emit<CircuitBreakerClearedEvent>({ prior_tier: prior, reason: 0n, current_timestamp: t });
}

const STAGING_PROGRAM_ID = pubkey("stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct");
const MAINNET_PROGRAM_ID = pubkey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");

/**
 * Backfill a bank's flags (anyone): its seed, when it derives the bank's address from the group and mint (under the
 * mainnet program, or staging's), and IS_T22 when its mint is a Token-2022 mint.
 */
export function lendingPoolBackfillBankIsT22Flag(
  bank: HasOne<HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>, "mint", MarginfiError.InvalidMint>,
  group: Account<MarginfiGroup>,
  mint: AccountInfo,
  bank_seed: Option<u64>,
): void {
  if (bank_seed !== null) {
    const seed: u64 = bank_seed;
    const derived = findProgramAddress([group.key, mint.key, seed], programId() === STAGING_PROGRAM_ID ? STAGING_PROGRAM_ID : MAINNET_PROGRAM_ID);
    require(derived === bank.key, MarginfiError.InvalidBankAccount);
    bank.bank_seed = seed;
    bank.flags |= BANK_SEED_KNOWN;
  }
  if ((bank.flags & IS_T22) === 0n && mint.owner === TOKEN_2022_ID) bank.flags |= IS_T22;
}

/**
 * Close an empty bank (the admin), its rent to the admin: created to close (0.1.4 or later) with no positions, unless
 * forced; no shares or emissions left either way.
 */
export function lendingPoolCloseBank(
  group: HasOne<Mut<MarginfiGroup>, "admin", MarginfiError.Unauthorized>,
  bank: CloseTo<HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>, "admin">,
  admin: Mut<Signer>,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  force_close: Option<boolean>,
): void {
  checkNoDurableNonce(instruction_sysvar);
  group.banks = group.banks === 0n ? 0n : group.banks - 1n;
  if (!(force_close ?? false)) {
    require((bank.flags & CLOSE_ENABLED_FLAG) !== 0n, MarginfiError.BankCannotClose);
    require(bank.lending_position_count === 0n && bank.borrowing_position_count === 0n, MarginfiError.BankCannotClose);
  }
  require(isZeroWithTolerance(bank.total_asset_shares.value) && isZeroWithTolerance(bank.total_liability_shares.value), MarginfiError.BankCannotClose);
  require(isZeroWithTolerance(bank.emissions_remaining.value), MarginfiError.BankCannotClose);
}

/**
 * Send a bank's collected premium to the premium wallet's token account (anyone): as much as the vault holds, in whole
 * tokens.
 */
export function lendingPoolCollectBankPremiumFees(
  group: Account<MarginfiGroup>,
  bank: HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>,
  liquidity_vault_authority: Seeds<AccountInfo, ["liquidity_vault_auth", "@bank"], "@bank.liquidity_vault_authority_bump">,
  liquidity_vault: Seeds<Mut<TokenAccount>, ["liquidity_vault", "@bank"], "@bank.liquidity_vault_bump">,
  fee_state: Seeds<Account<FeeState>, ["feestate"]>,
  premium_ata: Mut<TokenAccount>,
  token_program: TokenInterface,
): void {
  constraint(group, !protocolPaused(group), MarginfiError.ProtocolPaused);
  require(fee_state.premium_wallet !== SYSTEM_PROGRAM_ID, MarginfiError.PremiumWalletNotSet);
  require(premium_ata.key === findProgramAddress([fee_state.premium_wallet, token_program.key, bank.mint], ATA_PROGRAM_ID), MarginfiError.InvalidPremiumAta);
  let decimals: u8 = 0n;
  const t22 = token_program.key !== TOKEN_PROGRAM_ID;
  if (t22) {
    require(remainingAccounts().length > 0n, MarginfiError.T22MintRequired);
    const mint = remainingAccounts().get(0n);
    const n = mint.dataLen;
    require(mintOk(
      bank.mint,
      mint.key,
      mint.owner,
      n,
      n >= 82n ? readData<u8>(mint, 45n) : 0n,
      n > 165n ? readData<u8>(mint, 165n) : 0n,
    ), MarginfiError.T22MintRequired);
    decimals = readData<u8>(mint, 44n);
  }
  const available = fxFromU64(liquidity_vault.amount);
  const outstanding = bank.collected_premium_outstanding.value;
  const amount = fxInt(outstanding < available ? outstanding : available);
  const left = fxSub(outstanding, amount);
  bank.collected_premium_outstanding.value = left;
  const tokens = fxToU64(amount);
  const bump = bank.liquidity_vault_authority_bump;
  if (t22)
    invoke(
      token_program,
      [writable(liquidity_vault), readonly(remainingAccounts().get(0n)), writable(premium_ata), readonlySigner(liquidity_vault_authority)],
      [u8(12n), tokens, decimals],
      ["liquidity_vault_auth", bank.key, bump],
    );
  else
    invoke(
      token_program,
      [writable(liquidity_vault), writable(premium_ata), readonlySigner(liquidity_vault_authority)],
      [u8(3n), tokens],
      ["liquidity_vault_auth", bank.key, bump],
    );
  emit<LendingPoolPremiumFeesCollectedEvent>({
    header: { signer: null, marginfi_group: group.key },
    bank: bank.key,
    mint: liquidity_vault.mint,
    premium_collected: f64FromBits(fxToF64Bits(amount)),
    premium_outstanding: f64FromBits(fxToF64Bits(left)),
  });
}

/**
 * super_admin_deposit: staging and localnet builds only. The mainnet build panics once the accounts and the durable
 * nonce check pass.
 */
export function superAdminDeposit(
  group: HasOne<Account<MarginfiGroup>, "admin", MarginfiError.Unauthorized>,
  admin: Signer,
  bank: HasOne<HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>, "liquidity_vault", MarginfiError.InvalidLiquidityVault>,
  admin_token_account: Mut<AccountInfo>,
  liquidity_vault: Mut<TokenAccount>,
  token_program: TokenInterface,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  amount: u64,
): void {
  constraint(bank, bank.config.asset_tag === ASSET_TAG_DEFAULT || bank.config.asset_tag === ASSET_TAG_SOL);
  checkNoDurableNonce(instruction_sysvar);
  // "Staging or localnet only!"
  require(false, MarginfiError.InternalLogicError);
}

/** super_admin_withdraw: as super_admin_deposit, the mainnet build panics. */
export function superAdminWithdraw(
  group: HasOne<Account<MarginfiGroup>, "admin", MarginfiError.Unauthorized>,
  admin: Signer,
  bank: HasOne<HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>, "liquidity_vault", MarginfiError.InvalidLiquidityVault>,
  destination_token_account: Mut<TokenAccount>,
  liquidity_vault_authority: Seeds<AccountInfo, ["liquidity_vault_auth", "@bank"], "@bank.liquidity_vault_authority_bump">,
  liquidity_vault: Mut<TokenAccount>,
  token_program: TokenInterface,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  amount: u64,
): void {
  constraint(bank, bank.config.asset_tag === ASSET_TAG_DEFAULT || bank.config.asset_tag === ASSET_TAG_SOL);
  checkNoDurableNonce(instruction_sysvar);
  // "Staging or localnet only!"
  require(false, MarginfiError.InternalLogicError);
}

/**
 * Configure a bank's risk settings (the governance admin): its weights, risk tier, asset tag, oracle confidence cap
 * and age, the freeze and tokenless flags; the operational state only back to Operational. A bank with frozen
 * settings takes none of them (with the original's warning).
 */
export function lendingPoolConfigureBankGov(
  group: HasOne<Account<MarginfiGroup>, "governance_admin", MarginfiError.Unauthorized>,
  governance_admin: Signer,
  bank: HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  bank_config_opt: BankConfigGov,
): void {
  checkNoDurableNonce(instruction_sysvar);
  const c = bank_config_opt;
  require(c.operational_state === null || c.operational_state === BankOperationalState.Operational, MarginfiError.InvalidGovernanceBankOperationalState);
  if ((bank.flags & FREEZE_SETTINGS) === FREEZE_SETTINGS) {
    log("WARN: Only deposit+borrow limits updated. Other settings IGNORED for frozen banks!");
    emit<LendingPoolBankConfigureFrozenEvent>({
      header: { signer: governance_admin.key, marginfi_group: group.key },
      bank: bank.key,
      mint: bank.mint,
      deposit_limit: bank.config.deposit_limit,
      borrow_limit: bank.config.borrow_limit,
    });
    return;
  }
  configureBankGov(bank, c);
  validateEmodeEntries(bank, totalLiquidationFee(bank), group.emode_max_init_leverage, group.emode_max_maint_leverage);
  emit<LendingPoolBankConfigureEvent>({
    header: { signer: governance_admin.key, marginfi_group: group.key },
    bank: bank.key,
    mint: bank.mint,
    config: {
      asset_weight_init: c.asset_weight_init,
      asset_weight_maint: c.asset_weight_maint,
      liability_weight_init: c.liability_weight_init,
      liability_weight_maint: c.liability_weight_maint,
      deposit_limit: null,
      borrow_limit: null,
      operational_state: c.operational_state,
      interest_rate_config: null,
      risk_tier: c.risk_tier,
      asset_tag: c.asset_tag,
      total_asset_value_init_limit: null,
      oracle_max_confidence: c.oracle_max_confidence,
      oracle_max_age: c.oracle_max_age,
      permissionless_bad_debt_settlement: null,
      freeze_settings: c.freeze_settings,
      tokenless_repayments_allowed: c.tokenless_repayments_allowed,
      liquidation_liquidator_fee: null,
      liquidation_insurance_fee: null,
      circuit_breaker_enabled: null,
      cb_deviation_bps_tiers: null,
      cb_tier_durations_seconds: null,
      cb_escalation_window_mult: null,
      cb_ema_alpha_bps: null,
      cb_window_seconds: null,
      cb_window_max_up_bps: null,
      cb_window_max_down_bps: null,
    },
  });
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
    require(mintOk(
      bank.mint,
      mint.key,
      mint.owner,
      n,
      n >= 82n ? readData<u8>(mint, 45n) : 0n,
      n > 165n ? readData<u8>(mint, 165n) : 0n,
    ), MarginfiError.T22MintRequired);
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
    header: {
      signer: authority.key,
      marginfi_account: marginfi_account.key,
      marginfi_account_authority: marginfi_account.authority,
      marginfi_group: marginfi_account.group,
    },
    bank: bank.key,
    mint: bank.mint,
    amount: repaid,
    close_balance: all,
    share_amount: { value: shares },
  });
  if (settledNow > I80F48_ZERO || writtenOff > I80F48_ZERO)
    emit<LendingAccountPremiumSettledEvent>({
      header: {
        signer: authority.key,
        marginfi_account: marginfi_account.key,
        marginfi_account_authority: marginfi_account.authority,
        marginfi_group: marginfi_account.group,
      },
      bank: bank.key,
      mint: bank.mint,
      premium_settled: f64FromBits(fxToF64Bits(settledNow)),
      premium_written_off: f64FromBits(fxToF64Bits(writtenOff)),
      premium_outstanding_remaining: f64FromBits(fxToF64Bits(remaining)),
    });
  sortBalances(marginfi_account);
  refreshIndexerFlags(marginfi_account);
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
    require(mintOk(
      bank.mint,
      mint.key,
      mint.owner,
      n,
      n >= 82n ? readData<u8>(mint, 45n) : 0n,
      n > 165n ? readData<u8>(mint, 165n) : 0n,
    ), MarginfiError.T22MintRequired);
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
  else
    invoke(
      token_program,
      [writable(liquidity_vault), writable(fee_vault), readonlySigner(liquidity_vault_authority)],
      [u8(3n), fxToU64(groupFees)],
      ["liquidity_vault_auth", bank.key, bump],
    );
  if (t22)
    invoke(
      token_program,
      [writable(liquidity_vault), readonly(remainingAccounts().get(0n)), writable(insurance_vault), readonlySigner(liquidity_vault_authority)],
      [u8(12n), fxToU64(insurance), decimals],
      ["liquidity_vault_auth", bank.key, bump],
    );
  else
    invoke(
      token_program,
      [writable(liquidity_vault), writable(insurance_vault), readonlySigner(liquidity_vault_authority)],
      [u8(3n), fxToU64(insurance)],
      ["liquidity_vault_auth", bank.key, bump],
    );
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
  else
    invoke(
      token_program,
      [writable(liquidity_vault), writable(fee_ata), readonlySigner(liquidity_vault_authority)],
      [u8(3n), fxToU64(programFees)],
      ["liquidity_vault_auth", bank.key, bump],
    );
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
    require(mintOk(
      bank.mint,
      mint.key,
      mint.owner,
      n,
      n >= 82n ? readData<u8>(mint, 45n) : 0n,
      n > 165n ? readData<u8>(mint, 165n) : 0n,
    ), MarginfiError.T22MintRequired);
    decimals = readData<u8>(mint, 44n);
  }
  if (t22)
    invoke(
      token_program,
      [writable(fee_vault), readonly(remainingAccounts().get(0n)), writable(dst_token_account), readonlySigner(fee_vault_authority)],
      [u8(12n), amount, decimals],
      ["fee_vault_auth", bank.key, bank.fee_vault_authority_bump],
    );
  else
    invoke(
      token_program,
      [writable(fee_vault), writable(dst_token_account), readonlySigner(fee_vault_authority)],
      [u8(3n), amount],
      ["fee_vault_auth", bank.key, bank.fee_vault_authority_bump],
    );
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
    require(mintOk(
      bank.mint,
      mint.key,
      mint.owner,
      n,
      n >= 82n ? readData<u8>(mint, 45n) : 0n,
      n > 165n ? readData<u8>(mint, 165n) : 0n,
    ), MarginfiError.T22MintRequired);
    decimals = readData<u8>(mint, 44n);
  }
  if (t22)
    invoke(
      token_program,
      [writable(insurance_vault), readonly(remainingAccounts().get(0n)), writable(dst_token_account), readonlySigner(insurance_vault_authority)],
      [u8(12n), amount, decimals],
      ["insurance_vault_auth", bank.key, bank.insurance_vault_authority_bump],
    );
  else
    invoke(
      token_program,
      [writable(insurance_vault), writable(dst_token_account), readonlySigner(insurance_vault_authority)],
      [u8(3n), amount],
      ["insurance_vault_auth", bank.key, bank.insurance_vault_authority_bump],
    );
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
    require(mintOk(
      bank.mint,
      mint.key,
      mint.owner,
      n,
      n >= 82n ? readData<u8>(mint, 45n) : 0n,
      n > 165n ? readData<u8>(mint, 165n) : 0n,
    ), MarginfiError.T22MintRequired);
    decimals = readData<u8>(mint, 44n);
  }
  if (t22)
    invoke(
      token_program,
      [writable(fee_vault), readonly(remainingAccounts().get(0n)), writable(fees_destination_account), readonlySigner(fee_vault_authority)],
      [u8(12n), amount < held ? amount : held, decimals],
      ["fee_vault_auth", bank.key, bank.fee_vault_authority_bump],
    );
  else
    invoke(
      token_program,
      [writable(fee_vault), writable(fees_destination_account), readonlySigner(fee_vault_authority)],
      [u8(3n), amount < held ? amount : held],
      ["fee_vault_auth", bank.key, bank.fee_vault_authority_bump],
    );
}

// ---- emissions and same-asset e-mode ------------------------------------------------------------------------------

/** The share supply a bank needs before it takes emissions: a floor on how far one deposit can move the share value. */
const MIN_EMISSIONS_SHARE_SUPPLY: i128 = 295147905179352825856n; // 2^20 in I80F48

/**
 * Give a bank's depositors same-mint emissions (permissionless): the tokens go straight into the liquidity vault and
 * raise the asset share value. Mints with a transfer fee or a transfer hook are refused.
 */
export function lendingPoolEmissionsDeposit(
  group: Account<MarginfiGroup>,
  bank: HasOne<
    HasOne<HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>, "mint", MarginfiError.InvalidEmissionsMint>,
    "liquidity_vault",
    MarginfiError.InvalidLiquidityVault
  >,
  mint: Mint,
  emissions_funding_account: Mut<AccountInfo>,
  depositor: Mut<Signer>,
  liquidity_vault: Mut<TokenAccount>,
  token_program: TokenInterface,
  amount: u64,
): void {
  constraint(group, !protocolPaused(group), MarginfiError.ProtocolPaused);
  constraint(bank, isMarginfiAssetTag(bank.config.asset_tag), MarginfiError.WrongAssetTagForStandardInstructions);
  if (amount === 0n) return;
  const t = now();
  validateBankState(bank, FAILS_IF_PAUSED_OR_REDUCE_STATE, true, t);
  require(transferFeeBasisPoints(mint) === 0n, MarginfiError.InvalidTransfer);
  require(transferHookProgram(mint) === null, MarginfiError.InvalidTransfer);
  const shares = bank.total_asset_shares.value;
  require(shares >= MIN_EMISSIONS_SHARE_SUPPLY, MarginfiError.EmissionsUpdateError);
  accrueInterest(bank, group, bank.key, t);
  invoke(
    token_program,
    [writable(emissions_funding_account), readonly(mint), writable(liquidity_vault), readonlySigner(depositor)],
    [u8(12n), amount, mint.decimals],
  );
  bank.asset_share_value.value = fxDiv(fxAdd(assetAmount(bank, shares), fxFromU64(amount)), shares);
  updateBankCache(bank, group, t);
  log(`Deposited ${amount} same-bank emissions into liquidity vault`);
}

/** Create the group's same-asset e-mode registry, the PDA ["same_asset_emode_registry", group] (governance admin). */
export function lendingPoolInitSameAssetEmodeRegistry(
  group: HasOne<Account<MarginfiGroup>, "governance_admin", MarginfiError.Unauthorized>,
  governance_admin: Mut<Signer>,
  same_asset_emode_registry: Init<SameAssetEmodeRegistry>,
  system_program: SystemProgram,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
): void {
  const bump = same_asset_emode_registry.create(governance_admin, ["same_asset_emode_registry", group.key]);
  checkNoDurableNonce(instruction_sysvar);
  same_asset_emode_registry.key_ = same_asset_emode_registry.key;
  same_asset_emode_registry.group = group.key;
  same_asset_emode_registry.group_count = 0n;
  same_asset_emode_registry.bank_count = 0n;
  same_asset_emode_registry.bump = bump;
}

/** List a bank in the registry under its (mint, oracle_keys[0]) group, adding the group when it is new. */
function addSameAssetEmodeBank(registry: Mut<SameAssetEmodeRegistry>, bankKey: Pubkey, mint: Pubkey, oracleKey: Pubkey): void {
  const banks = u64(registry.bank_count);
  let listed = false;
  for (let i = 0n; i < banks; i++) if (registry.banks.get(i).bank === bankKey) listed = true;
  if (listed) return;
  const groups = u64(registry.group_count);
  let index = groups;
  for (let i = 0n; i < groups; i++)
    if (index === groups && registry.groups.get(i).mint === mint && registry.groups.get(i).oracle_key === oracleKey) index = i;
  if (index === groups) {
    require(index < 32n, MarginfiError.BadEmodeConfig);
    registry.groups.get(index).mint = mint;
    registry.groups.get(index).oracle_key = oracleKey;
    registry.group_count += 1n;
  }
  require(banks < 128n, MarginfiError.BadEmodeConfig);
  const entry = registry.banks.get(banks);
  entry.bank = bankKey;
  entry.group_index = u8(index);
  for (let k = 0n; k < 7n; k++) entry.padding.set(k, 0n);
  registry.bank_count += 1n;
}

/**
 * Take a bank out of the registry: the last entry moves into its place, and a group left empty is replaced by the last
 * group (its banks re-pointed).
 */
function removeSameAssetEmodeBank(registry: Mut<SameAssetEmodeRegistry>, bankKey: Pubkey): void {
  const banks = u64(registry.bank_count);
  let at = banks;
  for (let i = 0n; i < banks; i++) if (at === banks && registry.banks.get(i).bank === bankKey) at = i;
  if (at === banks) return;
  const removed = registry.banks.get(at).group_index;
  const last = banks - 1n;
  const to = registry.banks.get(at);
  const from = registry.banks.get(last);
  to.bank = from.bank;
  to.group_index = from.group_index;
  for (let k = 0n; k < 7n; k++) to.padding.set(k, from.padding.get(k));
  from.bank = ZERO_KEY;
  from.group_index = 0n;
  for (let k = 0n; k < 7n; k++) from.padding.set(k, 0n);
  registry.bank_count -= 1n;
  let members = 0n;
  for (let i = 0n; i < last; i++) if (registry.banks.get(i).group_index === removed) members += 1n;
  if (members > 0n) return;
  const gone = u64(removed);
  const lastGroup = u64(registry.group_count) - 1n;
  registry.groups.get(gone).mint = registry.groups.get(lastGroup).mint;
  registry.groups.get(gone).oracle_key = registry.groups.get(lastGroup).oracle_key;
  registry.groups.get(lastGroup).mint = ZERO_KEY;
  registry.groups.get(lastGroup).oracle_key = ZERO_KEY;
  registry.group_count -= 1n;
  if (gone !== lastGroup)
    for (let i = 0n; i < last; i++) if (u64(registry.banks.get(i).group_index) === lastGroup) registry.banks.get(i).group_index = removed;
}

/**
 * Opt a bank in or out of same-asset e-mode (governance admin): eligible banks need a Pyth push or Switchboard pull
 * feed and oracle_keys[0]; the registry lists them by (mint, oracle) group. Frozen banks are refused.
 */
export function lendingPoolSetBankSameAssetEmodeEligibility(
  group: HasOne<Account<MarginfiGroup>, "governance_admin", MarginfiError.Unauthorized>,
  governance_admin: Signer,
  bank: HasOne<Mut<Bank>, "group", MarginfiError.InvalidGroup>,
  same_asset_emode_registry: HasOne<
    Seeds<Mut<SameAssetEmodeRegistry>, ["same_asset_emode_registry", "@group"]>,
    "group",
    MarginfiError.InvalidGroup
  >,
  instruction_sysvar: Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">,
  enabled: boolean,
): void {
  checkNoDurableNonce(instruction_sysvar);
  require((bank.flags & FREEZE_SETTINGS) === 0n, MarginfiError.Unauthorized);
  if (enabled) {
    require(feedFamily(bank.config.oracle_setup) !== 0n, MarginfiError.BadEmodeConfig);
    require(bank.config.oracle_keys.get(0n) !== ZERO_KEY, MarginfiError.BadEmodeConfig);
    addSameAssetEmodeBank(same_asset_emode_registry, bank.key, bank.mint, bank.config.oracle_keys.get(0n));
  } else removeSameAssetEmodeBank(same_asset_emode_registry, bank.key);
  if (enabled) bank.flags |= BANK_SAME_ASSET_EMODE_ELIGIBLE;
  else bank.flags &= ~BANK_SAME_ASSET_EMODE_ELIGIBLE;
  checkSameAssetFee(bank, group);
  emit<LendingPoolBankSetSameAssetEmodeEligibilityEvent>({
    header: { signer: governance_admin.key, marginfi_group: group.key },
    bank: bank.key,
    mint: bank.mint,
    enabled,
  });
}
