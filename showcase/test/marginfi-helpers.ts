// Marginfi's mainnet binary (test/programs/marginfi_v2.so) and showcase/mainnet/marginfi side by side, for the differential test
// (showcase/test/marginfi.test.ts) and the fuzzer (showcase/test/fuzz-marginfi.test.ts): instruction builders, bank
// configs, and writes into both of state the ported instructions cannot reach yet.
import { type Address, type Instruction, type KeyPairSigner, address, lamports } from "@solana/kit";
import { web3 } from "@anchor-lang/core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FailedTransactionMetadata } from "litesvm";
import * as t22 from "@solana-program/token-2022";
import { getCreateAccountInstruction } from "@solana-program/system";
import { BN, TOKEN_2022, TOKEN_PROGRAM, pda, send } from "../../test/harness.js";
import { SYSTEM, key, pairOf } from "./jito-helpers.js";

export const PROGRAM = address("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");
const SOURCE = fileURLToPath(new URL("../mainnet/marginfi/marginfi.ts", import.meta.url));
export const INSTRUCTIONS = address("Sysvar1nstructions1111111111111111111111111");
const BUDGET: Instruction = {
  programAddress: address("ComputeBudget111111111111111111111111111111"),
  accounts: [],
  data: Uint8Array.from([2, ...new Uint8Array(Uint32Array.of(1_400_000).buffer)]),
};

/** An I80F48 as Anchor's coder takes a WrappedI80F48: its 16 little-endian bytes. */
export const fx = (bits: bigint) => {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(bits & ((1n << 64n) - 1n), 0);
  b.writeBigInt64LE(bits >> 64n, 8);
  return { value: [...b] };
};
export const ONE = 1n << 48n;
/** n / d as I80F48 (truncated). */
export const ratio = (n: bigint, d: bigint) => (n * ONE) / d;
const pk = (a: Address) => new web3.PublicKey(a);
export const U32_MAX = 4294967295n;
type IdlType = string | { array: [IdlType, number] } | { defined: { name: string } };
const IDL = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/marginfi/marginfi.idl.json", import.meta.url)), "utf8")) as {
  types: { name: string; type: { kind: string; fields?: { name: string; type: IdlType }[] } }[];
};
const SIZES: Record<string, number> = { u8: 1, i8: 1, bool: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16, pubkey: 32 };
/** The size of a zero-copy type as the original lays it out (repr(C) without implicit padding; unit enums are a u8). */
const sizeOf = (t: IdlType): number => {
  if (typeof t === "string") return SIZES[t]!;
  if ("array" in t) return sizeOf(t.array[0]) * t.array[1];
  const d = IDL.types.find((x) => x.name === t.defined.name)!;
  return d.type.kind === "enum" ? 1 : d.type.fields!.reduce((n, f) => n + sizeOf(f.type), 0);
};
/**
 * The byte offset of `path` in an account of type `account`, discriminator included: fields separated by dots, an
 * array element as `name[i]` (`lending_account.balances[3].asset_shares`).
 */
export const offsetOf = (account: string, path: string) => {
  let at = 8;
  let type: IdlType = { defined: { name: account } };
  for (const part of path.split(".")) {
    const [, name, index] = /^(\w+)(?:\[(\d+)\])?$/.exec(part)!;
    const d = IDL.types.find((x) => x.name === (type as { defined: { name: string } }).defined.name)!;
    let found = false;
    for (const f of d.type.fields!) {
      if (f.name === name) {
        type = f.type;
        found = true;
        break;
      }
      at += sizeOf(f.type);
    }
    if (!found) throw new Error(`no field ${name} in ${d.name}`);
    if (index !== undefined) {
      const elem: IdlType = (type as { array: [IdlType, number] }).array[0];
      at += sizeOf(elem) * Number(index);
      type = elem;
    }
  }
  return at;
};
export const le = (n: bigint, bytes: number) => {
  const b = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) b[i] = Number((n >> BigInt(8 * i)) & 0xffn);
  return b;
};

export const PYTH_RECEIVER = address("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
export const SWITCHBOARD = address("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");
/** A Pyth update: spot and EMA pairs (EMA defaults to spot), Full or Partial; `len`, `disc`, `level` to break it. */
export type Pyth = {
  price: bigint;
  conf: bigint;
  expo: number;
  publishTime: bigint;
  emaPrice?: bigint;
  emaConf?: bigint;
  partial?: boolean;
  len?: number;
  disc?: number[];
  level?: number;
};
/** A Switchboard pull feed: result.value (the price × 10^18) and last_update_timestamp; `len`, `owner`, `disc` to break it. */
export type Swb = { value: bigint; lastUpdate: bigint; len?: number; owner?: Address; disc?: number[] };

/** A Pyth PriceUpdateV2 as Borsh lays it out (the verification level is one byte for Full, two for Partial). */
export const pythData = (p: Pyth) => {
  const d = Buffer.alloc(p.len ?? 134);
  const put = (b: Buffer, at: number) => b.copy(d, at, 0, Math.max(0, Math.min(b.length, d.length - at)));
  put(Buffer.from(p.disc ?? [34, 241, 35, 99, 157, 126, 244, 205]), 0);
  const m = p.partial ? 42 : 41;
  if (d.length > 40) d[40] = p.level ?? (p.partial ? 0 : 1);
  if (p.partial && d.length > 41) d[41] = 13;
  put(le(BigInt.asUintN(64, p.price), 8), m + 32);
  put(le(p.conf, 8), m + 40);
  put(le(BigInt.asUintN(32, BigInt(p.expo)), 4), m + 48);
  put(le(BigInt.asUintN(64, p.publishTime), 8), m + 52);
  put(le(BigInt.asUintN(64, p.publishTime - 1n), 8), m + 60);
  put(le(BigInt.asUintN(64, p.emaPrice ?? p.price), 8), m + 68);
  put(le(p.emaConf ?? p.conf, 8), m + 76);
  put(le(77n, 8), m + 84);
  return d;
};
/** A Switchboard PullFeedAccountData: the discriminator, last_update_timestamp at 2216 and result.value at 2264. */
export const swbData = (w: Swb) => {
  const d = Buffer.alloc(w.len ?? 3208);
  Buffer.from(w.disc ?? [196, 27, 108, 196, 10, 215, 219, 40]).copy(d, 0, 0, Math.min(8, d.length));
  if (d.length >= 2224) le(BigInt.asUintN(64, w.lastUpdate), 8).copy(d, 2216);
  if (d.length >= 2280) le(BigInt.asUintN(128, w.value), 16).copy(d, 2264);
  return d;
};

/** A bank config as lending_pool_add_bank takes it (BankConfigCompact), with the defaults of a plain collateral bank. */
export const bankConfig = (over: Record<string, unknown> = {}, ir: Record<string, unknown> = {}) => ({
  asset_weight_init: fx(ratio(1n, 2n)),
  asset_weight_maint: fx(ratio(6n, 10n)),
  liability_weight_init: fx(ratio(13n, 10n)),
  liability_weight_maint: fx(ratio(12n, 10n)),
  deposit_limit: new BN("1000000000000"),
  interest_rate_config: {
    insurance_fee_fixed_apr: fx(ratio(1n, 1000n)),
    insurance_ir_fee: fx(ratio(2n, 100n)),
    protocol_fixed_fee_apr: fx(ratio(1n, 100n)),
    protocol_ir_fee: fx(ratio(5n, 100n)),
    protocol_origination_fee: fx(0n),
    zero_util_rate: 0,
    hundred_util_rate: Number(U32_MAX / 2n),
    points: [
      { util: Number(U32_MAX / 2n), rate: Number(U32_MAX / 100n) },
      { util: Number((U32_MAX * 8n) / 10n), rate: Number(U32_MAX / 20n) },
      { util: 0, rate: 0 },
      { util: 0, rate: 0 },
      { util: 0, rate: 0 },
    ],
    ...ir,
  },
  operational_state: { Operational: {} },
  borrow_limit: new BN("1000000000000"),
  risk_tier: { Collateral: {} },
  asset_tag: 0,
  config_flags: 1,
  _pad0: [0, 0, 0, 0, 0],
  total_asset_value_init_limit: new BN(0),
  oracle_max_age: 60,
  oracle_max_confidence: 0,
  ...over,
});

/** BankConfigCompact as the test writes it. */
export type BankConfig = ReturnType<typeof bankConfig>;

/** The pair, its fee state and admin, and the builders: `load()` deploys both and funds the admin and fee wallet. */
export function marginfiPair() {
  const s = pairOf("marginfi_v2.so", SOURCE, PROGRAM);
  let feeState = undefined as unknown as Address;
  let admin = undefined as unknown as KeyPairSigner;
  let feeWallet = undefined as unknown as Address;
  /** Send to both with the most compute a transaction may use (the original's msg! logging is costly); compare. */
  const run = async (label: string, payer: KeyPairSigner, ixs: Instruction[], watch: Address[], failing: boolean | "if-panics" = false) => {
    const o = await s.both(label, payer, [BUDGET, ...ixs], watch, failing);
    if (process.env.MARGINFI_VERBOSE) console.log(`${label}: ${o.replace(/.*code: (\d+).*/, "$1")}`);
    return o;
  };
  const initFeeState = (payer: KeyPairSigner, wallet: Address) =>
    s.ix(
      "init_global_fee_state",
      {
        admin: pk(admin.address),
        fee_wallet: pk(wallet),
        bank_init_flat_sol_fee: 50_000,
        liquidation_flat_sol_fee: 70_000,
        order_init_flat_sol_fee: 90_000,
        program_fee_fixed: fx(ratio(1n, 100n)),
        program_fee_rate: fx(ratio(5n, 100n)),
        liquidation_max_fee: fx(ratio(10n, 100n)),
        order_execution_max_fee: fx(ratio(3n, 100n)),
      },
      [{ address: payer.address, signer: payer, writable: true }, { address: feeState, writable: true }, { address: SYSTEM }],
    );
  const groupInit = (group: KeyPairSigner, by: KeyPairSigner, fee = feeState, sysvar: Address = INSTRUCTIONS) =>
    s.ix("marginfi_group_initialize", {}, [
      { address: group.address, signer: group, writable: true },
      { address: by.address, signer: by, writable: true },
      { address: fee },
      { address: SYSTEM },
      { address: sysvar },
    ]);
  const configure = (group: Address, by: KeyPairSigner, args: Partial<Record<string, Address | null>>, sysvar: Address = INSTRUCTIONS) =>
    s.ix(
      "marginfi_group_configure",
      Object.fromEntries(
        ["new_admin", "new_curve_admin", "new_limit_admin", "new_flow_admin", "new_emissions_admin", "new_metadata_admin"].map((k) => [
          k,
          args[k] ? pk(args[k]!) : null,
        ]),
      ),
      [{ address: group, writable: true }, { address: by.address, signer: by }, { address: sysvar }],
    );
  /** System AdvanceNonceAccount's data (4u32): the shape check_no_durable_nonce refuses; never executed here. */
  const advanceNonce = (payer: KeyPairSigner): Instruction => ({
    programAddress: SYSTEM,
    accounts: [{ address: payer.address, role: 3, signer: payer } as never],
    data: Uint8Array.from([4, 0, 0, 0]),
  });

  /** A mint of `program` (82 bytes, no extensions) with `decimals`, written straight into both. */
  const mint = async (program: Address, decimals: number) => {
    const m = (await s.key()).address;
    const data = Buffer.alloc(82);
    data.writeUInt32LE(1, 0);
    key(admin.address).copy(data, 4);
    data[44] = decimals;
    data[45] = 1;
    for (const vm of s.vms())
      vm.setAccount({ address: m, data: new Uint8Array(data), executable: false, lamports: lamports(1_461_600n), programAddress: program, space: 82n });
    return m;
  };
  /** The bank's PDAs: its three vaults and their authorities. */
  const vaults = async (bank: Address) => {
    const at = async (seed: string) => (await pda(PROGRAM, [seed, bank]))[0];
    return {
      liquidityAuth: await at("liquidity_vault_auth"),
      liquidity: await at("liquidity_vault"),
      insuranceAuth: await at("insurance_vault_auth"),
      insurance: await at("insurance_vault"),
      feeAuth: await at("fee_vault_auth"),
      fee: await at("fee_vault"),
    };
  };
  type Bank = { address: Address; signer?: KeyPairSigner; v: Awaited<ReturnType<typeof vaults>> };
  const addBank = async (
    group: Address,
    by: KeyPairSigner,
    m: Address,
    program: Address,
    config: ReturnType<typeof bankConfig>,
    opts: { seed?: bigint; wallet?: Address; payer?: KeyPairSigner } = {},
  ): Promise<[Instruction, Bank]> => {
    let bank: Bank;
    if (opts.seed === undefined) {
      const k = await s.key();
      bank = { address: k.address, signer: k, v: await vaults(k.address) };
    } else {
      const seed = Buffer.alloc(8);
      seed.writeBigUInt64LE(opts.seed);
      const [b] = await pda(PROGRAM, [group, m, new Uint8Array(seed)]);
      bank = { address: b, v: await vaults(b) };
    }
    const payer = opts.payer ?? admin;
    const accounts = [
      { address: group, writable: true },
      { address: by.address, signer: by },
      { address: payer.address, signer: payer, writable: true },
      { address: feeState },
      { address: opts.wallet ?? feeWallet, writable: true },
      { address: m },
      bank.signer ? { address: bank.address, signer: bank.signer, writable: true } : { address: bank.address, writable: true },
      { address: bank.v.liquidityAuth },
      { address: bank.v.liquidity, writable: true },
      { address: bank.v.insuranceAuth },
      { address: bank.v.insurance, writable: true },
      { address: bank.v.feeAuth },
      { address: bank.v.fee, writable: true },
      { address: program },
      { address: SYSTEM },
      { address: INSTRUCTIONS },
    ];
    const ix =
      opts.seed === undefined
        ? s.ix("lending_pool_add_bank", { bank_config: config }, accounts)
        : s.ix("lending_pool_add_bank_with_seed", { bank_config: config, bank_seed: new BN(opts.seed.toString()) }, accounts);
    return [ix, bank];
  };
  const watchBank = (b: Bank, group: Address) => [b.address, b.v.liquidity, b.v.insurance, b.v.fee, group, feeWallet, admin.address];
  const accrue = (group: Address, bank: Address) => s.ix("lending_pool_accrue_bank_interest", {}, [{ address: group }, { address: bank, writable: true }]);
  /** Write fields of an account in both (state the ported instructions cannot reach yet): [field path, value, bytes]. */
  const edit = (type: string) => (at: Address, fields: [string, bigint, number][]) => {
    for (const vm of s.vms()) {
      const a = vm.getAccount(at);
      if (!a.exists) throw new Error(`no ${type}`);
      const data = Buffer.from(a.data);
      for (const [path, value, bytes] of fields) le(value, bytes).copy(data, offsetOf(type, path));
      vm.setAccount({ ...a, address: at, data: new Uint8Array(data) });
    }
  };
  const editBank = edit("Bank");
  const editGroup = edit("MarginfiGroup");
  const setTime = (t: bigint) => {
    for (const vm of s.vms()) {
      const clock = vm.getClock();
      clock.unixTimestamp = t;
      vm.setClock(clock);
    }
  };

  /** BankConfigFast with every field None but those given. */
  const fast = (over: Record<string, unknown> = {}) => ({
    deposit_limit: null,
    borrow_limit: null,
    operational_state: null,
    interest_rate_config: null,
    total_asset_value_init_limit: null,
    permissionless_bad_debt_settlement: null,
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
    ...over,
  });
  /** InterestRateConfigOpt with every field None but those given. */
  const irOpt = (over: Record<string, unknown> = {}) => ({
    insurance_fee_fixed_apr: null,
    insurance_ir_fee: null,
    protocol_fixed_fee_apr: null,
    protocol_ir_fee: null,
    protocol_origination_fee: null,
    zero_util_rate: null,
    hundred_util_rate: null,
    points: null,
    ...over,
  });
  const sysvar = { address: INSTRUCTIONS };
  /** A token account of `m` owned by `owner` (165 bytes, SPL Token), written straight into both. */
  const tokenAccount = async (m: Address, owner: Address, amount = 0n, program: Address = TOKEN_PROGRAM) => {
    const a = (await s.key()).address;
    const data = Buffer.alloc(165);
    key(m).copy(data, 0);
    key(owner).copy(data, 32);
    data.writeBigUInt64LE(amount, 64);
    data[108] = 1;
    for (const vm of s.vms())
      vm.setAccount({ address: a, data: new Uint8Array(data), executable: false, lamports: lamports(2_039_280n), programAddress: program, space: 165n });
    return a;
  };
  /** A Token-2022 mint with a transfer fee (basis points, maximum), created through Token-2022 in both. */
  const feeMint = async (decimals: number, basisPoints: number, maximumFee: bigint) => {
    const m = await s.key();
    const exts = [
      {
        __kind: "TransferFeeConfig" as const,
        transferFeeConfigAuthority: admin.address,
        withdrawWithheldAuthority: admin.address,
        withheldAmount: 0n,
        olderTransferFee: { epoch: 0n, maximumFee, transferFeeBasisPoints: basisPoints },
        newerTransferFee: { epoch: 0n, maximumFee, transferFeeBasisPoints: basisPoints },
      },
    ];
    const space = t22.getMintSize(exts as never);
    const ixs = [
      getCreateAccountInstruction({
        payer: admin,
        newAccount: m,
        lamports: s.original.minimumBalanceForRentExemption(BigInt(space)),
        space,
        programAddress: TOKEN_2022,
      }),
      t22.getInitializeTransferFeeConfigInstruction({
        mint: m.address,
        transferFeeConfigAuthority: admin.address,
        withdrawWithheldAuthority: admin.address,
        transferFeeBasisPoints: basisPoints,
        maximumFee,
      }),
      t22.getInitializeMint2Instruction({ mint: m.address, decimals, mintAuthority: admin.address }) as Instruction,
    ];
    for (const vm of s.vms()) {
      const r = await send(vm, admin, ixs);
      if (r instanceof FailedTransactionMetadata) throw new Error(`fee mint: ${String(r.err())}`);
    }
    return m.address;
  };
  /** A Token-2022 token account of `m` (with its extensions' room) owned by `owner`, through Token-2022 in both. */
  const t22Account = async (m: Address, owner: Address, amount = 0n) => {
    const a = await s.key();
    const space = 182;
    const ixs: Instruction[] = [
      getCreateAccountInstruction({
        payer: admin,
        newAccount: a,
        lamports: s.original.minimumBalanceForRentExemption(BigInt(space)),
        space,
        programAddress: TOKEN_2022,
      }),
      t22.getInitializeAccount3Instruction({ account: a.address, mint: m, owner }) as Instruction,
    ];
    if (amount > 0n) ixs.push(t22.getMintToInstruction({ mint: m, token: a.address, mintAuthority: admin, amount }) as Instruction);
    for (const vm of s.vms()) {
      const r = await send(vm, admin, ixs);
      if (r instanceof FailedTransactionMetadata) throw new Error(`t22 account: ${String(r.err())}\n${r.meta().logs().join("\n")}`);
    }
    return a.address;
  };

  // Marginfi accounts and deposits.
  const accountInit = (group: Address, account: KeyPairSigner, authority: KeyPairSigner, payer: KeyPairSigner = authority) =>
    s.ix("marginfi_account_initialize", {}, [
      { address: group },
      { address: account.address, signer: account, writable: true },
      { address: authority.address, signer: authority },
      { address: payer.address, signer: payer, writable: true },
      { address: SYSTEM },
    ]);
  /** The PDA ["marginfi_account", group, authority, index (u16 LE), third-party id (u16 LE)]. */
  const accountPda = async (group: Address, authority: Address, index: number, thirdParty: number) =>
    (await pda(PROGRAM, ["marginfi_account", group, authority, new Uint8Array(le(BigInt(index), 2)), new Uint8Array(le(BigInt(thirdParty), 2))]))[0];
  const accountInitPda = (
    group: Address,
    account: Address,
    authority: KeyPairSigner,
    index: number,
    thirdParty: number | null,
    payer: KeyPairSigner = authority,
  ) =>
    s.ix("marginfi_account_initialize_pda", { account_index: index, third_party_id: thirdParty }, [
      { address: group },
      { address: account, writable: true },
      { address: authority.address, signer: authority },
      { address: payer.address, signer: payer, writable: true },
      { address: INSTRUCTIONS },
      { address: SYSTEM },
    ]);
  const accountClose = async (account: Address, authority: KeyPairSigner, payer: KeyPairSigner = authority) =>
    s.ix("marginfi_account_close", {}, [
      { address: account, writable: true },
      { address: authority.address, signer: authority },
      { address: payer.address, signer: payer, writable: true },
      { address: (await pda(PROGRAM, ["rebalance_fee_pool", account]))[0] },
    ]);
  const closeBalance = (group: Address, account: Address, authority: KeyPairSigner, bank: Address) =>
    s.ix("lending_account_close_balance", {}, [
      { address: group },
      { address: account, writable: true },
      { address: authority.address, signer: authority },
      { address: bank, writable: true },
    ]);
  const deposit = (
    group: Address,
    account: Address,
    authority: KeyPairSigner,
    bank: Address,
    from: Address,
    vault: Address,
    amount: bigint,
    opts: { upToLimit?: boolean | null; program?: Address; rest?: Address[] } = {},
  ): Instruction => {
    const ix = s.ix("lending_account_deposit", { amount: new BN(amount.toString()), deposit_up_to_limit: opts.upToLimit ?? null }, [
      { address: group },
      { address: account, writable: true },
      { address: authority.address, signer: authority },
      { address: bank, writable: true },
      { address: from, writable: true },
      { address: vault, writable: true },
      { address: opts.program ?? TOKEN_PROGRAM },
    ]);
    return { ...ix, accounts: [...ix.accounts!, ...(opts.rest ?? []).map((address) => ({ address, role: 0 }) as never)] };
  };

  const repay = (
    group: Address,
    account: Address,
    authority: KeyPairSigner,
    bank: Address,
    from: Address,
    vault: Address,
    amount: bigint,
    opts: { all?: boolean | null; program?: Address; rest?: Address[] } = {},
  ): Instruction => {
    const ix = s.ix("lending_account_repay", { amount: new BN(amount.toString()), repay_all: opts.all ?? null }, [
      { address: group },
      { address: account, writable: true },
      { address: authority.address, signer: authority },
      { address: bank, writable: true },
      { address: from, writable: true },
      { address: vault, writable: true },
      { address: opts.program ?? TOKEN_PROGRAM },
    ]);
    return { ...ix, accounts: [...ix.accounts!, ...(opts.rest ?? []).map((address) => ({ address, role: 0 }) as never)] };
  };
  /** The associated token account of `owner` for `m` under `program`. */
  const ata = async (owner: Address, m: Address, program: Address = TOKEN_PROGRAM) =>
    (await pda(address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"), [owner, program, m]))[0];
  /** A token account at a given address (an ATA, say), written into both. */
  const tokenAccountAt = (at: Address, m: Address, owner: Address, amount = 0n, program: Address = TOKEN_PROGRAM) => {
    const data = Buffer.alloc(165);
    key(m).copy(data, 0);
    key(owner).copy(data, 32);
    data.writeBigUInt64LE(amount, 64);
    data[108] = 1;
    for (const vm of s.vms())
      vm.setAccount({ address: at, data: new Uint8Array(data), executable: false, lamports: lamports(2_039_280n), programAddress: program, space: 165n });
    return at;
  };
  type BankRef = { address: Address; v: Awaited<ReturnType<typeof vaults>> };
  const withRest = (ix: Instruction, rest: Address[]): Instruction => ({
    ...ix,
    accounts: [...ix.accounts!, ...rest.map((address) => ({ address, role: 0 }) as never)],
  });
  const collectFees = (group: Address, bank: BankRef, feeAta: Address, program: Address = TOKEN_PROGRAM, rest: Address[] = []) =>
    withRest(
      s.ix("lending_pool_collect_bank_fees", {}, [
        { address: group },
        { address: bank.address, writable: true },
        { address: bank.v.liquidityAuth },
        { address: bank.v.liquidity, writable: true },
        { address: bank.v.insurance, writable: true },
        { address: bank.v.fee, writable: true },
        { address: feeState },
        { address: feeAta, writable: true },
        { address: program },
      ]),
      rest,
    );
  const withdrawVault = (
    which: "fees" | "insurance",
    group: Address,
    bank: BankRef,
    by: KeyPairSigner,
    dst: Address,
    amount: bigint,
    program: Address = TOKEN_PROGRAM,
    rest: Address[] = [],
  ) =>
    withRest(
      s.ix(which === "fees" ? "lending_pool_withdraw_fees" : "lending_pool_withdraw_insurance", { amount: new BN(amount.toString()) }, [
        { address: group },
        { address: bank.address },
        { address: by.address, signer: by },
        { address: which === "fees" ? bank.v.fee : bank.v.insurance, writable: true },
        { address: which === "fees" ? bank.v.feeAuth : bank.v.insuranceAuth },
        { address: dst, writable: true },
        { address: program },
        { address: INSTRUCTIONS },
      ]),
      rest,
    );
  const withdrawFeesPermissionless = (group: Address, bank: BankRef, dst: Address, amount: bigint, program: Address = TOKEN_PROGRAM, rest: Address[] = []) =>
    withRest(
      s.ix("lending_pool_withdraw_fees_permissionless", { amount: new BN(amount.toString()) }, [
        { address: group },
        { address: bank.address },
        { address: bank.v.fee, writable: true },
        { address: bank.v.feeAuth },
        { address: dst, writable: true },
        { address: program },
      ]),
      rest,
    );
  const updateFeesDestination = (group: Address, bank: Address, by: KeyPairSigner, dst: Address) =>
    s.ix("lending_pool_update_fees_destination_account", {}, [
      { address: group },
      { address: bank, writable: true },
      { address: by.address, signer: by },
      { address: dst },
      { address: INSTRUCTIONS },
    ]);

  /** The associated token account of `owner` for `m`, created through the ATA program in both. */
  const createAta = async (owner: Address, m: Address, program: Address = TOKEN_PROGRAM) => {
    const at = await ata(owner, m, program);
    const ix = t22.getCreateAssociatedTokenIdempotentInstruction({ payer: admin, ata: at, owner, mint: m, tokenProgram: program }) as Instruction;
    for (const vm of s.vms()) {
      const r = await send(vm, admin, [ix]);
      if (r instanceof FailedTransactionMetadata) throw new Error(`ata: ${String(r.err())}`);
    }
    return at;
  };

  /** An account written into both with this data and owner, rent-exempt. */
  const put = (at: Address, data: Buffer, owner: Address) => {
    for (const vm of s.vms())
      vm.setAccount({
        address: at,
        data: new Uint8Array(data),
        executable: false,
        lamports: lamports(vm.minimumBalanceForRentExemption(BigInt(data.length))),
        programAddress: owner,
        space: BigInt(data.length),
      });
  };
  const setPyth = (at: Address, p: Pyth) => put(at, pythData(p), PYTH_RECEIVER);
  const setSwb = (at: Address, w: Swb) => put(at, swbData(w), w.owner ?? SWITCHBOARD);
  /** The clock in both: its unix time and slot (the circuit breaker counts slots). */
  const setClock = (t: bigint, slot: bigint) => {
    for (const vm of s.vms()) {
      const c = vm.getClock();
      c.unixTimestamp = t;
      c.slot = slot;
      vm.setClock(c);
    }
  };
  const configureOracle = (
    group: Address,
    by: KeyPairSigner,
    bank: Address,
    setup: number,
    oracle: Address,
    rest: Address[] = [],
    sysvar: Address = INSTRUCTIONS,
  ) =>
    withRest(
      s.ix("lending_pool_configure_bank_oracle", { setup, oracle: pk(oracle) }, [
        { address: group },
        { address: by.address, signer: by },
        { address: bank, writable: true },
        { address: sysvar },
      ]),
      rest,
    );
  const setOraclePrice = (group: Address, by: KeyPairSigner, bank: Address, price: bigint, setup: number, rest: Address[] = []) =>
    withRest(
      s.ix("lending_pool_set_oracle_price", { price: fx(price), setup }, [
        { address: group },
        { address: by.address, signer: by },
        { address: bank, writable: true },
        { address: INSTRUCTIONS },
      ]),
      rest,
    );
  const withdraw = (
    group: Address,
    account: Address,
    authority: KeyPairSigner,
    bank: BankRef,
    to: Address,
    amount: bigint,
    opts: { all?: boolean | null; program?: Address; rest?: Address[] } = {},
  ) =>
    withRest(
      s.ix("lending_account_withdraw", { amount: new BN(amount.toString()), withdraw_all: opts.all ?? null }, [
        { address: group },
        { address: account, writable: true },
        { address: authority.address, signer: authority },
        { address: bank.address, writable: true },
        { address: to, writable: true },
        { address: bank.v.liquidityAuth },
        { address: bank.v.liquidity, writable: true },
        { address: opts.program ?? TOKEN_PROGRAM },
      ]),
      opts.rest ?? [],
    );
  const borrow = (
    group: Address,
    account: Address,
    authority: KeyPairSigner,
    bank: BankRef,
    to: Address,
    amount: bigint,
    opts: { program?: Address; rest?: Address[] } = {},
  ) =>
    withRest(
      s.ix("lending_account_borrow", { amount: new BN(amount.toString()) }, [
        { address: group },
        { address: account, writable: true },
        { address: authority.address, signer: authority },
        { address: bank.address, writable: true },
        { address: to, writable: true },
        { address: bank.v.liquidityAuth },
        { address: bank.v.liquidity, writable: true },
        { address: opts.program ?? TOKEN_PROGRAM },
      ]),
      opts.rest ?? [],
    );
  const pulseHealth = (account: Address, group: Address, rest: Address[] = []) =>
    withRest(s.ix("lending_account_pulse_health", {}, [{ address: account, writable: true }, { address: group }]), rest);
  const pulse = (group: Address, bank: Address, rest: Address[] = []) =>
    withRest(s.ix("lending_pool_pulse_bank_price_cache", {}, [{ address: group }, { address: bank, writable: true }]), rest);

  return {
    s,
    run,
    put,
    setPyth,
    setSwb,
    setClock,
    configureOracle,
    setOraclePrice,
    pulse,
    withdraw,
    borrow,
    pulseHealth,
    createAta,
    repay,
    ata,
    tokenAccountAt,
    collectFees,
    withdrawVault,
    withdrawFeesPermissionless,
    updateFeesDestination,
    async load() {
      await s.load();
      [feeState] = await pda(PROGRAM, ["feestate"]);
      admin = await s.funded();
      // A funded wallet: the flat fees paid into it are below the rent minimum of an empty account.
      feeWallet = (await s.funded(1n)).address;
    },
    get admin() {
      return admin;
    },
    get feeState() {
      return feeState;
    },
    get feeWallet() {
      return feeWallet;
    },
    initFeeState,
    groupInit,
    configure,
    advanceNonce,
    mint,
    vaults,
    addBank,
    watchBank,
    accrue,
    edit,
    editBank,
    editGroup,
    setTime,
    fast,
    irOpt,
    sysvar,
    tokenAccount,
    feeMint,
    t22Account,
    accountInit,
    accountPda,
    accountInitPda,
    accountClose,
    closeBalance,
    deposit,
  };
}
