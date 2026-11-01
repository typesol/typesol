// showcase/mainnet/marginfi/state.ts read through TypeSOL, for showcase/test/marginfi-state.test.ts: every account type in one
// instruction (so the IDL lists them all), and fields across three mainnet accounts returned for comparison.
import { type Account, type Pubkey, type i128, type i64, type u16, type u32, type u64, type u8 } from "typesol";
import {
  type Bank,
  type BankMetadata,
  type ExecuteOrderRecord,
  type FeeState,
  type LiquidationRecord,
  type MarginfiAccount,
  type MarginfiGroup,
  type Order,
  type RebalanceOrder,
  type RebalanceRecord,
  type SameAssetEmodeRegistry,
  type StakedSettings,
} from "../../mainnet/marginfi/state";

export interface Peek {
  mint_decimals: u8;
  asset_share_value: i128;
  liability_share_value: i128;
  last_update: i64;
  flags: u64;
  liquidation_insurance_fee: u32;
  oracle_key_0: Pubkey;
  group_admin: Pubkey;
  banks: u16;
  risk_admin: Pubkey;
  rate_limiter_last_admin_update_seq: u64;
  global_fee_wallet: Pubkey;
  program_fee_rate: i128;
  order_init_flat_sol_fee: u32;
}

export function peek(group: Account<MarginfiGroup>, bank: Account<Bank>, fee_state: Account<FeeState>): Peek {
  return {
    mint_decimals: bank.mint_decimals,
    asset_share_value: bank.asset_share_value.value,
    liability_share_value: bank.liability_share_value.value,
    last_update: bank.last_update,
    flags: bank.flags,
    liquidation_insurance_fee: bank.liquidation_insurance_fee,
    oracle_key_0: bank.config.oracle_keys.get(0n),
    group_admin: group.admin,
    banks: group.banks,
    risk_admin: group.risk_admin,
    rate_limiter_last_admin_update_seq: group.rate_limiter_last_admin_update_seq,
    global_fee_wallet: fee_state.global_fee_wallet,
    program_fee_rate: fee_state.program_fee_rate.value,
    order_init_flat_sol_fee: fee_state.order_init_flat_sol_fee,
  };
}

export function all(
  a: Account<Bank>,
  b: Account<BankMetadata>,
  c: Account<ExecuteOrderRecord>,
  d: Account<FeeState>,
  e: Account<LiquidationRecord>,
  f: Account<MarginfiAccount>,
  g: Account<MarginfiGroup>,
  h: Account<Order>,
  i: Account<RebalanceOrder>,
  j: Account<RebalanceRecord>,
  k: Account<SameAssetEmodeRegistry>,
  l: Account<StakedSettings>,
): void {}
