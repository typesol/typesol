// A TypeSOL port of Raydium CLMM (raydium-io/raydium-clmm @ 6d7a0f8, Apache-2.0; mainnet
// CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK). Instruction and account names, argument order, error codes and events
// are the original's, so its IDL and clients work unchanged. See docs/case-study-raydium-clmm.md.
import {
  AnchorError,
  AuthorityType,
  type Account,
  type AccountInfo,
  type Address,
  type AssociatedTokenProgram,
  type Dup,
  type Init,
  type Mint,
  type MintOf,
  type Mut,
  type Option,
  type Seeds,
  type Signer,
  type SignerSeeds,
  type SystemProgram,
  type Token2022Program,
  type TokenAccount,
  type TokenInterface,
  type TokenProgram,
  type AccountMeta,
  type i32,
  type u32,
  type u128,
  type Pubkey,
  bigEndian,
  byteLength,
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
  writable,
  u8,
  u16,
  u64,
} from "typesol";
import { ErrorCode } from "./errors";
import {
  type LiquidityChange,
  addLiquidityToTicks,
  burnLiquidityFromTicks,
  checkTickArrayStartIndex,
  flipBitDefault,
  flipBitExtension,
  initPosition,
  inverseTransferFee,
  isValidStartIndex,
  overflowsDefaultBitmap,
  updatePosition,
} from "./liquidity";
import { FEE_RATE_DENOMINATOR_VALUE, getTickAtSqrtPrice } from "./math";
import {
  type AmmConfig,
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
  type TickArrayBitmapExtension,
  type TickArrayState,
} from "./state";

const PROTOCOL_FEE_OWNER = pubkey("projjosVCPQH49d5em7VYS7fJZzaqKixqKtus7yk416");
const FUND_FEE_OWNER = pubkey("FundHfY8oo8J9KYGyfXFFuQCHe7Z1VBNmsj84eMcdYs4");
const SPL_TOKEN = pubkey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
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
  // The seed is the index's big-endian bytes: the little-endian bytes of the swapped u16.
  const bump = amm_config.create(owner, ["amm_config", ((index & 0xffn) << 8n) | (index >> 8n)]);
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
): void {
  // GetAccountDataSize with ImmutableOwner: the size the token program wants for an account of this mint.
  invoke(token_program, [readonly(mint)], [u8(21n), u16(7n)]);
  const space = returnData<u64>(token_program);
  if (vault.lamports === 0n)
    system_program.createAccount(payer, vault, rentExempt(space), space, token_program.key, ["pool_vault", pool.key, mint.key, bump]);
  else {
    const min = rentExempt(space) > 1n ? rentExempt(space) : 1n;
    if (min > vault.lamports) system_program.transfer(payer, vault, min - vault.lamports);
    system_program.allocate(vault, space, ["pool_vault", pool.key, mint.key, bump]);
    system_program.assign(vault, token_program.key, ["pool_vault", pool.key, mint.key, bump]);
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

  createTokenVault(pool_creator, pool_state, token_vault_0, token_mint_0, system_program, token_program_0, token_vault_0.pdaBump);
  createTokenVault(pool_creator, pool_state, token_vault_1, token_mint_1, system_program, token_program_1, token_vault_1.pdaBump);

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

  const change = addLiquidityToTicks(
    pool_state,
    lower,
    upper,
    vault_0_mint,
    vault_1_mint,
    liquidity,
    base_flag,
    amount_0_max,
    amount_1_max,
    tick_lower_index,
    tick_upper_index,
    u64(now()),
  );
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

  const change = addLiquidityToTicks(
    pool_state,
    tick_array_lower,
    tick_array_upper,
    vault_0_mint,
    vault_1_mint,
    liquidity,
    base_flag,
    amount_0_max,
    amount_1_max,
    tickLower,
    tickUpper,
    u64(now()),
  );
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
