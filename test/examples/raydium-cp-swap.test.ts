// examples/raydium-cp-swap against Raydium CP-Swap as deployed on mainnet (test/programs/raydium_cp_swap.so). Both run in
// their own LiteSVM under the same program id with the same clock. Mints and token accounts are made by the same
// token-program instructions in both; the program's own accounts (the AmmConfig, a pool and its observation account)
// are written in both as the original lays them out, since creating a config needs Raydium's admin key. Every
// transaction must then have the same outcome, the same account bytes and the same events ("Program data:" lines).
import { getCreateAccountInstruction } from "@solana-program/system";
import * as token from "@solana-program/token";
import * as t22 from "@solana-program/token-2022";
import { type Address, type Instruction, type KeyPairSigner, AccountRole, address, generateKeyPairSigner, getAddressEncoder, lamports } from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from "litesvm";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, acct, deployFile, pda, send, type Deployed } from "../harness.js";

const PROGRAM = address("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
const ORIGINAL = fileURLToPath(new URL("../programs/raydium_cp_swap.so", import.meta.url));
const PORT = fileURLToPath(new URL("../../examples/raydium-cp-swap/raydium_cp_swap.ts", import.meta.url));
const TOKEN = address(token.TOKEN_PROGRAM_ADDRESS);
const TOKEN_2022 = address(t22.TOKEN_2022_PROGRAM_ADDRESS);
const MEMO = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

type Result = TransactionMetadata | FailedTransactionMetadata;
type Meta = { address: Address; signer?: KeyPairSigner; writable?: boolean };

const enc = getAddressEncoder();
const key = (a: Address) => Buffer.from(enc.encode(a));
const disc = (name: string) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
const u8 = (n: number) => Buffer.from([n]);
const u16 = (n: number) => Buffer.from(Uint16Array.of(n).buffer);
const u64 = (n: bigint) => Buffer.from(BigUint64Array.of(n).buffer);
const outcome = (r: Result) => (r instanceof FailedTransactionMetadata ? `error: ${String(r.err())}` : "ok");
const meta = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r);
const events = (r: Result) =>
  meta(r)
    .logs()
    .filter((l) => l.startsWith("Program data:"));

describe("examples/raydium-cp-swap against Raydium CP-Swap on mainnet", () => {
  let d: Deployed;
  let original: LiteSVM;
  const cu: Record<string, [bigint, bigint]> = {};
  let eventsCompared = 0;
  let compared = 0;
  beforeAll(async () => {
    d = await deployFile(PORT, { programId: PROGRAM });
    original = new LiteSVM();
    original.addProgramFromFile(PROGRAM, ORIGINAL);
    for (const vm of [original, d.svm]) {
      const clock = vm.getClock();
      clock.unixTimestamp = 1_800_000_000n;
      clock.epoch = 900n;
      vm.setClock(clock);
    }
  });
  const vms = () => [original, d.svm] as const;

  const ix = (name: string, args: Record<string, unknown>, accounts: Meta[]): Instruction => ({
    programAddress: PROGRAM,
    accounts: accounts.map((a) => ({
      address: a.address,
      role: a.signer ? (a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY,
      ...(a.signer ? { signer: a.signer } : {}),
    })) as Instruction["accounts"],
    data: new Uint8Array(d.coder.instruction.encode(name, args)),
  });
  const funded = async () => {
    const s = await generateKeyPairSigner();
    for (const vm of vms()) vm.airdrop(s.address, lamports(100_000_000_000n));
    return s;
  };
  const bytes = (vm: LiteSVM, a: Address) => {
    const acct = vm.getAccount(a);
    return acct.exists ? `${acct.lamports} ${acct.programAddress} ${Buffer.from(acct.data).toString("hex")}` : "missing";
  };
  /** Set up in both VMs (the same instructions); must succeed in both. */
  const setup = async (payer: KeyPairSigner, ixs: Instruction[]) => {
    for (const vm of vms()) {
      const r = await send(vm, payer, ixs);
      if (r instanceof FailedTransactionMetadata) throw new Error(`setup failed: ${String(r.err())}\n${r.meta().logs().join("\n")}`);
    }
  };
  /** Send to both: the same outcome, account bytes and events. */
  const both = async (label: string, payer: KeyPairSigner, ixs: Instruction[], watch: Address[]) => {
    const [a, b] = [await send(original, payer, ixs), await send(d.svm, payer, ixs)];
    compared++;
    const logs = (r: Result) => meta(r).logs().join("\n");
    expect(outcome(b), `${label}\noriginal:\n${logs(a)}\nTypeSOL:\n${logs(b)}`).toBe(outcome(a));
    for (const w of watch) expect(bytes(d.svm, w), `${label}: ${w}`).toBe(bytes(original, w));
    if (!(a instanceof FailedTransactionMetadata)) {
      expect(events(b), `${label}: events`).toEqual(events(a));
      eventsCompared += events(a).length;
    }
    cu[label] = [meta(a).computeUnitsConsumed(), meta(b).computeUnitsConsumed()];
    return outcome(a);
  };
  const custom = (code: number) => `error: TransactionErrorInstructionError { index: 0, error: InstructionErrorCustom { code: ${code} } }`;

  /** A mint of `program` (Token-2022 with a transfer fee when `fee` is given), authority `payer`. */
  async function mint(payer: KeyPairSigner, program: Address, decimals: number, fee?: { bps: number; max: bigint }) {
    const m = await generateKeyPairSigner();
    const feeExt = fee && {
      __kind: "TransferFeeConfig" as const,
      transferFeeConfigAuthority: payer.address,
      withdrawWithheldAuthority: payer.address,
      withheldAmount: 0n,
      olderTransferFee: { epoch: 0n, maximumFee: fee.max, transferFeeBasisPoints: fee.bps },
      newerTransferFee: { epoch: 0n, maximumFee: fee.max, transferFeeBasisPoints: fee.bps },
    };
    const space = feeExt ? t22.getMintSize([feeExt]) : 82;
    await setup(payer, [
      getCreateAccountInstruction({ payer, newAccount: m, lamports: original.minimumBalanceForRentExemption(BigInt(space)), space, programAddress: program }),
      ...(feeExt
        ? [
            t22.getInitializeTransferFeeConfigInstruction({
              mint: m.address,
              transferFeeConfigAuthority: payer.address,
              withdrawWithheldAuthority: payer.address,
              transferFeeBasisPoints: fee!.bps,
              maximumFee: fee!.max,
            }),
          ]
        : []),
      (program === TOKEN ? token.getInitializeMint2Instruction : t22.getInitializeMint2Instruction)({ mint: m.address, decimals, mintAuthority: payer.address }) as Instruction,
    ]);
    return { address: m.address, program, decimals, fee };
  }
  type MintInfo = Awaited<ReturnType<typeof mint>>;
  /** A token account of `m` owned by `owner`, holding `amount` (minted by `payer`, the mint authority). */
  async function account(payer: KeyPairSigner, m: MintInfo, owner: Address, amount: bigint) {
    const a = await generateKeyPairSigner();
    const space = m.fee ? t22.getTokenSize([{ __kind: "TransferFeeAmount", withheldAmount: 0n }]) : 165;
    const init = (m.program === TOKEN ? token.getInitializeAccount3Instruction : t22.getInitializeAccount3Instruction)({ account: a.address, mint: m.address, owner });
    const mintTo = (m.program === TOKEN ? token.getMintToInstruction : t22.getMintToInstruction)({ mint: m.address, token: a.address, mintAuthority: payer, amount });
    await setup(payer, [
      getCreateAccountInstruction({ payer, newAccount: a, lamports: original.minimumBalanceForRentExemption(BigInt(space)), space, programAddress: m.program }),
      init as Instruction,
      ...(amount > 0n ? [mintTo as Instruction] : []),
    ]);
    return a.address;
  }
  /** Write a program-owned account in both VMs. */
  const write = (addr: Address, data: Buffer) => {
    for (const vm of vms())
      vm.setAccount({ address: addr, data: new Uint8Array(data), executable: false, lamports: lamports(vm.minimumBalanceForRentExemption(BigInt(data.length))), programAddress: PROGRAM, space: BigInt(data.length) });
  };

  /** A pool as the original's initialize leaves it, with `reserve0` / `reserve1` in its vaults. */
  async function pool(
    opts: {
      fee0?: { bps: number; max: bigint };
      fee1?: { bps: number; max: bigint };
      /** Token-2022 mints without a transfer fee. */
      t22?: boolean;
      tradeFee?: bigint;
      status?: number;
      reserve0?: bigint;
      reserve1?: bigint;
      /** The creator fee on, at `rate`, taken as `on` says (0 the input's token, 1 token_0, 2 token_1). */
      creatorFee?: { rate: bigint; on: number };
      /** The observation ring at its last slot, with a cumulative price about to wrap. */
      ringAtEnd?: boolean;
    } = {},
  ) {
    const admin = await funded();
    const protocolOwner = await funded();
    const fundOwner = await funded();
    const [authority, authBump] = await pda(PROGRAM, ["vault_and_lp_mint_auth_seed"]);
    let m0 = await mint(admin, opts.fee0 || opts.t22 ? TOKEN_2022 : TOKEN, 6, opts.fee0);
    let m1 = await mint(admin, opts.fee1 || opts.t22 ? TOKEN_2022 : TOKEN, 9, opts.fee1);
    if (Buffer.compare(key(m0.address), key(m1.address)) > 0) [m0, m1] = [m1, m0];
    const index = Math.floor(Math.random() * 60_000);
    const [config, configBump] = await pda(PROGRAM, ["amm_config", u16(index).reverse()]);
    write(
      config,
      Buffer.concat([
        disc("AmmConfig"),
        u8(configBump),
        u8(0),
        u16(index),
        u64(opts.tradeFee ?? 2500n),
        u64(120_000n),
        u64(40_000n),
        u64(0n),
        key(protocolOwner.address),
        key(fundOwner.address),
        u64(opts.creatorFee?.rate ?? 0n),
        u64(0n),
        Buffer.alloc(8 * 14),
      ]),
    );
    const [poolKey] = await pda(PROGRAM, ["pool", config, m0.address, m1.address]);
    const [lp] = await pda(PROGRAM, ["pool_lp_mint", poolKey]);
    const [observation] = await pda(PROGRAM, ["observation", poolKey]);
    // The LP mint at its PDA (its authority the pool authority), and the two vaults (accounts owned by the authority).
    const lpMint = await mint(admin, TOKEN, 9);
    const reserve0 = opts.reserve0 ?? 1_000_000_000n;
    const reserve1 = opts.reserve1 ?? 4_000_000_000_000n;
    const vault0 = await account(admin, m0, authority, reserve0);
    const vault1 = await account(admin, m1, authority, reserve1);
    const liquidity = BigInt(Math.floor(Math.sqrt(Number(reserve0) * Number(reserve1))));
    // Move the LP mint's bytes to its PDA with the pool authority as mint authority and the supply minted so far.
    for (const vm of vms()) {
      const src = acct(vm, lpMint.address);
      const data = Buffer.from(src.data);
      data.set(Buffer.concat([u8(1), u8(0), u8(0), u8(0), key(authority)]), 0); // mint_authority: Some(authority)
      data.writeBigUInt64LE(liquidity, 36); // supply
      vm.setAccount({ address: lp, data: new Uint8Array(data), executable: false, lamports: lamports(src.lamports), programAddress: TOKEN, space: BigInt(data.length) });
    }
    const pv = Buffer.concat([
      disc("PoolState"),
      key(config),
      key(admin.address),
      key(vault0),
      key(vault1),
      key(lp),
      key(m0.address),
      key(m1.address),
      key(m0.program),
      key(m1.program),
      key(observation),
      u8(authBump),
      u8(opts.status ?? 0),
      u8(9),
      u8(m0.decimals),
      u8(m1.decimals),
      u64(liquidity),
      u64(0n),
      u64(0n),
      u64(0n),
      u64(0n),
      u64(0n), // open_time
      u64(900n),
      u8(opts.creatorFee?.on ?? 0),
      u8(opts.creatorFee ? 1 : 0),
      Buffer.alloc(6),
      u64(0n),
      u64(0n),
      Buffer.alloc(8 * 28),
    ]);
    write(poolKey, pv);
    const ring = Buffer.alloc(40 * 100);
    let lastUpdate = 0n;
    if (opts.ringAtEnd) {
      // Slot 99 written 100 s ago, its cumulative token_0 price 10 below u128::MAX: the next point wraps both.
      lastUpdate = original.getClock().unixTimestamp - 100n;
      ring.writeBigUInt64LE(lastUpdate, 99 * 40);
      ring.writeBigUInt64LE(2n ** 64n - 10n, 99 * 40 + 8);
      ring.writeBigUInt64LE(2n ** 64n - 1n, 99 * 40 + 16);
      ring.writeBigUInt64LE(5n, 99 * 40 + 24);
    }
    write(
      observation,
      Buffer.concat([disc("ObservationState"), u8(opts.ringAtEnd ? 1 : 0), u16(opts.ringAtEnd ? 99 : 0), key(poolKey), ring, u64(lastUpdate), Buffer.alloc(24)]),
    );
    return { admin, protocolOwner, fundOwner, authority, config, pool: poolKey, lp, observation, m0, m1, vault0, vault1, liquidity };
  }
  type Pool = Awaited<ReturnType<typeof pool>>;

  /** A trader holding both tokens and an LP account. */
  async function trader(p: Pool, amount0 = 50_000_000n, amount1 = 200_000_000_000n) {
    const t = await funded();
    const a0 = await account(p.admin, p.m0, t.address, amount0);
    const a1 = await account(p.admin, p.m1, t.address, amount1);
    const lp = await account(p.admin, { address: p.lp, program: TOKEN, decimals: 9, fee: undefined }, t.address, 0n);
    return { signer: t, a0, a1, lp };
  }
  type Trader = Awaited<ReturnType<typeof trader>>;

  const swap = (name: "swap_base_input" | "swap_base_output", p: Pool, t: Trader, zeroForOne: boolean, x: bigint, y: bigint) => {
    const [inM, outM] = zeroForOne ? [p.m0, p.m1] : [p.m1, p.m0];
    const [inA, outA] = zeroForOne ? [t.a0, t.a1] : [t.a1, t.a0];
    const [inV, outV] = zeroForOne ? [p.vault0, p.vault1] : [p.vault1, p.vault0];
    const args = name === "swap_base_input" ? { amount_in: new BN(x.toString()), minimum_amount_out: new BN(y.toString()) } : { max_amount_in: new BN(x.toString()), amount_out: new BN(y.toString()) };
    return ix(name, args, [
      { address: t.signer.address, signer: t.signer },
      { address: p.authority },
      { address: p.config },
      { address: p.pool, writable: true },
      { address: inA, writable: true },
      { address: outA, writable: true },
      { address: inV, writable: true },
      { address: outV, writable: true },
      { address: inM.program },
      { address: outM.program },
      { address: inM.address },
      { address: outM.address },
      { address: p.observation, writable: true },
    ]);
  };
  const liquidity = (name: "deposit" | "withdraw", p: Pool, t: Trader, lpAmount: bigint, a: bigint, b: bigint) => {
    const args =
      name === "deposit"
        ? { lp_token_amount: new BN(lpAmount.toString()), maximum_token_0_amount: new BN(a.toString()), maximum_token_1_amount: new BN(b.toString()) }
        : { lp_token_amount: new BN(lpAmount.toString()), minimum_token_0_amount: new BN(a.toString()), minimum_token_1_amount: new BN(b.toString()) };
    return ix(name, args, [
      { address: t.signer.address, signer: t.signer },
      { address: p.authority },
      { address: p.pool, writable: true },
      { address: t.lp, writable: true },
      { address: t.a0, writable: true },
      { address: t.a1, writable: true },
      { address: p.vault0, writable: true },
      { address: p.vault1, writable: true },
      { address: TOKEN },
      { address: TOKEN_2022 },
      { address: p.m0.address },
      { address: p.m1.address },
      { address: p.lp, writable: true },
      ...(name === "withdraw" ? [{ address: MEMO }] : []),
    ]);
  };
  const watchAll = (p: Pool, t: Trader) => [p.pool, p.observation, p.vault0, p.vault1, p.lp, t.a0, t.a1, t.lp];

  it("swaps both ways, by input and by output, as the original (SPL Token pool)", async () => {
    const p = await pool();
    const t = await trader(p);
    expect(await both("swap_base_input 0→1", t.signer, [swap("swap_base_input", p, t, true, 1_000_000n, 1n)], watchAll(p, t))).toBe("ok");
    expect(await both("swap_base_input 1→0", t.signer, [swap("swap_base_input", p, t, false, 7_000_000_000n, 1n)], watchAll(p, t))).toBe("ok");
    // The clock moves on: the observation ring records a new point.
    for (const vm of vms()) {
      const c = vm.getClock();
      c.unixTimestamp += 20n;
      vm.setClock(c);
    }
    expect(await both("swap_base_output 0→1", t.signer, [swap("swap_base_output", p, t, true, 10_000_000n, 3_000_000_000n)], watchAll(p, t))).toBe("ok");
    expect(await both("swap_base_output 1→0", t.signer, [swap("swap_base_output", p, t, false, 9_000_000_000n, 500_000n)], watchAll(p, t))).toBe("ok");
    // Slippage and zero amounts.
    expect(await both("slippage (input)", t.signer, [swap("swap_base_input", p, t, true, 1_000_000n, 10n ** 15n)], watchAll(p, t))).toBe(custom(6005));
    expect(await both("slippage (output)", t.signer, [swap("swap_base_output", p, t, true, 1n, 3_000_000_000n)], watchAll(p, t))).toBe(custom(6005));
    expect(await both("zero in", t.signer, [swap("swap_base_input", p, t, true, 0n, 0n)], watchAll(p, t))).not.toBe("ok");
    expect(await both("zero out", t.signer, [swap("swap_base_output", p, t, true, 1_000n, 0n)], watchAll(p, t))).not.toBe("ok");
  });

  it("deposits and withdraws liquidity as the original", async () => {
    const p = await pool();
    const t = await trader(p);
    expect(await both("deposit", t.signer, [liquidity("deposit", p, t, 1_000_000n, 10n ** 12n, 10n ** 15n)], watchAll(p, t))).toBe("ok");
    expect(await both("withdraw half", t.signer, [liquidity("withdraw", p, t, 500_000n, 0n, 0n)], watchAll(p, t))).toBe("ok");
    expect(await both("deposit slippage", t.signer, [liquidity("deposit", p, t, 1_000_000n, 1n, 1n)], watchAll(p, t))).toBe(custom(6005));
    expect(await both("withdraw more than held", t.signer, [liquidity("withdraw", p, t, 10n ** 9n, 0n, 0n)], watchAll(p, t))).not.toBe("ok");
    expect(await both("withdraw slippage", t.signer, [liquidity("withdraw", p, t, 100_000n, 10n ** 15n, 0n)], watchAll(p, t))).toBe(custom(6005));
    expect(await both("deposit zero", t.signer, [liquidity("deposit", p, t, 0n, 1n, 1n)], watchAll(p, t))).not.toBe("ok");
  });

  it("collects protocol and fund fees for their owners only", async () => {
    const p = await pool();
    const t = await trader(p);
    for (let i = 0; i < 3; i++) await both(`fee swap ${i}`, t.signer, [swap("swap_base_input", p, t, i % 2 === 0, i % 2 === 0 ? 5_000_000n : 20_000_000_000n, 1n)], watchAll(p, t));
    const collect = (name: "collect_protocol_fee" | "collect_fund_fee", owner: KeyPairSigner, r0: Address, r1: Address) =>
      ix(name, { amount_0_requested: new BN("18446744073709551615"), amount_1_requested: new BN("18446744073709551615") }, [
        { address: owner.address, signer: owner },
        { address: p.authority },
        { address: p.pool, writable: true },
        { address: p.config },
        { address: p.vault0, writable: true },
        { address: p.vault1, writable: true },
        { address: p.m0.address },
        { address: p.m1.address },
        { address: r0, writable: true },
        { address: r1, writable: true },
        { address: TOKEN },
        { address: TOKEN_2022 },
      ]);
    const r0 = await account(p.admin, p.m0, p.protocolOwner.address, 0n);
    const r1 = await account(p.admin, p.m1, p.protocolOwner.address, 0n);
    const watch = [p.pool, p.vault0, p.vault1, r0, r1];
    expect(await both("protocol fee by a stranger", t.signer, [collect("collect_protocol_fee", t.signer, r0, r1)], watch)).toBe(custom(6001));
    expect(await both("protocol fee", p.protocolOwner, [collect("collect_protocol_fee", p.protocolOwner, r0, r1)], watch)).toBe("ok");
    expect(await both("fund fee by the protocol owner", p.protocolOwner, [collect("collect_fund_fee", p.protocolOwner, r0, r1)], watch)).toBe(custom(6001));
    expect(await both("fund fee", p.fundOwner, [collect("collect_fund_fee", p.fundOwner, r0, r1)], watch)).toBe("ok");
  });

  it("swaps and provides liquidity through Token-2022 transfer fees as the original", async () => {
    const p = await pool({ fee0: { bps: 150, max: 1_000_000n }, fee1: { bps: 37, max: 10n ** 12n } });
    const t = await trader(p);
    expect(await both("t22 swap_base_input 0→1", t.signer, [swap("swap_base_input", p, t, true, 3_000_000n, 1n)], watchAll(p, t))).toBe("ok");
    expect(await both("t22 swap_base_output 1→0", t.signer, [swap("swap_base_output", p, t, false, 50_000_000_000n, 777_777n)], watchAll(p, t))).toBe("ok");
    expect(await both("t22 deposit", t.signer, [liquidity("deposit", p, t, 2_000_000n, 10n ** 12n, 10n ** 15n)], watchAll(p, t))).toBe("ok");
    expect(await both("t22 withdraw", t.signer, [liquidity("withdraw", p, t, 1_000_000n, 0n, 0n)], watchAll(p, t))).toBe("ok");
  });

  it("refuses wrong accounts and disabled pools as the original", async () => {
    const p = await pool();
    const t = await trader(p);
    const other = await pool();
    const ot = await trader(other);
    // Another pool's vaults with this pool, another config, another observation account.
    const mixed = swap("swap_base_input", p, t, true, 1_000_000n, 1n);
    const withAccount = (i: number, a: Address) => ({ ...mixed, accounts: mixed.accounts!.map((m, j) => (j === i ? { ...m, address: a } : m)) as Instruction["accounts"] });
    expect(await both("wrong config", t.signer, [withAccount(2, other.config)], watchAll(p, t))).toBe(custom(2012));
    expect(await both("wrong input vault", t.signer, [withAccount(6, other.vault0)], watchAll(p, t))).toBe(custom(2003));
    expect(await both("wrong observation", t.signer, [withAccount(12, other.observation)], watchAll(p, t))).toBe(custom(2012));
    expect(await both("wrong input mint", t.signer, [withAccount(10, p.m1.address)], watchAll(p, t))).toBe(custom(2012));
    expect(await both("same vault twice", t.signer, [withAccount(7, p.vault0)], watchAll(p, t))).not.toBe("ok");
    expect(await both("not the pool authority", t.signer, [withAccount(1, t.a0)], watchAll(p, t))).toBe(custom(2006));
    expect(await both("another trader's account", t.signer, [{ ...mixed, accounts: mixed.accounts!.map((m, j) => (j === 4 ? { ...m, address: ot.a0 } : m)) as Instruction["accounts"] }], watchAll(p, t))).not.toBe("ok");
    // Deposits into another pool's vaults; a wrong LP mint.
    const dep = liquidity("deposit", p, t, 1_000n, 10n ** 12n, 10n ** 15n);
    const depWith = (i: number, a: Address) => ({ ...dep, accounts: dep.accounts!.map((m, j) => (j === i ? { ...m, address: a } : m)) as Instruction["accounts"] });
    expect(await both("deposit: wrong vault", t.signer, [depWith(6, other.vault0)], watchAll(p, t))).not.toBe("ok");
    expect(await both("deposit: wrong LP mint", t.signer, [depWith(12, other.lp)], watchAll(p, t))).toBe(custom(6004));
    expect(await both("deposit: wrong token program", t.signer, [depWith(8, TOKEN_2022)], watchAll(p, t))).not.toBe("ok");
    // A pool with swaps disabled (status bit 2), deposits disabled (bit 0).
    const off = await pool({ status: 5 });
    const ofT = await trader(off);
    expect(await both("swaps disabled", ofT.signer, [swap("swap_base_input", off, ofT, true, 1_000_000n, 1n)], watchAll(off, ofT))).toBe(custom(6000));
    expect(await both("deposits disabled", ofT.signer, [liquidity("deposit", off, ofT, 1_000n, 10n ** 12n, 10n ** 15n)], watchAll(off, ofT))).toBe(custom(6000));
    // update_pool_status needs Raydium's admin.
    const status = ix("update_pool_status", { status: 0 }, [{ address: t.signer.address, signer: t.signer }, { address: off.pool, writable: true }]);
    expect(await both("update_pool_status by a stranger", t.signer, [status], [off.pool])).toBe(custom(2012));
    // The configuration instructions need it too.
    const [newConfig] = await pda(PROGRAM, ["amm_config", u16(7).reverse()]);
    const create = ix(
      "create_amm_config",
      { index: 7, trade_fee_rate: new BN(2500), protocol_fee_rate: new BN(0), fund_fee_rate: new BN(0), create_pool_fee: new BN(0), creator_fee_rate: new BN(0) },
      [{ address: t.signer.address, signer: t.signer, writable: true }, { address: newConfig, writable: true }, { address: address("11111111111111111111111111111111") }],
    );
    expect(await both("create_amm_config by a stranger", t.signer, [create], [newConfig])).toBe(custom(6001));
    const update = ix("update_amm_config", { param: 0, value: new BN(1) }, [{ address: t.signer.address, signer: t.signer }, { address: p.config, writable: true }]);
    expect(await both("update_amm_config by a stranger", t.signer, [update], [p.config])).toBe(custom(6001));
  });

  it("records prices in the observation ring: a new point, the same point within 15 s, and the wrap at the end", async () => {
    const p = await pool();
    const t = await trader(p);
    const tick = (s: bigint) => {
      for (const vm of vms()) {
        const c = vm.getClock();
        c.unixTimestamp += s;
        vm.setClock(c);
      }
    };
    expect(await both("oracle: first point", t.signer, [swap("swap_base_input", p, t, true, 1_000_000n, 1n)], watchAll(p, t))).toBe("ok");
    tick(5n);
    expect(await both("oracle: within 15 s", t.signer, [swap("swap_base_input", p, t, false, 4_000_000_000n, 1n)], watchAll(p, t))).toBe("ok");
    tick(30n);
    expect(await both("oracle: next point", t.signer, [swap("swap_base_input", p, t, true, 1_000_000n, 1n)], watchAll(p, t))).toBe("ok");
    const end = await pool({ ringAtEnd: true });
    const te = await trader(end);
    expect(await both("oracle: wrap to slot 0", te.signer, [swap("swap_base_input", end, te, true, 1_000_000n, 1n)], watchAll(end, te))).toBe("ok");
  });

  it("takes the creator fee as the pool says: from the input, only token_0, only token_1", async () => {
    for (const on of [0, 1, 2]) {
      const p = await pool({ creatorFee: { rate: 500n, on } });
      const t = await trader(p);
      expect(await both(`creator fee ${on}: input 0→1`, t.signer, [swap("swap_base_input", p, t, true, 2_000_000n, 1n)], watchAll(p, t))).toBe("ok");
      expect(await both(`creator fee ${on}: input 1→0`, t.signer, [swap("swap_base_input", p, t, false, 8_000_000_000n, 1n)], watchAll(p, t))).toBe("ok");
      expect(await both(`creator fee ${on}: output 0→1`, t.signer, [swap("swap_base_output", p, t, true, 10_000_000n, 1_000_000_000n)], watchAll(p, t))).toBe("ok");
      expect(await both(`creator fee ${on}: output 1→0`, t.signer, [swap("swap_base_output", p, t, false, 9_000_000_000n, 300_000n)], watchAll(p, t))).toBe("ok");
    }
  });

  it("trades Token-2022 mints without a transfer fee as the original", async () => {
    const p = await pool({ t22: true });
    const t = await trader(p);
    expect(await both("plain t22 swap_base_output", t.signer, [swap("swap_base_output", p, t, true, 10_000_000n, 1_000_000_000n)], watchAll(p, t))).toBe("ok");
    expect(await both("plain t22 deposit", t.signer, [liquidity("deposit", p, t, 1_000_000n, 10n ** 12n, 10n ** 15n)], watchAll(p, t))).toBe("ok");
    expect(await both("plain t22 zero out", t.signer, [swap("swap_base_output", p, t, true, 1_000n, 0n)], watchAll(p, t))).toBe(custom(2505));
  });

  it("reports compute units side by side", () => {
    const rows = Object.entries(cu).map(([k, [o, t]]) => `${k.padEnd(40)} ${String(o).padStart(8)} ${String(t).padStart(8)}`);
    console.log(["instruction".padEnd(40) + " original  TypeSOL", ...rows].join("\n"));
    expect(rows.length).toBeGreaterThan(0);
    expect(compared).toBe(59); // as docs/case-study-raydium-cp-swap.md says
    expect(eventsCompared).toBe(13 + 4 + 12 + 2); // one per successful swap, deposit and withdrawal, byte for byte
  });
});
