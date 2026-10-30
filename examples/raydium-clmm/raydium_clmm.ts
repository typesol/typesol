// A TypeSOL port of Raydium CLMM (raydium-io/raydium-clmm @ 6d7a0f8, Apache-2.0; mainnet
// CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK). Instruction and account names, argument order, error codes and events
// are the original's, so its IDL and clients work unchanged. See docs/case-study-raydium-clmm.md.
import {
  AnchorError,
  type Account,
  type AccountInfo,
  type Address,
  type Init,
  type Mint,
  type MintOf,
  type Mut,
  type Seeds,
  type Signer,
  type SystemProgram,
  type TokenInterface,
  type AccountMeta,
  type u32,
  type u128,
  constraint,
  currentEpoch,
  emit,
  extensionsWithin,
  findProgramAddress,
  invoke,
  loadAccount,
  now,
  programId,
  pubkey,
  readonly,
  remainingAccounts,
  rentExempt,
  require,
  returnData,
  u8,
  u16,
  u64,
} from "typesol";
import { ErrorCode } from "./errors";
import { FEE_RATE_DENOMINATOR_VALUE, getTickAtSqrtPrice } from "./math";
import {
  type AmmConfig,
  type ConfigChangeEvent,
  type ObservationState,
  type PoolCreatedEvent,
  type PoolState,
  type SupportMintAssociated,
  type TickArrayBitmapExtension,
} from "./state";

const PROTOCOL_FEE_OWNER = pubkey("projjosVCPQH49d5em7VYS7fJZzaqKixqKtus7yk416");
const FUND_FEE_OWNER = pubkey("FundHfY8oo8J9KYGyfXFFuQCHe7Z1VBNmsj84eMcdYs4");
const SPL_TOKEN = pubkey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const MAX_TICK_SPACING = 1000n;

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
