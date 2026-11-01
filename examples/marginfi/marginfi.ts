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
  type Address,
  type Mint,
  type TokenAccount,
  type TokenInterface,
  type u8,
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
  emit,
  log,
  now,
  pubkey,
  require,
  u64,
} from "typesol";
import { type BankConfigCompact, type BankConfigFast } from "./args";
import {
  BANK_SEED_KNOWN,
  CIRCUIT_BREAKER_ENABLED,
  FREEZE_SETTINGS,
  IS_T22,
  accrueInterest,
  checkSameAssetFee,
  configureBank,
  initBank,
  totalLiquidationFee,
  updateBankCache,
  updateInterestRateConfig,
  validateBankConfig,
  validateEmodeEntries,
} from "./bank";
import { MarginfiError } from "./errors";
import {
  type InterestRateConfigOpt,
  type LendingPoolBankConfigureEvent,
  type LendingPoolBankConfigureFrozenEvent,
  type LendingPoolBankCreateEvent,
  type MarginfiGroupConfigureEvent,
  type MarginfiGroupCreateEvent,
} from "./events";
import { I80F48_ONE } from "./i80f48";
import { PROGRAM_FEES_ENABLED, basisToU32, validateInterestRateConfig } from "./interest_rate";
import { type Bank, type FeeState, type MarginfiGroup, type WrappedI80F48, BankOperationalState } from "./state";

const SYSTEM_PROGRAM_ID = pubkey("11111111111111111111111111111111");
const ASSET_TAG_DEFAULT: u8 = 0n;
const ASSET_TAG_SOL: u8 = 1n;
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
