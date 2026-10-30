// A TypeSOL port of Raydium CLMM (raydium-io/raydium-clmm @ 6d7a0f8, Apache-2.0; mainnet
// CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK). Instruction and account names, argument order, error codes and events
// are the original's, so its IDL and clients work unchanged. See docs/case-study-raydium-clmm.md.
import {
  AnchorError,
  AuthorityType,
  type Account,
  type AccountInfo,
  type Address,
  type Ata,
  type AssociatedTokenProgram,
  type CloseTo,
  type Dup,
  type Init,
  type InitIfNeeded,
  type MemoProgram,
  type Mint,
  type MintOf,
  type Mut,
  type Option,
  type Owner,
  type Seeds,
  type Signer,
  type SignerSeeds,
  type SystemProgram,
  type Token2022Program,
  type TokenAccount,
  type TokenInterface,
  type TokenProgram,
  type TokenMetadataProgram,
  type AccountMeta,
  i32,
  i64,
  type u128,
  type Pubkey,
  type Vec,
  u256,
  u32,
  bigEndian,
  byteLength,
  close,
  findProgramAddressBump,
  constraint,
  currentEpoch,
  emit,
  extensionsWithin,
  findProgramAddress,
  fixedArray,
  initAccount,
  invoke,
  loadAccount,
  loadAccountMut,
  log,
  now,
  programId,
  pubkey,
  readData,
  readonly,
  readonlySigner,
  remainingAccounts,
  rentExempt,
  require,
  returnData,
  signer,
  transferFee,
  transferFeeInverse,
  writable,
  u8,
  u16,
  u64,
} from "typesol";
import { ErrorCode } from "./errors";
import { checkLimitOrderAmount, checkTickIndex, decreaseOrder, increaseOrder, orderOffset, settleFilledOrder, unfilledOf } from "./limit_order";
import {
  type LiquidityChange,
  addLiquidityToTicks,
  liquidityFromOneAmount,
  arrayStartIndex,
  burnLiquidityFromTicks,
  checkTickArrayStartIndex,
  flipBitDefault,
  flipBitExtension,
  initPosition,
  inverseTransferFee,
  isValidStartIndex,
  overflowsDefaultBitmap,
  updatePosition,
  accrueRewards,
  NO_KEY,
} from "./liquidity";
import { FEE_RATE_DENOMINATOR_VALUE, MAX_SQRT_PRICE_X64, MAX_TICK, MIN_SQRT_PRICE_X64, MIN_TICK, Q64, addDelta, computeSwap, getSqrtPriceAtTick, getTickAtSqrtPrice } from "./math";
import {
  arrayInExtension,
  crossTick,
  currentArrayInBitmap,
  dynamicFeeEnabled,
  feeOnInput,
  feeOnToken0,
  firstInitializedOffset,
  matchLimitOrder,
  NO_ARRAY,
  newSwapRun,
  swapInArray,
  nextArrayInBitmap,
  nextArrayInExtension,
  nextInitializedOffset,
  spacingBound,
  splitFees,
  tickInitialized,
  tickSpacingIndex,
  totalFeeRate,
  unfilledAmount,
  updateObservation,
  updatePoolFees,
  updateReference,
  updateVolatilityAccumulator,
} from "./swap";
import {
  type AmmConfig,
  type CollectProtocolFeeEvent,
  type ConfigChangeEvent,
  type CreatePersonalPositionEvent,
  type DecreaseLiquidityEvent,
  type IncreaseLiquidityEvent,
  type LiquidityCalculateEvent,
  type LiquidityChangeEvent,
  type ObservationState,
  type PersonalPositionState,
  type PoolCreatedEvent,
  type PoolState,
  type SupportMintAssociated,
  type SwapEvent,
  type TickArrayBitmapExtension,
  type TickArrayState,
  type OperationState,
  type DynamicFeeConfig,
  type ProtocolPositionState,
  type CreateCustomizableParams,
  type InitializeRewardParam,
  type UpdateRewardInfosEvent,
  CollectFeeOn,
  type LimitOrderNonce,
  type LimitOrderState,
  type OpenLimitOrderEvent,
  type IncreaseLimitOrderEvent,
  type DecreaseLimitOrderEvent,
  type SettleLimitOrderEvent,
} from "./state";

const PROTOCOL_FEE_OWNER = pubkey("projjosVCPQH49d5em7VYS7fJZzaqKixqKtus7yk416");
const FUND_FEE_OWNER = pubkey("FundHfY8oo8J9KYGyfXFFuQCHe7Z1VBNmsj84eMcdYs4");
const SPL_TOKEN = pubkey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/** A multi-hop swap passes each hop's accounts and tick arrays: take as many accounts as the runtime allows. */
export const MAX_ACCOUNTS = 255n;
const ADMIN = pubkey("GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ");
const SPL_TOKEN_2022 = pubkey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const SYSTEM = pubkey("11111111111111111111111111111111");
const MAX_TICK_SPACING = 1000n;
/** util::frozen_position_nft_authorities (mainnet): pools of mints this freezes get untransferable position NFTs. */
const FROZEN_POSITION_NFT_AUTHORITY = pubkey("2Yq4T3mPNfjtEyTxSbRjRKqLf1pwbTasuCQrWe6QpM7x");

/** Create a fee tier (admin only). */
export function createAmmConfig(
  owner: Address<Mut<Signer>, "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ", ErrorCode.NotApproved>,
  amm_config: Init<AmmConfig>,
  system_program: SystemProgram,
  index: u16,
  tick_spacing: u16,
  trade_fee_rate: u32,
  protocol_fee_rate: u32,
  fund_fee_rate: u32,
): void {
  const bump = amm_config.create(owner, ["amm_config", bigEndian(index)]);
  require(FEE_RATE_DENOMINATOR_VALUE > trade_fee_rate, AnchorError.RequireGtViolated);
  require(FEE_RATE_DENOMINATOR_VALUE >= fund_fee_rate + protocol_fee_rate, AnchorError.RequireGteViolated);
  require(MAX_TICK_SPACING >= u64(tick_spacing), AnchorError.RequireGteViolated);
  amm_config.owner = PROTOCOL_FEE_OWNER;
  amm_config.bump = bump;
  amm_config.index = index;
  amm_config.trade_fee_rate = trade_fee_rate;
  amm_config.protocol_fee_rate = protocol_fee_rate;
  amm_config.tick_spacing = tick_spacing;
  amm_config.fund_fee_rate = fund_fee_rate;
  amm_config.padding_u32 = 0n;
  amm_config.fund_owner = FUND_FEE_OWNER;
  emit<ConfigChangeEvent>({
    index,
    owner: owner.key,
    trade_fee_rate,
    protocol_fee_rate,
    tick_spacing,
    fund_fee_rate,
    fund_owner: FUND_FEE_OWNER,
  });
}

/** SPL Token mints, and Token-2022 mints with only extensions a pool handles, or ones the admin allowed (util::is_supported_mint). */
function supportedMint(mint: Mint, associated: boolean): boolean {
  if (mint.tokenProgram === SPL_TOKEN) return true;
  if (associated) return true;
  // TransferFeeConfig, MetadataPointer, TokenMetadata, InterestBearingConfig, ScaledUiAmount.
  return extensionsWithin(mint, [1n, 18n, 19n, 10n, 25n]);
}

/** A pool vault: a token account at its PDA, owned by the pool (util::create_token_vault_account). */
function createTokenVault(
  payer: Mut<Signer>,
  pool: AccountMeta,
  vault: Mut<AccountInfo>,
  mint: Mint,
  system_program: SystemProgram,
  token_program: TokenInterface,
  bump: u8,
  seed: string,
): void {
  // GetAccountDataSize with ImmutableOwner: the size the token program wants for an account of this mint.
  invoke(token_program, [readonly(mint)], [u8(21n), u16(7n)]);
  const space = returnData<u64>(token_program);
  if (vault.lamports === 0n)
    system_program.createAccount(payer, vault, rentExempt(space), space, token_program.key, [seed, pool.key, mint.key, bump]);
  else {
    const min = rentExempt(space) > 1n ? rentExempt(space) : 1n;
    if (min > vault.lamports) system_program.transfer(payer, vault, min - vault.lamports);
    system_program.allocate(vault, space, [seed, pool.key, mint.key, bump]);
    system_program.assign(vault, token_program.key, [seed, pool.key, mint.key, bump]);
  }
  token_program.initializeImmutableOwner(vault);
  token_program.initializeAccount3(vault, mint, pool.key);
}

/** Create a pool of a token pair under a fee tier, at an initial price. */
export function createPool(
  pool_creator: Mut<Signer>,
  amm_config: Account<AmmConfig>,
  pool_state: Init<PoolState>,
  token_mint_0: MintOf<Mint, never, never, "token_program_0">,
  token_mint_1: MintOf<Mint, never, never, "token_program_1">,
  token_vault_0: Seeds<Mut<AccountInfo>, ["pool_vault", "@pool_state", "@token_mint_0"]>,
  token_vault_1: Seeds<Mut<AccountInfo>, ["pool_vault", "@pool_state", "@token_mint_1"]>,
  observation_state: Init<ObservationState>,
  tick_array_bitmap: Init<TickArrayBitmapExtension>,
  token_program_0: TokenInterface,
  token_program_1: TokenInterface,
  system_program: SystemProgram,
  rent: Address<AccountInfo, "SysvarRent111111111111111111111111111111111">,
  sqrt_price_x64: u128,
  open_time: u64,
): void {
  constraint(token_mint_0, token_mint_0.key.compare(token_mint_1.key) < 0n);
  const bump = pool_state.create(pool_creator, ["pool", amm_config.key, token_mint_0.key, token_mint_1.key]);
  observation_state.create(pool_creator, ["observation", pool_state.key]);
  tick_array_bitmap.create(pool_creator, ["pool_tick_array_bitmap_extension", pool_state.key]);

  // SupportMintAssociated accounts in the remaining accounts (util::support_mint_associated_is_initialized).
  let associated0 = false;
  let associated1 = false;
  const rest = remainingAccounts();
  if (rest.length > 0n) {
    const expected0 = findProgramAddress(["support_mint", token_mint_0.key], programId());
    const expected1 = findProgramAddress(["support_mint", token_mint_1.key], programId());
    for (let i = 0n; i < rest.length && !associated0; i++) {
      const info = rest.get(i);
      if (info.owner === programId() && info.key === expected0) {
        const associated = loadAccount<SupportMintAssociated>(info);
        if (associated.mint === token_mint_0.key) associated0 = true;
      }
    }
    for (let i = 0n; i < rest.length && !associated1; i++) {
      const info = rest.get(i);
      if (info.owner === programId() && info.key === expected1) {
        const associated = loadAccount<SupportMintAssociated>(info);
        if (associated.mint === token_mint_1.key) associated1 = true;
      }
    }
  }
  require(supportedMint(token_mint_0, associated0) && supportedMint(token_mint_1, associated1), ErrorCode.NotSupportMint);
  require(u64(now()) > open_time, AnchorError.RequireGtViolated);
  const tick = getTickAtSqrtPrice(sqrt_price_x64);

  createTokenVault(pool_creator, pool_state, token_vault_0, token_mint_0, system_program, token_program_0, token_vault_0.pdaBump, "pool_vault");
  createTokenVault(pool_creator, pool_state, token_vault_1, token_mint_1, system_program, token_program_1, token_vault_1.pdaBump, "pool_vault");

  observation_state.initialized = false;
  observation_state.recent_epoch = currentEpoch();
  observation_state.observation_index = 0n;
  observation_state.pool_id = pool_state.key;

  pool_state.bump.set(0n, bump);
  pool_state.amm_config = amm_config.key;
  pool_state.owner = pool_creator.key;
  pool_state.token_mint_0 = token_mint_0.key;
  pool_state.token_mint_1 = token_mint_1.key;
  pool_state.mint_decimals_0 = token_mint_0.decimals;
  pool_state.mint_decimals_1 = token_mint_1.decimals;
  pool_state.token_vault_0 = token_vault_0.key;
  pool_state.token_vault_1 = token_vault_1.key;
  pool_state.tick_spacing = amm_config.tick_spacing;
  pool_state.sqrt_price_x64 = sqrt_price_x64;
  pool_state.tick_current = tick;
  for (let i = 0n; i < 3n; i++) pool_state.reward_infos.get(i).authority = pool_creator.key;
  pool_state.fee_on = 0n;
  pool_state.open_time = 0n;
  pool_state.recent_epoch = currentEpoch();
  pool_state.observation_key = observation_state.key;

  tick_array_bitmap.pool_id = pool_state.key;

  emit<PoolCreatedEvent>({
    token_mint_0: token_mint_0.key,
    token_mint_1: token_mint_1.key,
    tick_spacing: amm_config.tick_spacing,
    pool_state: pool_state.key,
    sqrt_price_x64,
    tick,
    token_vault_0: token_vault_0.key,
    token_vault_1: token_vault_1.key,
  });
}


// ---- positions and liquidity ---------------------------------------------------------------------------------------

/** The pool's signer seeds (PoolState::seeds): a pool made with a seed index signs with it, others without. */
function poolIsIndexed(pool: Account<PoolState>): boolean {
  return pool.seed_index.get(0n) !== 0n || pool.seed_index.get(1n) !== 0n;
}

/** TickArrayBitmapExtension::key. */
function extensionKey(pool: AccountMeta): Pubkey {
  return findProgramAddress(["pool_tick_array_bitmap_extension", pool.key], programId());
}

/** TickArrayState::get_or_create_tick_array, the create half: an array account at its PDA, initialized for the pool. */
function createTickArray(payer: Mut<Signer>, array: Mut<AccountInfo>, pool: Account<PoolState>, system_program: SystemProgram, start: i32, bump: u8): void {
  // util::create_or_allocate_account: someone may have sent lamports to the address first.
  const space = 10240n;
  if (array.lamports === 0n)
    system_program.createAccount(payer, array, rentExempt(space), space, programId(), ["tick_array", pool.key, bigEndian(start), bump]);
  else {
    const min = rentExempt(space) > 1n ? rentExempt(space) : 1n;
    if (min > array.lamports) system_program.transfer(payer, array, min - array.lamports);
    system_program.allocate(array, space, ["tick_array", pool.key, bigEndian(start), bump]);
    system_program.assign(array, programId(), ["tick_array", pool.key, bigEndian(start), bump]);
  }
  const created = initAccount<TickArrayState>(array);
  created.start_tick_index = start;
  created.pool_id = pool.key;
  created.recent_epoch = currentEpoch();
}

/** transfer_from_user_to_pool_vault (v2): transfer_checked under the program that holds the user's account. */
function transferIn(authority: Signer, from: Mut<TokenAccount>, vault: Mut<TokenAccount>, mint: Mint, token_program: TokenProgram, token_program_2022: Token2022Program, amount: u64): void {
  if (amount === 0n) return;
  if (from.tokenProgram === token_program_2022.key) token_program_2022.transferChecked(from, mint, vault, authority, amount);
  else token_program.transferChecked(from, mint, vault, authority, amount);
}

/** transfer_from_pool_vault_to_user (v2): the pool signs. */
function transferOut(
  pool: Account<PoolState>,
  vault: Mut<TokenAccount>,
  to: Mut<TokenAccount>,
  mint: Mint,
  token_program: TokenProgram,
  token_program_2022: Token2022Program,
  amount: u64,
  seeds: SignerSeeds,
): void {
  if (amount === 0n) return;
  if (vault.tokenProgram === token_program_2022.key) token_program_2022.transferChecked(vault, mint, to, pool, amount, seeds);
  else token_program.transferChecked(vault, mint, to, pool, amount, seeds);
}

export interface TransferFees {
  fee_0: u64;
  fee_1: u64;
}

/** The rest of add_liquidity once the ticks and bitmap are done: the amounts with their transfer fees, the deposit. */
function finishAddLiquidity(
  payer: Signer,
  token_account_0: Mut<TokenAccount>,
  token_account_1: Mut<TokenAccount>,
  token_vault_0: Mut<TokenAccount>,
  token_vault_1: Mut<TokenAccount>,
  vault_0_mint: Mint,
  vault_1_mint: Mint,
  token_program: TokenProgram,
  token_program_2022: Token2022Program,
  pool: Account<PoolState>,
  change: LiquidityChange,
  amount_0_max: u64,
  amount_1_max: u64,
  tick_lower: i32,
  tick_upper: i32,
): TransferFees {
  require(change.amount_0 > 0n || change.amount_1 > 0n, ErrorCode.ForbidBothZeroForSupplyLiquidity);
  const fee0 = inverseTransferFee(vault_0_mint, change.amount_0);
  const fee1 = inverseTransferFee(vault_1_mint, change.amount_1);
  emit<LiquidityCalculateEvent>({
    pool_liquidity: change.liquidity_before,
    pool_sqrt_price_x64: pool.sqrt_price_x64,
    pool_tick: pool.tick_current,
    calc_amount_0: change.amount_0,
    calc_amount_1: change.amount_1,
    trade_fee_owed_0: 0n,
    trade_fee_owed_1: 0n,
    transfer_fee_0: fee0,
    transfer_fee_1: fee1,
  });
  require(amount_0_max >= change.amount_0 + fee0, ErrorCode.PriceSlippageCheck);
  require(amount_1_max >= change.amount_1 + fee1, ErrorCode.PriceSlippageCheck);
  transferIn(payer, token_account_0, token_vault_0, vault_0_mint, token_program, token_program_2022, change.amount_0 + fee0);
  transferIn(payer, token_account_1, token_vault_1, vault_1_mint, token_program, token_program_2022, change.amount_1 + fee1);
  emit<LiquidityChangeEvent>({
    pool_state: pool.key,
    tick: pool.tick_current,
    tick_lower,
    tick_upper,
    liquidity_before: change.liquidity_before,
    liquidity_after: pool.liquidity,
  });
  return { fee_0: fee0, fee_1: fee1 };
}

/** util::position_nft_must_freeze: a mint whose freeze authority is a restricted-asset issuer's. */
function restrictedMint(mint: Mint): boolean {
  const authority = mint.freezeAuthority;
  return authority !== null && authority === FROZEN_POSITION_NFT_AUTHORITY;
}

/**
 * Open a position as a Token-2022 NFT (MintCloseAuthority, and with `with_metadata` a MetadataPointer with the
 * metadata in the mint), adding `liquidity` (or, when 0 and `base_flag` is given, what amount_0_max / amount_1_max
 * buys) between two ticks. The tick arrays are created when needed; past the pool's own bitmap the
 * TickArrayBitmapExtension is the first remaining account.
 */
export function openPositionWithToken22Nft(
  payer: Mut<Signer>,
  position_nft_owner: AccountInfo,
  position_nft_mint: Mut<Signer>,
  position_nft_account: Mut<AccountInfo>,
  pool_state: Mut<PoolState>,
  protocol_position: AccountInfo,
  tick_array_lower: Seeds<Mut<AccountInfo>, ["tick_array", "@pool_state", "@tick_array_lower_start_index:be"]>,
  tick_array_upper: Dup<Seeds<Mut<AccountInfo>, ["tick_array", "@pool_state", "@tick_array_upper_start_index:be"]>>,
  personal_position: Init<PersonalPositionState>,
  token_account_0: Mut<TokenAccount>,
  token_account_1: Mut<TokenAccount>,
  token_vault_0: Mut<TokenAccount>,
  token_vault_1: Mut<TokenAccount>,
  rent: Address<AccountInfo, "SysvarRent111111111111111111111111111111111">,
  system_program: SystemProgram,
  token_program: TokenProgram,
  associated_token_program: AssociatedTokenProgram,
  token_program_2022: Token2022Program,
  vault_0_mint: Mint,
  vault_1_mint: Mint,
  tick_lower_index: i32,
  tick_upper_index: i32,
  tick_array_lower_start_index: i32,
  tick_array_upper_start_index: i32,
  liquidity: u128,
  amount_0_max: u64,
  amount_1_max: u64,
  with_metadata: boolean,
  base_flag: Option<boolean>,
): void {
  constraint(token_account_0, token_account_0.mint === token_vault_0.mint, AnchorError.ConstraintTokenMint);
  constraint(token_account_1, token_account_1.mint === token_vault_1.mint, AnchorError.ConstraintTokenMint);
  constraint(token_vault_0, token_vault_0.key === pool_state.token_vault_0);
  constraint(token_vault_1, token_vault_1.key === pool_state.token_vault_1);
  constraint(vault_0_mint, vault_0_mint.key === token_vault_0.mint, AnchorError.ConstraintAddress);
  constraint(vault_1_mint, vault_1_mint.key === token_vault_1.mint, AnchorError.ConstraintAddress);
  const positionBump = personal_position.create(payer, ["position", position_nft_mint.key]);
  require(!token_account_0.isFrozen && !token_account_1.isFrozen, ErrorCode.NotApproved);

  // create_nft_mint_with_extensions: the pool mints and freezes, the position may close the mint.
  const mintSpace = with_metadata ? 270n : 202n;
  system_program.createAccount(payer, position_nft_mint, rentExempt(mintSpace), mintSpace, token_program_2022.key);
  token_program_2022.initializeMintCloseAuthority(position_nft_mint, personal_position.key);
  if (with_metadata) token_program_2022.initializeMetadataPointer(position_nft_mint, null, position_nft_mint.key);
  token_program_2022.initializeMint2(position_nft_mint, 0n, pool_state.key, pool_state.key);
  associated_token_program.create(payer, position_nft_account, position_nft_owner, position_nft_mint, system_program, token_program_2022);

  // open_position
  const frozen = restrictedMint(vault_0_mint) || restrictedMint(vault_1_mint);
  require((pool_state.status & 1n) === 0n, ErrorCode.NotApproved);
  require(tick_lower_index < tick_upper_index, ErrorCode.TickInvalidOrder);
  const spacing = pool_state.tick_spacing;
  checkTickArrayStartIndex(tick_array_lower_start_index, tick_lower_index, spacing);
  checkTickArrayStartIndex(tick_array_upper_start_index, tick_upper_index, spacing);
  require(isValidStartIndex(tick_array_lower_start_index, spacing), ErrorCode.InvalidTickIndex);
  if (tick_array_lower.owner === SYSTEM)
    createTickArray(payer, tick_array_lower, pool_state, system_program, tick_array_lower_start_index, tick_array_lower.pdaBump);
  if (tick_array_lower_start_index !== tick_array_upper_start_index) {
    require(isValidStartIndex(tick_array_upper_start_index, spacing), ErrorCode.InvalidTickIndex);
    if (tick_array_upper.owner === SYSTEM)
      createTickArray(payer, tick_array_upper, pool_state, system_program, tick_array_upper_start_index, tick_array_upper.pdaBump);
  }
  const lower = loadAccountMut<TickArrayState>(tick_array_lower);
  const upper = loadAccountMut<TickArrayState>(tick_array_upper);
  const useExtension = overflowsDefaultBitmap(tick_array_lower_start_index, spacing) || overflowsDefaultBitmap(tick_array_upper_start_index, spacing);
  const rest = remainingAccounts();
  if (useExtension) require(rest.get(0n).key === extensionKey(pool_state), AnchorError.RequireKeysEqViolated);

  const resolved =
    liquidity === 0n && base_flag !== null
      ? liquidityFromOneAmount(pool_state, vault_0_mint, vault_1_mint, base_flag, amount_0_max, amount_1_max, tick_lower_index, tick_upper_index)
      : liquidity;
  const change = addLiquidityToTicks(pool_state, lower, upper, resolved, liquidity === 0n && base_flag === null, tick_lower_index, tick_upper_index, u64(now()));
  let fee0: u64 = 0n;
  let fee1: u64 = 0n;
  if (!change.skipped) {
    const extLower = change.flip_lower && overflowsDefaultBitmap(lower.start_tick_index, spacing);
    const extUpper = change.flip_upper && overflowsDefaultBitmap(upper.start_tick_index, spacing);
    if (change.flip_lower && !extLower) flipBitDefault(pool_state, lower.start_tick_index);
    if (change.flip_upper && !extUpper) flipBitDefault(pool_state, upper.start_tick_index);
    if (extLower || extUpper) {
      const ext = loadAccountMut<TickArrayBitmapExtension>(rest.get(0n));
      if (extLower) flipBitExtension(ext, lower.start_tick_index, spacing);
      if (extUpper) flipBitExtension(ext, upper.start_tick_index, spacing);
    }
    const fees = finishAddLiquidity(
      payer,
      token_account_0,
      token_account_1,
      token_vault_0,
      token_vault_1,
      vault_0_mint,
      vault_1_mint,
      token_program,
      token_program_2022,
      pool_state,
      change,
      amount_0_max,
      amount_1_max,
      tick_lower_index,
      tick_upper_index,
    );
    fee0 = fees.fee_0;
    fee1 = fees.fee_1;
  }

  initPosition(personal_position, positionBump, position_nft_mint.key, pool_state.key, tick_lower_index, tick_upper_index, change);
  emit<CreatePersonalPositionEvent>({
    pool_state: pool_state.key,
    minter: payer.key,
    nft_owner: position_nft_owner.key,
    tick_lower_index,
    tick_upper_index,
    liquidity: change.liquidity,
    deposit_amount_0: change.amount_0,
    deposit_amount_1: change.amount_1,
    deposit_amount_0_transfer_fee: fee0,
    deposit_amount_1_transfer_fee: fee1,
  });

  // mint_nft_and_remove_mint_authority
  const seedIndex = u16(pool_state.seed_index.get(0n)) | (u16(pool_state.seed_index.get(1n)) << 8n);
  const poolSigner = poolIsIndexed(pool_state)
    ? signer(["pool", pool_state.amm_config, pool_state.token_mint_0, pool_state.token_mint_1, seedIndex, pool_state.bump.get(0n)])
    : signer(["pool", pool_state.amm_config, pool_state.token_mint_0, pool_state.token_mint_1, pool_state.bump.get(0n)]);
  if (with_metadata) {
    // initialize_token_metadata_extension: the mint grows by the metadata's TLV entry, its rent topped up first.
    const uri = `https://dynamic-ipfs.raydium.io/clmm/position?id=${personal_position.key}`;
    const grown = rentExempt(mintSpace + 4n + 113n + byteLength(uri));
    if (grown > position_nft_mint.lamports) system_program.transfer(payer, position_nft_mint, grown - position_nft_mint.lamports);
    token_program_2022.initializeMetadata(position_nft_mint, personal_position, pool_state, "Raydium Concentrated Liquidity", "RCL", uri, poolSigner);
  }
  token_program_2022.mintTo(position_nft_mint, position_nft_account, pool_state, 1n, poolSigner);
  if (frozen) token_program_2022.freezeAccount(position_nft_account, position_nft_mint, pool_state, poolSigner);
  token_program_2022.setAuthority(position_nft_mint, pool_state, AuthorityType.MintTokens, null, poolSigner);
}

/** Add liquidity to a position (or, with `liquidity` 0 and `base_flag`, what one amount buys). */
export function increaseLiquidityV2(
  nft_owner: Signer,
  nft_account: TokenAccount,
  pool_state: Mut<PoolState>,
  protocol_position: AccountInfo,
  personal_position: Mut<PersonalPositionState>,
  tick_array_lower: Mut<TickArrayState>,
  tick_array_upper: Dup<Mut<TickArrayState>>,
  token_account_0: Mut<TokenAccount>,
  token_account_1: Mut<TokenAccount>,
  token_vault_0: Mut<TokenAccount>,
  token_vault_1: Mut<TokenAccount>,
  token_program: TokenProgram,
  token_program_2022: Token2022Program,
  vault_0_mint: Mint,
  vault_1_mint: Mint,
  liquidity: u128,
  amount_0_max: u64,
  amount_1_max: u64,
  base_flag: Option<boolean>,
): void {
  constraint(nft_account, nft_account.mint === personal_position.nft_mint);
  constraint(nft_account, nft_account.amount === 1n);
  constraint(nft_account, nft_account.owner === nft_owner.key, AnchorError.ConstraintTokenOwner);
  constraint(personal_position, personal_position.pool_id === pool_state.key);
  constraint(tick_array_lower, tick_array_lower.pool_id === pool_state.key);
  constraint(tick_array_upper, tick_array_upper.pool_id === pool_state.key);
  constraint(token_account_0, token_account_0.mint === token_vault_0.mint, AnchorError.ConstraintTokenMint);
  constraint(token_account_1, token_account_1.mint === token_vault_1.mint, AnchorError.ConstraintTokenMint);
  constraint(token_vault_0, token_vault_0.key === pool_state.token_vault_0);
  constraint(token_vault_1, token_vault_1.key === pool_state.token_vault_1);
  constraint(vault_0_mint, vault_0_mint.key === token_vault_0.mint, AnchorError.ConstraintAddress);
  constraint(vault_1_mint, vault_1_mint.key === token_vault_1.mint, AnchorError.ConstraintAddress);
  // lib.rs: adding nothing needs base_flag to say which amount to add.
  if (liquidity === 0n) require(base_flag !== null, ErrorCode.MissingBaseFlag);

  require((pool_state.status & 1n) === 0n, ErrorCode.NotApproved);
  const tickLower = personal_position.tick_lower_index;
  const tickUpper = personal_position.tick_upper_index;
  const spacing = pool_state.tick_spacing;
  const useExtension = overflowsDefaultBitmap(tickLower, spacing) || overflowsDefaultBitmap(tickUpper, spacing);
  const rest = remainingAccounts();
  if (useExtension) require(rest.get(0n).key === extensionKey(pool_state), AnchorError.RequireKeysEqViolated);

  const resolved =
    liquidity === 0n && base_flag !== null
      ? liquidityFromOneAmount(pool_state, vault_0_mint, vault_1_mint, base_flag, amount_0_max, amount_1_max, tickLower, tickUpper)
      : liquidity;
  const change = addLiquidityToTicks(pool_state, tick_array_lower, tick_array_upper, resolved, liquidity === 0n && base_flag === null, tickLower, tickUpper, u64(now()));
  let fee0: u64 = 0n;
  let fee1: u64 = 0n;
  if (!change.skipped) {
    const extLower = change.flip_lower && overflowsDefaultBitmap(tick_array_lower.start_tick_index, spacing);
    const extUpper = change.flip_upper && overflowsDefaultBitmap(tick_array_upper.start_tick_index, spacing);
    if (change.flip_lower && !extLower) flipBitDefault(pool_state, tick_array_lower.start_tick_index);
    if (change.flip_upper && !extUpper) flipBitDefault(pool_state, tick_array_upper.start_tick_index);
    if (extLower || extUpper) {
      const ext = loadAccountMut<TickArrayBitmapExtension>(rest.get(0n));
      if (extLower) flipBitExtension(ext, tick_array_lower.start_tick_index, spacing);
      if (extUpper) flipBitExtension(ext, tick_array_upper.start_tick_index, spacing);
    }
    const fees = finishAddLiquidity(
      nft_owner,
      token_account_0,
      token_account_1,
      token_vault_0,
      token_vault_1,
      vault_0_mint,
      vault_1_mint,
      token_program,
      token_program_2022,
      pool_state,
      change,
      amount_0_max,
      amount_1_max,
      tickLower,
      tickUpper,
    );
    fee0 = fees.fee_0;
    fee1 = fees.fee_1;
  }
  updatePosition(personal_position, change, true);
  emit<IncreaseLiquidityEvent>({
    position_nft_mint: personal_position.nft_mint,
    liquidity: change.liquidity,
    amount_0: change.amount_0,
    amount_1: change.amount_1,
    amount_0_transfer_fee: fee0,
    amount_1_transfer_fee: fee1,
  });
}

/**
 * Take liquidity out of a position, with the fees it earned, and its rewards: per reward set up, the reward vault,
 * the recipient's token account and the reward mint, as remaining accounts (the TickArrayBitmapExtension may be
 * among them too).
 */
export function decreaseLiquidityV2(
  nft_owner: Signer,
  nft_account: TokenAccount,
  personal_position: Mut<PersonalPositionState>,
  pool_state: Mut<PoolState>,
  protocol_position: AccountInfo,
  token_vault_0: Mut<TokenAccount>,
  token_vault_1: Mut<TokenAccount>,
  tick_array_lower: Mut<TickArrayState>,
  tick_array_upper: Dup<Mut<TickArrayState>>,
  recipient_token_account_0: Mut<TokenAccount>,
  recipient_token_account_1: Mut<TokenAccount>,
  token_program: TokenProgram,
  token_program_2022: Token2022Program,
  memo_program: Address<AccountInfo, "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr">,
  vault_0_mint: Mint,
  vault_1_mint: Mint,
  liquidity: u128,
  amount_0_min: u64,
  amount_1_min: u64,
): void {
  constraint(nft_account, nft_account.mint === personal_position.nft_mint);
  constraint(nft_account, nft_account.amount === 1n);
  constraint(nft_account, nft_account.owner === nft_owner.key, AnchorError.ConstraintTokenOwner);
  constraint(personal_position, personal_position.pool_id === pool_state.key);
  constraint(token_vault_0, token_vault_0.key === pool_state.token_vault_0);
  constraint(token_vault_1, token_vault_1.key === pool_state.token_vault_1);
  constraint(tick_array_lower, tick_array_lower.pool_id === pool_state.key);
  constraint(tick_array_upper, tick_array_upper.pool_id === pool_state.key);
  constraint(recipient_token_account_0, recipient_token_account_0.mint === token_vault_0.mint, AnchorError.ConstraintTokenMint);
  constraint(recipient_token_account_1, recipient_token_account_1.mint === token_vault_1.mint, AnchorError.ConstraintTokenMint);
  constraint(vault_0_mint, vault_0_mint.key === token_vault_0.mint, AnchorError.ConstraintAddress);
  constraint(vault_1_mint, vault_1_mint.key === token_vault_1.mint, AnchorError.ConstraintAddress);

  require(personal_position.liquidity >= liquidity, AnchorError.RequireGteViolated);
  // Status bits 1, 2, 3: decrease liquidity, collect fees, collect rewards. Any of them lets this through.
  require((pool_state.status & 14n) !== 14n, ErrorCode.NotApproved);
  const liquidityBefore = pool_state.liquidity;
  const sqrtPrice = pool_state.sqrt_price_x64;
  const tickCurrent = pool_state.tick_current;
  const spacing = pool_state.tick_spacing;
  const useExtension = overflowsDefaultBitmap(tick_array_lower.start_tick_index, spacing) || overflowsDefaultBitmap(tick_array_upper.start_tick_index, spacing);
  // The bitmap extension, wherever it is among the remaining accounts; the others are the reward accounts.
  const rest = remainingAccounts();
  const extKey = extensionKey(pool_state);
  let extAt = rest.length;
  for (let i = 0n; i < rest.length; i++) if (rest.get(i).key === extKey) extAt = i;
  require(!useExtension || extAt < rest.length, ErrorCode.MissingTickArrayBitmapExtensionAccount);

  // decrease_liquidity_and_update_position
  let decrease0: u64 = 0n;
  let decrease1: u64 = 0n;
  if ((pool_state.status & 2n) === 0n) {
    const change = burnLiquidityFromTicks(
      pool_state,
      tick_array_lower,
      tick_array_upper,
      personal_position.tick_lower_index,
      personal_position.tick_upper_index,
      liquidity,
      u64(now()),
    );
    const extLower = change.flip_lower && overflowsDefaultBitmap(tick_array_lower.start_tick_index, spacing);
    const extUpper = change.flip_upper && overflowsDefaultBitmap(tick_array_upper.start_tick_index, spacing);
    if (change.flip_lower && !extLower) flipBitDefault(pool_state, tick_array_lower.start_tick_index);
    if (change.flip_upper && !extUpper) flipBitDefault(pool_state, tick_array_upper.start_tick_index);
    if (extLower || extUpper) {
      const ext = loadAccountMut<TickArrayBitmapExtension>(rest.get(extAt));
      if (extLower) flipBitExtension(ext, tick_array_lower.start_tick_index, spacing);
      if (extUpper) flipBitExtension(ext, tick_array_upper.start_tick_index, spacing);
    }
    emit<LiquidityChangeEvent>({
      pool_state: pool_state.key,
      tick: pool_state.tick_current,
      tick_lower: personal_position.tick_lower_index,
      tick_upper: personal_position.tick_upper_index,
      liquidity_before: change.liquidity_before,
      liquidity_after: pool_state.liquidity,
    });
    updatePosition(personal_position, change, false);
    decrease0 = change.amount_0;
    decrease1 = change.amount_1;
  }
  let fees0: u64 = 0n;
  let fees1: u64 = 0n;
  if ((pool_state.status & 4n) === 0n) {
    fees0 = personal_position.token_fees_owed_0;
    fees1 = personal_position.token_fees_owed_1;
    personal_position.token_fees_owed_0 = 0n;
    personal_position.token_fees_owed_1 = 0n;
  }

  const transferFee0 = transferFee(vault_0_mint, decrease0);
  const transferFee1 = transferFee(vault_1_mint, decrease1);
  emit<LiquidityCalculateEvent>({
    pool_liquidity: liquidityBefore,
    pool_sqrt_price_x64: sqrtPrice,
    pool_tick: tickCurrent,
    calc_amount_0: decrease0,
    calc_amount_1: decrease1,
    trade_fee_owed_0: fees0,
    trade_fee_owed_1: fees1,
    transfer_fee_0: transferFee0,
    transfer_fee_1: transferFee1,
  });
  if (liquidity > 0n) {
    require(decrease0 - transferFee0 >= amount_0_min, ErrorCode.PriceSlippageCheck);
    require(decrease1 - transferFee1 >= amount_1_min, ErrorCode.PriceSlippageCheck);
  }
  const seedIndex = u16(pool_state.seed_index.get(0n)) | (u16(pool_state.seed_index.get(1n)) << 8n);
  const poolSigner = poolIsIndexed(pool_state)
    ? signer(["pool", pool_state.amm_config, pool_state.token_mint_0, pool_state.token_mint_1, seedIndex, pool_state.bump.get(0n)])
    : signer(["pool", pool_state.amm_config, pool_state.token_mint_0, pool_state.token_mint_1, pool_state.bump.get(0n)]);
  transferOut(pool_state, token_vault_0, recipient_token_account_0, vault_0_mint, token_program, token_program_2022, decrease0 + fees0, poolSigner);
  transferOut(pool_state, token_vault_1, recipient_token_account_1, vault_1_mint, token_program, token_program_2022, decrease1 + fees1, poolSigner);

  // collect_rewards: groups of (reward vault, recipient, reward mint), one per reward set up.
  const rewards = fixedArray<u64, 3>(0n);
  if ((pool_state.status & 8n) === 0n) {
    let valid = 0n;
    for (let i = 0n; i < 3n; i++) if (pool_state.reward_infos.get(i).token_mint !== SYSTEM) valid += 1n;
    const count = extAt < rest.length ? rest.length - 1n : rest.length;
    require(count === valid * 3n, ErrorCode.InvalidRewardInputAccountNumber);
    for (let i = 0n; i < count / 3n; i++) {
      // The i-th group among the accounts other than the extension.
      const at = 3n * i;
      const v = at < extAt ? at : at + 1n;
      const r = at + 1n < extAt ? at + 1n : at + 2n;
      const m = at + 2n < extAt ? at + 2n : at + 3n;
      const vault = rest.get(v);
      const recipient = rest.get(r);
      const mint = rest.get(m);
      // InterfaceAccount<TokenAccount> / <Mint>: owned by a token program and holding one.
      require(vault.owner === SPL_TOKEN || vault.owner === SPL_TOKEN_2022, AnchorError.AccountOwnedByWrongProgram);
      require(vault.dataLen >= 165n, AnchorError.AccountDidNotDeserialize);
      require(recipient.owner === SPL_TOKEN || recipient.owner === SPL_TOKEN_2022, AnchorError.AccountOwnedByWrongProgram);
      require(recipient.dataLen >= 165n, AnchorError.AccountDidNotDeserialize);
      require(mint.owner === SPL_TOKEN || mint.owner === SPL_TOKEN_2022, AnchorError.AccountOwnedByWrongProgram);
      require(mint.dataLen >= 82n, AnchorError.AccountDidNotDeserialize);
      require(readData<Pubkey>(vault, 0n) === readData<Pubkey>(recipient, 0n), AnchorError.RequireKeysEqViolated);
      const info = pool_state.reward_infos.get(i);
      require(vault.key === info.token_vault, AnchorError.RequireKeysEqViolated);
      const owed = personal_position.reward_infos.get(i).reward_amount_owed;
      if (owed === 0n) continue;
      // check_unclaimed_reward
      require(info.reward_total_emitted >= info.reward_claimed, ErrorCode.CalculateOverflow);
      require(info.reward_total_emitted - info.reward_claimed >= owed, AnchorError.RequireGteViolated);
      const balance = readData<u64>(vault, 64n);
      const amount = owed > balance ? balance : owed;
      if (amount > 0n) {
        log(`collect reward index: ${i}, transfer_amount: ${amount}, reward_amount_owed:${owed} `);
        personal_position.reward_infos.get(i).reward_amount_owed = owed - amount;
        require(info.reward_claimed <= 18446744073709551615n - amount, ErrorCode.CalculateOverflow);
        info.reward_claimed += amount;
        const decimals = readData<u8>(mint, 44n);
        if (vault.owner === SPL_TOKEN_2022)
          invoke(token_program_2022, [writable(vault), readonly(mint), writable(recipient), readonlySigner(pool_state)], [u8(12n), amount, decimals], poolSigner);
        else invoke(token_program, [writable(vault), readonly(mint), writable(recipient), readonlySigner(pool_state)], [u8(12n), amount, decimals], poolSigner);
      }
      rewards.set(i, amount);
    }
  }
  emit<DecreaseLiquidityEvent>({
    position_nft_mint: personal_position.nft_mint,
    liquidity,
    decrease_amount_0: decrease0,
    decrease_amount_1: decrease1,
    fee_amount_0: fees0,
    fee_amount_1: fees1,
    reward_amounts: rewards,
    transfer_fee_0: transferFee0,
    transfer_fee_1: transferFee1,
  });
}


// ---- swaps -------------------------------------------------------------------------------------------------------


/**
 * Swap `amount` of one token of the pool (or, with `is_base_input` false, for exactly `amount` of the other), across
 * as many ticks as it takes, down (or up) to `sqrt_price_limit_x64` (0: no limit). The tick arrays it may cross, in
 * order, and the TickArrayBitmapExtension when the price may leave the pool's own bitmap, are the remaining accounts.
 */
export function swapV2(
  payer: Signer,
  amm_config: Account<AmmConfig>,
  pool_state: Mut<PoolState>,
  input_token_account: Mut<TokenAccount>,
  output_token_account: Mut<TokenAccount>,
  input_vault: Mut<TokenAccount>,
  output_vault: Mut<TokenAccount>,
  observation_state: Mut<ObservationState>,
  token_program: TokenProgram,
  token_program_2022: Token2022Program,
  memo_program: MemoProgram,
  input_vault_mint: Mint,
  output_vault_mint: Mint,
  amount: u64,
  other_amount_threshold: u64,
  sqrt_price_limit_x64: u128,
  is_base_input: boolean,
): void {
  constraint(amm_config, amm_config.key === pool_state.amm_config, AnchorError.ConstraintAddress);
  constraint(input_token_account, input_token_account.mint === input_vault.mint, AnchorError.ConstraintTokenMint);
  constraint(input_token_account, input_token_account.owner === payer.key, AnchorError.ConstraintTokenOwner);
  constraint(output_token_account, output_token_account.mint === output_vault.mint, AnchorError.ConstraintTokenMint);
  constraint(observation_state, observation_state.key === pool_state.observation_key, AnchorError.ConstraintAddress);
  constraint(input_vault_mint, input_vault_mint.key === input_vault.mint, AnchorError.ConstraintAddress);
  constraint(output_vault_mint, output_vault_mint.key === output_vault.mint, AnchorError.ConstraintAddress);

  // exact_internal_v2: the transfer fee comes off an exact input, or on top of an exact output.
  const timestamp = u64(now());
  const inputBefore = input_token_account.amount;
  const outputBefore = output_token_account.amount;
  let specifiedFee: u64 = 0n;
  let specified: u64 = 0n;
  if (is_base_input) {
    specifiedFee = transferFee(input_vault_mint, amount);
    specified = amount - specifiedFee;
  } else {
    specifiedFee = inverseTransferFee(output_vault_mint, amount);
    specified = amount + specifiedFee;
  }
  const priceBefore = pool_state.sqrt_price_x64;
  const zeroForOne = input_vault.mint === pool_state.token_mint_0;
  require(timestamp > pool_state.open_time, AnchorError.RequireGtViolated);
  require(
    zeroForOne
      ? input_vault.key === pool_state.token_vault_0 && output_vault.key === pool_state.token_vault_1
      : input_vault.key === pool_state.token_vault_1 && output_vault.key === pool_state.token_vault_0,
    ErrorCode.InvalidInputPoolVault,
  );
  // The remaining accounts: tick arrays and the bitmap extension, told apart by size, up to the first that is neither.
  const rest = remainingAccounts();
  let scanEnd = rest.length;
  let extAt = rest.length;
  for (let i = 0n; i < rest.length && scanEnd === rest.length; i++) {
    const a = rest.get(i);
    if (a.dataLen === 10240n) {
      // AccountLoad::load_data_mut
      require(a.owner === programId(), AnchorError.AccountOwnedByWrongProgram);
      require(a.isWritable, AnchorError.AccountNotMutable);
      // Its discriminator (the view itself is taken when the swap reaches it).
      const array = loadAccount<TickArrayState>(a);
    } else if (a.dataLen === 1832n) {
      // TickArrayBitmapExtension::validate_belongs_to_pool
      const ext = loadAccount<TickArrayBitmapExtension>(a);
      require(ext.pool_id === pool_state.key, ErrorCode.InvalidTickArrayBitmapExtensionAccount);
      extAt = i;
    } else scanEnd = i;
  }
  /** The next tick array after remaining account `from` (-1: the first), or -1. */
  const nextTickArray = (from: i64): i64 => {
    for (let i = from + 1n; i < i64(scanEnd); i++) if (rest.get(u64(i)).dataLen === 10240n) return i;
    return -1n;
  };
  const spacing = pool_state.tick_spacing;
  /** PoolState::next_tick_array_index_with_extension_info: the next marked array, or NO_ARRAY. */
  const nextArrayStart = (from: i32): i64 => {
    let last = arrayStartIndex(from, spacing);
    for (;;) {
      const inPool = nextArrayInBitmap(pool_state, last, zeroForOne);
      if (inPool.found) return i64(inPool.start);
      if (spacing >= 15n) return NO_ARRAY;
      last = inPool.start;
      require(extAt < rest.length, ErrorCode.MissingTickArrayBitmapExtensionAccount);
      const ext = loadAccount<TickArrayBitmapExtension>(rest.get(extAt));
      const inExt = nextArrayInExtension(ext, last, spacing, zeroForOne);
      if (inExt.found) return i64(inExt.start);
      last = inExt.start;
      if (last < MIN_TICK || last > MAX_TICK) return NO_ARRAY;
    }
  };
  const limit = sqrt_price_limit_x64 !== 0n ? sqrt_price_limit_x64 : zeroForOne ? MIN_SQRT_PRICE_X64 + 1n : MAX_SQRT_PRICE_X64 - 1n;
  const blockTimestamp = u32(timestamp & 0xffffffffn);

  // swap_internal
  require(specified !== 0n, ErrorCode.ZeroAmountSpecified);
  require((pool_state.status & 16n) === 0n, ErrorCode.NotApproved);
  require(
    zeroForOne
      ? limit < pool_state.sqrt_price_x64 && limit > MIN_SQRT_PRICE_X64
      : limit > pool_state.sqrt_price_x64 && limit < MAX_SQRT_PRICE_X64,
    ErrorCode.SqrtPriceLimitOverflow,
  );
  accrueRewards(pool_state, u64(blockTimestamp));
  require(observation_state.pool_id === pool_state.key, AnchorError.RequireKeysEqViolated);
  // first_tick_array_index_with_extension_info
  let firstHasPoolTick = false;
  let validStart: i32 = 0n;
  let current = arrayStartIndex(pool_state.tick_current, spacing);
  let marked = false;
  if (overflowsDefaultBitmap(pool_state.tick_current, spacing)) {
    require(extAt < rest.length, ErrorCode.MissingTickArrayBitmapExtensionAccount);
    const ext = loadAccount<TickArrayBitmapExtension>(rest.get(extAt));
    const found = arrayInExtension(ext, current, spacing);
    marked = found.found;
    current = found.start;
  } else {
    const found = currentArrayInBitmap(pool_state);
    marked = found.found;
    current = found.start;
  }
  if (marked) {
    firstHasPoolTick = true;
    validStart = current;
  } else {
    const next = nextArrayStart(arrayStartIndex(pool_state.tick_current, spacing));
    require(next !== NO_ARRAY, ErrorCode.InsufficientLiquidityForDirection);
    validStart = i32(next);
  }
  // The first tick array passed that is that one (the ones before it are skipped).
  let at = nextTickArray(-1n);
  require(at >= 0n, ErrorCode.NotEnoughTickArrayAccount);
  for (;;) {
    if (readData<i32>(rest.get(u64(at)), 40n) === validStart) break;
    const next = nextTickArray(at);
    if (next < 0n) break;
    at = next;
  }
  require(readData<Pubkey>(rest.get(u64(at)), 8n) === pool_state.key, AnchorError.RequireKeysEqViolated);
  require(readData<i32>(rest.get(u64(at)), 40n) === validStart, ErrorCode.InvalidFirstTickArrayAccount);

  const isFeeOnInput = feeOnInput(pool_state, zeroForOne);
  const dynamic = dynamicFeeEnabled(pool_state);
  const run = newSwapRun(pool_state, specified, zeroForOne, firstHasPoolTick);
  if (dynamic) {
    run.s.tick_spacing_index = tickSpacingIndex(run.s.tick, spacing);
    updateReference(pool_state, run.s.tick_spacing_index, u64(blockTimestamp));
  }
  // The swap, one tick array at a time.
  let finished = false;
  while (!finished) {
    const array = loadAccountMut<TickArrayState>(rest.get(u64(at)));
    run.s = swapInArray(pool_state, amm_config, array, run.s, limit, zeroForOne, is_base_input, isFeeOnInput, dynamic);
    if (run.s.ext_flip) {
      require(extAt < rest.length, ErrorCode.MissingTickArrayBitmapExtensionAccount);
      const ext = loadAccountMut<TickArrayBitmapExtension>(rest.get(extAt));
      flipBitExtension(ext, run.s.ext_flip_start, spacing);
      run.s.ext_flip = false;
    }
    if (run.s.move_on) {
      // Past this array: the next marked one, among the tick arrays passed after it.
      const next = nextArrayStart(validStart);
      require(next !== NO_ARRAY, ErrorCode.LiquidityInsufficient);
      while (readData<i32>(rest.get(u64(at)), 40n) !== i32(next)) {
        at = nextTickArray(at);
        require(at >= 0n, ErrorCode.NotEnoughTickArrayAccount);
        require(readData<Pubkey>(rest.get(u64(at)), 8n) === pool_state.key, AnchorError.RequireKeysEqViolated);
      }
      validStart = i32(next);
      run.s.take_first = true;
      run.s.move_on = false;
    } else finished = true;
  }
  const st = run.s;

  if (st.tick !== pool_state.tick_current) updateObservation(observation_state, blockTimestamp, pool_state.tick_current);
  // settle_amounts
  require(specified >= st.amount_specified_remaining, ErrorCode.CalculateOverflow);
  const consumed = specified - st.amount_specified_remaining;
  const amount0 = zeroForOne === is_base_input ? consumed : st.amount_calculated;
  const amount1 = zeroForOne === is_base_input ? st.amount_calculated : consumed;
  require(st.lp_fee <= 18446744073709551615n - st.protocol_fee, ErrorCode.CalculateOverflow);
  require(st.lp_fee + st.protocol_fee <= 18446744073709551615n - st.fund_fee, ErrorCode.CalculateOverflow);
  const tradeFee = st.lp_fee + st.protocol_fee + st.fund_fee;
  const onToken0 = feeOnToken0(pool_state, zeroForOne);
  // update_after_swap
  pool_state.tick_current = st.tick;
  pool_state.sqrt_price_x64 = st.sqrt_price_x64;
  pool_state.liquidity = st.liquidity;
  updatePoolFees(pool_state, st, zeroForOne);

  log(`exact_swap_internal, is_base_input:${is_base_input}, amount_0: ${amount0}, amount_1: ${amount1}`);
  require(amount0 !== 0n && amount1 !== 0n, ErrorCode.TooSmallInputOrOutputAmount);
  // The transfer fees: the input's on top of what the pool takes in, the output's out of what it pays.
  let fee0: u64 = 0n;
  let fee1: u64 = 0n;
  let net0 = amount0;
  let net1 = amount1;
  let send0 = amount0;
  let send1 = amount1;
  if (zeroForOne) {
    fee0 = is_base_input && amount0 === specified ? specifiedFee : inverseTransferFee(input_vault_mint, amount0);
    fee1 = transferFee(output_vault_mint, amount1);
    require(amount1 >= fee1, ErrorCode.CalculateOverflow);
    net1 = amount1 - fee1;
    require(amount0 <= 18446744073709551615n - fee0, ErrorCode.CalculateOverflow);
    send0 = amount0 + fee0;
  } else {
    fee0 = transferFee(output_vault_mint, amount0);
    fee1 = is_base_input && amount1 === specified ? specifiedFee : inverseTransferFee(input_vault_mint, amount1);
    require(amount0 >= fee0, ErrorCode.CalculateOverflow);
    net0 = amount0 - fee0;
    require(amount1 <= 18446744073709551615n - fee1, ErrorCode.CalculateOverflow);
    send1 = amount1 + fee1;
  }
  log(`amount_0:${amount0}, transfer_fee_0:${fee0}, amount_1:${amount1}, transfer_fee_1:${fee1}`);
  emit<SwapEvent>({
    pool_state: pool_state.key,
    sender: payer.key,
    token_account_0: zeroForOne ? input_token_account.key : output_token_account.key,
    token_account_1: zeroForOne ? output_token_account.key : input_token_account.key,
    amount_0: net0,
    transfer_fee_0: fee0,
    amount_1: net1,
    transfer_fee_1: fee1,
    zero_for_one: zeroForOne,
    sqrt_price_x64: pool_state.sqrt_price_x64,
    liquidity: pool_state.liquidity,
    tick: pool_state.tick_current,
    trade_fee_0: onToken0 ? tradeFee : 0n,
    trade_fee_1: onToken0 ? 0n : tradeFee,
  });
  const seedIndex = u16(pool_state.seed_index.get(0n)) | (u16(pool_state.seed_index.get(1n)) << 8n);
  const poolSigner = poolIsIndexed(pool_state)
    ? signer(["pool", pool_state.amm_config, pool_state.token_mint_0, pool_state.token_mint_1, seedIndex, pool_state.bump.get(0n)])
    : signer(["pool", pool_state.amm_config, pool_state.token_mint_0, pool_state.token_mint_1, pool_state.bump.get(0n)]);
  transferIn(payer, input_token_account, input_vault, input_vault_mint, token_program, token_program_2022, zeroForOne ? send0 : send1);
  transferOut(pool_state, output_vault, output_token_account, output_vault_mint, token_program, token_program_2022, zeroForOne ? send1 : send0, poolSigner);

  if (zeroForOne) require(priceBefore >= pool_state.sqrt_price_x64, AnchorError.RequireGteViolated);
  else require(pool_state.sqrt_price_x64 >= priceBefore, AnchorError.RequireGteViolated);
  if (sqrt_price_limit_x64 === 0n) {
    // Without a price limit the whole amount must have been swapped.
    if (is_base_input) require(amount === (zeroForOne ? send0 : send1), AnchorError.RequireEqViolated);
    else require(specified === (zeroForOne ? send1 : send0), AnchorError.RequireEqViolated);
  }
  if (is_base_input) {
    require(output_token_account.amount >= outputBefore, ErrorCode.CalculateOverflow);
    require(output_token_account.amount - outputBefore >= other_amount_threshold, ErrorCode.TooLittleOutputReceived);
  } else {
    require(inputBefore >= input_token_account.amount, ErrorCode.CalculateOverflow);
    require(other_amount_threshold >= inputBefore - input_token_account.amount, ErrorCode.TooMuchInputPaid);
  }
}

/** Pay out protocol fees (`fund`: fund fees) the pool holds, up to the amounts asked for. */
function collectFees(
  pool_state: Mut<PoolState>,
  token_vault_0: Mut<TokenAccount>,
  token_vault_1: Mut<TokenAccount>,
  vault_0_mint: Mint,
  vault_1_mint: Mint,
  recipient_token_account_0: Mut<TokenAccount>,
  recipient_token_account_1: Mut<TokenAccount>,
  token_program: TokenProgram,
  token_program_2022: Token2022Program,
  amount_0_requested: u64,
  amount_1_requested: u64,
  fund: boolean,
  seeds: SignerSeeds,
): void {
  const owed0 = fund ? pool_state.fund_fees_token_0 : pool_state.protocol_fees_token_0;
  const owed1 = fund ? pool_state.fund_fees_token_1 : pool_state.protocol_fees_token_1;
  const amount0 = amount_0_requested < owed0 ? amount_0_requested : owed0;
  const amount1 = amount_1_requested < owed1 ? amount_1_requested : owed1;
  if (fund) {
    pool_state.fund_fees_token_0 = owed0 - amount0;
    pool_state.fund_fees_token_1 = owed1 - amount1;
  } else {
    pool_state.protocol_fees_token_0 = owed0 - amount0;
    pool_state.protocol_fees_token_1 = owed1 - amount1;
  }
  transferOut(pool_state, token_vault_0, recipient_token_account_0, vault_0_mint, token_program, token_program_2022, amount0, seeds);
  transferOut(pool_state, token_vault_1, recipient_token_account_1, vault_1_mint, token_program, token_program_2022, amount1, seeds);
  emit<CollectProtocolFeeEvent>({
    pool_state: pool_state.key,
    recipient_token_account_0: recipient_token_account_0.key,
    recipient_token_account_1: recipient_token_account_1.key,
    amount_0: amount0,
    amount_1: amount1,
  });
}

/** Collect the protocol fees (the config's owner or Raydium's admin). */
export function collectProtocolFee(
  owner: Signer,
  pool_state: Mut<PoolState>,
  amm_config: Account<AmmConfig>,
  token_vault_0: Mut<TokenAccount>,
  token_vault_1: Mut<TokenAccount>,
  vault_0_mint: Mint,
  vault_1_mint: Mint,
  recipient_token_account_0: Mut<TokenAccount>,
  recipient_token_account_1: Mut<TokenAccount>,
  token_program: TokenProgram,
  token_program_2022: Token2022Program,
  amount_0_requested: u64,
  amount_1_requested: u64,
): void {
  constraint(owner, owner.key === amm_config.owner || owner.key === ADMIN, ErrorCode.NotApproved);
  constraint(amm_config, amm_config.key === pool_state.amm_config, AnchorError.ConstraintAddress);
  constraint(token_vault_0, token_vault_0.key === pool_state.token_vault_0);
  constraint(token_vault_1, token_vault_1.key === pool_state.token_vault_1);
  constraint(vault_0_mint, vault_0_mint.key === token_vault_0.mint, AnchorError.ConstraintAddress);
  constraint(vault_1_mint, vault_1_mint.key === token_vault_1.mint, AnchorError.ConstraintAddress);
  const seedIndex = u16(pool_state.seed_index.get(0n)) | (u16(pool_state.seed_index.get(1n)) << 8n);
  const poolSigner = poolIsIndexed(pool_state)
    ? signer(["pool", pool_state.amm_config, pool_state.token_mint_0, pool_state.token_mint_1, seedIndex, pool_state.bump.get(0n)])
    : signer(["pool", pool_state.amm_config, pool_state.token_mint_0, pool_state.token_mint_1, pool_state.bump.get(0n)]);
  collectFees(
    pool_state,
    token_vault_0,
    token_vault_1,
    vault_0_mint,
    vault_1_mint,
    recipient_token_account_0,
    recipient_token_account_1,
    token_program,
    token_program_2022,
    amount_0_requested,
    amount_1_requested,
    false,
    poolSigner,
  );
}

/** Collect the fund fees (the config's fund owner or Raydium's admin). */
export function collectFundFee(
  owner: Signer,
  pool_state: Mut<PoolState>,
  amm_config: Account<AmmConfig>,
  token_vault_0: Mut<TokenAccount>,
  token_vault_1: Mut<TokenAccount>,
  vault_0_mint: Mint,
  vault_1_mint: Mint,
  recipient_token_account_0: Mut<TokenAccount>,
  recipient_token_account_1: Mut<TokenAccount>,
  token_program: TokenProgram,
  token_program_2022: Token2022Program,
  amount_0_requested: u64,
  amount_1_requested: u64,
): void {
  constraint(owner, owner.key === amm_config.fund_owner || owner.key === ADMIN, ErrorCode.NotApproved);
  constraint(amm_config, amm_config.key === pool_state.amm_config, AnchorError.ConstraintAddress);
  constraint(token_vault_0, token_vault_0.key === pool_state.token_vault_0);
  constraint(token_vault_1, token_vault_1.key === pool_state.token_vault_1);
  constraint(vault_0_mint, vault_0_mint.key === token_vault_0.mint, AnchorError.ConstraintAddress);
  constraint(vault_1_mint, vault_1_mint.key === token_vault_1.mint, AnchorError.ConstraintAddress);
  const seedIndex = u16(pool_state.seed_index.get(0n)) | (u16(pool_state.seed_index.get(1n)) << 8n);
  const poolSigner = poolIsIndexed(pool_state)
    ? signer(["pool", pool_state.amm_config, pool_state.token_mint_0, pool_state.token_mint_1, seedIndex, pool_state.bump.get(0n)])
    : signer(["pool", pool_state.amm_config, pool_state.token_mint_0, pool_state.token_mint_1, pool_state.bump.get(0n)]);
  collectFees(
    pool_state,
    token_vault_0,
    token_vault_1,
    vault_0_mint,
    vault_1_mint,
    recipient_token_account_0,
    recipient_token_account_1,
    token_program,
    token_program_2022,
    amount_0_requested,
    amount_1_requested,
    true,
    poolSigner,
  );
}


// ---- admin --------------------------------------------------------------------------------------------------------

const SUPPORT_MINT_OWNER = pubkey("RayVyjyJQz9vAi126A4sGexKnSU1XeZaHTRcM1mZMPY");
const COLLECT_LAMPORTS_WALLET = pubkey("Ray9LdYRLXsHzL8pr3Ceahfiz8MsS2pZagzHo1ckdfJ");
const MAX_FEE_RATE: u32 = 1_000_000n;

/** Change a fee tier (admin only): 0 trade fee, 1 protocol fee, 2 fund fee, 3 owner, 4 fund owner (the first remaining account). */
export function updateAmmConfig(
  owner: Address<Signer, "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ", ErrorCode.NotApproved>,
  amm_config: Mut<AmmConfig>,
  param: u8,
  value: u32,
): void {
  const rest = remainingAccounts();
  if (param === 0n) {
    require(MAX_FEE_RATE > value, AnchorError.RequireGtViolated);
    amm_config.trade_fee_rate = value;
  } else if (param === 1n) {
    require(MAX_FEE_RATE >= value, AnchorError.RequireGteViolated);
    require(MAX_FEE_RATE >= value + amm_config.fund_fee_rate, AnchorError.RequireGteViolated);
    amm_config.protocol_fee_rate = value;
  } else if (param === 2n) {
    require(MAX_FEE_RATE >= value, AnchorError.RequireGteViolated);
    require(MAX_FEE_RATE >= value + amm_config.protocol_fee_rate, AnchorError.RequireGteViolated);
    amm_config.fund_fee_rate = value;
  } else if (param === 3n) {
    require(rest.length > 0n, ErrorCode.AccountLack);
    amm_config.owner = rest.get(0n).key;
  } else if (param === 4n) {
    require(rest.length > 0n, ErrorCode.AccountLack);
    amm_config.fund_owner = rest.get(0n).key;
  } else require(false, ErrorCode.InvalidUpdateConfigFlag);
  emit<ConfigChangeEvent>({
    index: amm_config.index,
    owner: amm_config.owner,
    trade_fee_rate: amm_config.trade_fee_rate,
    protocol_fee_rate: amm_config.protocol_fee_rate,
    tick_spacing: amm_config.tick_spacing,
    fund_fee_rate: amm_config.fund_fee_rate,
    fund_owner: amm_config.fund_owner,
  });
}

/** Set a pool's status bits (admin only): 1 open/increase off, 2 decrease off, 4 collect fees off, 8 collect rewards off, 16 swaps off, 32 limit orders off. */
export function updatePoolStatus(authority: Address<Signer, "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ">, pool_state: Mut<PoolState>, status: u8): void {
  pool_state.status = status;
}

/** Create the account listing operators and reward mints (admin only). */
export function createOperationAccount(
  owner: Address<Mut<Signer>, "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ", ErrorCode.NotApproved>,
  operation_state: Init<OperationState>,
  system_program: SystemProgram,
): void {
  operation_state.bump = operation_state.create(owner, ["operation"]);
}

/**
 * Change the operators or reward mints (admin only): 0 add operators, 1 remove operators, 2 add reward mints,
 * 3 remove reward mints. Operators are kept sorted; reward mints in the order added (the original keeps them in a
 * hash set's order; only membership is ever read).
 */
export function updateOperationAccount(
  owner: Address<Signer, "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ", ErrorCode.NotApproved>,
  operation_state: Seeds<Mut<OperationState>, ["operation"]>,
  system_program: SystemProgram,
  param: u8,
  keys: Vec<Pubkey>,
): void {
  require(param <= 3n, ErrorCode.InvalidUpdateConfigFlag);
  if (param === 0n || param === 2n) {
    // Add: the listed keys and the new ones, without the empty key or repeats.
    const owners = param === 0n;
    const size = owners ? 10n : 100n;
    const merged = fixedArray<Pubkey, 100>(NO_KEY);
    let n = 0n;
    for (let i = 0n; i < size + keys.length; i++) {
      const k = i < size ? (owners ? operation_state.operation_owners.get(i) : operation_state.whitelist_mints.get(i)) : keys.get(i - size);
      if (k === NO_KEY) continue;
      let seen = false;
      for (let j = 0n; j < n && !seen; j++) if (merged.get(j) === k) seen = true;
      if (seen) continue;
      // More than fit: the original's copy_from_slice panics.
      require(n < size, ErrorCode.CalculateOverflow);
      merged.set(n, k);
      n++;
    }
    if (owners)
      // Sorted, as the original sorts them.
      for (let i = 1n; i < n; i++)
        for (let j = i; j > 0n && merged.get(j - 1n).compare(merged.get(j)) > 0n; j--) {
          const t = merged.get(j);
          merged.set(j, merged.get(j - 1n));
          merged.set(j - 1n, t);
        }
    for (let i = 0n; i < size; i++) {
      const k = i < n ? merged.get(i) : NO_KEY;
      if (owners) operation_state.operation_owners.set(i, k);
      else operation_state.whitelist_mints.set(i, k);
    }
  } else {
    // Remove: the others stay in order, empty slots included, then the list is padded with empty keys.
    const owners = param === 1n;
    const size = owners ? 10n : 100n;
    let n = 0n;
    for (let i = 0n; i < size; i++) {
      const k = owners ? operation_state.operation_owners.get(i) : operation_state.whitelist_mints.get(i);
      if (keys.includes(k)) continue;
      if (owners) operation_state.operation_owners.set(n, k);
      else operation_state.whitelist_mints.set(n, k);
      n++;
    }
    for (let i = n; i < size; i++) {
      if (owners) operation_state.operation_owners.set(i, NO_KEY);
      else operation_state.whitelist_mints.set(i, NO_KEY);
    }
  }
}

/** DynamicFeeInfo::validate_params. */
function validDynamicFee(spacing: u16, filter: u16, decay: u16, reduction: u16, control: u32, maxVolatility: u32): boolean {
  if (filter === 0n) return false;
  if (decay === 0n || decay <= filter) return false;
  if (reduction === 0n || reduction >= 10_000n) return false;
  if (control === 0n || control >= 100_000n) return false;
  return u64(maxVolatility) * u64(spacing) <= 4294967295n;
}

/** Create a dynamic fee setting customizable pools may take (admin only). */
export function createDynamicFeeConfig(
  owner: Address<Mut<Signer>, "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ", ErrorCode.NotApproved>,
  dynamic_fee_config: Init<DynamicFeeConfig>,
  system_program: SystemProgram,
  index: u16,
  filter_period: u16,
  decay_period: u16,
  reduction_factor: u16,
  dynamic_fee_control: u32,
  max_volatility_accumulator: u32,
): void {
  dynamic_fee_config.create(owner, ["dynamic_fee_config", bigEndian(index)]);
  dynamic_fee_config.index = index;
  require(validDynamicFee(MAX_TICK_SPACING, filter_period, decay_period, reduction_factor, dynamic_fee_control, max_volatility_accumulator), ErrorCode.InvalidDynamicFeeConfigParams);
  dynamic_fee_config.filter_period = filter_period;
  dynamic_fee_config.decay_period = decay_period;
  dynamic_fee_config.reduction_factor = reduction_factor;
  dynamic_fee_config.dynamic_fee_control = dynamic_fee_control;
  dynamic_fee_config.max_volatility_accumulator = max_volatility_accumulator;
}

/** Change a dynamic fee setting (admin only). */
export function updateDynamicFeeConfig(
  owner: Address<Signer, "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ", ErrorCode.NotApproved>,
  dynamic_fee_config: Mut<DynamicFeeConfig>,
  filter_period: u16,
  decay_period: u16,
  reduction_factor: u16,
  dynamic_fee_control: u32,
  max_volatility_accumulator: u32,
): void {
  require(validDynamicFee(MAX_TICK_SPACING, filter_period, decay_period, reduction_factor, dynamic_fee_control, max_volatility_accumulator), ErrorCode.InvalidDynamicFeeConfigParams);
  dynamic_fee_config.filter_period = filter_period;
  dynamic_fee_config.decay_period = decay_period;
  dynamic_fee_config.reduction_factor = reduction_factor;
  dynamic_fee_config.dynamic_fee_control = dynamic_fee_control;
  dynamic_fee_config.max_volatility_accumulator = max_volatility_accumulator;
}

/** Allow a Token-2022 mint in pools whatever its extensions (Raydium's admin or mint operator). */
export function createSupportMintAssociated(
  owner: Mut<Signer>,
  token_mint: Mint,
  support_mint_associated: Init<SupportMintAssociated>,
  system_program: SystemProgram,
): void {
  // Anchor creates the account (its seeds checked) before it checks the signer and the mint's owner.
  support_mint_associated.bump = support_mint_associated.create(owner, ["support_mint", token_mint.key]);
  require(owner.key === ADMIN || owner.key === SUPPORT_MINT_OWNER, ErrorCode.NotApproved);
  require(token_mint.tokenProgram === SPL_TOKEN_2022, ErrorCode.NotApproved);
  support_mint_associated.mint = token_mint.key;
}

/** Withdraw that allowance (the same signers); the account's rent goes to the signer. */
export function closeSupportMintAssociated(
  owner: Mut<Signer>,
  token_mint: Owner<Mint, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", ErrorCode.NotApproved>,
  support_mint_associated: Seeds<CloseTo<Mut<SupportMintAssociated>, "owner">, ["support_mint", "@token_mint"]>,
): void {
  constraint(owner, owner.key === ADMIN || owner.key === SUPPORT_MINT_OWNER, ErrorCode.NotApproved);
}

/** Give a pool and its reward streams a new owner (admin only). */
export function transferRewardOwner(
  authority: Address<Signer, "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ", ErrorCode.NotApproved>,
  pool_state: Mut<PoolState>,
  new_owner: Pubkey,
): void {
  for (let i = 0n; i < 3n; i++) pool_state.reward_infos.get(i).authority = new_owner;
  pool_state.owner = new_owner;
}

/** Close a ProtocolPositionState left from earlier versions (admin only). */
export function closeProtocolPosition(
  admin: Address<Mut<Signer>, "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ", ErrorCode.NotApproved>,
  protocol_position: CloseTo<Mut<ProtocolPositionState>, "admin">,
): void {}

/** Whether these token account bytes unpack as an initialized (possibly Token-2022) token account, and if so its fields. */
function tokenAccountUnpacks(dataLen: u64, state: u8, accountType: u8): boolean {
  if (dataLen < 165n || state === 0n) return false;
  return dataLen === 165n || (dataLen !== 355n && accountType === 2n);
}

/**
 * Send lamports above rent to Raydium's lamport wallet (or the admin): from token accounts and mints the pool owns
 * (the token programs' WithdrawExcessLamports, or SyncNative + UnwrapLamports for wrapped SOL), from the pool, and from
 * the other accounts of this program passed.
 */
export function collectExcessLamports(
  collect_lamports_wallet: Mut<Signer>,
  pool_state: Mut<PoolState>,
  token_program: TokenProgram,
  token_program_2022: Token2022Program,
): void {
  constraint(collect_lamports_wallet, collect_lamports_wallet.key === COLLECT_LAMPORTS_WALLET || collect_lamports_wallet.key === ADMIN, ErrorCode.NotApproved);
  const seedIndex = u16(pool_state.seed_index.get(0n)) | (u16(pool_state.seed_index.get(1n)) << 8n);
  const poolSigner = poolIsIndexed(pool_state)
    ? signer(["pool", pool_state.amm_config, pool_state.token_mint_0, pool_state.token_mint_1, seedIndex, pool_state.bump.get(0n)])
    : signer(["pool", pool_state.amm_config, pool_state.token_mint_0, pool_state.token_mint_1, pool_state.bump.get(0n)]);
  const rest = remainingAccounts();
  for (let i = 0n; i < rest.length; i++) {
    const source = rest.get(i);
    const t22 = source.owner === SPL_TOKEN_2022;
    if (source.owner !== SPL_TOKEN && !t22) continue;
    // token_account_native_and_amount
    const unpacks = tokenAccountUnpacks(source.dataLen, source.dataLen > 108n ? readData<u8>(source, 108n) : 0n, source.dataLen > 165n ? readData<u8>(source, 165n) : 0n);
    const native = unpacks && readData<u32>(source, 109n) === 1n;
    if (!native) {
      // WithdrawExcessLamports
      if (t22) invoke(token_program_2022, [writable(source), writable(collect_lamports_wallet), readonlySigner(pool_state)], [u8(38n)], poolSigner);
      else invoke(token_program, [writable(source), writable(collect_lamports_wallet), readonlySigner(pool_state)], [u8(38n)], poolSigner);
      continue;
    }
    const before = readData<u64>(source, 64n);
    // SyncNative folds the extra lamports into the wrapped amount; UnwrapLamports sends that much out.
    if (t22) invoke(token_program_2022, [writable(source)], [u8(17n)]);
    else invoke(token_program, [writable(source)], [u8(17n)]);
    const after = readData<u64>(source, 64n);
    require(after >= before, ErrorCode.LamportsCalculateError);
    const excess = after - before;
    if (excess === 0n) continue;
    if (t22) invoke(token_program_2022, [writable(source), writable(collect_lamports_wallet), readonlySigner(pool_state)], [u8(45n), u8(1n), excess], poolSigner);
    else invoke(token_program, [writable(source), writable(collect_lamports_wallet), readonlySigner(pool_state)], [u8(45n), u8(1n), excess], poolSigner);
    require(readData<u64>(source, 64n) === before, ErrorCode.LamportsCalculateError);
  }
  // withdraw_excess_lamports_from_pda: the pool, then this program's accounts passed.
  const poolExcess = pool_state.lamports - rentExempt(pool_state.dataLen);
  if (poolExcess > 0n) {
    pool_state.lamports -= poolExcess;
    collect_lamports_wallet.lamports += poolExcess;
  }
  for (let i = 0n; i < rest.length; i++) {
    const source = rest.get(i);
    if (source.owner !== programId()) continue;
    const excess = source.lamports - rentExempt(source.dataLen);
    if (excess === 0n) continue;
    source.lamports -= excess;
    collect_lamports_wallet.lamports += excess;
  }
}

// ---- customizable pools ------------------------------------------------------------------------------------------

/** PoolState::initialize and what follows it in create_customizable_pool: fee mode, seed index, dynamic fee. */
function initCustomizablePool(
  pool: Mut<PoolState>,
  bump: u8,
  creator: Pubkey,
  amm_config: Account<AmmConfig>,
  token_mint_0: Mint,
  token_mint_1: Mint,
  vault0: Pubkey,
  vault1: Pubkey,
  observation: Pubkey,
  sqrt_price_x64: u128,
  tick: i32,
  fee_on: u8,
  seed_index: u16,
): void {
  pool.bump.set(0n, bump);
  pool.amm_config = amm_config.key;
  pool.owner = creator;
  pool.token_mint_0 = token_mint_0.key;
  pool.token_mint_1 = token_mint_1.key;
  pool.mint_decimals_0 = token_mint_0.decimals;
  pool.mint_decimals_1 = token_mint_1.decimals;
  pool.token_vault_0 = vault0;
  pool.token_vault_1 = vault1;
  pool.tick_spacing = amm_config.tick_spacing;
  pool.sqrt_price_x64 = sqrt_price_x64;
  pool.tick_current = tick;
  for (let i = 0n; i < 3n; i++) pool.reward_infos.get(i).authority = creator;
  pool.fee_on = fee_on;
  pool.open_time = 0n;
  pool.recent_epoch = currentEpoch();
  pool.observation_key = observation;
  pool.seed_index.set(0n, u8(seed_index & 0xffn));
  pool.seed_index.set(1n, u8(seed_index >> 8n));
}

/** PoolState::initialize_dynamic_fee_info from a DynamicFeeConfig (the last remaining account). */
function initDynamicFee(pool: Mut<PoolState>, config: Account<DynamicFeeConfig>, tick: i32): void {
  require(
    validDynamicFee(pool.tick_spacing, config.filter_period, config.decay_period, config.reduction_factor, config.dynamic_fee_control, config.max_volatility_accumulator),
    ErrorCode.InvalidDynamicFeeConfigParams,
  );
  const f = pool.dynamic_fee_info;
  f.filter_period = config.filter_period;
  f.decay_period = config.decay_period;
  f.reduction_factor = config.reduction_factor;
  f.dynamic_fee_control = config.dynamic_fee_control;
  f.max_volatility_accumulator = config.max_volatility_accumulator;
  f.tick_spacing_index_reference = tickSpacingIndex(tick, pool.tick_spacing);
}

/**
 * Create a pool choosing where the fee is taken and whether it has a dynamic fee (its DynamicFeeConfig the last
 * remaining account); it opens at once.
 */
export function createCustomizablePool(
  pool_creator: Mut<Signer>,
  amm_config: Account<AmmConfig>,
  pool_state: Init<PoolState>,
  token_mint_0: MintOf<Mint, never, never, "token_program_0">,
  token_mint_1: MintOf<Mint, never, never, "token_program_1">,
  token_vault_0: Seeds<Mut<AccountInfo>, ["pool_vault", "@pool_state", "@token_mint_0"]>,
  token_vault_1: Seeds<Mut<AccountInfo>, ["pool_vault", "@pool_state", "@token_mint_1"]>,
  observation_state: Init<ObservationState>,
  tick_array_bitmap: Init<TickArrayBitmapExtension>,
  token_program_0: TokenInterface,
  token_program_1: TokenInterface,
  system_program: SystemProgram,
  rent: Address<AccountInfo, "SysvarRent111111111111111111111111111111111">,
  customizable_params: CreateCustomizableParams,
): void {
  constraint(token_mint_0, token_mint_0.key.compare(token_mint_1.key) < 0n);
  const bump = pool_state.create(pool_creator, ["pool", amm_config.key, token_mint_0.key, token_mint_1.key]);
  observation_state.create(pool_creator, ["observation", pool_state.key]);
  tick_array_bitmap.create(pool_creator, ["pool_tick_array_bitmap_extension", pool_state.key]);
  const rest = remainingAccounts();
  let associated0 = false;
  let associated1 = false;
  if (rest.length > 0n) {
    const expected0 = findProgramAddress(["support_mint", token_mint_0.key], programId());
    const expected1 = findProgramAddress(["support_mint", token_mint_1.key], programId());
    for (let i = 0n; i < rest.length && !associated0; i++) {
      const info = rest.get(i);
      if (info.owner === programId() && info.key === expected0) {
        const associated = loadAccount<SupportMintAssociated>(info);
        if (associated.mint === token_mint_0.key) associated0 = true;
      }
    }
    for (let i = 0n; i < rest.length && !associated1; i++) {
      const info = rest.get(i);
      if (info.owner === programId() && info.key === expected1) {
        const associated = loadAccount<SupportMintAssociated>(info);
        if (associated.mint === token_mint_1.key) associated1 = true;
      }
    }
  }
  require(supportedMint(token_mint_0, associated0) && supportedMint(token_mint_1, associated1), ErrorCode.NotSupportMint);
  const sqrt = customizable_params.sqrt_price_x64;
  const tick = getTickAtSqrtPrice(sqrt);
  createTokenVault(pool_creator, pool_state, token_vault_0, token_mint_0, system_program, token_program_0, token_vault_0.pdaBump, "pool_vault");
  createTokenVault(pool_creator, pool_state, token_vault_1, token_mint_1, system_program, token_program_1, token_vault_1.pdaBump, "pool_vault");
  observation_state.recent_epoch = currentEpoch();
  observation_state.pool_id = pool_state.key;
  initCustomizablePool(
    pool_state,
    bump,
    pool_creator.key,
    amm_config,
    token_mint_0,
    token_mint_1,
    token_vault_0.key,
    token_vault_1.key,
    observation_state.key,
    sqrt,
    tick,
    customizable_params.collect_fee_on === CollectFeeOn.Token0Only ? 1n : customizable_params.collect_fee_on === CollectFeeOn.Token1Only ? 2n : 0n,
    0n,
  );
  if (customizable_params.enable_dynamic_fee) {
    require(rest.length > 0n, ErrorCode.AccountLack);
    const config = loadAccount<DynamicFeeConfig>(rest.get(rest.length - 1n));
    initDynamicFee(pool_state, config, tick);
  }
  tick_array_bitmap.pool_id = pool_state.key;
  emit<PoolCreatedEvent>({
    token_mint_0: token_mint_0.key,
    token_mint_1: token_mint_1.key,
    tick_spacing: amm_config.tick_spacing,
    pool_state: pool_state.key,
    sqrt_price_x64: sqrt,
    tick,
    token_vault_0: token_vault_0.key,
    token_vault_1: token_vault_1.key,
  });
}

/** create_customizable_pool with a seed index (several pools of one pair and fee tier), a payer and a separate creator. */
export function createCustomizablePoolV2(
  payer: Mut<Signer>,
  pool_creator: AccountInfo,
  amm_config: Account<AmmConfig>,
  pool_state: Init<PoolState>,
  token_mint_0: MintOf<Mint, never, never, "token_program_0">,
  token_mint_1: MintOf<Mint, never, never, "token_program_1">,
  token_vault_0: Seeds<Mut<AccountInfo>, ["pool_vault", "@pool_state", "@token_mint_0"]>,
  token_vault_1: Seeds<Mut<AccountInfo>, ["pool_vault", "@pool_state", "@token_mint_1"]>,
  observation_state: Init<ObservationState>,
  tick_array_bitmap: Init<TickArrayBitmapExtension>,
  token_program_0: TokenInterface,
  token_program_1: TokenInterface,
  system_program: SystemProgram,
  rent: Address<AccountInfo, "SysvarRent111111111111111111111111111111111">,
  customizable_params: CreateCustomizableParams,
  seed_index: u16,
): void {
  constraint(token_mint_0, token_mint_0.key.compare(token_mint_1.key) < 0n);
  const bump = pool_state.create(payer, ["pool", amm_config.key, token_mint_0.key, token_mint_1.key, seed_index]);
  observation_state.create(payer, ["observation", pool_state.key]);
  tick_array_bitmap.create(payer, ["pool_tick_array_bitmap_extension", pool_state.key]);
  require(seed_index > 0n, AnchorError.RequireGtViolated);
  const rest = remainingAccounts();
  let associated0 = false;
  let associated1 = false;
  if (rest.length > 0n) {
    const expected0 = findProgramAddress(["support_mint", token_mint_0.key], programId());
    const expected1 = findProgramAddress(["support_mint", token_mint_1.key], programId());
    for (let i = 0n; i < rest.length && !associated0; i++) {
      const info = rest.get(i);
      if (info.owner === programId() && info.key === expected0) {
        const associated = loadAccount<SupportMintAssociated>(info);
        if (associated.mint === token_mint_0.key) associated0 = true;
      }
    }
    for (let i = 0n; i < rest.length && !associated1; i++) {
      const info = rest.get(i);
      if (info.owner === programId() && info.key === expected1) {
        const associated = loadAccount<SupportMintAssociated>(info);
        if (associated.mint === token_mint_1.key) associated1 = true;
      }
    }
  }
  require(supportedMint(token_mint_0, associated0) && supportedMint(token_mint_1, associated1), ErrorCode.NotSupportMint);
  const sqrt = customizable_params.sqrt_price_x64;
  const tick = getTickAtSqrtPrice(sqrt);
  createTokenVault(payer, pool_state, token_vault_0, token_mint_0, system_program, token_program_0, token_vault_0.pdaBump, "pool_vault");
  createTokenVault(payer, pool_state, token_vault_1, token_mint_1, system_program, token_program_1, token_vault_1.pdaBump, "pool_vault");
  observation_state.recent_epoch = currentEpoch();
  observation_state.pool_id = pool_state.key;
  initCustomizablePool(
    pool_state,
    bump,
    pool_creator.key,
    amm_config,
    token_mint_0,
    token_mint_1,
    token_vault_0.key,
    token_vault_1.key,
    observation_state.key,
    sqrt,
    tick,
    customizable_params.collect_fee_on === CollectFeeOn.Token0Only ? 1n : customizable_params.collect_fee_on === CollectFeeOn.Token1Only ? 2n : 0n,
    seed_index,
  );
  if (customizable_params.enable_dynamic_fee) {
    require(rest.length > 0n, ErrorCode.AccountLack);
    const config = loadAccount<DynamicFeeConfig>(rest.get(rest.length - 1n));
    initDynamicFee(pool_state, config, tick);
  }
  tick_array_bitmap.pool_id = pool_state.key;
  emit<PoolCreatedEvent>({
    token_mint_0: token_mint_0.key,
    token_mint_1: token_mint_1.key,
    tick_spacing: amm_config.tick_spacing,
    pool_state: pool_state.key,
    sqrt_price_x64: sqrt,
    tick,
    token_vault_0: token_vault_0.key,
    token_vault_1: token_vault_1.key,
  });
}

// ---- rewards -------------------------------------------------------------------------------------------------------

/** reward_period_limit (mainnet): a stream runs 7 to 90 days; lowering emissions needs less than 72 hours left. */
const MIN_REWARD_PERIOD: u64 = 604_800n;
const MAX_REWARD_PERIOD: u64 = 7_776_000n;
const INCREASE_EMISSIONS_PERIOD: u64 = 259_200n;

/** OperationState::validate_operation_owner. */
function isOperator(operation: Account<OperationState>, key: Pubkey): boolean {
  return key !== NO_KEY && operation.operation_owners.includes(key);
}

/** ceil(seconds * emissions / 2^64), truncated to 64 bits as U128::as_u64 does (CalculateOverflow past u128). */
function rewardAmount(seconds: u64, emissionsX64: u128): u64 {
  const r = (u256(seconds) * u256(emissionsX64) + u256(Q64) - 1n) / u256(Q64);
  require(r <= u256(340282366920938463463374607431768211455n), ErrorCode.CalculateOverflow);
  return u64(r & u256(18446744073709551615n));
}

/** PoolState::initialize_reward: the next free reward slot, under the original's rules for which mints may go where. */
function addReward(
  pool: Mut<PoolState>,
  operation: Account<OperationState>,
  openTime: u64,
  endTime: u64,
  emissionsX64: u128,
  mint: Mint,
  vault: Pubkey,
  authority: Pubkey,
): void {
  let lowest = 3n;
  for (let i = 0n; i < 3n && lowest === 3n; i++) if (pool.reward_infos.get(i).token_mint === NO_KEY) lowest = i;
  require(lowest < 3n, ErrorCode.FullRewardInfo);
  let used0 = false;
  let used1 = false;
  for (let i = 0n; i < 3n; i++) {
    const m = pool.reward_infos.get(i).token_mint;
    require(m !== mint.key, ErrorCode.RewardTokenAlreadyInUse);
    if (m === pool.token_mint_0) used0 = true;
    if (m === pool.token_mint_1) used1 = true;
  }
  const listed = mint.key === pool.token_mint_0 || mint.key === pool.token_mint_1 || operation.whitelist_mints.includes(mint.key);
  if (lowest === 0n) {
    // The first: an outside mint must have no freeze authority.
    if (!listed) require(mint.freezeAuthority === null, ErrorCode.ExceptRewardMint);
  } else if (lowest === 1n) {
    // The second: one of the pool's tokens (or a listed mint) unless the first was.
    if (!used0 && !used1) require(listed, ErrorCode.ExceptRewardMint);
    else if (!listed) require(mint.freezeAuthority === null, ErrorCode.ExceptRewardMint);
  } else require(authority === ADMIN || isOperator(operation, authority), ErrorCode.NotApproved);
  const r = pool.reward_infos.get(lowest);
  r.last_update_time = openTime;
  r.open_time = openTime;
  r.end_time = endTime;
  r.emissions_per_second_x64 = emissionsX64;
  r.token_mint = mint.key;
  r.token_vault = vault;
  r.authority = authority;
  pool.recent_epoch = currentEpoch();
}

/** Start a reward stream: its vault is created and funded for the whole period now. */
export function initializeReward(
  reward_funder: Mut<Signer>,
  funder_token_account: Mut<TokenAccount>,
  amm_config: Account<AmmConfig>,
  pool_state: Mut<PoolState>,
  operation_state: Seeds<Account<OperationState>, ["operation"]>,
  reward_token_mint: Mint,
  reward_token_vault: Seeds<Mut<AccountInfo>, ["pool_reward_vault", "@pool_state", "@reward_token_mint"]>,
  reward_token_program: TokenInterface,
  system_program: SystemProgram,
  rent: Address<AccountInfo, "SysvarRent111111111111111111111111111111111">,
  param: InitializeRewardParam,
): void {
  constraint(funder_token_account, funder_token_account.mint === reward_token_mint.key, AnchorError.ConstraintTokenMint);
  constraint(amm_config, amm_config.key === pool_state.amm_config, AnchorError.ConstraintAddress);
  const rest = remainingAccounts();
  let associated = false;
  if (rest.length > 0n) {
    const expected = findProgramAddress(["support_mint", reward_token_mint.key], programId());
    for (let i = 0n; i < rest.length && !associated; i++) {
      const info = rest.get(i);
      if (info.owner === programId() && info.key === expected) {
        const a = loadAccount<SupportMintAssociated>(info);
        if (a.mint === reward_token_mint.key) associated = true;
      }
    }
  }
  require(supportedMint(reward_token_mint, associated), ErrorCode.NotSupportMint);
  createTokenVault(reward_funder, pool_state, reward_token_vault, reward_token_mint, system_program, reward_token_program, reward_token_vault.pdaBump, "pool_reward_vault");
  require(
    reward_funder.key === ADMIN || reward_funder.key === pool_state.owner || isOperator(operation_state, reward_funder.key),
    ErrorCode.NotApproved,
  );
  const timestamp = now();
  log(`current block timestamp:${timestamp}`);
  const current = u64(timestamp);
  // InitializeRewardParam::check
  require(
    param.open_time < param.end_time && param.open_time >= current && param.end_time >= current && param.emissions_per_second_x64 !== 0n,
    ErrorCode.InvalidRewardInitParam,
  );
  const period = param.end_time - param.open_time;
  require(period >= MIN_REWARD_PERIOD && period <= MAX_REWARD_PERIOD, ErrorCode.InvalidRewardPeriod);
  const amount = rewardAmount(period, param.emissions_per_second_x64);
  const fee = inverseTransferFee(reward_token_mint, amount);
  require(amount <= 18446744073709551615n - fee, ErrorCode.CalculateOverflow);
  require(funder_token_account.amount >= amount + fee, AnchorError.RequireGteViolated);
  require(6148914691236517205n > amount, AnchorError.RequireGtViolated);
  addReward(pool_state, operation_state, param.open_time, param.end_time, param.emissions_per_second_x64, reward_token_mint, reward_token_vault.key, reward_funder.key);
  // transfer_from_user_to_pool_vault into the vault just made.
  if (amount + fee > 0n)
    invoke(reward_token_program, [writable(funder_token_account), readonly(reward_token_mint), writable(reward_token_vault), readonlySigner(reward_funder)], [u8(12n), amount + fee, reward_token_mint.decimals]);
}

/** Bring the pool's reward streams up to now. */
export function updateRewardInfos(pool_state: Mut<PoolState>): void {
  const timestamp = now();
  require(timestamp >= 0n, ErrorCode.CalculateOverflow);
  accrueRewards(pool_state, u64(timestamp));
  const growths = fixedArray<u128, 3>(0n);
  for (let i = 0n; i < 3n; i++) growths.set(i, pool_state.reward_infos.get(i).reward_growth_global_x64);
  emit<UpdateRewardInfosEvent>({ reward_growth_global_x64: growths });
}

/** After a stream ends, its funder takes back what nobody earned. */
export function collectRemainingRewards(
  reward_funder: Signer,
  funder_token_account: Mut<TokenAccount>,
  pool_state: Mut<PoolState>,
  reward_token_vault: Mut<TokenAccount>,
  reward_vault_mint: Mint,
  token_program: TokenProgram,
  token_program_2022: Token2022Program,
  memo_program: MemoProgram,
  reward_index: u8,
): void {
  constraint(reward_vault_mint, reward_vault_mint.key === reward_token_vault.mint, AnchorError.ConstraintAddress);
  const timestamp = now();
  require(timestamp >= 0n, ErrorCode.CalculateOverflow);
  accrueRewards(pool_state, u64(timestamp));
  const r = pool_state.reward_infos.get(reward_index);
  require(r.token_mint !== NO_KEY, ErrorCode.UnInitializedRewardInfo);
  require(r.last_update_time === r.end_time, ErrorCode.NotApproved);
  require(reward_funder.key === r.authority, AnchorError.RequireKeysEqViolated);
  require(reward_token_vault.key === r.token_vault, AnchorError.RequireKeysEqViolated);
  require(r.reward_total_emitted >= r.reward_claimed, ErrorCode.CalculateOverflow);
  const unclaimed = r.reward_total_emitted - r.reward_claimed;
  require(reward_token_vault.amount >= unclaimed, ErrorCode.CalculateOverflow);
  const seedIndex = u16(pool_state.seed_index.get(0n)) | (u16(pool_state.seed_index.get(1n)) << 8n);
  const poolSigner = poolIsIndexed(pool_state)
    ? signer(["pool", pool_state.amm_config, pool_state.token_mint_0, pool_state.token_mint_1, seedIndex, pool_state.bump.get(0n)])
    : signer(["pool", pool_state.amm_config, pool_state.token_mint_0, pool_state.token_mint_1, pool_state.bump.get(0n)]);
  transferOut(pool_state, reward_token_vault, funder_token_account, reward_vault_mint, token_program, token_program_2022, reward_token_vault.amount - unclaimed, poolSigner);
}

/**
 * Change a reward stream's emissions or period. The admin and operators restart it or change it freely; its own
 * authority only while it runs (extending it 7 to 90 days, lowering emissions only in its last 72 hours). The reward
 * that adds comes from the authority: reward vault, the authority's token account and the reward mint, as remaining
 * accounts.
 */
export function setRewardParams(
  authority: Signer,
  amm_config: Account<AmmConfig>,
  pool_state: Mut<PoolState>,
  operation_state: Seeds<Account<OperationState>, ["operation"]>,
  token_program: TokenProgram,
  token_program_2022: Token2022Program,
  reward_index: u8,
  emissions_per_second_x64: u128,
  open_time: u64,
  end_time: u64,
): void {
  constraint(amm_config, amm_config.key === pool_state.amm_config, AnchorError.ConstraintAddress);
  constraint(pool_state, pool_state.amm_config === amm_config.key);
  require(reward_index < 3n, ErrorCode.InvalidRewardIndex);
  require(end_time > open_time, AnchorError.RequireGtViolated);
  require(emissions_per_second_x64 > 0n, AnchorError.RequireGtViolated);
  require(authority.key !== NO_KEY, AnchorError.RequireKeysNeqViolated);
  const operator = operation_state.operation_owners.includes(authority.key) || authority.key === ADMIN;
  const timestamp = now();
  require(timestamp >= 0n, ErrorCode.CalculateOverflow);
  const current = u64(timestamp);
  require(open_time > current, AnchorError.RequireGtViolated);
  if (!operator) require(authority.key === pool_state.reward_infos.get(reward_index).authority, AnchorError.RequireKeysEqViolated);
  accrueRewards(pool_state, current);
  const r = pool_state.reward_infos.get(reward_index);
  require(r.token_mint !== NO_KEY, ErrorCode.UnInitializedRewardInfo);
  let amount: u64 = 0n;
  if (operator && (r.last_update_time === r.end_time || r.open_time > current)) {
    // admin_update, a stream ended or not started: a new period.
    require(end_time !== open_time, ErrorCode.InvalidRewardPeriod);
    amount = rewardAmount(end_time - open_time, emissions_per_second_x64);
    r.open_time = open_time;
    r.last_update_time = open_time;
    r.end_time = end_time;
    r.emissions_per_second_x64 = emissions_per_second_x64;
  } else if (operator) {
    // admin_update, a running stream: the emissions added for the time left, and any extension.
    require(r.end_time >= current, ErrorCode.CalculateOverflow);
    const left = r.end_time - current;
    const extend = end_time > r.end_time ? end_time - r.end_time : 0n;
    const diff = emissions_per_second_x64 > r.emissions_per_second_x64 ? emissions_per_second_x64 - r.emissions_per_second_x64 : 0n;
    amount = rewardAmount(left, diff);
    r.emissions_per_second_x64 = emissions_per_second_x64;
    const more = rewardAmount(extend, r.emissions_per_second_x64);
    require(amount <= 18446744073709551615n - more, ErrorCode.CalculateOverflow);
    amount += more;
    r.end_time = end_time;
  } else {
    require(current > r.open_time, ErrorCode.NotApproved);
    if (r.last_update_time === r.end_time) {
      // normal_update, a stream that ended: a new period within the limits.
      require(end_time >= open_time, ErrorCode.CalculateOverflow);
      const period = end_time - open_time;
      require(period >= MIN_REWARD_PERIOD && period <= MAX_REWARD_PERIOD, ErrorCode.InvalidRewardPeriod);
      amount = rewardAmount(period, emissions_per_second_x64);
      r.open_time = open_time;
      r.last_update_time = open_time;
      r.end_time = end_time;
      r.emissions_per_second_x64 = emissions_per_second_x64;
    } else {
      // normal_update, a running stream: extend it 7 to 90 days; lower emissions only near its end.
      require(r.end_time >= current, ErrorCode.CalculateOverflow);
      const left = r.end_time - current;
      require(end_time >= r.end_time, ErrorCode.CalculateOverflow);
      const extend = end_time - r.end_time;
      require(extend >= MIN_REWARD_PERIOD && extend <= MAX_REWARD_PERIOD, ErrorCode.NotApproveUpdateRewardEmissions);
      if (emissions_per_second_x64 < r.emissions_per_second_x64) require(INCREASE_EMISSIONS_PERIOD > left, AnchorError.RequireGtViolated);
      const diff = emissions_per_second_x64 > r.emissions_per_second_x64 ? emissions_per_second_x64 - r.emissions_per_second_x64 : 0n;
      amount = rewardAmount(left, diff);
      r.emissions_per_second_x64 = emissions_per_second_x64;
      if (extend > 0n) {
        const more = rewardAmount(extend, r.emissions_per_second_x64);
        require(amount <= 18446744073709551615n - more, ErrorCode.CalculateOverflow);
        amount += more;
        r.end_time = end_time;
      }
    }
  }
  require(6148914691236517205n > amount, AnchorError.RequireGtViolated);
  require(r.reward_total_emitted <= 18446744073709551615n - amount, ErrorCode.MaxTokenOverflow);
  if (amount > 0n) {
    const rest = remainingAccounts();
    require(rest.length >= 3n, ErrorCode.AccountLack);
    const vault = rest.get(0n);
    const from = rest.get(1n);
    const mint = rest.get(2n);
    // InterfaceAccount<TokenAccount> / <Mint>
    require(vault.owner === SPL_TOKEN || vault.owner === SPL_TOKEN_2022, AnchorError.AccountOwnedByWrongProgram);
    require(vault.dataLen >= 165n, AnchorError.AccountDidNotDeserialize);
    require(from.owner === SPL_TOKEN || from.owner === SPL_TOKEN_2022, AnchorError.AccountOwnedByWrongProgram);
    require(from.dataLen >= 165n, AnchorError.AccountDidNotDeserialize);
    require(mint.owner === SPL_TOKEN || mint.owner === SPL_TOKEN_2022, AnchorError.AccountOwnedByWrongProgram);
    require(mint.dataLen >= 82n, AnchorError.AccountDidNotDeserialize);
    require(readData<Pubkey>(vault, 0n) === readData<Pubkey>(from, 0n), AnchorError.RequireKeysEqViolated);
    require(vault.key === r.token_vault, AnchorError.RequireKeysEqViolated);
    const fee = transferFeeInverse(mint, amount);
    require(amount <= 18446744073709551615n - fee, ErrorCode.CalculateOverflow);
    require(transferFee(mint, amount + fee) === fee, ErrorCode.TransferFeeCalculateNotMatch);
    const decimals = readData<u8>(mint, 44n);
    if (from.owner === SPL_TOKEN_2022)
      invoke(token_program_2022, [writable(from), readonly(mint), writable(vault), readonlySigner(authority)], [u8(12n), amount + fee, decimals]);
    else invoke(token_program, [writable(from), readonly(mint), writable(vault), readonlySigner(authority)], [u8(12n), amount + fee, decimals]);
  }
}


/** finishAddLiquidity for the v1 instructions: no transfer fees, plain SPL Token transfers. */
function finishAddLiquidityLegacy(
  payer: Signer,
  token_account_0: Mut<TokenAccount>,
  token_account_1: Mut<TokenAccount>,
  token_vault_0: Mut<TokenAccount>,
  token_vault_1: Mut<TokenAccount>,
  token_program: TokenProgram,
  pool: Account<PoolState>,
  change: LiquidityChange,
  amount_0_max: u64,
  amount_1_max: u64,
  tick_lower: i32,
  tick_upper: i32,
): TransferFees {
  require(change.amount_0 > 0n || change.amount_1 > 0n, ErrorCode.ForbidBothZeroForSupplyLiquidity);
  emit<LiquidityCalculateEvent>({
    pool_liquidity: change.liquidity_before,
    pool_sqrt_price_x64: pool.sqrt_price_x64,
    pool_tick: pool.tick_current,
    calc_amount_0: change.amount_0,
    calc_amount_1: change.amount_1,
    trade_fee_owed_0: 0n,
    trade_fee_owed_1: 0n,
    transfer_fee_0: 0n,
    transfer_fee_1: 0n,
  });
  require(amount_0_max >= change.amount_0, ErrorCode.PriceSlippageCheck);
  require(amount_1_max >= change.amount_1, ErrorCode.PriceSlippageCheck);
  if (change.amount_0 > 0n) token_program.transfer(token_account_0, token_vault_0, payer, change.amount_0);
  if (change.amount_1 > 0n) token_program.transfer(token_account_1, token_vault_1, payer, change.amount_1);
  emit<LiquidityChangeEvent>({
    pool_state: pool.key,
    tick: pool.tick_current,
    tick_lower,
    tick_upper,
    liquidity_before: change.liquidity_before,
    liquidity_after: pool.liquidity,
  });
  return { fee_0: 0n, fee_1: 0n };
}


/** Open a position as a Metaplex NFT (SPL Token, metadata always), adding `liquidity` between two ticks. */
export function openPosition(
  payer: Mut<Signer>,
  position_nft_owner: AccountInfo,
  position_nft_mint: Init<Mint>,
  position_nft_account: Ata<Init<TokenAccount>, "position_nft_owner", "position_nft_mint">,
  metadata_account: Mut<AccountInfo>,
  pool_state: Mut<PoolState>,
  protocol_position: AccountInfo,
  tick_array_lower: Seeds<Mut<AccountInfo>, ["tick_array", "@pool_state", "@tick_array_lower_start_index:be"]>,
  tick_array_upper: Dup<Seeds<Mut<AccountInfo>, ["tick_array", "@pool_state", "@tick_array_upper_start_index:be"]>>,
  personal_position: Init<PersonalPositionState>,
  token_account_0: Mut<TokenAccount>,
  token_account_1: Mut<TokenAccount>,
  token_vault_0: Mut<TokenAccount>,
  token_vault_1: Mut<TokenAccount>,
  rent: Address<AccountInfo, "SysvarRent111111111111111111111111111111111">,
  system_program: SystemProgram,
  token_program: TokenProgram,
  associated_token_program: AssociatedTokenProgram,
  metadata_program: TokenMetadataProgram,
  tick_lower_index: i32,
  tick_upper_index: i32,
  tick_array_lower_start_index: i32,
  tick_array_upper_start_index: i32,
  liquidity: u128,
  amount_0_max: u64,
  amount_1_max: u64,
): void {
  // Account<TokenAccount> of anchor_spl::token: SPL Token accounts only.
  constraint(token_account_0, token_account_0.tokenProgram === SPL_TOKEN, AnchorError.AccountOwnedByWrongProgram);
  constraint(token_account_1, token_account_1.tokenProgram === SPL_TOKEN, AnchorError.AccountOwnedByWrongProgram);
  constraint(token_vault_0, token_vault_0.tokenProgram === SPL_TOKEN, AnchorError.AccountOwnedByWrongProgram);
  constraint(token_vault_1, token_vault_1.tokenProgram === SPL_TOKEN, AnchorError.AccountOwnedByWrongProgram);
  constraint(token_account_0, token_account_0.mint === token_vault_0.mint, AnchorError.ConstraintTokenMint);
  constraint(token_account_1, token_account_1.mint === token_vault_1.mint, AnchorError.ConstraintTokenMint);
  constraint(token_vault_0, token_vault_0.key === pool_state.token_vault_0);
  constraint(token_vault_1, token_vault_1.key === pool_state.token_vault_1);
  // Anchor's init accounts: the NFT mint (the pool its mint and freeze authority), its associated account, the position.
  position_nft_mint.create(payer, null, 0n, pool_state.key, pool_state.key, token_program);
  position_nft_account.create(payer, token_program);
  const positionBump = personal_position.create(payer, ["position", position_nft_mint.key]);
  require(!token_account_0.isFrozen && !token_account_1.isFrozen, ErrorCode.NotApproved);

  // open_position
  require((pool_state.status & 1n) === 0n, ErrorCode.NotApproved);
  require(tick_lower_index < tick_upper_index, ErrorCode.TickInvalidOrder);
  const spacing = pool_state.tick_spacing;
  checkTickArrayStartIndex(tick_array_lower_start_index, tick_lower_index, spacing);
  checkTickArrayStartIndex(tick_array_upper_start_index, tick_upper_index, spacing);
  require(isValidStartIndex(tick_array_lower_start_index, spacing), ErrorCode.InvalidTickIndex);
  if (tick_array_lower.owner === SYSTEM)
    createTickArray(payer, tick_array_lower, pool_state, system_program, tick_array_lower_start_index, tick_array_lower.pdaBump);
  if (tick_array_lower_start_index !== tick_array_upper_start_index) {
    require(isValidStartIndex(tick_array_upper_start_index, spacing), ErrorCode.InvalidTickIndex);
    if (tick_array_upper.owner === SYSTEM)
      createTickArray(payer, tick_array_upper, pool_state, system_program, tick_array_upper_start_index, tick_array_upper.pdaBump);
  }
  const lower = loadAccountMut<TickArrayState>(tick_array_lower);
  const upper = loadAccountMut<TickArrayState>(tick_array_upper);
  const useExtension = overflowsDefaultBitmap(tick_array_lower_start_index, spacing) || overflowsDefaultBitmap(tick_array_upper_start_index, spacing);
  const rest = remainingAccounts();
  if (useExtension) require(rest.get(0n).key === extensionKey(pool_state), AnchorError.RequireKeysEqViolated);

  const change = addLiquidityToTicks(pool_state, lower, upper, liquidity, liquidity === 0n, tick_lower_index, tick_upper_index, u64(now()));
  let fee0: u64 = 0n;
  let fee1: u64 = 0n;
  if (!change.skipped) {
    const extLower = change.flip_lower && overflowsDefaultBitmap(lower.start_tick_index, spacing);
    const extUpper = change.flip_upper && overflowsDefaultBitmap(upper.start_tick_index, spacing);
    if (change.flip_lower && !extLower) flipBitDefault(pool_state, lower.start_tick_index);
    if (change.flip_upper && !extUpper) flipBitDefault(pool_state, upper.start_tick_index);
    if (extLower || extUpper) {
      const ext = loadAccountMut<TickArrayBitmapExtension>(rest.get(0n));
      if (extLower) flipBitExtension(ext, lower.start_tick_index, spacing);
      if (extUpper) flipBitExtension(ext, upper.start_tick_index, spacing);
    }
    const fees = finishAddLiquidityLegacy(
      payer,
      token_account_0,
      token_account_1,
      token_vault_0,
      token_vault_1,
      token_program,
      pool_state,
      change,
      amount_0_max,
      amount_1_max,
      tick_lower_index,
      tick_upper_index,
    );
    fee0 = fees.fee_0;
    fee1 = fees.fee_1;
  }

  initPosition(personal_position, positionBump, position_nft_mint.key, pool_state.key, tick_lower_index, tick_upper_index, change);
  emit<CreatePersonalPositionEvent>({
    pool_state: pool_state.key,
    minter: payer.key,
    nft_owner: position_nft_owner.key,
    tick_lower_index,
    tick_upper_index,
    liquidity: change.liquidity,
    deposit_amount_0: change.amount_0,
    deposit_amount_1: change.amount_1,
    deposit_amount_0_transfer_fee: fee0,
    deposit_amount_1_transfer_fee: fee1,
  });

  // mint_nft_and_remove_mint_authority, a Metaplex NFT: the metadata (the pool the verified creator), the token, no more minting.
  const seedIndex = u16(pool_state.seed_index.get(0n)) | (u16(pool_state.seed_index.get(1n)) << 8n);
  const poolSigner = poolIsIndexed(pool_state)
    ? signer(["pool", pool_state.amm_config, pool_state.token_mint_0, pool_state.token_mint_1, seedIndex, pool_state.bump.get(0n)])
    : signer(["pool", pool_state.amm_config, pool_state.token_mint_0, pool_state.token_mint_1, pool_state.bump.get(0n)]);
  if (true) {
    const uri = `https://dynamic-ipfs.raydium.io/clmm/position?id=${personal_position.key}`;
    metadata_program.createV3(
      metadata_account,
      position_nft_mint,
      pool_state,
      payer,
      pool_state,
      system_program,
      "Raydium Concentrated Liquidity",
      "RCL",
      uri,
      0n,
      false,
      { creators: [{ address: pool_state.key, verified: true, share: 100n }] },
      poolSigner,
    );
  }
  token_program.mintTo(position_nft_mint, position_nft_account, pool_state, 1n, poolSigner);
  token_program.setAuthority(position_nft_mint, pool_state, AuthorityType.MintTokens, null, poolSigner);
}


/** open_position with Token-2022 pool tokens and a choice of metadata: the NFT is still a Metaplex one (SPL Token). */
export function openPositionV2(
  payer: Mut<Signer>,
  position_nft_owner: AccountInfo,
  position_nft_mint: Init<Mint>,
  position_nft_account: Ata<Init<TokenAccount>, "position_nft_owner", "position_nft_mint">,
  metadata_account: Mut<AccountInfo>,
  pool_state: Mut<PoolState>,
  protocol_position: AccountInfo,
  tick_array_lower: Seeds<Mut<AccountInfo>, ["tick_array", "@pool_state", "@tick_array_lower_start_index:be"]>,
  tick_array_upper: Dup<Seeds<Mut<AccountInfo>, ["tick_array", "@pool_state", "@tick_array_upper_start_index:be"]>>,
  personal_position: Init<PersonalPositionState>,
  token_account_0: Mut<TokenAccount>,
  token_account_1: Mut<TokenAccount>,
  token_vault_0: Mut<TokenAccount>,
  token_vault_1: Mut<TokenAccount>,
  rent: Address<AccountInfo, "SysvarRent111111111111111111111111111111111">,
  system_program: SystemProgram,
  token_program: TokenProgram,
  associated_token_program: AssociatedTokenProgram,
  metadata_program: TokenMetadataProgram,
  token_program_2022: Token2022Program,
  vault_0_mint: Mint,
  vault_1_mint: Mint,
  tick_lower_index: i32,
  tick_upper_index: i32,
  tick_array_lower_start_index: i32,
  tick_array_upper_start_index: i32,
  liquidity: u128,
  amount_0_max: u64,
  amount_1_max: u64,
  with_metadata: boolean,
  base_flag: Option<boolean>,
): void {
  constraint(token_account_0, token_account_0.mint === token_vault_0.mint, AnchorError.ConstraintTokenMint);
  constraint(token_account_1, token_account_1.mint === token_vault_1.mint, AnchorError.ConstraintTokenMint);
  constraint(token_vault_0, token_vault_0.key === pool_state.token_vault_0);
  constraint(token_vault_1, token_vault_1.key === pool_state.token_vault_1);
  constraint(vault_0_mint, vault_0_mint.key === token_vault_0.mint, AnchorError.ConstraintAddress);
  constraint(vault_1_mint, vault_1_mint.key === token_vault_1.mint, AnchorError.ConstraintAddress);
  // Anchor's init accounts: the NFT mint (the pool its mint and freeze authority), its associated account, the position.
  position_nft_mint.create(payer, null, 0n, pool_state.key, pool_state.key, token_program);
  position_nft_account.create(payer, token_program);
  const positionBump = personal_position.create(payer, ["position", position_nft_mint.key]);
  require(!token_account_0.isFrozen && !token_account_1.isFrozen, ErrorCode.NotApproved);

  // open_position
  const frozen = restrictedMint(vault_0_mint) || restrictedMint(vault_1_mint);
  require((pool_state.status & 1n) === 0n, ErrorCode.NotApproved);
  require(tick_lower_index < tick_upper_index, ErrorCode.TickInvalidOrder);
  const spacing = pool_state.tick_spacing;
  checkTickArrayStartIndex(tick_array_lower_start_index, tick_lower_index, spacing);
  checkTickArrayStartIndex(tick_array_upper_start_index, tick_upper_index, spacing);
  require(isValidStartIndex(tick_array_lower_start_index, spacing), ErrorCode.InvalidTickIndex);
  if (tick_array_lower.owner === SYSTEM)
    createTickArray(payer, tick_array_lower, pool_state, system_program, tick_array_lower_start_index, tick_array_lower.pdaBump);
  if (tick_array_lower_start_index !== tick_array_upper_start_index) {
    require(isValidStartIndex(tick_array_upper_start_index, spacing), ErrorCode.InvalidTickIndex);
    if (tick_array_upper.owner === SYSTEM)
      createTickArray(payer, tick_array_upper, pool_state, system_program, tick_array_upper_start_index, tick_array_upper.pdaBump);
  }
  const lower = loadAccountMut<TickArrayState>(tick_array_lower);
  const upper = loadAccountMut<TickArrayState>(tick_array_upper);
  const useExtension = overflowsDefaultBitmap(tick_array_lower_start_index, spacing) || overflowsDefaultBitmap(tick_array_upper_start_index, spacing);
  const rest = remainingAccounts();
  if (useExtension) require(rest.get(0n).key === extensionKey(pool_state), AnchorError.RequireKeysEqViolated);

  const resolved =
    liquidity === 0n && base_flag !== null
      ? liquidityFromOneAmount(pool_state, vault_0_mint, vault_1_mint, base_flag, amount_0_max, amount_1_max, tick_lower_index, tick_upper_index)
      : liquidity;
  const change = addLiquidityToTicks(pool_state, lower, upper, resolved, liquidity === 0n && base_flag === null, tick_lower_index, tick_upper_index, u64(now()));
  let fee0: u64 = 0n;
  let fee1: u64 = 0n;
  if (!change.skipped) {
    const extLower = change.flip_lower && overflowsDefaultBitmap(lower.start_tick_index, spacing);
    const extUpper = change.flip_upper && overflowsDefaultBitmap(upper.start_tick_index, spacing);
    if (change.flip_lower && !extLower) flipBitDefault(pool_state, lower.start_tick_index);
    if (change.flip_upper && !extUpper) flipBitDefault(pool_state, upper.start_tick_index);
    if (extLower || extUpper) {
      const ext = loadAccountMut<TickArrayBitmapExtension>(rest.get(0n));
      if (extLower) flipBitExtension(ext, lower.start_tick_index, spacing);
      if (extUpper) flipBitExtension(ext, upper.start_tick_index, spacing);
    }
    const fees = finishAddLiquidity(
      payer,
      token_account_0,
      token_account_1,
      token_vault_0,
      token_vault_1,
      vault_0_mint,
      vault_1_mint,
      token_program,
      token_program_2022,
      pool_state,
      change,
      amount_0_max,
      amount_1_max,
      tick_lower_index,
      tick_upper_index,
    );
    fee0 = fees.fee_0;
    fee1 = fees.fee_1;
  }

  initPosition(personal_position, positionBump, position_nft_mint.key, pool_state.key, tick_lower_index, tick_upper_index, change);
  emit<CreatePersonalPositionEvent>({
    pool_state: pool_state.key,
    minter: payer.key,
    nft_owner: position_nft_owner.key,
    tick_lower_index,
    tick_upper_index,
    liquidity: change.liquidity,
    deposit_amount_0: change.amount_0,
    deposit_amount_1: change.amount_1,
    deposit_amount_0_transfer_fee: fee0,
    deposit_amount_1_transfer_fee: fee1,
  });

  // mint_nft_and_remove_mint_authority, a Metaplex NFT: the metadata (the pool the verified creator), the token, no more minting.
  const seedIndex = u16(pool_state.seed_index.get(0n)) | (u16(pool_state.seed_index.get(1n)) << 8n);
  const poolSigner = poolIsIndexed(pool_state)
    ? signer(["pool", pool_state.amm_config, pool_state.token_mint_0, pool_state.token_mint_1, seedIndex, pool_state.bump.get(0n)])
    : signer(["pool", pool_state.amm_config, pool_state.token_mint_0, pool_state.token_mint_1, pool_state.bump.get(0n)]);
  if (with_metadata) {
    const uri = `https://dynamic-ipfs.raydium.io/clmm/position?id=${personal_position.key}`;
    metadata_program.createV3(
      metadata_account,
      position_nft_mint,
      pool_state,
      payer,
      pool_state,
      system_program,
      "Raydium Concentrated Liquidity",
      "RCL",
      uri,
      0n,
      false,
      { creators: [{ address: pool_state.key, verified: true, share: 100n }] },
      poolSigner,
    );
  }
  token_program.mintTo(position_nft_mint, position_nft_account, pool_state, 1n, poolSigner);
  if (frozen) token_program.freezeAccount(position_nft_account, position_nft_mint, pool_state, poolSigner);
  token_program.setAuthority(position_nft_mint, pool_state, AuthorityType.MintTokens, null, poolSigner);
}

/** increase_liquidity_v2 for SPL Token pools (no transfer fees, no base_flag). */
export function increaseLiquidity(
  nft_owner: Signer,
  nft_account: TokenAccount,
  pool_state: Mut<PoolState>,
  protocol_position: AccountInfo,
  personal_position: Mut<PersonalPositionState>,
  tick_array_lower: Mut<TickArrayState>,
  tick_array_upper: Dup<Mut<TickArrayState>>,
  token_account_0: Mut<TokenAccount>,
  token_account_1: Mut<TokenAccount>,
  token_vault_0: Mut<TokenAccount>,
  token_vault_1: Mut<TokenAccount>,
  token_program: TokenProgram,
  liquidity: u128,
  amount_0_max: u64,
  amount_1_max: u64,
): void {
  constraint(nft_account, nft_account.mint === personal_position.nft_mint);
  constraint(nft_account, nft_account.amount === 1n);
  constraint(nft_account, nft_account.owner === nft_owner.key, AnchorError.ConstraintTokenOwner);
  constraint(personal_position, personal_position.pool_id === pool_state.key);
  constraint(tick_array_lower, tick_array_lower.pool_id === pool_state.key);
  constraint(tick_array_upper, tick_array_upper.pool_id === pool_state.key);
  constraint(token_account_0, token_account_0.mint === token_vault_0.mint, AnchorError.ConstraintTokenMint);
  constraint(token_account_1, token_account_1.mint === token_vault_1.mint, AnchorError.ConstraintTokenMint);
  constraint(token_vault_0, token_vault_0.key === pool_state.token_vault_0);
  constraint(token_vault_1, token_vault_1.key === pool_state.token_vault_1);
  constraint(nft_account, nft_account.tokenProgram === SPL_TOKEN, AnchorError.AccountOwnedByWrongProgram);
  constraint(token_account_0, token_account_0.tokenProgram === SPL_TOKEN, AnchorError.AccountOwnedByWrongProgram);
  constraint(token_account_1, token_account_1.tokenProgram === SPL_TOKEN, AnchorError.AccountOwnedByWrongProgram);
  constraint(token_vault_0, token_vault_0.tokenProgram === SPL_TOKEN, AnchorError.AccountOwnedByWrongProgram);
  constraint(token_vault_1, token_vault_1.tokenProgram === SPL_TOKEN, AnchorError.AccountOwnedByWrongProgram);
  // lib.rs
  require(liquidity > 0n, AnchorError.RequireGtViolated);

  require((pool_state.status & 1n) === 0n, ErrorCode.NotApproved);
  const tickLower = personal_position.tick_lower_index;
  const tickUpper = personal_position.tick_upper_index;
  const spacing = pool_state.tick_spacing;
  const useExtension = overflowsDefaultBitmap(tickLower, spacing) || overflowsDefaultBitmap(tickUpper, spacing);
  const rest = remainingAccounts();
  if (useExtension) require(rest.get(0n).key === extensionKey(pool_state), AnchorError.RequireKeysEqViolated);

  const change = addLiquidityToTicks(pool_state, tick_array_lower, tick_array_upper, liquidity, false, tickLower, tickUpper, u64(now()));
  let fee0: u64 = 0n;
  let fee1: u64 = 0n;
  if (!change.skipped) {
    const extLower = change.flip_lower && overflowsDefaultBitmap(tick_array_lower.start_tick_index, spacing);
    const extUpper = change.flip_upper && overflowsDefaultBitmap(tick_array_upper.start_tick_index, spacing);
    if (change.flip_lower && !extLower) flipBitDefault(pool_state, tick_array_lower.start_tick_index);
    if (change.flip_upper && !extUpper) flipBitDefault(pool_state, tick_array_upper.start_tick_index);
    if (extLower || extUpper) {
      const ext = loadAccountMut<TickArrayBitmapExtension>(rest.get(0n));
      if (extLower) flipBitExtension(ext, tick_array_lower.start_tick_index, spacing);
      if (extUpper) flipBitExtension(ext, tick_array_upper.start_tick_index, spacing);
    }
    const fees = finishAddLiquidityLegacy(
      nft_owner,
      token_account_0,
      token_account_1,
      token_vault_0,
      token_vault_1,
      token_program,
      pool_state,
      change,
      amount_0_max,
      amount_1_max,
      tickLower,
      tickUpper,
    );
    fee0 = fees.fee_0;
    fee1 = fees.fee_1;
  }
  updatePosition(personal_position, change, true);
  emit<IncreaseLiquidityEvent>({
    position_nft_mint: personal_position.nft_mint,
    liquidity: change.liquidity,
    amount_0: change.amount_0,
    amount_1: change.amount_1,
    amount_0_transfer_fee: fee0,
    amount_1_transfer_fee: fee1,
  });
}

/**
 * decrease_liquidity_v2 for SPL Token pools: no transfer fees; per reward set up, the reward vault and the
 * recipient's token account (no mint) as remaining accounts.
 */
export function decreaseLiquidity(
  nft_owner: Signer,
  nft_account: TokenAccount,
  personal_position: Mut<PersonalPositionState>,
  pool_state: Mut<PoolState>,
  protocol_position: AccountInfo,
  token_vault_0: Mut<TokenAccount>,
  token_vault_1: Mut<TokenAccount>,
  tick_array_lower: Mut<TickArrayState>,
  tick_array_upper: Dup<Mut<TickArrayState>>,
  recipient_token_account_0: Mut<TokenAccount>,
  recipient_token_account_1: Mut<TokenAccount>,
  token_program: TokenProgram,
  liquidity: u128,
  amount_0_min: u64,
  amount_1_min: u64,
): void {
  constraint(nft_account, nft_account.mint === personal_position.nft_mint);
  constraint(nft_account, nft_account.amount === 1n);
  constraint(nft_account, nft_account.owner === nft_owner.key, AnchorError.ConstraintTokenOwner);
  constraint(personal_position, personal_position.pool_id === pool_state.key);
  constraint(token_vault_0, token_vault_0.key === pool_state.token_vault_0);
  constraint(token_vault_1, token_vault_1.key === pool_state.token_vault_1);
  constraint(tick_array_lower, tick_array_lower.pool_id === pool_state.key);
  constraint(tick_array_upper, tick_array_upper.pool_id === pool_state.key);
  constraint(recipient_token_account_0, recipient_token_account_0.mint === token_vault_0.mint, AnchorError.ConstraintTokenMint);
  constraint(recipient_token_account_1, recipient_token_account_1.mint === token_vault_1.mint, AnchorError.ConstraintTokenMint);
  constraint(nft_account, nft_account.tokenProgram === SPL_TOKEN, AnchorError.AccountOwnedByWrongProgram);
  constraint(token_vault_0, token_vault_0.tokenProgram === SPL_TOKEN, AnchorError.AccountOwnedByWrongProgram);
  constraint(token_vault_1, token_vault_1.tokenProgram === SPL_TOKEN, AnchorError.AccountOwnedByWrongProgram);
  constraint(recipient_token_account_0, recipient_token_account_0.tokenProgram === SPL_TOKEN, AnchorError.AccountOwnedByWrongProgram);
  constraint(recipient_token_account_1, recipient_token_account_1.tokenProgram === SPL_TOKEN, AnchorError.AccountOwnedByWrongProgram);

  require(personal_position.liquidity >= liquidity, AnchorError.RequireGteViolated);
  // Status bits 1, 2, 3: decrease liquidity, collect fees, collect rewards. Any of them lets this through.
  require((pool_state.status & 14n) !== 14n, ErrorCode.NotApproved);
  const liquidityBefore = pool_state.liquidity;
  const sqrtPrice = pool_state.sqrt_price_x64;
  const tickCurrent = pool_state.tick_current;
  const spacing = pool_state.tick_spacing;
  const useExtension = overflowsDefaultBitmap(tick_array_lower.start_tick_index, spacing) || overflowsDefaultBitmap(tick_array_upper.start_tick_index, spacing);
  // The bitmap extension, wherever it is among the remaining accounts; the others are the reward accounts.
  const rest = remainingAccounts();
  const extKey = extensionKey(pool_state);
  let extAt = rest.length;
  for (let i = 0n; i < rest.length; i++) if (rest.get(i).key === extKey) extAt = i;
  require(!useExtension || extAt < rest.length, ErrorCode.MissingTickArrayBitmapExtensionAccount);

  // decrease_liquidity_and_update_position
  let decrease0: u64 = 0n;
  let decrease1: u64 = 0n;
  if ((pool_state.status & 2n) === 0n) {
    const change = burnLiquidityFromTicks(
      pool_state,
      tick_array_lower,
      tick_array_upper,
      personal_position.tick_lower_index,
      personal_position.tick_upper_index,
      liquidity,
      u64(now()),
    );
    const extLower = change.flip_lower && overflowsDefaultBitmap(tick_array_lower.start_tick_index, spacing);
    const extUpper = change.flip_upper && overflowsDefaultBitmap(tick_array_upper.start_tick_index, spacing);
    if (change.flip_lower && !extLower) flipBitDefault(pool_state, tick_array_lower.start_tick_index);
    if (change.flip_upper && !extUpper) flipBitDefault(pool_state, tick_array_upper.start_tick_index);
    if (extLower || extUpper) {
      const ext = loadAccountMut<TickArrayBitmapExtension>(rest.get(extAt));
      if (extLower) flipBitExtension(ext, tick_array_lower.start_tick_index, spacing);
      if (extUpper) flipBitExtension(ext, tick_array_upper.start_tick_index, spacing);
    }
    emit<LiquidityChangeEvent>({
      pool_state: pool_state.key,
      tick: pool_state.tick_current,
      tick_lower: personal_position.tick_lower_index,
      tick_upper: personal_position.tick_upper_index,
      liquidity_before: change.liquidity_before,
      liquidity_after: pool_state.liquidity,
    });
    updatePosition(personal_position, change, false);
    decrease0 = change.amount_0;
    decrease1 = change.amount_1;
  }
  let fees0: u64 = 0n;
  let fees1: u64 = 0n;
  if ((pool_state.status & 4n) === 0n) {
    fees0 = personal_position.token_fees_owed_0;
    fees1 = personal_position.token_fees_owed_1;
    personal_position.token_fees_owed_0 = 0n;
    personal_position.token_fees_owed_1 = 0n;
  }

  const transferFee0: u64 = 0n;
  const transferFee1: u64 = 0n;
  emit<LiquidityCalculateEvent>({
    pool_liquidity: liquidityBefore,
    pool_sqrt_price_x64: sqrtPrice,
    pool_tick: tickCurrent,
    calc_amount_0: decrease0,
    calc_amount_1: decrease1,
    trade_fee_owed_0: fees0,
    trade_fee_owed_1: fees1,
    transfer_fee_0: transferFee0,
    transfer_fee_1: transferFee1,
  });
  if (liquidity > 0n) {
    require(decrease0 - transferFee0 >= amount_0_min, ErrorCode.PriceSlippageCheck);
    require(decrease1 - transferFee1 >= amount_1_min, ErrorCode.PriceSlippageCheck);
  }
  const seedIndex = u16(pool_state.seed_index.get(0n)) | (u16(pool_state.seed_index.get(1n)) << 8n);
  const poolSigner = poolIsIndexed(pool_state)
    ? signer(["pool", pool_state.amm_config, pool_state.token_mint_0, pool_state.token_mint_1, seedIndex, pool_state.bump.get(0n)])
    : signer(["pool", pool_state.amm_config, pool_state.token_mint_0, pool_state.token_mint_1, pool_state.bump.get(0n)]);
  if (decrease0 + fees0 > 0n) token_program.transfer(token_vault_0, recipient_token_account_0, pool_state, decrease0 + fees0, poolSigner);
  if (decrease1 + fees1 > 0n) token_program.transfer(token_vault_1, recipient_token_account_1, pool_state, decrease1 + fees1, poolSigner);

  // collect_rewards: groups of (reward vault, recipient, reward mint), one per reward set up.
  const rewards = fixedArray<u64, 3>(0n);
  if ((pool_state.status & 8n) === 0n) {
    let valid = 0n;
    for (let i = 0n; i < 3n; i++) if (pool_state.reward_infos.get(i).token_mint !== SYSTEM) valid += 1n;
    const count = extAt < rest.length ? rest.length - 1n : rest.length;
    require(count === valid * 2n, ErrorCode.InvalidRewardInputAccountNumber);
    for (let i = 0n; i < count / 2n; i++) {
      // The i-th group among the accounts other than the extension.
      const at = 2n * i;
      const v = at < extAt ? at : at + 1n;
      const r = at + 1n < extAt ? at + 1n : at + 2n;
      const vault = rest.get(v);
      const recipient = rest.get(r);
      // InterfaceAccount<TokenAccount> / <Mint>: owned by a token program and holding one.
      require(vault.owner === SPL_TOKEN || vault.owner === SPL_TOKEN_2022, AnchorError.AccountOwnedByWrongProgram);
      require(vault.dataLen >= 165n, AnchorError.AccountDidNotDeserialize);
      require(recipient.owner === SPL_TOKEN || recipient.owner === SPL_TOKEN_2022, AnchorError.AccountOwnedByWrongProgram);
      require(recipient.dataLen >= 165n, AnchorError.AccountDidNotDeserialize);
      require(readData<Pubkey>(vault, 0n) === readData<Pubkey>(recipient, 0n), AnchorError.RequireKeysEqViolated);
      const info = pool_state.reward_infos.get(i);
      require(vault.key === info.token_vault, AnchorError.RequireKeysEqViolated);
      const owed = personal_position.reward_infos.get(i).reward_amount_owed;
      if (owed === 0n) continue;
      // check_unclaimed_reward
      require(info.reward_total_emitted >= info.reward_claimed, ErrorCode.CalculateOverflow);
      require(info.reward_total_emitted - info.reward_claimed >= owed, AnchorError.RequireGteViolated);
      const balance = readData<u64>(vault, 64n);
      const amount = owed > balance ? balance : owed;
      if (amount > 0n) {
        log(`collect reward index: ${i}, transfer_amount: ${amount}, reward_amount_owed:${owed} `);
        personal_position.reward_infos.get(i).reward_amount_owed = owed - amount;
        require(info.reward_claimed <= 18446744073709551615n - amount, ErrorCode.CalculateOverflow);
        info.reward_claimed += amount;
        // token::transfer under the SPL Token program, whatever owns the vault.
        invoke(token_program, [writable(vault), writable(recipient), readonlySigner(pool_state)], [u8(3n), amount], poolSigner);
      }
      rewards.set(i, amount);
    }
  }
  emit<DecreaseLiquidityEvent>({
    position_nft_mint: personal_position.nft_mint,
    liquidity,
    decrease_amount_0: decrease0,
    decrease_amount_1: decrease1,
    fee_amount_0: fees0,
    fee_amount_1: fees1,
    reward_amounts: rewards,
    transfer_fee_0: transferFee0,
    transfer_fee_1: transferFee1,
  });
}



/**
 * Close an empty position (no liquidity, fees or rewards owed): the NFT burned, its account and (Token-2022) its mint
 * closed, the position's rent to the owner. A frozen NFT account (a restricted-asset pool) is thawed by the pool, the
 * first remaining account.
 */
export function closePosition(
  nft_owner: Mut<Signer>,
  position_nft_mint: Mut<Mint>,
  position_nft_account: Mut<TokenAccount>,
  personal_position: Seeds<CloseTo<Mut<PersonalPositionState>, "nft_owner">, ["position", "@position_nft_mint"]>,
  system_program: SystemProgram,
  token_program: TokenInterface,
): void {
  constraint(position_nft_mint, position_nft_mint.key === personal_position.nft_mint, AnchorError.ConstraintAddress);
  constraint(position_nft_mint, position_nft_mint.tokenProgram === token_program.key, AnchorError.ConstraintMintTokenProgram);
  constraint(position_nft_account, position_nft_account.amount === 1n);
  constraint(position_nft_account, position_nft_account.mint === position_nft_mint.key, AnchorError.ConstraintTokenMint);
  constraint(position_nft_account, position_nft_account.owner === nft_owner.key, AnchorError.ConstraintTokenOwner);
  constraint(position_nft_account, position_nft_account.tokenProgram === token_program.key, AnchorError.ConstraintTokenTokenProgram);
  if (personal_position.liquidity !== 0n || personal_position.token_fees_owed_0 !== 0n || personal_position.token_fees_owed_1 !== 0n) {
    log(`remaing liquidity:${personal_position.liquidity},token_fees_owed_0:${personal_position.token_fees_owed_0},token_fees_owed_1:${personal_position.token_fees_owed_1}`);
    require(false, ErrorCode.ClosePositionErr);
  }
  for (let i = 0n; i < 3n; i++) {
    const owed = personal_position.reward_infos.get(i).reward_amount_owed;
    if (owed !== 0n) {
      log(`remaing reward index:${i},amount:${owed}`);
      require(false, ErrorCode.ClosePositionErr);
    }
  }
  if (position_nft_account.isFrozen) {
    const rest = remainingAccounts();
    require(rest.length > 0n, ErrorCode.AccountLack);
    const info = rest.get(0n);
    require(info.key === personal_position.pool_id, ErrorCode.NotApproved);
    const pool = loadAccount<PoolState>(info);
    const seedIndex = u16(pool.seed_index.get(0n)) | (u16(pool.seed_index.get(1n)) << 8n);
    const poolSigner = poolIsIndexed(pool)
      ? signer(["pool", pool.amm_config, pool.token_mint_0, pool.token_mint_1, seedIndex, pool.bump.get(0n)])
      : signer(["pool", pool.amm_config, pool.token_mint_0, pool.token_mint_1, pool.bump.get(0n)]);
    // ThawAccount, the pool the freeze authority.
    invoke(token_program, [writable(position_nft_account), readonly(position_nft_mint), readonlySigner(info)], [u8(11n)], poolSigner);
  }
  token_program.burn(position_nft_account, position_nft_mint, nft_owner, 1n);
  token_program.closeAccount(position_nft_account, nft_owner, nft_owner);
  // A Token-2022 NFT's mint closes too; the position is its close authority.
  if (position_nft_mint.tokenProgram === SPL_TOKEN_2022)
    token_program.closeAccount(position_nft_mint, nft_owner, personal_position, ["position", position_nft_mint.key, personal_position.bump.get(0n)]);
}

// ---- limit orders --------------------------------------------------------------------------------------------------

const LIMIT_ORDER_ADMIN = pubkey("Ray8HHtixhL9zvnokMyELCVGp622PDPJj96zcVC9RWp");

/** The pool's bit for a tick array whose first used tick appeared or whose last went: in its bitmap or the extension (the first remaining account). */
function flipForOrder(pool: Mut<PoolState>, start: i32, extensionPassed: boolean): boolean {
  if (!overflowsDefaultBitmap(start, pool.tick_spacing)) {
    flipBitDefault(pool, start);
    return false;
  }
  require(extensionPassed, ErrorCode.AccountLack);
  return true;
}

/**
 * Place a limit order on a tick past the price: `amount` of the input token waits there for a swap that crosses it.
 * The order's address comes from the payer's nonce account `nonce_index`.
 */
export function openLimitOrder(
  payer: Mut<Signer>,
  pool_state: Mut<PoolState>,
  tick_array: Mut<AccountInfo>,
  limit_order_nonce: InitIfNeeded<LimitOrderNonce>,
  limit_order: Init<LimitOrderState>,
  input_token_account: Mut<TokenAccount>,
  output_token_account: Mut<TokenAccount>,
  input_vault: Mut<TokenAccount>,
  output_vault: Mut<TokenAccount>,
  input_vault_mint: Mint,
  output_vault_mint: Mint,
  input_token_program: TokenInterface,
  system_program: SystemProgram,
  nonce_index: u8,
  zero_for_one: boolean,
  tick_index: i32,
  amount: u64,
): void {
  constraint(input_token_account, input_token_account.mint === input_vault.mint, AnchorError.ConstraintTokenMint);
  constraint(input_token_account, input_token_account.owner === payer.key, AnchorError.ConstraintTokenOwner);
  constraint(output_token_account, output_token_account.mint === output_vault.mint, AnchorError.ConstraintTokenMint);
  constraint(output_token_account, output_token_account.owner === payer.key, AnchorError.ConstraintTokenOwner);
  constraint(input_vault, input_vault.key === (zero_for_one ? pool_state.token_vault_0 : pool_state.token_vault_1));
  constraint(output_vault, output_vault.key === (zero_for_one ? pool_state.token_vault_1 : pool_state.token_vault_0));
  constraint(input_vault_mint, input_vault_mint.key === input_vault.mint, AnchorError.ConstraintAddress);
  constraint(output_vault_mint, output_vault_mint.key === output_vault.mint, AnchorError.ConstraintAddress);
  constraint(input_token_program, input_token_program.key === input_vault_mint.tokenProgram, AnchorError.ConstraintAddress);
  // `&[nonce_index as u8]`: a seed Anchor's IDL does not record.
  limit_order_nonce.createIfNeeded(payer, [payer.key, u8(nonce_index)]);
  limit_order.create(payer, [payer.key, limit_order_nonce.key, bigEndian(limit_order_nonce.order_nonce)]);

  require(!input_token_account.isFrozen && !output_token_account.isFrozen, ErrorCode.NotApproved);
  // Limit orders (bit 5) and swaps (bit 4) both on.
  require((pool_state.status & 48n) === 0n, ErrorCode.NotApproved);
  const spacing = pool_state.tick_spacing;
  checkTickIndex(tick_index, zero_for_one, pool_state.tick_current, spacing);
  const fee = transferFee(input_vault_mint, amount);
  require(amount >= fee, ErrorCode.CalculateOverflow);
  const net = amount - fee;
  checkLimitOrderAmount(net, tick_index, zero_for_one);
  const start = arrayStartIndex(tick_index, spacing);
  require(tick_array.key === findProgramAddress(["tick_array", pool_state.key, bigEndian(start)], programId()), AnchorError.RequireKeysEqViolated);
  // get_or_create_tick_array
  require(isValidStartIndex(start, spacing), ErrorCode.InvalidTickIndex);
  if (tick_array.owner === SYSTEM)
    createTickArray(payer, tick_array, pool_state, system_program, start, findProgramAddressBump(["tick_array", pool_state.key, bigEndian(start)], programId()));
  const array = loadAccountMut<TickArrayState>(tick_array);
  const countBefore = array.initialized_tick_count;
  const offset = orderOffset(array, tick_index, spacing);
  const t = array.ticks.get(offset);
  require(t.order_phase < 18446744073709551615n, ErrorCode.OrderPhaseSaturated);
  const usedBefore = tickInitialized(t);
  t.tick = tick_index;
  limit_order.pool_id = pool_state.key;
  limit_order.owner = payer.key;
  limit_order.tick_index = tick_index;
  limit_order.zero_for_one = zero_for_one;
  limit_order.order_phase = t.order_phase;
  limit_order.total_amount = net;
  limit_order.filled_amount = 0n;
  limit_order.open_time = u64(now());
  limit_order.unfilled_ratio_x64 = Q64;
  limit_order.settle_base = net;
  limit_order.settled_output = 0n;
  require(t.orders_amount <= 18446744073709551615n - net, ErrorCode.CalculateOverflow);
  t.orders_amount += net;
  if (!usedBefore) {
    require(array.initialized_tick_count < 255n, ErrorCode.CalculateOverflow);
    array.initialized_tick_count += 1n;
    const rest = remainingAccounts();
    if (countBefore === 0n && flipForOrder(pool_state, array.start_tick_index, rest.length > 0n)) {
      require(rest.get(0n).key === extensionKey(pool_state), AnchorError.RequireKeysEqViolated);
      const ext = loadAccountMut<TickArrayBitmapExtension>(rest.get(0n));
      flipBitExtension(ext, array.start_tick_index, spacing);
    }
  }
  if (limit_order_nonce.user_wallet === NO_KEY) {
    limit_order_nonce.user_wallet = payer.key;
    limit_order_nonce.nonce_index = nonce_index;
  }
  limit_order_nonce.order_nonce = limit_order_nonce.order_nonce < 18446744073709551615n ? limit_order_nonce.order_nonce + 1n : limit_order_nonce.order_nonce;
  input_token_program.transferChecked(input_token_account, input_vault_mint, input_vault, payer, amount);
  emit<OpenLimitOrderEvent>({
    pool_id: pool_state.key,
    limit_order: limit_order.key,
    zero_for_one: limit_order.zero_for_one,
    tick_index: limit_order.tick_index,
    total_amount: limit_order.total_amount,
    transfer_fee: fee,
  });
}

/** Add to a limit order while its tick has not started filling it. */
export function increaseLimitOrder(
  owner: Signer,
  pool_state: Mut<PoolState>,
  tick_array: Mut<TickArrayState>,
  limit_order: Mut<LimitOrderState>,
  input_token_account: Mut<TokenAccount>,
  input_vault: Mut<TokenAccount>,
  input_vault_mint: Mint,
  input_token_program: TokenInterface,
  amount: u64,
): void {
  constraint(tick_array, tick_array.pool_id === pool_state.key);
  constraint(limit_order, limit_order.pool_id === pool_state.key && limit_order.owner === owner.key);
  constraint(input_token_account, input_token_account.mint === input_vault.mint, AnchorError.ConstraintTokenMint);
  constraint(input_token_account, input_token_account.owner === owner.key, AnchorError.ConstraintTokenOwner);
  constraint(input_vault, input_vault.key === (limit_order.zero_for_one ? pool_state.token_vault_0 : pool_state.token_vault_1));
  constraint(input_vault_mint, input_vault_mint.key === input_vault.mint, AnchorError.ConstraintAddress);
  constraint(input_token_program, input_token_program.key === input_vault_mint.tokenProgram, AnchorError.ConstraintAddress);
  require(amount > 0n, ErrorCode.ZeroAmountSpecified);
  require((pool_state.status & 48n) === 0n, ErrorCode.NotApproved);
  const spacing = pool_state.tick_spacing;
  checkTickIndex(limit_order.tick_index, limit_order.zero_for_one, pool_state.tick_current, spacing);
  const countBefore = tick_array.initialized_tick_count;
  const offset = orderOffset(tick_array, limit_order.tick_index, spacing);
  const usedBefore = tickInitialized(tick_array.ticks.get(offset));
  const fee = transferFee(input_vault_mint, amount);
  require(amount >= fee, ErrorCode.CalculateOverflow);
  const net = amount - fee;
  increaseOrder(limit_order, tick_array, offset, net);
  emit<IncreaseLimitOrderEvent>({
    pool_id: pool_state.key,
    limit_order: limit_order.key,
    zero_for_one: limit_order.zero_for_one,
    tick_index: limit_order.tick_index,
    total_amount: limit_order.total_amount,
    increased_amount: net,
    transfer_fee: fee,
  });
  checkLimitOrderAmount(limit_order.total_amount, limit_order.tick_index, limit_order.zero_for_one);
  if (!usedBefore) {
    require(tick_array.initialized_tick_count < 255n, ErrorCode.CalculateOverflow);
    tick_array.initialized_tick_count += 1n;
    const rest = remainingAccounts();
    if (countBefore === 0n && flipForOrder(pool_state, tick_array.start_tick_index, rest.length > 0n)) {
      require(rest.get(0n).key === extensionKey(pool_state), AnchorError.RequireKeysEqViolated);
      const ext = loadAccountMut<TickArrayBitmapExtension>(rest.get(0n));
      flipBitExtension(ext, tick_array.start_tick_index, spacing);
    }
  }
  input_token_program.transferChecked(input_token_account, input_vault_mint, input_vault, owner, amount);
}

/** Take back part of a limit order (what is unfilled), with what it has filled so far. */
export function decreaseLimitOrder(
  owner: Signer,
  pool_state: Mut<PoolState>,
  tick_array: Mut<TickArrayState>,
  limit_order: Mut<LimitOrderState>,
  input_token_account: Mut<TokenAccount>,
  output_token_account: Mut<TokenAccount>,
  input_vault: Mut<TokenAccount>,
  output_vault: Mut<TokenAccount>,
  input_vault_mint: Mint,
  output_vault_mint: Mint,
  token_program: TokenProgram,
  token_program_2022: Token2022Program,
  amount: u64,
  amount_min: u64,
): void {
  constraint(tick_array, tick_array.pool_id === pool_state.key);
  constraint(limit_order, limit_order.pool_id === pool_state.key && limit_order.owner === owner.key);
  constraint(input_token_account, input_token_account.mint === input_vault.mint, AnchorError.ConstraintTokenMint);
  constraint(input_token_account, input_token_account.owner === owner.key, AnchorError.ConstraintTokenOwner);
  constraint(output_token_account, output_token_account.mint === output_vault.mint, AnchorError.ConstraintTokenMint);
  constraint(output_token_account, output_token_account.owner === owner.key, AnchorError.ConstraintTokenOwner);
  constraint(input_vault, input_vault.key === (limit_order.zero_for_one ? pool_state.token_vault_0 : pool_state.token_vault_1));
  constraint(output_vault, output_vault.key === (limit_order.zero_for_one ? pool_state.token_vault_1 : pool_state.token_vault_0));
  constraint(input_vault_mint, input_vault_mint.key === input_vault.mint, AnchorError.ConstraintAddress);
  constraint(output_vault_mint, output_vault_mint.key === output_vault.mint, AnchorError.ConstraintAddress);
  require(amount > 0n, ErrorCode.ZeroAmountSpecified);
  const spacing = pool_state.tick_spacing;
  const offset = orderOffset(tick_array, limit_order.tick_index, spacing);
  const usedBefore = tickInitialized(tick_array.ticks.get(offset));
  const result = decreaseOrder(limit_order, tick_array, offset, amount);
  emit<DecreaseLimitOrderEvent>({
    pool_id: pool_state.key,
    limit_order: limit_order.key,
    zero_for_one: limit_order.zero_for_one,
    tick_index: limit_order.tick_index,
    total_amount: limit_order.total_amount,
    filled_amount: limit_order.filled_amount,
    settled_output_amount: result.settled_output_amount,
    decreased_amount: result.real_decrease_amount,
  });
  if (usedBefore && !tickInitialized(tick_array.ticks.get(offset))) {
    require(tick_array.initialized_tick_count > 0n, ErrorCode.CalculateOverflow);
    tick_array.initialized_tick_count -= 1n;
    const rest = remainingAccounts();
    const start = arrayStartIndex(limit_order.tick_index, spacing);
    if (tick_array.initialized_tick_count === 0n && flipForOrder(pool_state, start, rest.length > 0n)) {
      require(rest.get(0n).key === extensionKey(pool_state), AnchorError.RequireKeysEqViolated);
      const ext = loadAccountMut<TickArrayBitmapExtension>(rest.get(0n));
      flipBitExtension(ext, start, spacing);
    }
  }
  const seedIndex = u16(pool_state.seed_index.get(0n)) | (u16(pool_state.seed_index.get(1n)) << 8n);
  const poolSigner = poolIsIndexed(pool_state)
    ? signer(["pool", pool_state.amm_config, pool_state.token_mint_0, pool_state.token_mint_1, seedIndex, pool_state.bump.get(0n)])
    : signer(["pool", pool_state.amm_config, pool_state.token_mint_0, pool_state.token_mint_1, pool_state.bump.get(0n)]);
  if (result.settled_output_amount > 0n)
    transferOut(pool_state, output_vault, output_token_account, output_vault_mint, token_program, token_program_2022, result.settled_output_amount, poolSigner);
  if (result.real_decrease_amount > 0n) {
    const fee = transferFee(input_vault_mint, result.real_decrease_amount);
    require(result.real_decrease_amount >= fee, ErrorCode.CalculateOverflow);
    require(result.real_decrease_amount - fee >= amount_min, ErrorCode.PriceSlippageCheck);
    transferOut(pool_state, input_vault, input_token_account, input_vault_mint, token_program, token_program_2022, result.real_decrease_amount, poolSigner);
  }
}

/** Pay out what a limit order has filled (its owner, or Raydium's limit order operator). */
export function settleLimitOrder(
  signer: Signer,
  pool_state: Account<PoolState>,
  tick_array: Account<TickArrayState>,
  limit_order: Mut<LimitOrderState>,
  output_token_account: Mut<TokenAccount>,
  output_vault: Mut<TokenAccount>,
  output_vault_mint: Mint,
  output_token_program: TokenInterface,
): void {
  constraint(signer, signer.key === limit_order.owner || signer.key === LIMIT_ORDER_ADMIN);
  constraint(tick_array, tick_array.pool_id === pool_state.key);
  constraint(limit_order, limit_order.pool_id === pool_state.key);
  constraint(output_token_account, output_token_account.mint === output_vault.mint, AnchorError.ConstraintTokenMint);
  constraint(output_token_account, output_token_account.owner === limit_order.owner, AnchorError.ConstraintTokenOwner);
  constraint(output_vault, output_vault.key === (limit_order.zero_for_one ? pool_state.token_vault_1 : pool_state.token_vault_0));
  constraint(output_vault_mint, output_vault_mint.key === output_vault.mint, AnchorError.ConstraintAddress);
  constraint(output_token_program, output_token_program.key === output_vault_mint.tokenProgram, AnchorError.ConstraintAddress);
  const offset = orderOffset(tick_array, limit_order.tick_index, pool_state.tick_spacing);
  const out = settleFilledOrder(limit_order, tick_array, offset);
  if (unfilledOf(limit_order) !== 0n) require(out > 0n, AnchorError.RequireGtViolated);
  emit<SettleLimitOrderEvent>({
    pool_id: pool_state.key,
    limit_order: limit_order.key,
    zero_for_one: limit_order.zero_for_one,
    tick_index: limit_order.tick_index,
    total_amount: limit_order.total_amount,
    filled_amount: limit_order.filled_amount,
    settled_amount_out: out,
  });
  payFromPool(pool_state, output_vault, output_token_account, output_vault_mint, output_token_program, out);
}

/** transfer_checked out of a pool vault, the pool signing (always, even of 0, as settle_limit_order does). */
function payFromPool(pool: Account<PoolState>, vault: Mut<TokenAccount>, to: Mut<TokenAccount>, mint: Mint, program: TokenInterface, amount: u64): void {
  const seedIndex = u16(pool.seed_index.get(0n)) | (u16(pool.seed_index.get(1n)) << 8n);
  const poolSigner = poolIsIndexed(pool)
    ? signer(["pool", pool.amm_config, pool.token_mint_0, pool.token_mint_1, seedIndex, pool.bump.get(0n)])
    : signer(["pool", pool.amm_config, pool.token_mint_0, pool.token_mint_1, pool.bump.get(0n)]);
  program.transferChecked(vault, mint, to, pool, amount, poolSigner);
}

/** Close a fully filled (or emptied) limit order; its rent goes to its owner. */
export function closeLimitOrder(signer: Signer, rent_receiver: Mut<AccountInfo>, limit_order: Mut<LimitOrderState>): void {
  constraint(signer, signer.key === limit_order.owner || signer.key === LIMIT_ORDER_ADMIN);
  constraint(rent_receiver, rent_receiver.key === limit_order.owner, AnchorError.ConstraintAddress);
  require(unfilledOf(limit_order) === 0n, ErrorCode.InvalidLimitOrderAmount);
  close(limit_order, rent_receiver);
}


/**
 * swap_v2 for SPL Token pools: no transfer fees, and the first tick array an account of the instruction (the others,
 * and the bitmap extension, remaining accounts).
 */
export function swap(
  payer: Signer,
  amm_config: Account<AmmConfig>,
  pool_state: Mut<PoolState>,
  input_token_account: Mut<TokenAccount>,
  output_token_account: Mut<TokenAccount>,
  input_vault: Mut<TokenAccount>,
  output_vault: Mut<TokenAccount>,
  observation_state: Mut<ObservationState>,
  token_program: TokenProgram,
  tick_array: Mut<TickArrayState>,
  amount: u64,
  other_amount_threshold: u64,
  sqrt_price_limit_x64: u128,
  is_base_input: boolean,
): void {
  constraint(amm_config, amm_config.key === pool_state.amm_config, AnchorError.ConstraintAddress);
  constraint(input_token_account, input_token_account.tokenProgram === SPL_TOKEN, AnchorError.AccountOwnedByWrongProgram);
  constraint(output_token_account, output_token_account.tokenProgram === SPL_TOKEN, AnchorError.AccountOwnedByWrongProgram);
  constraint(input_vault, input_vault.tokenProgram === SPL_TOKEN, AnchorError.AccountOwnedByWrongProgram);
  constraint(output_vault, output_vault.tokenProgram === SPL_TOKEN, AnchorError.AccountOwnedByWrongProgram);
  constraint(input_token_account, input_token_account.mint === input_vault.mint, AnchorError.ConstraintTokenMint);
  constraint(input_token_account, input_token_account.owner === payer.key, AnchorError.ConstraintTokenOwner);
  constraint(output_token_account, output_token_account.mint === output_vault.mint, AnchorError.ConstraintTokenMint);
  constraint(observation_state, observation_state.key === pool_state.observation_key, AnchorError.ConstraintAddress);
  constraint(tick_array, tick_array.pool_id === pool_state.key);

  // exact_internal: the vaults' balances measure what the swap took and paid.
  const timestamp = u64(now());
  const inputBefore = input_vault.amount;
  const outputBefore = output_vault.amount;
  const specified = amount;
  const priceBefore = pool_state.sqrt_price_x64;
  const zeroForOne = input_vault.mint === pool_state.token_mint_0;
  require(timestamp > pool_state.open_time, AnchorError.RequireGtViolated);
  require(
    zeroForOne
      ? input_vault.key === pool_state.token_vault_0 && output_vault.key === pool_state.token_vault_1
      : input_vault.key === pool_state.token_vault_1 && output_vault.key === pool_state.token_vault_0,
    ErrorCode.InvalidInputPoolVault,
  );
  // The remaining accounts: tick arrays and the bitmap extension, told apart by size, up to the first that is neither.
  const rest = remainingAccounts();
  let scanEnd = rest.length;
  let extAt = rest.length;
  for (let i = 0n; i < rest.length && scanEnd === rest.length; i++) {
    const a = rest.get(i);
    if (a.dataLen === 10240n) {
      // AccountLoad::load_data_mut
      require(a.owner === programId(), AnchorError.AccountOwnedByWrongProgram);
      require(a.isWritable, AnchorError.AccountNotMutable);
      // Its discriminator (the view itself is taken when the swap reaches it).
      const array = loadAccount<TickArrayState>(a);
    } else if (a.dataLen === 1832n) {
      // TickArrayBitmapExtension::validate_belongs_to_pool
      const ext = loadAccount<TickArrayBitmapExtension>(a);
      require(ext.pool_id === pool_state.key, ErrorCode.InvalidTickArrayBitmapExtensionAccount);
      extAt = i;
    } else scanEnd = i;
  }
  /** The next tick array after remaining account `from` (-1: the first), or -1. */
  const nextTickArray = (from: i64): i64 => {
    for (let i = from + 1n; i < i64(scanEnd); i++) if (rest.get(u64(i)).dataLen === 10240n) return i;
    return -1n;
  };
  const spacing = pool_state.tick_spacing;
  /** PoolState::next_tick_array_index_with_extension_info: the next marked array, or NO_ARRAY. */
  const nextArrayStart = (from: i32): i64 => {
    let last = arrayStartIndex(from, spacing);
    for (;;) {
      const inPool = nextArrayInBitmap(pool_state, last, zeroForOne);
      if (inPool.found) return i64(inPool.start);
      if (spacing >= 15n) return NO_ARRAY;
      last = inPool.start;
      require(extAt < rest.length, ErrorCode.MissingTickArrayBitmapExtensionAccount);
      const ext = loadAccount<TickArrayBitmapExtension>(rest.get(extAt));
      const inExt = nextArrayInExtension(ext, last, spacing, zeroForOne);
      if (inExt.found) return i64(inExt.start);
      last = inExt.start;
      if (last < MIN_TICK || last > MAX_TICK) return NO_ARRAY;
    }
  };
  const limit = sqrt_price_limit_x64 !== 0n ? sqrt_price_limit_x64 : zeroForOne ? MIN_SQRT_PRICE_X64 + 1n : MAX_SQRT_PRICE_X64 - 1n;
  const blockTimestamp = u32(timestamp & 0xffffffffn);

  // swap_internal
  require(specified !== 0n, ErrorCode.ZeroAmountSpecified);
  require((pool_state.status & 16n) === 0n, ErrorCode.NotApproved);
  require(
    zeroForOne
      ? limit < pool_state.sqrt_price_x64 && limit > MIN_SQRT_PRICE_X64
      : limit > pool_state.sqrt_price_x64 && limit < MAX_SQRT_PRICE_X64,
    ErrorCode.SqrtPriceLimitOverflow,
  );
  accrueRewards(pool_state, u64(blockTimestamp));
  require(observation_state.pool_id === pool_state.key, AnchorError.RequireKeysEqViolated);
  // first_tick_array_index_with_extension_info
  let firstHasPoolTick = false;
  let validStart: i32 = 0n;
  let current = arrayStartIndex(pool_state.tick_current, spacing);
  let marked = false;
  if (overflowsDefaultBitmap(pool_state.tick_current, spacing)) {
    require(extAt < rest.length, ErrorCode.MissingTickArrayBitmapExtensionAccount);
    const ext = loadAccount<TickArrayBitmapExtension>(rest.get(extAt));
    const found = arrayInExtension(ext, current, spacing);
    marked = found.found;
    current = found.start;
  } else {
    const found = currentArrayInBitmap(pool_state);
    marked = found.found;
    current = found.start;
  }
  if (marked) {
    firstHasPoolTick = true;
    validStart = current;
  } else {
    const next = nextArrayStart(arrayStartIndex(pool_state.tick_current, spacing));
    require(next !== NO_ARRAY, ErrorCode.InsufficientLiquidityForDirection);
    validStart = i32(next);
  }
  // The first tick array passed that is that one: the `tick_array` account (position -1), then the remaining ones.
  const startAt = (i: i64): i32 => (i < 0n ? tick_array.start_tick_index : readData<i32>(rest.get(u64(i)), 40n));
  let at: i64 = -1n;
  for (;;) {
    if (startAt(at) === validStart) break;
    const next = nextTickArray(at);
    if (next < 0n) break;
    at = next;
  }
  require(at < 0n || readData<Pubkey>(rest.get(u64(at)), 8n) === pool_state.key, AnchorError.RequireKeysEqViolated);
  require(startAt(at) === validStart, ErrorCode.InvalidFirstTickArrayAccount);

  const isFeeOnInput = feeOnInput(pool_state, zeroForOne);
  const dynamic = dynamicFeeEnabled(pool_state);
  const run = newSwapRun(pool_state, specified, zeroForOne, firstHasPoolTick);
  if (dynamic) {
    run.s.tick_spacing_index = tickSpacingIndex(run.s.tick, spacing);
    updateReference(pool_state, run.s.tick_spacing_index, u64(blockTimestamp));
  }
  // The swap, one tick array at a time.
  let finished = false;
  while (!finished) {
    if (at < 0n) run.s = swapInArray(pool_state, amm_config, tick_array, run.s, limit, zeroForOne, is_base_input, isFeeOnInput, dynamic);
    else {
      const array = loadAccountMut<TickArrayState>(rest.get(u64(at)));
      run.s = swapInArray(pool_state, amm_config, array, run.s, limit, zeroForOne, is_base_input, isFeeOnInput, dynamic);
    }
    if (run.s.ext_flip) {
      require(extAt < rest.length, ErrorCode.MissingTickArrayBitmapExtensionAccount);
      const ext = loadAccountMut<TickArrayBitmapExtension>(rest.get(extAt));
      flipBitExtension(ext, run.s.ext_flip_start, spacing);
      run.s.ext_flip = false;
    }
    if (run.s.move_on) {
      // Past this array: the next marked one, among the tick arrays passed after it.
      const next = nextArrayStart(validStart);
      require(next !== NO_ARRAY, ErrorCode.LiquidityInsufficient);
      while (startAt(at) !== i32(next)) {
        at = nextTickArray(at);
        require(at >= 0n, ErrorCode.NotEnoughTickArrayAccount);
        require(readData<Pubkey>(rest.get(u64(at)), 8n) === pool_state.key, AnchorError.RequireKeysEqViolated);
      }
      validStart = i32(next);
      run.s.take_first = true;
      run.s.move_on = false;
    } else finished = true;
  }
  const st = run.s;

  if (st.tick !== pool_state.tick_current) updateObservation(observation_state, blockTimestamp, pool_state.tick_current);
  require(specified >= st.amount_specified_remaining, ErrorCode.CalculateOverflow);
  const consumed = specified - st.amount_specified_remaining;
  const amount0 = zeroForOne === is_base_input ? consumed : st.amount_calculated;
  const amount1 = zeroForOne === is_base_input ? st.amount_calculated : consumed;
  require(st.lp_fee <= 18446744073709551615n - st.protocol_fee, ErrorCode.CalculateOverflow);
  require(st.lp_fee + st.protocol_fee <= 18446744073709551615n - st.fund_fee, ErrorCode.CalculateOverflow);
  const tradeFee = st.lp_fee + st.protocol_fee + st.fund_fee;
  const onToken0 = feeOnToken0(pool_state, zeroForOne);
  pool_state.tick_current = st.tick;
  pool_state.sqrt_price_x64 = st.sqrt_price_x64;
  pool_state.liquidity = st.liquidity;
  updatePoolFees(pool_state, st, zeroForOne);

  log(`exact_swap_internal, is_base_input:${is_base_input}, amount_0: ${amount0}, amount_1: ${amount1}`);
  require(amount0 !== 0n && amount1 !== 0n, ErrorCode.TooSmallInputOrOutputAmount);
  emit<SwapEvent>({
    pool_state: pool_state.key,
    sender: payer.key,
    token_account_0: zeroForOne ? input_token_account.key : output_token_account.key,
    token_account_1: zeroForOne ? output_token_account.key : input_token_account.key,
    amount_0: amount0,
    transfer_fee_0: 0n,
    amount_1: amount1,
    transfer_fee_1: 0n,
    zero_for_one: zeroForOne,
    sqrt_price_x64: pool_state.sqrt_price_x64,
    liquidity: pool_state.liquidity,
    tick: pool_state.tick_current,
    trade_fee_0: onToken0 ? tradeFee : 0n,
    trade_fee_1: onToken0 ? 0n : tradeFee,
  });
  const seedIndex = u16(pool_state.seed_index.get(0n)) | (u16(pool_state.seed_index.get(1n)) << 8n);
  const poolSigner = poolIsIndexed(pool_state)
    ? signer(["pool", pool_state.amm_config, pool_state.token_mint_0, pool_state.token_mint_1, seedIndex, pool_state.bump.get(0n)])
    : signer(["pool", pool_state.amm_config, pool_state.token_mint_0, pool_state.token_mint_1, pool_state.bump.get(0n)]);
  const paid = zeroForOne ? amount0 : amount1;
  const received = zeroForOne ? amount1 : amount0;
  if (paid > 0n) token_program.transfer(input_token_account, input_vault, payer, paid);
  if (received > 0n) token_program.transfer(output_vault, output_token_account, pool_state, received, poolSigner);

  if (zeroForOne) require(priceBefore >= pool_state.sqrt_price_x64, AnchorError.RequireGteViolated);
  else require(pool_state.sqrt_price_x64 >= priceBefore, AnchorError.RequireGteViolated);
  if (sqrt_price_limit_x64 === 0n) {
    if (is_base_input) require(amount === (zeroForOne ? amount0 : amount1), AnchorError.RequireEqViolated);
    else require(amount === (zeroForOne ? amount1 : amount0), AnchorError.RequireEqViolated);
  }
  if (is_base_input) {
    require(outputBefore >= output_vault.amount, ErrorCode.CalculateOverflow);
    require(outputBefore - output_vault.amount >= other_amount_threshold, ErrorCode.TooLittleOutputReceived);
  } else {
    require(input_vault.amount >= inputBefore, ErrorCode.CalculateOverflow);
    require(input_vault.amount - inputBefore <= other_amount_threshold, ErrorCode.TooMuchInputPaid);
  }
}


/**
 * Swap `amount_in` through a chain of pools, each hop's output the next hop's input (swap_v2 by input, no price
 * limit). Per hop, as remaining accounts: its AmmConfig, pool, output token account, input vault, output vault, output
 * mint and observation account, then its tick arrays (and bitmap extension).
 */
export function swapRouterBaseIn(
  payer: Signer,
  input_token_account: Mut<TokenAccount>,
  input_token_mint: Mut<Mint>,
  token_program: TokenProgram,
  token_program_2022: Token2022Program,
  memo_program: MemoProgram,
  amount_in: u64,
  amount_out_minimum: u64,
): void {
  constraint(input_token_account, input_token_account.mint === input_token_mint.key, AnchorError.ConstraintTokenMint);
  constraint(input_token_account, input_token_account.owner === payer.key, AnchorError.ConstraintTokenOwner);
  const rest = remainingAccounts();
  let amount = amount_in;
  // The hop's input token account and mint: the instruction's (-1) on the first hop, then the last hop's output.
  let inAccount: i64 = -1n;
  let inMint: i64 = -1n;
  let pos = 0n;
  while (pos < rest.length) {
    // Between hops, skip the last hop's tick arrays up to the next AmmConfig (117 bytes).
    if (pos !== 0n && rest.get(pos).dataLen !== 117n) {
      pos++;
      continue;
    }
    require(pos + 7n <= rest.length, ErrorCode.AccountLack);
    const config = loadAccount<AmmConfig>(rest.get(pos));
    const pool = loadAccountMut<PoolState>(rest.get(pos + 1n));
    const outAccount = rest.get(pos + 2n);
    const inVault = rest.get(pos + 3n);
    const outVault = rest.get(pos + 4n);
    const outMint = rest.get(pos + 5n);
    const obs = loadAccountMut<ObservationState>(rest.get(pos + 6n));
    // InterfaceAccount<TokenAccount> / <Mint>: owned by a token program, holding one.
    for (let k = 2n; k < 6n; k++) {
      const t = rest.get(pos + k);
      require(t.owner === SPL_TOKEN || t.owner === SPL_TOKEN_2022, AnchorError.AccountOwnedByWrongProgram);
      require(t.dataLen >= (k === 5n ? 82n : 165n), AnchorError.AccountDidNotDeserialize);
    }
    require(pool.observation_key === obs.key, AnchorError.RequireKeysEqViolated);
    require(pool.amm_config === config.key, AnchorError.RequireKeysEqViolated);
    pos += 7n;

    // exact_internal_v2 by input.
    const timestamp = u64(now());
    const outputBefore = readData<u64>(outAccount, 64n);
    const specifiedFee = inMint < 0n ? transferFee(input_token_mint, amount) : transferFee(rest.get(u64(inMint)), amount);
    const specified = amount - specifiedFee;
    const priceBefore = pool.sqrt_price_x64;
    const inVaultMint = readData<Pubkey>(inVault, 0n);
    const zeroForOne = inVaultMint === pool.token_mint_0;
    require(timestamp > pool.open_time, AnchorError.RequireGtViolated);
    require(
      zeroForOne ? inVault.key === pool.token_vault_0 && outVault.key === pool.token_vault_1 : inVault.key === pool.token_vault_1 && outVault.key === pool.token_vault_0,
      ErrorCode.InvalidInputPoolVault,
    );
    let scanEnd = rest.length;
    let extAt = rest.length;
    for (let i = pos; i < rest.length && scanEnd === rest.length; i++) {
      const a = rest.get(i);
      if (a.dataLen === 10240n) {
        // AccountLoad::load_data_mut
        require(a.owner === programId(), AnchorError.AccountOwnedByWrongProgram);
        require(a.isWritable, AnchorError.AccountNotMutable);
        // Its discriminator (the view itself is taken when the swap reaches it).
        const array = loadAccount<TickArrayState>(a);
      } else if (a.dataLen === 1832n) {
        // TickArrayBitmapExtension::validate_belongs_to_pool
        const ext = loadAccount<TickArrayBitmapExtension>(a);
        require(ext.pool_id === pool.key, ErrorCode.InvalidTickArrayBitmapExtensionAccount);
        extAt = i;
      } else scanEnd = i;
    }
    /** The next tick array after remaining account `from` (-1: the first), or -1. */
    const nextTickArray = (from: i64): i64 => {
      for (let i = from < i64(pos) ? i64(pos) : from + 1n; i < i64(scanEnd); i++) if (rest.get(u64(i)).dataLen === 10240n) return i;
      return -1n;
    };
    const spacing = pool.tick_spacing;
    /** PoolState::next_tick_array_index_with_extension_info: the next marked array, or NO_ARRAY. */
    const nextArrayStart = (from: i32): i64 => {
      let last = arrayStartIndex(from, spacing);
      for (;;) {
        const inPool = nextArrayInBitmap(pool, last, zeroForOne);
        if (inPool.found) return i64(inPool.start);
        if (spacing >= 15n) return NO_ARRAY;
        last = inPool.start;
        require(extAt < rest.length, ErrorCode.MissingTickArrayBitmapExtensionAccount);
        const ext = loadAccount<TickArrayBitmapExtension>(rest.get(extAt));
        const inExt = nextArrayInExtension(ext, last, spacing, zeroForOne);
        if (inExt.found) return i64(inExt.start);
        last = inExt.start;
        if (last < MIN_TICK || last > MAX_TICK) return NO_ARRAY;
      }
    };

    const limit = zeroForOne ? MIN_SQRT_PRICE_X64 + 1n : MAX_SQRT_PRICE_X64 - 1n;
    const blockTimestamp = u32(timestamp & 0xffffffffn);

    // swap_internal
    require(specified !== 0n, ErrorCode.ZeroAmountSpecified);
    require((pool.status & 16n) === 0n, ErrorCode.NotApproved);
    require(
      zeroForOne
        ? limit < pool.sqrt_price_x64 && limit > MIN_SQRT_PRICE_X64
        : limit > pool.sqrt_price_x64 && limit < MAX_SQRT_PRICE_X64,
      ErrorCode.SqrtPriceLimitOverflow,
    );
    accrueRewards(pool, u64(blockTimestamp));
    require(obs.pool_id === pool.key, AnchorError.RequireKeysEqViolated);
    // first_tick_array_index_with_extension_info
    let firstHasPoolTick = false;
    let validStart: i32 = 0n;
    let current = arrayStartIndex(pool.tick_current, spacing);
    let marked = false;
    if (overflowsDefaultBitmap(pool.tick_current, spacing)) {
      require(extAt < rest.length, ErrorCode.MissingTickArrayBitmapExtensionAccount);
      const ext = loadAccount<TickArrayBitmapExtension>(rest.get(extAt));
      const found = arrayInExtension(ext, current, spacing);
      marked = found.found;
      current = found.start;
    } else {
      const found = currentArrayInBitmap(pool);
      marked = found.found;
      current = found.start;
    }
    if (marked) {
      firstHasPoolTick = true;
      validStart = current;
    } else {
      const next = nextArrayStart(arrayStartIndex(pool.tick_current, spacing));
      require(next !== NO_ARRAY, ErrorCode.InsufficientLiquidityForDirection);
      validStart = i32(next);
    }
    // The first tick array passed that is that one (the ones before it are skipped).
    let at = nextTickArray(-1n);
    require(at >= 0n, ErrorCode.NotEnoughTickArrayAccount);
    for (;;) {
      if (readData<i32>(rest.get(u64(at)), 40n) === validStart) break;
      const next = nextTickArray(at);
      if (next < 0n) break;
      at = next;
    }
    require(readData<Pubkey>(rest.get(u64(at)), 8n) === pool.key, AnchorError.RequireKeysEqViolated);
    require(readData<i32>(rest.get(u64(at)), 40n) === validStart, ErrorCode.InvalidFirstTickArrayAccount);

    const isFeeOnInput = feeOnInput(pool, zeroForOne);
    const dynamic = dynamicFeeEnabled(pool);
    const run = newSwapRun(pool, specified, zeroForOne, firstHasPoolTick);
    if (dynamic) {
      run.s.tick_spacing_index = tickSpacingIndex(run.s.tick, spacing);
      updateReference(pool, run.s.tick_spacing_index, u64(blockTimestamp));
    }
    // The swap, one tick array at a time.
    let finished = false;
    while (!finished) {
      const array = loadAccountMut<TickArrayState>(rest.get(u64(at)));
      run.s = swapInArray(pool, config, array, run.s, limit, zeroForOne, true, isFeeOnInput, dynamic);
      if (run.s.ext_flip) {
        require(extAt < rest.length, ErrorCode.MissingTickArrayBitmapExtensionAccount);
        const ext = loadAccountMut<TickArrayBitmapExtension>(rest.get(extAt));
        flipBitExtension(ext, run.s.ext_flip_start, spacing);
        run.s.ext_flip = false;
      }
      if (run.s.move_on) {
        // Past this array: the next marked one, among the tick arrays passed after it.
        const next = nextArrayStart(validStart);
        require(next !== NO_ARRAY, ErrorCode.LiquidityInsufficient);
        while (readData<i32>(rest.get(u64(at)), 40n) !== i32(next)) {
          at = nextTickArray(at);
          require(at >= 0n, ErrorCode.NotEnoughTickArrayAccount);
          require(readData<Pubkey>(rest.get(u64(at)), 8n) === pool.key, AnchorError.RequireKeysEqViolated);
        }
        validStart = i32(next);
        run.s.take_first = true;
        run.s.move_on = false;
      } else finished = true;
    }
    const st = run.s;
    if (st.tick !== pool.tick_current) updateObservation(obs, blockTimestamp, pool.tick_current);
    require(specified >= st.amount_specified_remaining, ErrorCode.CalculateOverflow);
    const consumed = specified - st.amount_specified_remaining;
    const amount0 = zeroForOne ? consumed : st.amount_calculated;
    const amount1 = zeroForOne ? st.amount_calculated : consumed;
    require(st.lp_fee <= 18446744073709551615n - st.protocol_fee, ErrorCode.CalculateOverflow);
    require(st.lp_fee + st.protocol_fee <= 18446744073709551615n - st.fund_fee, ErrorCode.CalculateOverflow);
    const tradeFee = st.lp_fee + st.protocol_fee + st.fund_fee;
    const onToken0 = feeOnToken0(pool, zeroForOne);
    pool.tick_current = st.tick;
    pool.sqrt_price_x64 = st.sqrt_price_x64;
    pool.liquidity = st.liquidity;
    updatePoolFees(pool, st, zeroForOne);
    log(`exact_swap_internal, is_base_input:true, amount_0: ${amount0}, amount_1: ${amount1}`);
    require(amount0 !== 0n && amount1 !== 0n, ErrorCode.TooSmallInputOrOutputAmount);
    // The input's fee on top of what the pool takes in, the output's out of what it pays.
    const paid = zeroForOne ? amount0 : amount1;
    const received = zeroForOne ? amount1 : amount0;
    let inFee = specifiedFee;
    if (paid !== specified) {
      if (inMint < 0n) inFee = inverseTransferFee(input_token_mint, paid);
      else {
        // get_transfer_inverse_fee on the last hop's output mint.
        const m = rest.get(u64(inMint));
        inFee = transferFeeInverse(m, paid);
        require(paid <= 18446744073709551615n - inFee, ErrorCode.CalculateOverflow);
        require(transferFee(m, paid + inFee) === inFee, ErrorCode.TransferFeeCalculateNotMatch);
      }
    }
    const outFee = transferFee(outMint, received);
    require(received >= outFee, ErrorCode.CalculateOverflow);
    require(paid <= 18446744073709551615n - inFee, ErrorCode.CalculateOverflow);
    const fee0 = zeroForOne ? inFee : outFee;
    const fee1 = zeroForOne ? outFee : inFee;
    log(`amount_0:${amount0}, transfer_fee_0:${fee0}, amount_1:${amount1}, transfer_fee_1:${fee1}`);
    const inAccountKey = inAccount < 0n ? input_token_account.key : rest.get(u64(inAccount)).key;
    emit<SwapEvent>({
      pool_state: pool.key,
      sender: payer.key,
      token_account_0: zeroForOne ? inAccountKey : outAccount.key,
      token_account_1: zeroForOne ? outAccount.key : inAccountKey,
      amount_0: zeroForOne ? amount0 : amount0 - outFee,
      transfer_fee_0: fee0,
      amount_1: zeroForOne ? amount1 - outFee : amount1,
      transfer_fee_1: fee1,
      zero_for_one: zeroForOne,
      sqrt_price_x64: pool.sqrt_price_x64,
      liquidity: pool.liquidity,
      tick: pool.tick_current,
      trade_fee_0: onToken0 ? tradeFee : 0n,
      trade_fee_1: onToken0 ? 0n : tradeFee,
    });
    // In: transfer_checked from the payer's account, under the program that holds it.
    const sendIn = paid + inFee;
    if (sendIn > 0n) {
      if (inAccount < 0n) {
        const decimals = input_token_mint.decimals;
        if (input_token_account.tokenProgram === SPL_TOKEN_2022)
          invoke(token_program_2022, [writable(input_token_account), readonly(input_token_mint), writable(inVault), readonlySigner(payer)], [u8(12n), sendIn, decimals]);
        else invoke(token_program, [writable(input_token_account), readonly(input_token_mint), writable(inVault), readonlySigner(payer)], [u8(12n), sendIn, decimals]);
      } else {
        const from = rest.get(u64(inAccount));
        const mint = rest.get(u64(inMint));
        const decimals = readData<u8>(mint, 44n);
        if (from.owner === SPL_TOKEN_2022) invoke(token_program_2022, [writable(from), readonly(mint), writable(inVault), readonlySigner(payer)], [u8(12n), sendIn, decimals]);
        else invoke(token_program, [writable(from), readonly(mint), writable(inVault), readonlySigner(payer)], [u8(12n), sendIn, decimals]);
      }
    }
    // Out: the pool signs.
    if (received > 0n) {
      const seedIndex = u16(pool.seed_index.get(0n)) | (u16(pool.seed_index.get(1n)) << 8n);
      const poolSigner = poolIsIndexed(pool)
        ? signer(["pool", pool.amm_config, pool.token_mint_0, pool.token_mint_1, seedIndex, pool.bump.get(0n)])
        : signer(["pool", pool.amm_config, pool.token_mint_0, pool.token_mint_1, pool.bump.get(0n)]);
      const decimals = readData<u8>(outMint, 44n);
      if (outVault.owner === SPL_TOKEN_2022)
        invoke(token_program_2022, [writable(outVault), readonly(outMint), writable(outAccount), readonlySigner(rest.get(pos - 6n))], [u8(12n), received, decimals], poolSigner);
      else invoke(token_program, [writable(outVault), readonly(outMint), writable(outAccount), readonlySigner(rest.get(pos - 6n))], [u8(12n), received, decimals], poolSigner);
    }
    if (zeroForOne) require(priceBefore >= pool.sqrt_price_x64, AnchorError.RequireGteViolated);
    else require(pool.sqrt_price_x64 >= priceBefore, AnchorError.RequireGteViolated);
    require(amount === sendIn, AnchorError.RequireEqViolated);
    const outputAfter = readData<u64>(outAccount, 64n);
    require(outputAfter >= outputBefore, ErrorCode.CalculateOverflow);
    amount = outputAfter - outputBefore;
    inAccount = i64(pos - 5n);
    inMint = i64(pos - 2n);
  }
  require(amount >= amount_out_minimum, ErrorCode.TooLittleOutputReceived);
}
