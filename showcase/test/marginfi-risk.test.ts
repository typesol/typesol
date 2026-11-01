// Marginfi part 3 against the mainnet binary: withdrawals and borrows (lending_account_withdraw, lending_account_borrow)
// and the risk engine they run: Initial health over Pyth, Switchboard and fixed prices, the oracle errors it records or
// fails on, the isolated tier, e-mode, the deposit cap's discount, premiums, the liquidation tag, the circuit breaker's
// gate, rate limits, receivership and deleverage paths, origination fees, Token-2022. Most debts are written into both
// programs directly, to set up the withdrawals; the borrows make their own.
import { createHash } from "node:crypto";
import { type Address, type Instruction, type KeyPairSigner, generateKeyPairSigner, lamports } from "@solana/kit";
import { web3 } from "@anchor-lang/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BN, TOKEN_2022, TOKEN_PROGRAM, pda } from "../../test/harness.js";
import { SYSTEM, report } from "./jito-helpers.js";
import { INSTRUCTIONS, ONE, PROGRAM, U32_MAX, bankConfig, fx, marginfiPair, offsetOf, ratio } from "./marginfi-helpers.js";

type Bank = Awaited<ReturnType<ReturnType<typeof marginfiPair>["addBank"]>>[1];

describe("Marginfi v2 port against the mainnet binary: withdrawals, borrows and the risk engine", () => {
  const h = marginfiPair();
  const { s, run, initFeeState, groupInit, mint, addBank, editBank, editGroup, setPyth, setSwb, setClock } = h;
  let admin: KeyPairSigner;
  let group: KeyPairSigner;
  let t = 1_800_600_000n;
  let slot = 700_000_000n;
  const tick = (dt = 10n) => {
    t += dt;
    slot += 3n;
    setClock(t, slot);
  };
  const editAccount = h.edit("MarginfiAccount");
  const withRest = (ix: Instruction, rest: Address[]): Instruction => ({
    ...ix,
    accounts: [...ix.accounts!, ...rest.map((address) => ({ address, role: 0 }) as never)],
  });
  const keyBits = (a: Address) => BigInt("0x" + Buffer.from(new web3.PublicKey(a).toBytes()).reverse().toString("hex"));
  const keyBytes = (a: Address) => Buffer.from(new web3.PublicKey(a).toBytes());
  const data = (a: Address) => Buffer.from((s.original.getAccount(a) as { data: Uint8Array }).data);

  /** A bank and the oracle accounts that price it (none for a fixed price), refreshed before each transaction. */
  type Priced = Bank & { oracle: Address | null; kind: "pyth" | "swb" | "fixed"; price: bigint; decimals: number; mint: Address; program: Address };
  const banks: Priced[] = [];
  const refresh = () => {
    for (const b of banks) {
      if (b.kind === "pyth") setPyth(b.oracle!, { price: b.price, conf: b.price / 1000n, expo: -6, publishTime: t });
      if (b.kind === "swb") setSwb(b.oracle!, { value: b.price * 10n ** 12n, lastUpdate: t });
    }
  };
  const newBank = async (kind: Priced["kind"], price: bigint, over: Record<string, unknown> = {}, decimals = 6, program: Address = TOKEN_PROGRAM) => {
    const m = await mint(program, decimals);
    const [ix, b] = await addBank(group.address, admin, m, program, bankConfig(over));
    await run("add bank", admin, [ix], [b.address]);
    const oracle = kind === "fixed" ? null : (await generateKeyPairSigner()).address;
    const p: Priced = { ...b, oracle, kind, price, decimals, mint: m, program };
    banks.push(p);
    refresh();
    if (kind === "fixed") await run("fixed price", admin, [h.setOraclePrice(group.address, admin, b.address, (price * ONE) / 1_000_000n, 8)], [b.address]);
    else await run("oracle", admin, [h.configureOracle(group.address, admin, b.address, kind === "pyth" ? 3 : 4, oracle!, [oracle!])], [b.address]);
    return p;
  };
  const byAddress = (a: Address) => banks.find((b) => b.address === a)!;
  const byKind = (kind: Priced["kind"]) => banks.find((b) => b.kind === kind && b.program === TOKEN_PROGRAM)!;

  /**
   * The account's [bank, oracle] groups in balance order, leaving out `skip`: sorted by descending bank key, as the
   * balances are after a withdrawal or borrow sorts them, or (`asStored`) as they sit in the account now.
   */
  const healthAccounts = (account: Address, skip: Address[] = [], asStored = false) => {
    const d = data(account);
    const keys: Address[] = [];
    for (let i = 0; i < 16; i++) {
      const at = offsetOf("MarginfiAccount", `lending_account.balances[${i}].active`);
      if (d[at] === 0) continue;
      const k = d.subarray(at + 1, at + 33);
      const b = banks.find((x) => keyBytes(x.address).equals(k));
      if (b && !skip.includes(b.address)) keys.push(b.address);
    }
    if (!asStored) keys.sort((x, y) => Buffer.compare(keyBytes(y), keyBytes(x)));
    return keys.flatMap((k) => {
      const b = byAddress(k);
      return b.oracle ? [k, b.oracle] : [k];
    });
  };
  /** A liability written into both: `shares` owed to `bank` in a free (or the bank's) slot, the bank's total too. */
  const owe = (account: Address, bank: Priced, shares: bigint) => {
    const d = data(account);
    let slotIndex = -1;
    for (let i = 0; i < 16 && slotIndex < 0; i++) {
      const at = offsetOf("MarginfiAccount", `lending_account.balances[${i}].bank_pk`);
      if (d.subarray(at, at + 32).equals(keyBytes(bank.address))) slotIndex = i;
    }
    for (let i = 0; i < 16 && slotIndex < 0; i++) if (d[offsetOf("MarginfiAccount", `lending_account.balances[${i}].active`)] === 0) slotIndex = i;
    const b = `lending_account.balances[${slotIndex}]`;
    editAccount(account, [
      [`${b}.active`, 1n, 1],
      [`${b}.bank_pk`, keyBits(bank.address), 32],
      [`${b}.liability_shares`, shares, 16],
      [`${b}.last_update`, t, 8],
    ]);
    const bd = data(bank.address);
    const o = offsetOf("Bank", "total_liability_shares");
    const total = bd.readBigInt64LE(o + 8) * (1n << 64n) + bd.readBigUInt64LE(o);
    editBank(bank.address, [["total_liability_shares", total + shares, 16]]);
  };

  /** A user with a marginfi account and funded token accounts for each bank, deposits made through the port. */
  const user = async (deposits: [Priced, bigint][]) => {
    const u = await s.funded();
    const k = await generateKeyPairSigner();
    await run("account init", u, [h.accountInit(group.address, k, u)], [k.address]);
    const wallets = new Map<Address, Address>();
    for (const b of banks)
      wallets.set(
        b.address,
        b.program === TOKEN_2022 ? await h.t22Account(b.mint, u.address, 1n << 50n) : await h.tokenAccount(b.mint, u.address, 1n << 50n, b.program),
      );
    for (const [b, amount] of deposits) {
      refresh();
      await run(
        "deposit",
        u,
        [
          h.deposit(group.address, k.address, u, b.address, wallets.get(b.address)!, b.v.liquidity, amount, {
            program: b.program,
            rest: b.program === TOKEN_2022 ? [b.mint] : [],
          }),
        ],
        [k.address, b.address],
      );
    }
    return { owner: u, account: k.address, wallets };
  };
  type User = Awaited<ReturnType<typeof user>>;
  const w = (
    label: string,
    u: User,
    bank: Priced,
    amount: bigint,
    opts: { all?: boolean | null; rest?: Address[]; by?: KeyPairSigner; to?: Address; failing?: boolean | "if-panics"; skip?: Address[] } = {},
  ) => {
    refresh();
    const by = opts.by ?? u.owner;
    const to = opts.to ?? u.wallets.get(bank.address)!;
    const rest = opts.rest ?? [...(bank.program === TOKEN_2022 ? [bank.mint] : []), ...healthAccounts(u.account, opts.all ? [bank.address] : opts.skip)];
    return run(
      `withdraw: ${label}`,
      by,
      [h.withdraw(group.address, u.account, by, bank, to, amount, { all: opts.all ?? null, program: bank.program, rest })],
      [u.account, bank.address, bank.v.liquidity, bank.v.insurance, to, ...banks.map((b) => b.address)],
      opts.failing ?? false,
    );
  };

  const b = (
    label: string,
    u: User,
    bank: Priced,
    amount: bigint,
    opts: { rest?: Address[]; by?: KeyPairSigner; to?: Address; failing?: boolean | "if-panics"; extra?: Address[] } = {},
  ) => {
    refresh();
    const by = opts.by ?? u.owner;
    const to = opts.to ?? u.wallets.get(bank.address)!;
    // The health accounts after the borrow: the bank joins the account's balances if it is new there.
    const keys = new Set([...healthAccounts(u.account).filter((x) => banks.some((y) => y.address === x)), bank.address]);
    const sorted = [...keys].sort((x, y) => Buffer.compare(keyBytes(y), keyBytes(x)));
    const groups = sorted.flatMap((k) => {
      const p = byAddress(k);
      return p.oracle ? [k, p.oracle] : [k];
    });
    const rest = opts.rest ?? [...(bank.program === TOKEN_2022 ? [bank.mint] : []), ...groups, ...(opts.extra ?? [])];
    return run(
      `borrow: ${label}`,
      by,
      [h.borrow(group.address, u.account, by, bank, to, amount, { program: bank.program, rest })],
      [u.account, bank.address, bank.v.liquidity, to, ...banks.map((x) => x.address)],
      opts.failing ?? false,
    );
  };

  beforeAll(async () => {
    await h.load();
    admin = h.admin;
    await run("init fee state", admin, [initFeeState(admin, h.feeWallet)], [h.feeState]);
    group = await generateKeyPairSigner();
    setClock(t, slot);
    await run("group init", admin, [groupInit(group, admin)], [group.address]);
  });
  afterAll(() => report("marginfi-risk", s));

  it("takes deposits out, checking the account's health, as the original does", async () => {
    const usdc = await newBank("pyth", 1_000_000n);
    const sol = await newBank("swb", 150_000_000n, { asset_tag: 1 }, 9);
    const gold = await newBank("fixed", 2_000_000n);
    // Liquidity from another depositor.
    await user([
      [usdc, 500_000_000_000n],
      [sol, 500_000_000_000n],
      [gold, 500_000_000_000n],
    ]);
    const a = await user([
      [usdc, 1_000_000_000n],
      [sol, 10_000_000_000n],
    ]);

    // No liabilities: any amount up to the deposit, refusals in the original's order.
    tick();
    await w("part", a, usdc, 100_000_000n);
    await w("more than deposited", a, usdc, 2_000_000_000n);
    await w("no balance", a, gold, 1n);
    await w("not the authority", a, usdc, 1n, { by: admin });
    await w("wrong destination mint", a, usdc, 1n, { to: a.wallets.get(sol.address)! });
    editAccount(a.account, [["account_flags", 1n, 8]]);
    await w("disabled account", a, usdc, 1n);
    editAccount(a.account, [["account_flags", 64n, 8]]);
    await w("frozen account", a, usdc, 1n);
    editAccount(a.account, [["account_flags", 0n, 8]]);
    editBank(usdc.address, [["config.operational_state", 0n, 1]]);
    await w("paused bank", a, usdc, 1n);
    editBank(usdc.address, [["config.operational_state", 2n, 1]]);
    await w("reduce-only bank", a, usdc, 1n);
    editBank(usdc.address, [["config.operational_state", 1n, 1]]);
    await w("health accounts left out", a, usdc, 1n, { rest: [] });
    await w("an oracle left out", a, usdc, 1n, { rest: healthAccounts(a.account).slice(0, -1) });
    await w("banks out of order", a, usdc, 1n, { rest: [...healthAccounts(a.account).slice(2), ...healthAccounts(a.account).slice(0, 2)] });
    await w("extra accounts after", a, usdc, 1n, { rest: [...healthAccounts(a.account), gold.address] });

    // A liability: 500 USDC against 10 SOL ($1,500 at 0.5 initial weight = $750 against $650 at 1.3).
    const b = await user([[sol, 10_000_000_000n]]);
    owe(b.account, usdc, 500n * 1_000_000n * ONE);
    tick();
    await w("healthy after", b, sol, 500_000_000n);
    await w("unhealthy after", b, sol, 2_000_000_000n);
    await w("liability oracle left out", b, sol, 1n, { rest: healthAccounts(b.account).filter((x) => x !== usdc.oracle) });
    // A stale liability oracle fails; a stale collateral oracle skips the leg (recorded in the health cache).
    usdc.price = 1_000_000n;
    refresh();
    setPyth(usdc.oracle!, { price: 1_000_000n, conf: 1000n, expo: -6, publishTime: t - 100n });
    await run(
      "withdraw: stale liability oracle",
      b.owner,
      [h.withdraw(group.address, b.account, b.owner, sol, b.wallets.get(sol.address)!, 1n, { rest: healthAccounts(b.account) })],
      [b.account],
    );
    const c = await user([
      [sol, 10_000_000_000n],
      [gold, 1_000_000_000n],
    ]);
    owe(c.account, usdc, 100n * 1_000_000n * ONE);
    tick();
    refresh();
    setSwb(sol.oracle!, { value: sol.price * 10n ** 12n, lastUpdate: t - 1000n });
    await run(
      "withdraw: stale collateral oracle skipped",
      c.owner,
      [h.withdraw(group.address, c.account, c.owner, gold, c.wallets.get(gold.address)!, 1_000_000n, { rest: healthAccounts(c.account) })],
      [c.account, gold.address],
    );
    await run(
      "withdraw: stale collateral oracle, too much",
      c.owner,
      [h.withdraw(group.address, c.account, c.owner, gold, c.wallets.get(gold.address)!, 900_000_000n, { rest: healthAccounts(c.account) })],
      [c.account],
    );
    // An undecodable Pyth account: a collateral leg is skipped with nothing recorded (the error is not a custom code),
    // a liability fails with InternalLogicError.
    tick();
    refresh();
    setPyth(usdc.oracle!, { price: 1_000_000n, conf: 1000n, expo: -6, publishTime: t, len: 100 });
    await run(
      "withdraw: undecodable collateral oracle",
      a.owner,
      [h.withdraw(group.address, a.account, a.owner, sol, a.wallets.get(sol.address)!, 1_000n, { rest: healthAccounts(a.account) })],
      [a.account, sol.address],
    );
    await run(
      "withdraw: undecodable liability oracle",
      b.owner,
      [h.withdraw(group.address, b.account, b.owner, sol, b.wallets.get(sol.address)!, 1n, { rest: healthAccounts(b.account) })],
      [b.account],
    );
    // The confidence: Pyth's EMA (Initial) against its spot price.
    tick();
    refresh();
    setPyth(usdc.oracle!, { price: 1_000_000n, conf: 1000n, expo: -6, publishTime: t, emaPrice: 1_300_000n, emaConf: 200_000n });
    await run(
      "withdraw: EMA above the band",
      b.owner,
      [h.withdraw(group.address, b.account, b.owner, sol, b.wallets.get(sol.address)!, 1n, { rest: healthAccounts(b.account) })],
      [b.account],
    );

    // All of it: the balance closed, the fraction of a token to the insurance fund.
    tick();
    editBank(gold.address, [["asset_share_value", ONE + ONE / 3n, 16]]);
    await w("all", c, gold, 0n, { all: true });
    await w("all again", c, gold, 0n, { all: true });
    await w("all of a liability", b, usdc, 0n, { all: true });
  });

  it("applies tiers, e-mode, limits and the breaker as the original does", async () => {
    const usdc = await newBank("pyth", 1_000_000n);
    const sol = await newBank("swb", 150_000_000n, { asset_tag: 1 }, 9);
    const iso = await newBank("pyth", 2_000_000n, { risk_tier: { Isolated: {} }, asset_weight_init: fx(0n), asset_weight_maint: fx(0n) });
    await user([
      [usdc, 500_000_000_000n],
      [sol, 500_000_000_000n],
      [iso, 500_000_000_000n],
    ]);
    // Isolated: one liability only.
    const a = await user([[sol, 10_000_000_000n]]);
    owe(a.account, iso, 10n * 1_000_000n * ONE);
    owe(a.account, usdc, 10n * 1_000_000n * ONE);
    tick();
    await w("isolated and another liability", a, sol, 1n);
    // E-mode: the SOL bank's tag on the USDC bank's config lifts SOL's weight past the bank's own.
    const e = await user([[sol, 10_000_000_000n]]);
    owe(e.account, usdc, 900n * 1_000_000n * ONE);
    tick();
    await w("before e-mode", e, sol, 1n);
    editBank(sol.address, [["emode.emode_tag", 7n, 2]]);
    editBank(usdc.address, [
      ["emode.emode_config.entries[0].collateral_bank_emode_tag", 7n, 2],
      ["emode.emode_config.entries[0].asset_weight_init", ratio(9n, 10n), 16],
      ["emode.emode_config.entries[0].asset_weight_maint", ratio(95n, 100n), 16],
    ]);
    await w("with e-mode", e, sol, 1n);
    // The deposit cap: deposits past the bank's USD value count in proportion for Initial.
    editBank(sol.address, [["config.total_asset_value_init_limit", 1_000n, 8]]);
    await w("deposit cap discount", e, sol, 1n);
    editBank(sol.address, [["config.total_asset_value_init_limit", 0n, 8]]);
    // A paused collateral bank counts nothing for Initial.
    editBank(sol.address, [["config.operational_state", 2n, 1]]);
    await w("reduce-only collateral", e, sol, 1n);
    editBank(sol.address, [["config.operational_state", 1n, 1]]);

    // The breaker: a halted bank refuses withdrawals while the account owes; its gate refuses a jump.
    const cb = { cb_deviation_bps_tiers: [500, 1000, 2000], cb_tier_durations_seconds: [60, 300, 900], cb_escalation_window_mult: 2, cb_ema_alpha_bps: 1000 };
    tick();
    refresh();
    await run("pulse", admin, [h.pulse(group.address, sol.address, [sol.oracle!])], [sol.address]);
    await run(
      "breaker on",
      admin,
      [
        s.ix("lending_pool_configure_bank", { bank_config_opt: h.fast({ circuit_breaker_enabled: true, ...cb }) }, [
          { address: group.address },
          { address: admin.address, signer: admin },
          { address: sol.address, writable: true },
          { address: h.sysvar.address },
        ]),
      ],
      [sol.address],
    );
    const free = await user([[sol, 1_000_000_000n]]);
    tick();
    sol.price = 180_000_000n;
    await w("breaker gate: a jump", e, sol, 1n);
    sol.price = 150_000_000n;
    editBank(sol.address, [
      ["cb_tier", 1n, 1],
      ["cb_halt_ended_at", t + 1000n, 8],
    ]);
    await w("halted bank, owing", e, sol, 1n);
    await w("halted bank, owing nothing", free, sol, 1n);
    editBank(sol.address, [
      ["cb_tier", 0n, 1],
      ["cb_halt_ended_at", 0n, 8],
    ]);

    // Rate limits: the bank's hourly window, then the group's (which needs the bank's price up front).
    const r = await user([[usdc, 100_000_000n]]);
    tick();
    editBank(usdc.address, [
      ["rate_limiter.hourly.max_outflow", 1_000_000n, 8],
      ["rate_limiter.hourly.window_duration", 3600n, 8],
      ["rate_limiter.hourly.window_start", t, 8],
      ["rate_limiter.hourly.cur_window_outflow", 0n, 8],
    ]);
    await w("bank hourly limit, within", r, usdc, 600_000n);
    await w("bank hourly limit, past", r, usdc, 600_000n);
    editBank(usdc.address, [["rate_limiter.hourly.max_outflow", 0n, 8]]);
    editGroup(group.address, [
      ["rate_limiter.daily.max_outflow", 50n, 8],
      ["rate_limiter.daily.window_duration", 86400n, 8],
      ["rate_limiter.daily.window_start", t, 8],
    ]);
    await w("group daily limit, within", r, usdc, 10_000_000n);
    await w("group daily limit, past", r, usdc, 60_000_000n);
    await w("group limit, bank not among the accounts", r, usdc, 1n, { rest: [] });
    editGroup(group.address, [["rate_limiter.daily.max_outflow", 0n, 8]]);
  });

  it("follows receivership, deleverage and tokenless paths as the original does", async () => {
    const usdc = await newBank("pyth", 1_000_000n);
    const gold = await newBank("fixed", 2_000_000n);
    await user([
      [usdc, 500_000_000_000n],
      [gold, 500_000_000_000n],
    ]);
    const a = await user([
      [usdc, 1_000_000_000n],
      [gold, 1_000_000_000n],
    ]);
    // In receivership anyone may withdraw, with a price and no health check.
    editAccount(a.account, [["account_flags", 16n, 8]]);
    const liquidator = await s.funded();
    tick();
    await w("receivership, by a liquidator", a, usdc, 1_000_000n, { by: liquidator, to: a.wallets.get(usdc.address)! });
    await w("receivership, no price", a, usdc, 1_000_000n, { by: liquidator, rest: [] });
    await run("zero price", admin, [h.setOraclePrice(group.address, admin, gold.address, 0n, 8)], [gold.address]);
    await w("receivership, zero price", a, gold, 1_000_000n, { by: liquidator });
    editBank(usdc.address, [["config.asset_weight_init", 0n, 16]]);
    await w("receivership, zero weight", a, usdc, 1n, { by: liquidator });
    editBank(usdc.address, [["config.asset_weight_init", ratio(1n, 2n), 16]]);
    editAccount(a.account, [["account_flags", 0n, 8]]);
    await run("gold price back", admin, [h.setOraclePrice(group.address, admin, gold.address, 2n * ONE, 8)], [gold.address]);

    // Deleverage (under a receivership, which prices the bank): the day's withdrawn value against the group's daily
    // limit, reported. Without a price (deleverage alone) the value is 0.
    editAccount(a.account, [["account_flags", 32n, 8]]);
    await w("deleverage alone", a, usdc, 60_000_000n);
    editAccount(a.account, [["account_flags", 48n, 8]]);
    editGroup(group.address, [
      ["deleverage_withdraw_window_cache.daily_limit", 100n, 4],
      ["deleverage_withdraw_window_cache.withdrawn_today", 50n, 4],
      ["deleverage_withdraw_window_cache.last_daily_reset_timestamp", t, 8],
    ]);
    tick();
    await w("deleverage within the day's limit", a, usdc, 20_000_000n, { by: liquidator });
    await w("deleverage past the day's limit", a, usdc, 60_000_000n, { by: liquidator });
    editAccount(a.account, [["account_flags", 0n, 8]]);

    // A tokenless bank that finished repaying pays out what its vault holds.
    editBank(usdc.address, [["flags", 64n, 8]]);
    await w("tokenless done", a, usdc, 1_000n);
    editBank(usdc.address, [["flags", 0n, 8]]);
    // The liquidation tag clears when Maintenance health is positive.
    editAccount(a.account, [["liquidation_tagged_at", t - 100n, 8]]);
    tick();
    await w("tag cleared", a, usdc, 1_000n);
  });

  it("projects and refreshes premiums as the original does", async () => {
    const usdc = await newBank("pyth", 1_000_000n);
    const sol = await newBank("swb", 150_000_000n, { asset_tag: 1 }, 9);
    const gold = await newBank("fixed", 2_000_000n);
    await user([
      [usdc, 500_000_000_000n],
      [sol, 500_000_000_000n],
      [gold, 500_000_000_000n],
    ]);
    // The matrix: SOL (tag 5) and gold (tag 6) collateral against USDC (tag 9) debt; USDC premium-active.
    editGroup(group.address, [
      ["premium_settings.entry_count", 2n, 2],
      ["premium_entries[0].collateral_tag", 5n, 2],
      ["premium_entries[0].liability_tag", 9n, 2],
      ["premium_entries[0].rate", 40_000_000n, 4],
      ["premium_entries[1].collateral_tag", 6n, 2],
      ["premium_entries[1].liability_tag", 9n, 2],
      ["premium_entries[1].rate", 90_000_000n, 4],
    ]);
    editBank(sol.address, [["premium_tag", 5n, 2]]);
    editBank(gold.address, [["premium_tag", 6n, 2]]);
    editBank(usdc.address, [
      ["premium_tag", 9n, 2],
      ["flags", 8192n, 8],
      ["premium_activated_at", t - 10_000n, 8],
    ]);
    const a = await user([
      [sol, 5_000_000_000n],
      [gold, 500_000_000n],
    ]);
    owe(a.account, usdc, 200n * 1_000_000n * ONE);
    /** The USDC balance's premium rate snapshot in the original (MARGINFI_VERBOSE). */
    const snapshot = (label: string) => {
      if (!process.env.MARGINFI_VERBOSE) return;
      const d = data(a.account);
      for (let i = 0; i < 16; i++) {
        const at = offsetOf("MarginfiAccount", `lending_account.balances[${i}].bank_pk`);
        if (d.subarray(at, at + 32).equals(keyBytes(usdc.address)))
          console.log(`  ${label}: snapshot ${d.readUInt32LE(offsetOf("MarginfiAccount", `lending_account.balances[${i}].premium_rate_snapshot`))}`);
      }
    };
    tick(3600n);
    await w("premium rates from the mix", a, sol, 1_000_000_000n);
    snapshot("mix");
    tick(86_400n);
    await w("premium projected into health", a, sol, 1_000_000_000n);
    // An unpriceable collateral leg: the rates only ratchet up (to its full pair rate).
    tick(600n);
    refresh();
    setSwb(sol.oracle!, { value: sol.price * 10n ** 12n, lastUpdate: t - 1000n });
    await run(
      "withdraw: premium ratchet on a stale leg",
      a.owner,
      [h.withdraw(group.address, a.account, a.owner, gold, a.wallets.get(gold.address)!, 1_000_000n, { rest: healthAccounts(a.account) })],
      [a.account, gold.address, usdc.address],
    );
    snapshot("ratchet");
    // Premium inactive again: the receivable is written off.
    editBank(usdc.address, [["flags", 0n, 8]]);
    tick();
    await w("premium written off", a, gold, 1_000_000n);
    snapshot("written off");
  });

  it("checks an account with 16 positions, past 32 accounts, as the original does", async () => {
    // 16 banks priced by Pyth: 15 deposits and a debt, 8 + 32 accounts in the withdrawal.
    const many: Priced[] = [];
    for (let i = 0; i < 16; i++) many.push(await newBank("pyth", 1_000_000n + BigInt(i) * 10_000n));
    await user([[many[15]!, 100_000_000_000n]]);
    const a = await user(many.slice(0, 15).map((b) => [b, 10_000_000n] as [Priced, bigint]));
    owe(a.account, many[15]!, 52n * 1_000_000n * ONE);
    editAccount(a.account, [["liquidation_tagged_at", t - 100n, 8]]);
    tick();
    await w("16 positions", a, many[3]!, 1_000_000n);
    await w("16 positions, unhealthy", a, many[3]!, 9_000_000n);
    // In a flash loan the health check waits for the loan's end: nothing checked, the cache only reset.
    editAccount(a.account, [["account_flags", 2n, 8]]);
    await w("in a flash loan", a, many[4]!, 9_000_000n);
    await w("in a flash loan, no health accounts", a, many[5]!, 9_000_000n, { rest: [] });
    editAccount(a.account, [["account_flags", 0n, 8]]);
  });

  it("lends as the original does", async () => {
    const usdc = await newBank("pyth", 1_000_000n);
    const sol = await newBank("swb", 150_000_000n, { asset_tag: 1 }, 9);
    const gold = await newBank("fixed", 2_000_000n);
    const iso = await newBank("pyth", 3_000_000n, { risk_tier: { Isolated: {} }, asset_weight_init: fx(0n), asset_weight_maint: fx(0n) });
    await user([
      [usdc, 500_000_000_000n],
      [sol, 500_000_000_000n],
      [gold, 500_000_000_000n],
      [iso, 500_000_000_000n],
    ]);
    const a = await user([[sol, 10_000_000_000n]]);
    tick();
    // Against 10 SOL ($750 at Initial): borrows that fit, then one that does not.
    await b("USDC", a, usdc, 100_000_000n);
    await b("more USDC", a, usdc, 200_000_000n);
    await b("past health", a, usdc, 500_000_000n);
    await b("health accounts left out", a, usdc, 1n, { rest: [] });
    await b("not the authority", a, usdc, 1n, { by: admin });
    await b("against its own deposit", a, sol, 1_000_000n);
    await b("gold too", a, gold, 1_000_000n);
    // Refusals by account and bank state.
    editAccount(a.account, [["account_flags", 1n, 8]]);
    await b("disabled account", a, usdc, 1n);
    editAccount(a.account, [["account_flags", 16n, 8]]);
    await b("in receivership", a, usdc, 1n);
    editAccount(a.account, [["account_flags", 64n, 8]]);
    await b("frozen account", a, usdc, 1n);
    editAccount(a.account, [["account_flags", 0n, 8]]);
    for (const [label, state] of [
      ["paused bank", 0n],
      ["reduce-only bank", 2n],
      ["killed bank", 3n],
      ["borrowing-power reduce-only bank", 5n],
    ] as const) {
      editBank(usdc.address, [["config.operational_state", state, 1]]);
      await b(label, a, usdc, 1n);
    }
    editBank(usdc.address, [["config.operational_state", 1n, 1]]);
    editBank(usdc.address, [["flags", 32n, 8]]);
    await b("tokenless bank", a, usdc, 1n);
    editBank(usdc.address, [["flags", 0n, 8]]);
    editBank(usdc.address, [["config.borrow_limit", 350_000_000n, 8]]);
    await b("past the borrow limit", a, usdc, 100_000_000n);
    editBank(usdc.address, [["config.borrow_limit", 1_000_000_000_000n, 8]]);
    await b("more than the vault", a, gold, 900_000_000_000n);
    // A share worth two tokens: one token is half a share, which the original refuses as dust.
    const d = await user([[sol, 1_000_000_000n]]);
    editBank(gold.address, [["liability_share_value", 2n * ONE, 16]]);
    await b("dust shares", d, gold, 1n);
    editBank(gold.address, [["liability_share_value", ONE, 16]]);
    // Isolated: only one liability, and the account is flagged.
    const e = await user([[sol, 10_000_000_000n]]);
    await b("isolated", e, iso, 1_000_000n);
    await b("isolated and another", e, usdc, 1_000_000n);
    // Origination fees: the bank's, split with the program at the group's cached rate.
    editBank(usdc.address, [["config.interest_rate_config.protocol_origination_fee", ratio(1n, 100n), 16]]);
    await b("with an origination fee", a, usdc, 10_000_000n);
    editGroup(group.address, [["fee_state_cache.program_fee_rate", ratio(1n, 4n), 16]]);
    await b("origination fee split with the program", a, usdc, 10_000_000n);
    editBank(usdc.address, [["config.interest_rate_config.protocol_origination_fee", 0n, 16]]);
    // The group's rate limit prices the borrow after the health check; a fixed price of 0 cannot be limited.
    editGroup(group.address, [
      ["rate_limiter.daily.max_outflow", 50n, 8],
      ["rate_limiter.daily.window_duration", 86400n, 8],
      ["rate_limiter.daily.window_start", t, 8],
    ]);
    await b("group limit, within", a, usdc, 1_000_000n);
    await b("group limit, past", a, usdc, 60_000_000n);
    await run("gold at zero", admin, [h.setOraclePrice(group.address, admin, gold.address, 0n, 8)], [gold.address]);
    await b("group limit, a price of 0", a, gold, 1_000_000n);
    editGroup(group.address, [["rate_limiter.daily.max_outflow", 0n, 8]]);
    await run("gold back", admin, [h.setOraclePrice(group.address, admin, gold.address, 2n * ONE, 8)], [gold.address]);
    // Premium-active debt needs every collateral priced.
    editGroup(group.address, [
      ["premium_settings.entry_count", 1n, 2],
      ["premium_entries[0].collateral_tag", 5n, 2],
      ["premium_entries[0].liability_tag", 9n, 2],
      ["premium_entries[0].rate", 40_000_000n, 4],
    ]);
    editBank(sol.address, [["premium_tag", 5n, 2]]);
    editBank(usdc.address, [
      ["premium_tag", 9n, 2],
      ["flags", 8192n, 8],
      ["premium_activated_at", t - 100n, 8],
    ]);
    const g = await user([
      [sol, 10_000_000_000n],
      [gold, 1_000_000_000n],
    ]);
    tick();
    await b("premium-active debt", g, usdc, 10_000_000n);
    tick();
    refresh();
    setSwb(sol.oracle!, { value: sol.price * 10n ** 12n, lastUpdate: t - 1000n });
    await run(
      "borrow: premium-active debt, a stale collateral oracle",
      g.owner,
      [h.borrow(group.address, g.account, g.owner, usdc, g.wallets.get(usdc.address)!, 1_000_000n, { rest: healthAccounts(g.account) })],
      [g.account, usdc.address],
    );
    editBank(usdc.address, [["flags", 0n, 8]]);
    // The protocol paused.
    editGroup(group.address, [
      ["panic_state_cache.pause_flags", 1n, 1],
      ["panic_state_cache.pause_start_timestamp", t - 10n, 8],
    ]);
    await b("protocol paused", a, usdc, 1n);
    editGroup(group.address, [["panic_state_cache.pause_flags", 0n, 1]]);
  });

  it("pulses accounts' health as the original does", async () => {
    const usdc = await newBank("pyth", 1_000_000n);
    const sol = await newBank("swb", 150_000_000n, { asset_tag: 1 }, 9);
    const gold = await newBank("fixed", 2_000_000n);
    const iso = await newBank("pyth", 3_000_000n, { risk_tier: { Isolated: {} }, asset_weight_init: fx(0n), asset_weight_maint: fx(0n) });
    /** The original's health cache after a pulse (MARGINFI_VERBOSE): flags, the three error codes, liquidatable. */
    const cacheOf = (u: User) => {
      if (!process.env.MARGINFI_VERBOSE) return;
      const d = data(u.account);
      const at = (f: string) => offsetOf("MarginfiAccount", f);
      console.log(
        `  flags ${d.readUInt32LE(at("health_cache.flags"))} mrgn ${d.readUInt32LE(at("health_cache.mrgn_err"))} internal ${d.readUInt32LE(at("health_cache.internal_err"))} liq ${d.readUInt32LE(at("health_cache.internal_liq_err"))} bankruptcy ${d.readUInt32LE(at("health_cache.internal_bankruptcy_err"))} liquidatable ${d[at("indexer_flags.was_liquidatable")]} underwater ${d[at("indexer_flags.was_underwater")]} isolated ${d[at("indexer_flags.has_isolated")]} active30 ${d[at("indexer_flags.was_active_30d")]} tag ${d.readBigInt64LE(at("liquidation_tagged_at"))}`,
      );
    };
    const pulse = async (label: string, u: User, rest?: Address[]) => {
      refresh();
      await run(`pulse health: ${label}`, admin, [h.pulseHealth(u.account, group.address, rest ?? healthAccounts(u.account, [], true))], [u.account]);
      cacheOf(u);
    };
    const empty = await user([]);
    tick();
    await pulse("an empty account", empty);
    const a = await user([[sol, 10_000_000_000n]]);
    owe(a.account, usdc, 300n * 1_000_000n * ONE);
    await pulse("healthy", a);
    owe(a.account, usdc, 650n * 1_000_000n * ONE);
    await pulse("Initial health short, Maintenance fine", a);
    owe(a.account, usdc, 1_400n * 1_000_000n * ONE);
    await pulse("liquidatable", a);
    editAccount(a.account, [["liquidation_tagged_at", t - 10n, 8]]);
    owe(a.account, usdc, 100n * 1_000_000n * ONE);
    await pulse("healthy again, the tag cleared", a);
    // Bankrupt: debt and next to nothing left.
    const z = await user([[gold, 10_000n]]);
    owe(z.account, usdc, 5n * 1_000_000n * ONE);
    await pulse("bankrupt", z);
    // Oracle trouble: a stale collateral oracle (recorded), a stale liability oracle (the engine fails).
    const c = await user([
      [sol, 10_000_000_000n],
      [gold, 1_000_000_000n],
    ]);
    owe(c.account, usdc, 100n * 1_000_000n * ONE);
    tick();
    refresh();
    setSwb(sol.oracle!, { value: sol.price * 10n ** 12n, lastUpdate: t - 1000n });
    await run("pulse health: a stale collateral oracle", admin, [h.pulseHealth(c.account, group.address, healthAccounts(c.account, [], true))], [c.account]);
    cacheOf(c);
    setPyth(usdc.oracle!, { price: 1_000_000n, conf: 1000n, expo: -6, publishTime: t - 1000n });
    await run("pulse health: a stale liability oracle too", admin, [h.pulseHealth(c.account, group.address, healthAccounts(c.account, [], true))], [c.account]);
    cacheOf(c);
    await pulse("accounts left out", c, []);
    await pulse("an oracle left out", c, healthAccounts(c.account, [], true).slice(0, -1));
    // Isolated debt, a flash loan, an account idle for 45 days.
    const e = await user([[sol, 10_000_000_000n]]);
    owe(e.account, iso, 10n * 1_000_000n * ONE);
    await pulse("isolated debt", e);
    editAccount(e.account, [["account_flags", 2n, 8]]);
    await pulse("in a flash loan", e);
    editAccount(e.account, [
      ["account_flags", 0n, 8],
      ["last_update", t - 45n * 86_400n, 8],
    ]);
    await pulse("idle for 45 days", e);
    // Premium-active debt: the crank refreshes the rate (and does nothing on an incomplete pass).
    editGroup(group.address, [
      ["premium_settings.entry_count", 1n, 2],
      ["premium_entries[0].collateral_tag", 5n, 2],
      ["premium_entries[0].liability_tag", 9n, 2],
      ["premium_entries[0].rate", 40_000_000n, 4],
    ]);
    editBank(sol.address, [["premium_tag", 5n, 2]]);
    editBank(usdc.address, [
      ["premium_tag", 9n, 2],
      ["flags", 8192n, 8],
      ["premium_activated_at", t - 1000n, 8],
    ]);
    const g = await user([[sol, 10_000_000_000n]]);
    owe(g.account, usdc, 100n * 1_000_000n * ONE);
    tick(3600n);
    await pulse("premium rates refreshed", g);
    editBank(usdc.address, [["flags", 0n, 8]]);
  });

  const setAmount = (at: Address, amount: bigint) => {
    for (const vm of s.vms()) {
      const x = vm.getAccount(at);
      if (!x.exists) throw new Error("no token account");
      const d = Buffer.from(x.data);
      d.writeBigUInt64LE(amount, 64);
      vm.setAccount({ ...x, address: at, data: new Uint8Array(d) });
    }
  };
  const settle = (label: string, u: User, bank: Priced, by: KeyPairSigner = admin, rest?: Address[], failing: boolean | "if-panics" = false) => {
    refresh();
    const ix = s.ix("lending_pool_handle_bankruptcy", {}, [
      { address: group.address },
      { address: by.address, signer: by },
      { address: bank.address, writable: true },
      { address: u.account, writable: true },
      { address: bank.v.liquidity, writable: true },
      { address: bank.v.insurance, writable: true },
      { address: bank.v.insuranceAuth },
      { address: bank.program },
      { address: INSTRUCTIONS },
    ]);
    return run(
      `bankruptcy: ${label}`,
      by,
      [withRest(ix, rest ?? healthAccounts(u.account, [], true))],
      [u.account, bank.address, bank.v.liquidity, bank.v.insurance],
      failing,
    );
  };

  it("tags accounts, keeps liquidation records and settles bankruptcies as the original does", async () => {
    const usdc = await newBank("pyth", 1_000_000n);
    const sol = await newBank("swb", 150_000_000n, { asset_tag: 1 }, 9);
    const gold = await newBank("fixed", 2_000_000n);
    await user([
      [usdc, 500_000_000_000n],
      [sol, 500_000_000_000n],
      [gold, 500_000_000_000n],
    ]);
    const tag = (label: string, u: User, rest?: Address[]) => {
      refresh();
      return run(
        `tag: ${label}`,
        admin,
        [
          withRest(
            s.ix("marginfi_account_tag_liq_record", {}, [{ address: u.account, writable: true }, { address: group.address }]),
            rest ?? healthAccounts(u.account, [], true),
          ),
        ],
        [u.account],
      );
    };
    // Tagging: a healthy account has nothing to clear; a liquidatable one is tagged once; healthy again, cleared.
    const a = await user([[sol, 10_000_000_000n]]);
    tick();
    await tag("healthy, untagged", a);
    owe(a.account, usdc, 1_400n * 1_000_000n * ONE);
    await tag("liquidatable", a);
    await tag("tagged already", a);
    await tag("accounts left out", a, []);
    owe(a.account, usdc, 100n * 1_000_000n * ONE);
    await tag("healthy again", a);
    editAccount(a.account, [["account_flags", 1n, 8]]);
    await tag("disabled", a);
    editAccount(a.account, [["account_flags", 0n, 8]]);
    editGroup(group.address, [
      ["panic_state_cache.pause_flags", 1n, 1],
      ["panic_state_cache.pause_start_timestamp", t - 10n, 8],
    ]);
    await tag("protocol paused", a);
    editGroup(group.address, [["panic_state_cache.pause_flags", 0n, 1]]);
    // Liquidation records: created once, closed unused or after 60 idle days, by the payer's key only.
    const payer = await s.funded();
    const [record] = await pda(PROGRAM, ["liq_record", a.account]);
    const init = () =>
      s.ix("marginfi_account_init_liq_record", {}, [
        { address: a.account, writable: true },
        { address: payer.address, signer: payer, writable: true },
        { address: record, writable: true },
        { address: SYSTEM },
      ]);
    const close = (to: Address = payer.address) =>
      s.ix("marginfi_account_close_liq_record", {}, [
        { address: a.account, writable: true },
        { address: record, writable: true },
        { address: to, writable: true },
      ]);
    await run("record: init", payer, [init()], [a.account, record, payer.address]);
    await run("record: init again", payer, [init()], [a.account, record]);
    await run("record: close to another", payer, [close(admin.address)], [a.account, record]);
    h.edit("LiquidationRecord")(record, [["entries[2].timestamp", t - 100n, 8]]);
    await run("record: close, used lately", payer, [close()], [a.account, record]);
    h.edit("LiquidationRecord")(record, [["liquidation_receiver", keyBits(admin.address), 32]]);
    await run("record: close, a receiver set", payer, [close()], [a.account, record]);
    h.edit("LiquidationRecord")(record, [
      ["liquidation_receiver", 0n, 32],
      ["entries[2].timestamp", t - 61n * 86_400n, 8],
    ]);
    editAccount(a.account, [["account_flags", 16n, 8]]);
    await run("record: close, in receivership", payer, [close()], [a.account, record]);
    editAccount(a.account, [["account_flags", 0n, 8]]);
    await run("record: close, idle 61 days", payer, [close()], [a.account, record, payer.address]);
    await run("record: init after close", payer, [init()], [a.account, record, payer.address]);
    await run("record: close, unused", payer, [close()], [a.account, record, payer.address]);

    // Bankruptcy: next to nothing left against a USDC debt; the insurance fund covers what it can, the rest is
    // shared by USDC's depositors.
    const z = await user([[gold, 10_000n]]);
    owe(z.account, usdc, 50n * 1_000_000n * ONE);
    tick();
    const other = await s.funded();
    await settle("not an admin", z, usdc, other);
    await settle("no debt in that bank", z, sol);
    const rich = await user([[sol, 10_000_000_000n]]);
    owe(rich.account, usdc, 10n * 1_000_000n * ONE);
    await settle("not bankrupt", rich, usdc);
    editAccount(z.account, [["account_flags", 16n, 8]]);
    await settle("in receivership", z, usdc);
    editAccount(z.account, [["account_flags", 0n, 8]]);
    await settle("health accounts left out", z, usdc, admin, []);
    setAmount(usdc.v.insurance, 20_000_000n);
    tick(3600n);
    await settle("insurance covers part", z, usdc);
    await settle("again (disabled now)", z, usdc);
    // Permissionless where the bank allows it; insurance covering all of it.
    editBank(usdc.address, [["flags", 4n, 8]]);
    const y = await user([[gold, 10_000n]]);
    owe(y.account, usdc, 5n * 1_000_000n * ONE);
    setAmount(usdc.v.insurance, 100_000_000n);
    await settle("permissionless, covered", y, usdc, other);
    // A debt past the bank's deposits kills it.
    const k = await user([[sol, 1_000n]]);
    owe(k.account, gold, 900_000n * 1_000_000n * ONE);
    await settle("past the deposits", k, gold);
    editBank(usdc.address, [["flags", 0n, 8]]);
  });

  /** [bank, oracle…] groups for these banks, sorted as an account's balances are (descending key). */
  const groupsOf = (list: Priced[]) =>
    [...list].sort((x, y) => Buffer.compare(keyBytes(y.address), keyBytes(x.address))).flatMap((b) => (b.oracle ? [b.address, b.oracle] : [b.address]));
  const oraclesOf = (b: Priced) => (b.oracle ? [b.oracle] : []);
  type Liq = {
    by?: KeyPairSigner;
    liquidator?: User;
    after?: Priced[];
    liquidatee?: Address[];
    counts?: [number, number];
    failing?: boolean | "if-panics";
    noMint?: boolean;
  };
  const liq = (label: string, e: User, r: User, asset: Priced, liab: Priced, amount: bigint, o: Liq = {}) => {
    refresh();
    const by = o.by ?? r.owner;
    const liquidator = o.liquidator ?? r;
    const mine = groupsOf(o.after ?? [asset, liab]);
    const theirs = o.liquidatee ?? healthAccounts(e.account);
    const rest = [...(liab.program === TOKEN_2022 && !o.noMint ? [liab.mint] : []), ...oraclesOf(asset), ...oraclesOf(liab), ...mine, ...theirs];
    return run(
      `liquidate: ${label}`,
      by,
      [
        h.liquidate(
          group.address,
          asset.address,
          liab,
          liquidator.account,
          by,
          e.account,
          amount,
          o.counts?.[0] ?? theirs.length,
          o.counts?.[1] ?? mine.length,
          rest,
          liab.program,
        ),
      ],
      [e.account, liquidator.account, asset.address, liab.address, liab.v.liquidity, liab.v.insurance],
      o.failing ?? false,
    );
  };

  it("liquidates as the original does", async () => {
    const usdc = await newBank("pyth", 1_000_000n);
    const sol = await newBank("swb", 150_000_000n, { asset_tag: 1 }, 9);
    const gold = await newBank("fixed", 2_000_000n);
    await user([
      [usdc, 500_000_000_000n],
      [sol, 500_000_000_000n],
      [gold, 500_000_000_000n],
    ]);
    // 10 SOL ($1,500) against 1,400 USDC: liquidatable at Maintenance. The liquidator holds USDC to pay with.
    const e = await user([[sol, 10_000_000_000n]]);
    owe(e.account, usdc, 1_400n * 1_000_000n * ONE);
    const r = await user([[usdc, 5_000_000_000n]]);
    tick();
    await liq("zero amount", e, r, sol, usdc, 0n);
    await liq("same bank twice", e, r, usdc, usdc, 1_000_000n);
    await liq("liquidatee's accounts left out", e, r, sol, usdc, 1_000_000_000n, { liquidatee: [] });
    await liq("more liquidatee accounts than sent", e, r, sol, usdc, 1_000_000_000n, { counts: [40, 4], failing: "if-panics" });
    await liq("more liquidator accounts than sent", e, r, sol, usdc, 1_000_000_000n, { counts: [4, 40], failing: "if-panics" });
    await liq("a bank it owes nothing", e, r, sol, gold, 1_000_000_000n);
    await liq("past its collateral", e, r, sol, usdc, 11_000_000_000n);
    const other = await s.funded();
    await liq("not the liquidator's signer", e, r, sol, usdc, 1_000_000_000n, { by: other });
    await liq("the liquidatee itself", e, e, sol, usdc, 1_000_000_000n, { failing: true });
    editAccount(r.account, [["account_flags", 16n, 8]]);
    await liq("liquidator in receivership", e, r, sol, usdc, 1_000_000_000n);
    editAccount(r.account, [["account_flags", 0n, 8]]);
    editAccount(e.account, [["account_flags", 16n, 8]]);
    await liq("liquidatee in receivership", e, r, sol, usdc, 1_000_000_000n);
    editAccount(e.account, [["account_flags", 2n, 8]]);
    await liq("liquidatee in a flash loan", e, r, sol, usdc, 1_000_000_000n);
    editAccount(e.account, [["account_flags", 0n, 8]]);
    editGroup(group.address, [
      ["panic_state_cache.pause_flags", 1n, 1],
      ["panic_state_cache.pause_start_timestamp", t - 10n, 8],
    ]);
    await liq("protocol paused", e, r, sol, usdc, 1_000_000_000n);
    editGroup(group.address, [["panic_state_cache.pause_flags", 0n, 1]]);
    await liq("part of it", e, r, sol, usdc, 1_000_000_000n);
    // Tagged first: a liquidation that repays enough restarts the tag.
    await run("tag", admin, [h.tagLiqRecord(e.account, group.address, healthAccounts(e.account, [], true))], [e.account]);
    tick(7200n);
    await liq("tagged, a little", e, r, sol, usdc, 10_000_000n);
    await liq("tagged, a quarter of the debt", e, r, sol, usdc, 3_000_000_000n);
    // A liquidator with nothing else takes on the debt against the seized SOL alone: short at Initial.
    const poor = await user([]);
    await liq("liquidator without collateral", e, poor, sol, usdc, 1_000_000_000n, { after: [sol, usdc] });
    // The liquidator's accounts short of what its balances need.
    await liq("liquidator's accounts left out", e, r, sol, usdc, 100_000_000n, { after: [sol] });
    // A halted bank: only the admins liquidate, past the breaker's gate.
    editBank(usdc.address, [["config.operational_state", 6n, 1]]);
    await liq("circuit-broken bank, not an admin", e, r, sol, usdc, 100_000_000n);
    // The risk admin liquidating with its own account: past the halt and the gates.
    const riskAt = offsetOf("MarginfiGroup", "risk_admin");
    const riskWas = BigInt(
      "0x" +
        Buffer.from(data(group.address).subarray(riskAt, riskAt + 32))
          .reverse()
          .toString("hex"),
    );
    editGroup(group.address, [["risk_admin", keyBits(r.owner.address), 32]]);
    await liq("circuit-broken bank, by the risk admin", e, r, sol, usdc, 100_000_000n);
    editBank(usdc.address, [
      ["config.operational_state", 1n, 1],
      ["flags", 2048n, 8],
      ["cb_tier", 1n, 1],
      ["cb_halt_ended_at", t + 1000n, 8],
    ]);
    await liq("halted bank, by the risk admin", e, r, sol, usdc, 100_000_000n);
    editBank(usdc.address, [
      ["flags", 0n, 8],
      ["cb_tier", 0n, 1],
      ["cb_halt_ended_at", 0n, 8],
    ]);
    editGroup(group.address, [["risk_admin", riskWas, 32]]);
    editBank(usdc.address, [["config.operational_state", 1n, 1]]);
    // A liquidator owing a premium in the asset bank settles it from the seized collateral first.
    const r3 = await user([[usdc, 5_000_000_000n]]);
    owe(r3.account, sol, 100_000_000n * ONE);
    const slotOf = (account: Address, bank: Priced) => {
      const d = data(account);
      for (let i = 0; i < 16; i++) {
        const at = offsetOf("MarginfiAccount", `lending_account.balances[${i}].bank_pk`);
        if (d.subarray(at, at + 32).equals(keyBytes(bank.address))) return i;
      }
      throw new Error("no balance");
    };
    const k3 = slotOf(r3.account, sol);
    editAccount(r3.account, [
      [`lending_account.balances[${k3}].premium_outstanding`, 30_000_000n * ONE, 16],
      [`lending_account.balances[${k3}].premium_rate_snapshot`, 50_000_000n, 4],
    ]);
    editBank(sol.address, [
      ["flags", 8192n, 8],
      ["premium_activated_at", t - 50_000n, 8],
    ]);
    tick();
    await liq("premium settled from the seized collateral", e, r3, sol, usdc, 200_000_000n);
    editBank(sol.address, [["flags", 0n, 8]]);
    // A liquidator in a flash loan: no health check now. A premium-active debt it takes on that way is raised to the
    // highest rate configured for its tag.
    const fl = await user([[gold, 10_000_000_000n]]);
    editAccount(fl.account, [["account_flags", 2n, 8]]);
    await liq("liquidator in a flash loan", e, fl, sol, usdc, 50_000_000n, { after: [gold, sol, usdc] });
    const countAt = offsetOf("MarginfiGroup", "premium_settings.entry_count");
    const countWas = BigInt(data(group.address).readUInt16LE(countAt));
    editGroup(group.address, [
      ["premium_settings.entry_count", 2n, 2],
      ["premium_entries[0].collateral_tag", 5n, 2],
      ["premium_entries[0].liability_tag", 9n, 2],
      ["premium_entries[0].rate", 40_000_000n, 4],
      ["premium_entries[1].collateral_tag", 6n, 2],
      ["premium_entries[1].liability_tag", 9n, 2],
      ["premium_entries[1].rate", 90_000_000n, 4],
    ]);
    editBank(usdc.address, [
      ["flags", 8192n, 8],
      ["premium_tag", 9n, 2],
      ["premium_activated_at", t - 50_000n, 8],
    ]);
    tick(3600n);
    await liq("liquidator in a flash loan, a premium-active debt", e, fl, sol, usdc, 50_000_000n, { after: [gold, sol, usdc] });
    const snapshotAt = offsetOf("MarginfiAccount", `lending_account.balances[${slotOf(fl.account, usdc)}].premium_rate_snapshot`);
    expect(data(fl.account).readUInt32LE(snapshotAt)).toBe(90_000_000);
    tick(3600n);
    await liq("again, the debt's rate already raised", e, fl, sol, usdc, 50_000_000n, { after: [gold, sol, usdc] });
    editAccount(fl.account, [["account_flags", 0n, 8]]);
    editBank(usdc.address, [
      ["flags", 0n, 8],
      ["premium_tag", 0n, 2],
    ]);
    editGroup(group.address, [["premium_settings.entry_count", countWas, 2]]);
    // One liquidation too many: healthy after.
    const near = await user([[sol, 10_000_000_000n]]);
    owe(near.account, usdc, 800n * 1_000_000n * ONE);
    await liq("too much: healthy after", near, r, sol, usdc, 1_000_000_000n);
    await liq("just enough", near, r, sol, usdc, 500_000_000n);
    // A liquidatee healthy again.
    const fine = await user([[sol, 10_000_000_000n]]);
    owe(fine.account, usdc, 100n * 1_000_000n * ONE);
    await liq("healthy account", fine, r, sol, usdc, 100_000_000n);
    // Debt in a fixed-price bank, paid by a liquidator owing a premium-free USDC debt already.
    const g = await user([[usdc, 2_000_000_000n]]);
    owe(g.account, gold, 900n * 1_000_000n * ONE);
    const r2 = await user([[gold, 50_000_000_000n]]);
    owe(r2.account, sol, 1_000_000_000n * ONE);
    tick();
    await liq("a fixed-price debt", g, r2, usdc, gold, 100_000_000n, { after: [usdc, gold, sol] });
  });

  it("liquidates in receivership as the original does", async () => {
    const usdc = await newBank("pyth", 1_000_000n);
    const sol = await newBank("swb", 150_000_000n, { asset_tag: 1 }, 9);
    await user([
      [usdc, 500_000_000_000n],
      [sol, 500_000_000_000n],
    ]);
    /** The account's banks for the end: sorted as a withdrawal or repayment leaves them, else as they sit. */
    const banksOf = (u: User, sorted = false, skip: Address[] = []) =>
      healthAccounts(u.account, skip, !sorted).filter((a) => banks.some((b) => b.address === a));
    /** An account with 10 SOL against 1,400 USDC (liquidatable), its liquidation record, a receiver with tokens. */
    const setup = async (debt = 1_400n, collateral = 10_000_000_000n) => {
      const e = await user([[sol, collateral]]);
      owe(e.account, usdc, debt * 1_000_000n * ONE);
      const payer = await s.funded();
      const [record] = await pda(PROGRAM, ["liq_record", e.account]);
      await run(
        "record",
        payer,
        [
          s.ix("marginfi_account_init_liq_record", {}, [
            { address: e.account, writable: true },
            { address: payer.address, signer: payer, writable: true },
            { address: record, writable: true },
            { address: SYSTEM },
          ]),
        ],
        [e.account, record],
      );
      const r = await user([]);
      return { e, record, r };
    };
    type Rx = {
      seize?: bigint;
      repay?: bigint;
      repayAll?: boolean;
      before?: Instruction[];
      middle?: Instruction[];
      start?: boolean;
      end?: boolean;
      receiver?: KeyPairSigner;
      endBy?: KeyPairSigner;
      record?: Address;
      readonlyRest?: Address[];
      feePayer?: KeyPairSigner;
      failing?: boolean | "if-panics";
    };
    /** [start, withdraw `seize` SOL, repay `repay` USDC, end] in one transaction, the receiver signing. */
    const rx = (label: string, c: Awaited<ReturnType<typeof setup>>, o: Rx = {}) => {
      refresh();
      const receiver = o.receiver ?? c.r.owner;
      const rest = healthAccounts(c.e.account, [], true);
      const ixs: Instruction[] = [...(o.before ?? [])];
      if (o.start ?? true) ixs.push(h.startLiquidation(group.address, c.e.account, o.record ?? c.record, receiver, rest, { readonlyRest: o.readonlyRest }));
      if (o.seize) ixs.push(h.withdraw(group.address, c.e.account, receiver, sol, c.r.wallets.get(sol.address)!, o.seize, { rest }));
      if (o.repay || o.repayAll)
        ixs.push(
          h.repay(group.address, c.e.account, receiver, usdc.address, c.r.wallets.get(usdc.address)!, usdc.v.liquidity, o.repay ?? 0n, {
            all: o.repayAll ?? null,
          }),
        );
      ixs.push(...(o.middle ?? []));
      if (o.end ?? true)
        ixs.push(
          h.endLiquidation(
            group.address,
            c.e.account,
            c.record,
            o.endBy ?? receiver,
            banksOf(c.e, !!(o.seize || o.repay || o.repayAll), o.repayAll ? [usdc.address] : []),
            {
              feePayer: o.feePayer,
              readonlyRest: o.readonlyRest,
            },
          ),
        );
      return run(
        `receivership: ${label}`,
        receiver,
        ixs,
        [c.e.account, c.record, sol.address, usdc.address, sol.v.liquidity, usdc.v.liquidity, h.feeWallet, receiver.address],
        o.failing ?? false,
      );
    };
    const a = await setup();
    tick();
    await rx("seize 1 SOL, repay 140 USDC", a, { seize: 1_000_000_000n, repay: 140_000_000n });
    await rx("again", a, { seize: 1_000_000_000n, repay: 140_000_000n });
    await rx("seize without repaying", a, { seize: 1_000_000_000n });
    await rx("too much premium", a, { seize: 1_000_000_000n, repay: 100_000_000n });
    await rx("repay only", a, { repay: 50_000_000n });
    await rx("nothing in between", a);
    await rx("not the last instruction", a, { seize: 100_000_000n, repay: 20_000_000n, end: false });
    await rx("not the first instruction", a, {
      before: [h.repay(group.address, a.e.account, a.e.owner, usdc.address, a.e.wallets.get(usdc.address)!, usdc.v.liquidity, 1_000_000n)],
    });
    await rx("started twice", a, {
      middle: [h.startLiquidation(group.address, a.e.account, a.record, a.r.owner, healthAccounts(a.e.account, [], true))],
    });
    await rx("a borrow in between", a, {
      middle: [
        h.borrow(group.address, a.e.account, a.r.owner, usdc, a.r.wallets.get(usdc.address)!, 1_000_000n, { rest: healthAccounts(a.e.account, [], true) }),
      ],
    });
    await rx("a bank written by another instruction", a, { seize: 100_000_000n, repay: 20_000_000n, readonlyRest: [sol.address] });
    await rx("a bank not writable", a, { repay: 20_000_000n, readonlyRest: [sol.address] });
    const other = await s.funded();
    await rx("ended by someone else", a, { seize: 100_000_000n, repay: 20_000_000n, endBy: other });
    await rx("the end alone", a, { start: false });
    await rx("a separate fee payer", a, { seize: 100_000_000n, repay: 20_000_000n, feePayer: other });
    const b = await setup();
    await rx("another account's record", a, { record: b.record });
    // A healthy account cannot be put in receivership.
    const fine = await setup(100n);
    await rx("healthy account", fine, { seize: 100_000_000n, repay: 20_000_000n });
    // Under $5 of collateral: the receiver may leave the account healthy (a close-out).
    const small = await setup(5n, 20_000_000n);
    await rx("a close-out under $5", small, { seize: 19_000_000n, repayAll: true });
    // A halted bank refuses everyone.
    editBank(usdc.address, [["config.operational_state", 6n, 1]]);
    await rx("circuit-broken bank", b, { seize: 100_000_000n, repay: 20_000_000n });
    editBank(usdc.address, [["config.operational_state", 1n, 1]]);
    // A tagged account: the premium grows with the time since the tag.
    await run("tag", admin, [h.tagLiqRecord(b.e.account, group.address, healthAccounts(b.e.account, [], true))], [b.e.account]);
    tick(3n * 86_400n);
    await rx("tagged three days ago, a larger premium", b, { seize: 1_000_000_000n, repay: 110_000_000n });
  });

  it("deleverages as the original does", async () => {
    const usdc = await newBank("pyth", 1_000_000n);
    const sol = await newBank("swb", 150_000_000n, { asset_tag: 1 }, 9);
    await user([
      [usdc, 500_000_000_000n],
      [sol, 500_000_000_000n],
    ]);
    // The group's risk admin and flow admin for this test (restored at the end).
    const ra = await user([]);
    const flow = await s.funded();
    const at = (field: string) => {
      const o = offsetOf("MarginfiGroup", field);
      return BigInt(
        "0x" +
          Buffer.from(data(group.address).subarray(o, o + 32))
            .reverse()
            .toString("hex"),
      );
    };
    const riskWas = at("risk_admin");
    const flowWas = at("delegate_flow_admin");
    editGroup(group.address, [
      ["risk_admin", keyBits(ra.owner.address), 32],
      ["delegate_flow_admin", keyBits(flow.address), 32],
      ["deleverage_withdraw_window_cache.daily_limit", 0n, 4],
    ]);
    const setup = async (debt: bigint) => {
      const e = await user([[sol, 10_000_000_000n]]);
      owe(e.account, usdc, debt * 1_000_000n * ONE);
      const [record] = await pda(PROGRAM, ["liq_record", e.account]);
      await run(
        "record",
        ra.owner,
        [
          s.ix("marginfi_account_init_liq_record", {}, [
            { address: e.account, writable: true },
            { address: ra.owner.address, signer: ra.owner, writable: true },
            { address: record, writable: true },
            { address: SYSTEM },
          ]),
        ],
        [e.account, record],
      );
      return { e, record };
    };
    const startIx = (c: Awaited<ReturnType<typeof setup>>, by: KeyPairSigner) => {
      const ix = s.ix("start_deleverage", {}, [
        { address: c.e.account, writable: true },
        { address: c.record, writable: true },
        { address: group.address },
        { address: by.address, signer: by },
        { address: INSTRUCTIONS },
      ]);
      return { ...ix, accounts: [...ix.accounts!, ...healthAccounts(c.e.account, [], true).map((address) => ({ address, role: 1 }) as never)] };
    };
    /** The account's banks for the end: sorted as a withdrawal or repayment leaves them, else as they sit. */
    const endIx = (c: Awaited<ReturnType<typeof setup>>, by: KeyPairSigner, sorted = false) => {
      const ix = s.ix("end_deleverage", {}, [
        { address: c.e.account, writable: true },
        { address: c.record, writable: true },
        { address: group.address },
        { address: by.address, signer: by },
        { address: INSTRUCTIONS },
      ]);
      const list = healthAccounts(c.e.account, [], !sorted).filter((a) => banks.some((b) => b.address === a));
      return { ...ix, accounts: [...ix.accounts!, ...list.map((address) => ({ address, role: 1 }) as never)] };
    };
    type Dx = { seize?: bigint; repay?: bigint; by?: KeyPairSigner; endBy?: KeyPairSigner; start?: boolean; middle?: Instruction[] };
    const dx = (label: string, c: Awaited<ReturnType<typeof setup>>, o: Dx = {}) => {
      refresh();
      const by = o.by ?? ra.owner;
      const rest = healthAccounts(c.e.account, [], true);
      const ixs: Instruction[] = [];
      if (o.start ?? true) ixs.push(startIx(c, by));
      ixs.push(...(o.middle ?? []));
      if (o.seize) ixs.push(h.withdraw(group.address, c.e.account, by, sol, ra.wallets.get(sol.address)!, o.seize, { rest }));
      if (o.repay) ixs.push(h.repay(group.address, c.e.account, by, usdc.address, ra.wallets.get(usdc.address)!, usdc.v.liquidity, o.repay));
      ixs.push(endIx(c, o.endBy ?? by, !!(o.seize || o.repay)));
      return run(`deleverage: ${label}`, by, ixs, [c.e.account, c.record, sol.address, usdc.address, group.address, ra.owner.address], false);
    };
    // A healthy account: the risk admin unwinds part of it; health may not fall.
    const a = await setup(500n);
    tick();
    await dx("withdraw 1 SOL, repay 150 USDC", a, { seize: 1_000_000_000n, repay: 150_000_000n });
    await dx("health falls", a, { seize: 1_000_000_000n, repay: 10_000_000n });
    const other = await s.funded();
    await dx("not the risk admin", a, { by: other });
    await dx("ended by someone else", a, { endBy: other });
    await dx("the end alone", a, { start: false });
    await dx("durable nonce", a, { middle: [h.advanceNonce(ra.owner)] });
    // The group's daily limit on what deleverages withdraw.
    const limit = (label: string, by: KeyPairSigner, value: number) =>
      run(
        `deleverage limit: ${label}`,
        by,
        [
          s.ix("configure_deleverage_withdrawal_limit", { limit: value }, [
            { address: group.address, writable: true },
            { address: by.address, signer: by },
            { address: INSTRUCTIONS },
          ]),
        ],
        [group.address],
      );
    await limit("not an admin", other, 100);
    await limit("zero", admin, 0);
    await limit("$100 a day", admin, 100);
    await dx("past the day's limit", a, { seize: 1_000_000_000n, repay: 150_000_000n });
    await dx("within it", a, { seize: 100_000_000n, repay: 20_000_000n });
    // The flow admin's aggregated updates.
    const flowUpdate = (label: string, by: KeyPairSigner, usd: number, seq: bigint, from: bigint, to: bigint) =>
      run(
        `deleverage withdrawals: ${label}`,
        by,
        [
          s.ix(
            "update_deleverage_withdrawals",
            { outflow_usd: usd, update_seq: new BN(seq.toString()), event_start_slot: new BN(from.toString()), event_end_slot: new BN(to.toString()) },
            [{ address: group.address, writable: true }, { address: by.address, signer: by }, { address: INSTRUCTIONS }],
          ),
        ],
        [group.address],
      );
    tick();
    await flowUpdate("not the flow admin", other, 10, 1n, slot - 10n, slot - 5n);
    await flowUpdate("nothing", flow, 0, 1n, slot - 10n, slot - 5n);
    await flowUpdate("slots reversed", flow, 10, 1n, slot - 5n, slot - 10n);
    await flowUpdate("a future slot", flow, 10, 1n, slot - 5n, slot + 5n);
    await flowUpdate("stale", flow, 10, 1n, slot - 3000n, slot - 2000n);
    await flowUpdate("out of sequence", flow, 10, 5n, slot - 10n, slot - 5n);
    await flowUpdate("in order", flow, 10, 1n, slot - 10n, slot - 5n);
    await flowUpdate("an old slot", flow, 10, 2n, slot - 10n, slot - 5n);
    await flowUpdate("past the limit", flow, 1_000, 2n, slot - 4n, slot - 1n);
    tick(86_400n);
    await flowUpdate("a day later", flow, 50, 2n, slot - 4n, slot - 1n);
    // Tokenless repayments complete: the risk admin purges what deposits are left in the bank.
    const force = (label: string, by: KeyPairSigner, bank: Priced) =>
      run(
        `force tokenless complete: ${label}`,
        by,
        [
          s.ix("lending_pool_force_tokenless_repay_complete", {}, [
            { address: group.address },
            { address: by.address, signer: by },
            { address: bank.address, writable: true },
            { address: INSTRUCTIONS },
          ]),
        ],
        [bank.address],
      );
    const purge = (label: string, by: KeyPairSigner, u: User, bank: Priced) =>
      run(
        `purge: ${label}`,
        by,
        [
          s.ix("purge_deleverage_balance", {}, [
            { address: group.address },
            { address: u.account, writable: true },
            { address: by.address, signer: by },
            { address: bank.address, writable: true },
            { address: INSTRUCTIONS },
          ]),
        ],
        [u.account, bank.address],
      );
    const holder = await user([[sol, 1_000_000_000n]]);
    await purge("not complete", ra.owner, holder, sol);
    await force("not the risk admin", other, sol);
    await force("not allowed", ra.owner, sol);
    editBank(sol.address, [["flags", 32n, 8]]);
    await force("allowed", ra.owner, sol);
    await purge("not the risk admin", other, holder, sol);
    await purge("no balance there", ra.owner, ra, sol);
    const debtor = await user([]);
    owe(debtor.account, sol, 1_000_000_000n * ONE);
    await purge("owing", ra.owner, debtor, sol);
    await purge("a deposit", ra.owner, holder, sol);
    editBank(sol.address, [["flags", 0n, 8]]);
    editGroup(group.address, [
      ["risk_admin", riskWas, 32],
      ["delegate_flow_admin", flowWas, 32],
      ["deleverage_withdraw_window_cache.daily_limit", 0n, 4],
    ]);
  });

  it("lends in flash loans as the original does", async () => {
    const usdc = await newBank("pyth", 1_000_000n);
    const sol = await newBank("swb", 150_000_000n, { asset_tag: 1 }, 9);
    await user([
      [usdc, 500_000_000_000n],
      [sol, 500_000_000_000n],
    ]);
    const start = (u: User, endIndex: number, by: KeyPairSigner = u.owner, account = u.account) =>
      s.ix("lending_account_start_flashloan", { end_index: new BN(endIndex) }, [
        { address: account, writable: true },
        { address: by.address, signer: by },
        { address: INSTRUCTIONS },
      ]);
    const end = (u: User, rest: Address[], by: KeyPairSigner = u.owner, account = u.account): Instruction => {
      const ix = s.ix("lending_account_end_flashloan", {}, [
        { address: account, writable: true },
        { address: group.address },
        { address: by.address, signer: by },
      ]);
      return { ...ix, accounts: [...ix.accounts!, ...rest.map((address) => ({ address, role: 0 }) as never)] };
    };
    /** [start, …middle, end]: the end at index middle + 2 (after the compute budget instruction), unless `endAt`. */
    const fl = (
      label: string,
      u: User,
      middle: Instruction[],
      o: { endAt?: number; endRest?: Address[]; by?: KeyPairSigner; noEnd?: boolean; failing?: boolean } = {},
    ) => {
      refresh();
      const endAt = o.endAt ?? middle.length + 2;
      const ixs = [start(u, endAt, o.by), ...middle];
      if (!o.noEnd) ixs.push(end(u, o.endRest ?? healthAccounts(u.account), o.by));
      return run(`flash loan: ${label}`, o.by ?? u.owner, ixs, [u.account, usdc.address, sol.address, usdc.v.liquidity], o.failing ?? false);
    };
    const u = await user([[sol, 10_000_000_000n]]);
    tick();
    const borrow = (amount: bigint, rest: Address[]) => h.borrow(group.address, u.account, u.owner, usdc, u.wallets.get(usdc.address)!, amount, { rest });
    const repayAll = () => h.repay(group.address, u.account, u.owner, usdc.address, u.wallets.get(usdc.address)!, usdc.v.liquidity, 0n, { all: true });
    /** [bank, oracle] groups as the balances sort (descending bank key). */
    const groups = (list: Priced[]) =>
      [...list].sort((x, y) => Buffer.compare(keyBytes(y.address), keyBytes(x.address))).flatMap((b) => (b.oracle ? [b.address, b.oracle] : [b.address]));
    const both = () => groups([sol, usdc]);
    await fl("nothing in between", u, []);
    // Borrowed past what the collateral allows, repaid before the end: no health check in between.
    await fl("borrow past the limit, repay it all", u, [borrow(2_000_000_000n, both()), repayAll()], { endRest: groups([sol]) });
    await fl("borrow past the limit and keep it", u, [borrow(2_000_000_000n, both())], { endRest: both() });
    await fl("borrow within it and keep it", u, [borrow(100_000_000n, both())], { endRest: both() });
    await fl("health accounts left out at the end", u, [], { endRest: [] });
    await fl("the end index at another instruction", u, [repayAll()], { endAt: 2 });
    await fl("the end index past the transaction", u, [], { endAt: 9, failing: true });
    await fl("the end index at the start", u, [], { endAt: 1 });
    await fl("no end", u, [], { noEnd: true, endAt: 5, failing: true });
    const other = await user([[sol, 1_000_000_000n]]);
    await fl("another signer", u, [], { by: other.owner });
    await run("flash loan: an end alone", u.owner, [end(u, healthAccounts(u.account))], [u.account]);
    await run(
      "flash loan: the end names another account",
      u.owner,
      [start(u, 2), end(other, healthAccounts(other.account), other.owner)],
      [u.account, other.account],
    );
    await run("flash loan: started twice", u.owner, [start(u, 3), start(u, 3), end(u, healthAccounts(u.account))], [u.account]);
    editAccount(u.account, [["account_flags", 64n, 8]]);
    await fl("a frozen account", u, []);
    editAccount(u.account, [["account_flags", 0n, 8]]);
  });

  it("administers accounts as the original does", async () => {
    const usdc = await newBank("pyth", 1_000_000n);
    await user([[usdc, 500_000_000_000n]]);
    const gov = await s.funded();
    const govAt = offsetOf("MarginfiGroup", "governance_admin");
    const govWas = BigInt(
      "0x" +
        Buffer.from(data(group.address).subarray(govAt, govAt + 32))
          .reverse()
          .toString("hex"),
    );
    editGroup(group.address, [["governance_admin", keyBits(gov.address), 32]]);
    const other = await s.funded();
    const u = await user([[usdc, 100_000_000n]]);
    tick();
    // Freezing (the admin) and unfreezing (the governance admin).
    const freeze = (label: string, by: KeyPairSigner, account: Address, frozen: boolean, extra: Instruction[] = []) =>
      run(
        `freeze: ${label}`,
        by,
        [
          s.ix("marginfi_account_set_freeze", { frozen }, [
            { address: group.address },
            { address: account, writable: true },
            { address: by.address, signer: by },
            { address: INSTRUCTIONS },
          ]),
          ...extra,
        ],
        [account],
      );
    await freeze("by someone else", other, u.account, true);
    await freeze("unfrozen by the admin", admin, u.account, false);
    await freeze("frozen by the admin", admin, u.account, true);
    await freeze("durable nonce", admin, u.account, true, [h.advanceNonce(admin)]);
    // The emissions destination: the authority's, not while frozen.
    const dest = (label: string, by: KeyPairSigner, account: Address) =>
      run(
        `emissions destination: ${label}`,
        by,
        [
          s.ix("marginfi_account_update_emissions_destination_account", {}, [
            { address: account, writable: true },
            { address: by.address, signer: by },
            { address: other.address },
          ]),
        ],
        [account],
      );
    await dest("frozen", u.owner, u.account);
    await freeze("unfrozen by the governance admin", gov, u.account, false);
    await dest("by its authority", u.owner, u.account);
    await dest("by someone else", other, u.account);
    // Indexer flags for any accounts.
    const sync = (label: string, accounts: { address: Address; writable: boolean }[]) =>
      run(
        `sync indexer flags: ${label}`,
        other,
        [
          {
            ...s.ix("sync_indexer_flags", {}, [{ address: other.address, signer: other, writable: true }]),
            accounts: [{ address: other.address, role: 3 }, ...accounts.map((a) => ({ address: a.address, role: a.writable ? 1 : 0 }))] as never,
          },
        ],
        accounts.map((a) => a.address),
      );
    const v = await user([[usdc, 5_000_000n]]);
    editAccount(v.account, [["indexer_flags.is_empty", 1n, 1]]);
    await sync("two accounts", [
      { address: u.account, writable: true },
      { address: v.account, writable: true },
    ]);
    await sync("one not writable", [{ address: u.account, writable: false }]);
    await sync("a bank", [{ address: usdc.address, writable: true }]);
    await sync("none", []);
    // Transfers to a new account, for the fee state's fee.
    const transfer = async (label: string, from: User, by: KeyPairSigner, o: { wallet?: Address; pda?: [number, number | null]; to?: KeyPairSigner } = {}) => {
      const to = o.to ?? (await s.funded());
      let fresh: Address;
      let signers: KeyPairSigner[] = [];
      if (o.pda) {
        const le16 = (n: number) => Uint8Array.of(n & 255, n >> 8);
        [fresh] = await pda(PROGRAM, ["marginfi_account", group.address, to.address, le16(o.pda[0]), le16(o.pda[1] ?? 0)]);
      } else {
        const k = await generateKeyPairSigner();
        fresh = k.address;
        signers = [k];
      }
      const accounts = [
        { address: group.address },
        { address: from.account, writable: true },
        o.pda ? { address: fresh, writable: true } : { address: fresh, writable: true, signer: signers[0] },
        { address: by.address, signer: by },
        { address: by.address, signer: by, writable: true },
        { address: to.address },
        { address: o.wallet ?? h.feeWallet, writable: true },
        { address: h.feeState },
        ...(o.pda ? [{ address: INSTRUCTIONS }] : []),
        { address: SYSTEM },
      ];
      const ix = o.pda
        ? s.ix("transfer_to_new_account_pda", { account_index: o.pda[0], third_party_id: o.pda[1] }, accounts as never)
        : s.ix("transfer_to_new_account", {}, accounts as never);
      return run(`transfer: ${label}`, by, [ix], [from.account, fresh, h.feeWallet]);
    };
    const w = await user([[usdc, 7_000_000n]]);
    await transfer("by someone else", w, other);
    await transfer("to the wrong fee wallet", w, w.owner, { wallet: other.address });
    editAccount(w.account, [["account_flags", 2n, 8]]);
    await transfer("in a flash loan", w, w.owner);
    editAccount(w.account, [["account_flags", 0n, 8]]);
    await transfer("with its balances", w, w.owner);
    await transfer("again", w, w.owner);
    const x = await user([[usdc, 3_000_000n]]);
    await transfer("to a PDA", x, x.owner, { pda: [3, null] });
    const y = await user([]);
    await transfer("to a PDA with a third-party id", y, y.owner, { pda: [1, 10001] });
    await transfer("to a PDA with an open id", y, y.owner, { pda: [2, 7] });
    // Closing idle empty accounts (anyone), the rent to the global fee wallet.
    const close = (label: string, account: Address, wallet: Address = h.feeWallet) =>
      pda(PROGRAM, ["rebalance_fee_pool", account]).then(([pool]) =>
        run(
          `admin close: ${label}`,
          other,
          [
            s.ix("admin_close_account", {}, [
              { address: group.address },
              { address: account, writable: true },
              { address: wallet, writable: true },
              { address: pool },
            ]),
          ],
          [account, wallet],
        ),
      );
    const idle = await user([]);
    await close("active lately", idle.account);
    editAccount(idle.account, [["last_update", t - 61n * 86_400n, 8]]);
    await close("to the wrong wallet", idle.account, other.address);
    await close("with a balance", u.account);
    const [pool] = await pda(PROGRAM, ["rebalance_fee_pool", idle.account]);
    for (const vm of s.vms()) vm.airdrop(pool, lamports(1_000_000n));
    await close("a rebalance fee pool left", idle.account);
    const idle2 = await user([]);
    editAccount(idle2.account, [["last_update", t - 61n * 86_400n, 8]]);
    await close("idle 61 days", idle2.account);
    editGroup(group.address, [["governance_admin", govWas, 32]]);
  });

  it("administers the group and the fee state as the original does", async () => {
    const usdc = await newBank("pyth", 1_000_000n);
    const other = await s.funded();
    const flow = await s.funded();
    const fee = (
      label: string,
      name: string,
      by: KeyPairSigner,
      args: Record<string, unknown>,
      accounts: { address: Address; writable?: boolean; signer?: KeyPairSigner }[],
      watch: Address[],
    ) => run(`${label}`, by, [s.ix(name, args, accounts as never)], watch);
    // The program's fees for the group (the global fee admin).
    const groupFee = (label: string, by: KeyPairSigner, on: boolean) =>
      fee(
        `group fee: ${label}`,
        "config_group_fee",
        by,
        { enable_program_fee: on },
        [{ address: group.address, writable: true }, { address: by.address, signer: by }, { address: h.feeState }, { address: INSTRUCTIONS }],
        [group.address],
      );
    const flagsAt = offsetOf("MarginfiGroup", "group_flags");
    const flagsWas = data(group.address).readBigUInt64LE(flagsAt);
    await groupFee("by someone else", other, true);
    await groupFee("off", admin, false);
    await groupFee("on", admin, true);
    const premiumWallet = (label: string, by: KeyPairSigner) =>
      fee(
        `fee state premium wallet: ${label}`,
        "edit_fee_state_premium",
        by,
        { premium_wallet: new web3.PublicKey(other.address) },
        [{ address: by.address, signer: by }, { address: h.feeState, writable: true }, { address: INSTRUCTIONS }],
        [h.feeState],
      );
    await premiumWallet("by someone else", other);
    await premiumWallet("by the global fee admin", admin);
    // Panic pauses: 6 hours each, extended while running, at most 3 a day and 4 in a row.
    const pause = (label: string, by: KeyPairSigner) =>
      fee(
        `pause: ${label}`,
        "panic_pause",
        by,
        {},
        [{ address: by.address, signer: by }, { address: h.feeState, writable: true }, { address: INSTRUCTIONS }],
        [h.feeState],
      );
    const unpause = (label: string, by: KeyPairSigner) =>
      fee(
        `unpause: ${label}`,
        "panic_unpause",
        by,
        {},
        [{ address: by.address, signer: by, writable: true }, { address: h.feeState, writable: true }, { address: INSTRUCTIONS }],
        [h.feeState],
      );
    const unpauseAnyone = (label: string) =>
      fee(`unpause (anyone): ${label}`, "panic_unpause_permissionless", other, {}, [{ address: h.feeState, writable: true }], [h.feeState]);
    tick(2n * 86_400n);
    await pause("by someone else", other);
    await unpause("not paused", admin);
    await pause("paused", admin);
    await unpauseAnyone("too early");
    tick(60n);
    await pause("extended", admin);
    await pause("a third time", admin);
    await pause("a fourth time the same day", admin);
    await unpause("by someone else", other);
    await unpause("by the global fee admin", admin);
    tick(86_400n);
    await pause("the next day", admin);
    tick(7n * 3_600n);
    await unpauseAnyone("expired");
    await unpauseAnyone("again");
    // The governance admin: the current one hands over (to a new one and back).
    const gov = (label: string, by: KeyPairSigner, to: Address) =>
      fee(
        `governance admin: ${label}`,
        "marginfi_group_set_governance_admin",
        by,
        { new_governance_admin: new web3.PublicKey(to) },
        [{ address: group.address, writable: true }, { address: by.address, signer: by }, { address: INSTRUCTIONS }],
        [group.address],
      );
    const govAt = offsetOf("MarginfiGroup", "governance_admin");
    const govWas = BigInt(
      "0x" +
        Buffer.from(data(group.address).subarray(govAt, govAt + 32))
          .reverse()
          .toString("hex"),
    );
    const current = await s.funded();
    editGroup(group.address, [["governance_admin", keyBits(current.address), 32]]);
    await gov("to nobody", current, "11111111111111111111111111111111" as Address);
    await gov("by someone else", other, other.address);
    await gov("handed over", current, other.address);
    await gov("handed back", other, current.address);
    editGroup(group.address, [["governance_admin", 0n, 32]]);
    await gov("the first, by the admin", admin, other.address);
    editGroup(group.address, [["governance_admin", govWas, 32]]);
    // Rate limits: a bank's (tokens) and the group's (dollars), by the admin or the limit admin.
    const bankLimits = (label: string, by: KeyPairSigner, hourly: bigint | null, daily: bigint | null) =>
      fee(
        `bank rate limits: ${label}`,
        "configure_bank_rate_limits",
        by,
        { hourly_max_outflow: hourly === null ? null : new BN(hourly.toString()), daily_max_outflow: daily === null ? null : new BN(daily.toString()) },
        [{ address: group.address }, { address: by.address, signer: by }, { address: usdc.address, writable: true }, { address: INSTRUCTIONS }],
        [usdc.address],
      );
    await bankLimits("by someone else", other, 1n, null);
    await bankLimits("past i64", admin, 1n << 63n, null);
    await bankLimits("both", admin, 5_000_000n, 50_000_000n);
    await bankLimits("off", admin, 0n, 0n);
    const groupLimits = (label: string, by: KeyPairSigner, hourly: bigint | null, daily: bigint | null) =>
      fee(
        `group rate limits: ${label}`,
        "configure_group_rate_limits",
        by,
        { hourly_max_outflow_usd: hourly === null ? null : new BN(hourly.toString()), daily_max_outflow_usd: daily === null ? null : new BN(daily.toString()) },
        [{ address: group.address, writable: true }, { address: by.address, signer: by }, { address: INSTRUCTIONS }],
        [group.address],
      );
    await groupLimits("by someone else", other, 1n, null);
    await groupLimits("past i64", admin, null, 1n << 63n);
    await groupLimits("hourly $1,000", admin, 1_000n, null);
    // The flow admin's updates to the group's windows.
    const flowAt = offsetOf("MarginfiGroup", "delegate_flow_admin");
    const flowWas = BigInt(
      "0x" +
        Buffer.from(data(group.address).subarray(flowAt, flowAt + 32))
          .reverse()
          .toString("hex"),
    );
    editGroup(group.address, [["delegate_flow_admin", keyBits(flow.address), 32]]);
    const seqAt = offsetOf("MarginfiGroup", "rate_limiter_last_admin_update_seq");
    const seq0 = data(group.address).readBigUInt64LE(seqAt);
    const slotAt = offsetOf("MarginfiGroup", "rate_limiter_last_admin_update_slot");
    const update = (label: string, by: KeyPairSigner, out: bigint | null, inflow: bigint | null, seq: bigint, from: bigint, to: bigint) =>
      fee(
        `group rate limiter: ${label}`,
        "update_group_rate_limiter",
        by,
        {
          outflow_usd: out === null ? null : new BN(out.toString()),
          inflow_usd: inflow === null ? null : new BN(inflow.toString()),
          update_seq: new BN(seq.toString()),
          event_start_slot: new BN(from.toString()),
          event_end_slot: new BN(to.toString()),
        },
        [{ address: group.address, writable: true }, { address: by.address, signer: by }, { address: INSTRUCTIONS }],
        [group.address],
      );
    tick();
    const last = data(group.address).readBigUInt64LE(slotAt);
    const lo = (last > slot - 100n ? last : slot - 100n) + 1n;
    await update("by someone else", other, 10n, null, seq0 + 1n, lo, slot - 1n);
    await update("nothing", flow, null, null, seq0 + 1n, lo, slot - 1n);
    await update("slots reversed", flow, 10n, null, seq0 + 1n, slot - 1n, lo);
    await update("a future slot", flow, 10n, null, seq0 + 1n, lo, slot + 5n);
    await update("out of sequence", flow, 10n, null, seq0 + 3n, lo, slot - 1n);
    await update("an inflow past i64", flow, null, 1n << 63n, seq0 + 1n, lo, slot - 1n);
    await update("an outflow", flow, 400n, null, seq0 + 1n, lo, lo + 1n);
    await update("an old slot", flow, 10n, null, seq0 + 2n, lo, lo + 2n);
    await update("past the hourly limit", flow, 700n, null, seq0 + 2n, lo + 2n, slot - 1n);
    await update("an inflow, then an outflow", flow, 700n, 300n, seq0 + 2n, lo + 2n, slot - 1n);
    const lastNow = data(group.address).readBigUInt64LE(slotAt);
    slot += 2_000n;
    setClock(t, slot);
    await update("stale", flow, 10n, null, seq0 + 3n, lastNow + 1n, lastNow + 2n);
    editGroup(group.address, [["delegate_flow_admin", flowWas, 32]]);
    await groupLimits("off", admin, 0n, 0n);
    // The premium matrix: sorted pairs, at most 64.
    const premium = (label: string, by: KeyPairSigner, c: number, l: number, rate: number) =>
      fee(
        `group premium: ${label}`,
        "lending_pool_configure_group_premium",
        by,
        { collateral_tag: c, liability_tag: l, rate },
        [{ address: group.address, writable: true }, { address: by.address, signer: by }, { address: INSTRUCTIONS }],
        [group.address],
      );
    await premium("by someone else", other, 1, 2, 1_000);
    await premium("an empty tag", admin, 0, 2, 1_000);
    await premium("past the highest rate", admin, 1, 2, 429_496_730);
    await premium("a new pair", admin, 1, 2, 1_000);
    await premium("a pair before it", admin, 1, 1, 2_000);
    await premium("a pair after them", admin, 3, 1, 3_000);
    await premium("a new rate", admin, 1, 2, 5_000);
    await premium("removed", admin, 1, 1, 0);
    await premium("removed again", admin, 1, 1, 0);
    await premium("removed, the first", admin, 1, 2, 0);
    await premium("removed, the last", admin, 3, 1, 0);
    // The whole fee state (the global fee admin), each field given replacing the stored one; restored after.
    const snapshot = (a: Address) => s.vms().map((vm) => ({ vm, x: vm.getAccount(a) }));
    const restore = (saved: ReturnType<typeof snapshot>, a: Address) => {
      for (const { vm, x } of saved) if (x.exists) vm.setAccount({ ...x, address: a });
    };
    const feeSaved = snapshot(h.feeState);
    const groupSaved = snapshot(group.address);
    const editFee = (label: string, by: KeyPairSigner, args: Record<string, unknown>) =>
      fee(
        `fee state: ${label}`,
        "edit_global_fee_state",
        by,
        {
          admin: null,
          fee_wallet: null,
          bank_init_flat_sol_fee: null,
          liquidation_flat_sol_fee: null,
          order_init_flat_sol_fee: null,
          program_fee_fixed: null,
          program_fee_rate: null,
          liquidation_max_fee: null,
          order_execution_max_fee: null,
          pause_delegate_admin: null,
          account_transfer_fee: null,
          ...args,
        },
        [{ address: by.address, signer: by }, { address: h.feeState, writable: true }, { address: INSTRUCTIONS }],
        [h.feeState],
      );
    await editFee("by someone else", other, { liquidation_flat_sol_fee: 1 });
    await editFee("nothing", admin, {});
    await editFee("every field", admin, {
      fee_wallet: new web3.PublicKey(other.address),
      bank_init_flat_sol_fee: 1_000,
      liquidation_flat_sol_fee: 2_000,
      order_init_flat_sol_fee: 3_000,
      program_fee_fixed: fx(ratio(2n, 100n)),
      program_fee_rate: fx(ratio(7n, 100n)),
      liquidation_max_fee: fx(ratio(15n, 100n)),
      order_execution_max_fee: fx(ratio(4n, 100n)),
      pause_delegate_admin: new web3.PublicKey(flow.address),
      account_transfer_fee: 1_234_567,
      admin: new web3.PublicKey(other.address),
    });
    await editFee("by the new admin", other, { admin: new web3.PublicKey(admin.address) });
    restore(feeSaved, h.feeState);
    // Governance roles and e-mode leverage caps (the governance admin).
    const govAdmin = await s.funded();
    editGroup(group.address, [["governance_admin", keyBits(govAdmin.address), 32]]);
    const caps = (label: string, by: KeyPairSigner, args: Record<string, unknown>) =>
      fee(
        `group gov: ${label}`,
        "marginfi_group_configure_gov",
        by,
        {
          new_admin: null,
          new_emode_admin: null,
          new_risk_admin: null,
          emode_max_init_leverage: null,
          emode_max_maint_leverage: null,
          same_asset_emode_init_leverage: null,
          same_asset_emode_maint_leverage: null,
          ...args,
        },
        [{ address: group.address, writable: true }, { address: by.address, signer: by }, { address: INSTRUCTIONS }],
        [group.address],
      );
    const lev = (n: bigint, d = 1n) => fx(ratio(n, d));
    await caps("by someone else", other, { new_risk_admin: new web3.PublicKey(other.address) });
    await caps("roles", govAdmin, { new_emode_admin: new web3.PublicKey(other.address), new_risk_admin: new web3.PublicKey(flow.address) });
    await caps("a leverage under 1", govAdmin, { emode_max_init_leverage: lev(1n, 2n), emode_max_maint_leverage: lev(10n) });
    await caps("a leverage over 100", govAdmin, { emode_max_init_leverage: lev(10n), emode_max_maint_leverage: lev(101n) });
    await caps("only one cap", govAdmin, { emode_max_init_leverage: lev(10n) });
    await caps("init at maint", govAdmin, { emode_max_init_leverage: lev(20n), emode_max_maint_leverage: lev(20n) });
    await caps("caps", govAdmin, { emode_max_init_leverage: lev(10n), emode_max_maint_leverage: lev(20n) });
    await caps("same-asset, only init", govAdmin, { same_asset_emode_init_leverage: lev(5n) });
    await caps("same-asset, init over maint", govAdmin, { same_asset_emode_init_leverage: lev(9n), same_asset_emode_maint_leverage: lev(8n) });
    await caps("same-asset", govAdmin, { same_asset_emode_init_leverage: lev(5n), same_asset_emode_maint_leverage: lev(10n) });
    await caps("a new admin", govAdmin, { new_admin: new web3.PublicKey(other.address) });
    restore(groupSaved, group.address);
    editGroup(group.address, [["group_flags", flagsWas, 8]]);
  });

  it("administers banks as the original does", async () => {
    const usdc = await newBank("pyth", 1_000_000n);
    const sol = await newBank("swb", 150_000_000n, { asset_tag: 1 }, 9);
    await user([[usdc, 500_000_000n]]);
    const other = await s.funded();
    const gov = await s.funded();
    const govAt = offsetOf("MarginfiGroup", "governance_admin");
    const govWas = BigInt(
      "0x" +
        Buffer.from(data(group.address).subarray(govAt, govAt + 32))
          .reverse()
          .toString("hex"),
    );
    editGroup(group.address, [["governance_admin", keyBits(gov.address), 32]]);
    const call = (
      label: string,
      name: string,
      by: KeyPairSigner,
      args: Record<string, unknown>,
      accounts: { address: Address; writable?: boolean; signer?: KeyPairSigner }[],
      watch: Address[],
    ) => run(label, by, [s.ix(name, args, accounts as never)], watch);
    // E-mode entries (the governance admin): sorted, checked, e-mode on when any is set.
    const entry = (tag: number, init: bigint, maint: bigint, flags = 0) => ({
      collateral_bank_emode_tag: tag,
      flags,
      pad0: [1, 2, 3, 4, 5],
      asset_weight_init: fx(ratio(init, 100n)),
      asset_weight_maint: fx(ratio(maint, 100n)),
    });
    const empty = () => entry(0, 0n, 0n);
    const emode = (label: string, by: KeyPairSigner, bank: Priced, tag: number, list: ReturnType<typeof entry>[]) =>
      call(
        `bank emode: ${label}`,
        "lending_pool_configure_bank_emode",
        by,
        { emode_tag: tag, entries: [...list, ...Array.from({ length: 10 - list.length }, empty)] },
        [{ address: group.address }, { address: by.address, signer: by }, { address: bank.address, writable: true }, { address: INSTRUCTIONS }],
        [bank.address],
      );
    await emode("by someone else", other, sol, 5, [entry(3, 80n, 90n)]);
    await emode("entries out of order", gov, sol, 5, [entry(7, 70n, 80n), entry(3, 80n, 90n, 1), entry(4, 60n, 70n)]);
    await emode("an initial weight over maintenance", gov, sol, 5, [entry(3, 95n, 90n)]);
    await emode("a tag twice", gov, sol, 5, [entry(3, 80n, 90n), entry(3, 70n, 80n)]);
    await emode("past the leverage caps", gov, sol, 5, [entry(3, 129n, 129n)]);
    await emode("none", gov, usdc, 2, []);
    await emode("one for usdc", gov, usdc, 2, [entry(6, 50n, 60n)]);
    const clone = (label: string, by: KeyPairSigner, from: Priced, to: Priced) =>
      call(
        `clone emode: ${label}`,
        "lending_pool_clone_emode",
        by,
        {},
        [
          { address: group.address },
          { address: by.address, signer: by },
          { address: from.address },
          { address: to.address, writable: true },
          { address: INSTRUCTIONS },
        ],
        [to.address],
      );
    await clone("by someone else", other, sol, usdc);
    await clone("sol's to usdc", gov, sol, usdc);
    // Premium tags and activation (the admin); turning it off warns that unpaid premium is forgiven.
    const premium = (label: string, by: KeyPairSigner, bank: Priced, tag: number, active: boolean) =>
      call(
        `bank premium: ${label}`,
        "lending_pool_configure_bank_premium",
        by,
        { premium_tag: tag, active },
        [{ address: group.address }, { address: by.address, signer: by }, { address: bank.address, writable: true }, { address: INSTRUCTIONS }],
        [bank.address],
      );
    await premium("by someone else", other, usdc, 4, true);
    await premium("on", admin, usdc, 4, true);
    tick();
    await premium("on again", admin, usdc, 5, true);
    await premium("off", admin, usdc, 5, false);
    await premium("off again", admin, usdc, 0, false);
    // The circuit breaker cleared (the admin or the risk admin).
    const clear = (label: string, by: KeyPairSigner, reseed: boolean) =>
      call(
        `clear breaker: ${label}`,
        "lending_pool_clear_circuit_breaker",
        by,
        { reseed_reference: reseed },
        [{ address: group.address }, { address: by.address, signer: by }, { address: usdc.address, writable: true }, { address: INSTRUCTIONS }],
        [usdc.address],
      );
    editBank(usdc.address, [
      ["cb_tier", 2n, 1],
      ["cb_halt_started_at", t - 100n, 8],
      ["cb_halt_ended_at", t + 1_000n, 8],
      ["cb_reference_price", 5n * ONE, 16],
    ]);
    tick(60n);
    await clear("by someone else", other, false);
    await clear("by the admin", admin, false);
    editBank(usdc.address, [["cb_tier", 1n, 1]]);
    await clear("reseeding the references", admin, true);
    // Backfilled flags: a seed that derives the bank, IS_T22 from its mint.
    const backfill = (label: string, bank: Address, m: Address, seed: bigint | null) =>
      call(
        `backfill: ${label}`,
        "lending_pool_backfill_bank_is_t22_flag",
        other,
        { bank_seed: seed === null ? null : new BN(seed.toString()) },
        [{ address: bank, writable: true }, { address: group.address }, { address: m }],
        [bank],
      );
    await backfill("the wrong mint", usdc.address, sol.mint, null);
    await backfill("nothing to backfill", usdc.address, usdc.mint, null);
    await backfill("a seed of another bank", usdc.address, usdc.mint, 3n);
    const sm = await mint(TOKEN_PROGRAM, 6);
    const [seededIx, seeded] = await addBank(group.address, gov, sm, TOKEN_PROGRAM, bankConfig(), { seed: 7n });
    await run("add seeded bank", admin, [seededIx], [seeded.address]);
    editBank(seeded.address, [
      ["flags", 0n, 8],
      ["bank_seed", 0n, 8],
    ]);
    await backfill("its own seed", seeded.address, sm, 7n);
    const tm = await mint(TOKEN_2022, 6);
    const [t22Ix, t22Bank] = await addBank(group.address, gov, tm, TOKEN_2022, bankConfig());
    await run("add t22 bank", admin, [t22Ix], [t22Bank.address]);
    editBank(t22Bank.address, [["flags", 0n, 8]]);
    await backfill("a Token-2022 mint", t22Bank.address, tm, null);
    // Closing banks (the admin).
    const close = (label: string, by: KeyPairSigner, bank: Address, force: boolean | null) =>
      call(
        `close bank: ${label}`,
        "lending_pool_close_bank",
        by,
        { force_close: force },
        [
          { address: group.address, writable: true },
          { address: bank, writable: true },
          { address: by.address, signer: by, writable: true },
          { address: INSTRUCTIONS },
        ],
        [group.address, bank, by.address],
      );
    await close("by someone else", other, t22Bank.address, null);
    await close("with deposits", admin, usdc.address, null);
    await close("with deposits, forced", admin, usdc.address, true);
    editBank(t22Bank.address, [["flags", 0n, 8]]);
    await close("not made to close", admin, t22Bank.address, null);
    await close("not made to close, forced", admin, t22Bank.address, true);
    const fm = await mint(TOKEN_PROGRAM, 6);
    const [freshIx, fresh] = await addBank(group.address, gov, fm, TOKEN_PROGRAM, bankConfig());
    await run("add an empty bank", admin, [freshIx], [fresh.address]);
    await close("an empty bank", admin, fresh.address, false);
    // The governance admin's bank settings: weights, tier, tag, oracle limits, flags; only back to Operational.
    const govCfg = (label: string, by: KeyPairSigner, bank: Priced, c: Record<string, unknown>) =>
      call(
        `bank gov: ${label}`,
        "lending_pool_configure_bank_gov",
        by,
        {
          bank_config_opt: {
            asset_weight_init: null,
            asset_weight_maint: null,
            liability_weight_init: null,
            liability_weight_maint: null,
            operational_state: null,
            risk_tier: null,
            asset_tag: null,
            oracle_max_confidence: null,
            oracle_max_age: null,
            tokenless_repayments_allowed: null,
            freeze_settings: null,
            ...c,
          },
        },
        [{ address: group.address }, { address: by.address, signer: by }, { address: bank.address, writable: true }, { address: INSTRUCTIONS }],
        [bank.address],
      );
    const w = (n: bigint) => fx(ratio(n, 100n));
    await govCfg("by someone else", other, sol, { asset_weight_init: w(60n) });
    await govCfg("paused", gov, sol, { operational_state: { Paused: {} } });
    await govCfg("weights", gov, sol, {
      asset_weight_init: w(60n),
      asset_weight_maint: w(70n),
      liability_weight_init: w(140n),
      liability_weight_maint: w(130n),
    });
    await govCfg("an initial weight over maintenance", gov, sol, { asset_weight_init: w(80n), asset_weight_maint: w(70n) });
    await govCfg("isolated with weights", gov, usdc, { risk_tier: { Isolated: {} } });
    await govCfg("tier, tag and oracle limits", gov, usdc, {
      risk_tier: { Isolated: {} },
      asset_weight_init: w(0n),
      asset_weight_maint: w(0n),
      asset_tag: 0,
      oracle_max_confidence: 1_000,
      oracle_max_age: 60,
    });
    editBank(usdc.address, [["config.operational_state", 0n, 1]]);
    await govCfg("back to operational", gov, usdc, { operational_state: { Operational: {} }, risk_tier: { Collateral: {} } });
    await govCfg("tokenless repayments", gov, usdc, { tokenless_repayments_allowed: true });
    await govCfg("frozen", gov, usdc, { freeze_settings: true, tokenless_repayments_allowed: false });
    await govCfg("ignored while frozen", gov, usdc, { asset_weight_init: w(10n) });
    editBank(usdc.address, [["flags", 0n, 8]]);
    editGroup(group.address, [["governance_admin", govWas, 32]]);
  });

  it("collects premium fees, and refuses super-admin moves, as the original does", async () => {
    const usdc = await newBank("pyth", 1_000_000n);
    await user([[usdc, 500_000_000n]]);
    const other = await s.funded();
    const premiumWallet = await s.funded();
    const wallet = await h.createAta(premiumWallet.address, usdc.mint, TOKEN_PROGRAM);
    const sweep = (label: string, to: Address, extra: { address: Address }[] = []) =>
      run(
        `premium fees: ${label}`,
        other,
        [
          {
            ...s.ix("lending_pool_collect_bank_premium_fees", {}, [
              { address: group.address },
              { address: usdc.address, writable: true },
              { address: usdc.v.liquidityAuth },
              { address: usdc.v.liquidity, writable: true },
              { address: h.feeState },
              { address: to, writable: true },
              { address: TOKEN_PROGRAM },
            ]),
          },
        ],
        [usdc.address, usdc.v.liquidity, to],
      );
    const pwAt = offsetOf("FeeState", "premium_wallet");
    const pwWas = BigInt(
      "0x" +
        Buffer.from(data(h.feeState).subarray(pwAt, pwAt + 32))
          .reverse()
          .toString("hex"),
    );
    h.edit("FeeState")(h.feeState, [["premium_wallet", 0n, 32]]);
    await sweep("no premium wallet", wallet);
    h.edit("FeeState")(h.feeState, [["premium_wallet", keyBits(premiumWallet.address), 32]]);
    const otherAta = await h.createAta(other.address, usdc.mint, TOKEN_PROGRAM);
    await sweep("someone else's account", otherAta);
    editBank(usdc.address, [["collected_premium_outstanding", 1_234n * ONE + ONE / 3n, 16]]);
    await sweep("part of a token left", wallet);
    await sweep("nothing left but the fraction", wallet);
    editBank(usdc.address, [["collected_premium_outstanding", 900_000_000_000n * ONE, 16]]);
    await sweep("more than the vault holds", wallet);
    h.edit("FeeState")(h.feeState, [["premium_wallet", pwWas, 32]]);
    // Super-admin deposits and withdrawals exist only on staging and localnet builds.
    const sup = (
      label: string,
      name: string,
      by: KeyPairSigner,
      accounts: { address: Address; writable?: boolean; signer?: KeyPairSigner }[],
      failing: boolean,
    ) => run(`${name}: ${label}`, by, [s.ix(name, { amount: new BN(5) }, accounts as never)], [usdc.address], failing);
    const depositAccounts = (by: KeyPairSigner) => [
      { address: group.address },
      { address: by.address, signer: by },
      { address: usdc.address, writable: true },
      { address: wallet, writable: true },
      { address: usdc.v.liquidity, writable: true },
      { address: TOKEN_PROGRAM },
      { address: INSTRUCTIONS },
    ];
    await sup("by someone else", "super_admin_deposit", other, depositAccounts(other), false);
    await sup("on the mainnet build", "super_admin_deposit", admin, depositAccounts(admin), true);
    const withdrawAccounts = (by: KeyPairSigner) => [
      { address: group.address },
      { address: by.address, signer: by },
      { address: usdc.address, writable: true },
      { address: wallet, writable: true },
      { address: usdc.v.liquidityAuth },
      { address: usdc.v.liquidity, writable: true },
      { address: TOKEN_PROGRAM },
      { address: INSTRUCTIONS },
    ];
    await sup("by someone else", "super_admin_withdraw", other, withdrawAccounts(other), false);
    await sup("on the mainnet build", "super_admin_withdraw", admin, withdrawAccounts(admin), true);
  });

  it("withdraws Token-2022 with its transfer fee as the original does", async () => {
    const m = await h.feeMint(6, 150, 1_000_000n);
    const [ix, tb] = await addBank(group.address, admin, m, TOKEN_2022, bankConfig());
    await run("add t22 bank", admin, [ix], [tb.address]);
    const oracle = (await generateKeyPairSigner()).address;
    const p: Priced = { ...tb, oracle, kind: "pyth", price: 1_000_000n, decimals: 6, mint: m, program: TOKEN_2022 };
    banks.push(p);
    refresh();
    await run("t22 oracle", admin, [h.configureOracle(group.address, admin, tb.address, 3, oracle, [oracle])], [tb.address]);
    const a = await user([[p, 1_000_000_000n]]);
    tick();
    await w("t22 with fee", a, p, 100_000_000n);
    await w("t22 no mint", a, p, 1n, { rest: [] });
    await w("t22 all", a, p, 0n, { all: true });
    await user([[p, 500_000_000n]]);
    const c = await user([[byKind("swb"), 10_000_000_000n]]);
    tick();
    await b("t22 with fee", c, p, 10_000_000n);
    await b("t22 no mint", c, p, 1n, { rest: [] });
    // Bankruptcy in the fee bank: the vault's balance after the fee covers part, the transfer grossed up for it.
    const z = await user([[byKind("fixed"), 10_000n]]);
    owe(z.account, p, 50n * 1_000_000n * ONE);
    setAmount(p.v.insurance, 20_000_000n);
    tick();
    await settle("t22 insurance covers part", z, p, admin, [m, ...healthAccounts(z.account, [], true)]);
    await settle("t22 no mint", z, p, admin, healthAccounts(z.account, [], true));
    // Liquidating a debt in the fee bank: the insurance fund's cut moves with transfer_checked.
    const nb = await newBank("swb", 150_000_000n, {}, 9);
    await user([[nb, 100_000_000_000n]]);
    const q = await user([[nb, 10_000_000_000n]]);
    owe(q.account, p, 1_400n * 1_000_000n * ONE);
    const lq = await user([[p, 3_000_000_000n]]);
    tick();
    await liq("t22 debt", q, lq, nb, p, 1_000_000_000n);
    await liq("t22 debt, no mint", q, lq, nb, p, 1_000_000_000n, { noMint: true });
  });
  it("deposits emissions and keeps the same-asset e-mode registry as the original does", async () => {
    const usdc = await newBank("pyth", 1_000_000n);
    const sol = await newBank("swb", 150_000_000n, {}, 9);
    const t22 = await newBank("pyth", 1_000_000n, {}, 6, TOKEN_2022);
    const lender = await user([
      [usdc, 500_000_000n],
      [t22, 500_000_000n],
    ]);
    const donor = await user([]);
    const other = await user([]);
    // Same-mint emissions straight into the vault (anyone): the share value rises; fee and hook mints are refused.
    const emissions = (
      label: string,
      by: KeyPairSigner,
      bank: Bank,
      m: Address,
      from: Address,
      amount: bigint,
      program: Address = TOKEN_PROGRAM,
      vault: Address = bank.v.liquidity,
    ) =>
      run(
        `emissions: ${label}`,
        by,
        [
          s.ix("lending_pool_emissions_deposit", { amount: new BN(amount.toString()) }, [
            { address: group.address },
            { address: bank.address, writable: true },
            { address: m },
            { address: from, writable: true },
            { address: by.address, signer: by, writable: true },
            { address: vault, writable: true },
            { address: program },
          ] as never),
        ],
        [bank.address, bank.v.liquidity, from],
      );
    const give = (label: string, bank: Priced, amount: bigint) =>
      emissions(label, donor.owner, bank, bank.mint, donor.wallets.get(bank.address)!, amount, bank.program);
    tick();
    await give("nothing", usdc, 0n);
    await emissions("the wrong mint", donor.owner, usdc, sol.mint, donor.wallets.get(usdc.address)!, 1_000n);
    await emissions("the wrong vault", donor.owner, usdc, usdc.mint, donor.wallets.get(usdc.address)!, 1_000n, TOKEN_PROGRAM, sol.v.liquidity);
    await emissions("someone else's tokens", donor.owner, usdc, usdc.mint, other.wallets.get(usdc.address)!, 1_000n);
    await give("into usdc", usdc, 25_000_000n);
    tick(3_600n);
    await give("after an hour", usdc, 1n);
    await give("into a Token-2022 bank", t22, 7_000_000n);
    await give("into a bank without deposits", sol, 1_000n);
    await user([[sol, 1_000n]]);
    await give("too few shares", sol, 1_000n);
    editBank(usdc.address, [["config.operational_state", 0n, 1]]);
    await give("a paused bank", usdc, 1_000n);
    editBank(usdc.address, [["config.operational_state", 1n, 1]]);
    const extMint = async (label: string, m: Address) => {
      const [ix, bank] = await addBank(group.address, admin, m, TOKEN_2022, bankConfig());
      await run(`add ${label} bank`, admin, [ix], [bank.address]);
      const from = await h.t22Account(m, donor.owner.address, 0n);
      await emissions(label, donor.owner, bank, m, from, 1_000n, TOKEN_2022);
    };
    await extMint("a transfer fee", await h.feeMint(6, 150, 1_000_000n));
    await extMint("a zero transfer fee", await h.feeMint(6, 0, 0n));
    await extMint("a transfer hook", await h.hookMint(6, (await generateKeyPairSigner()).address));
    tick();
    await w("all of it, after emissions", lender, usdc, 0n, { all: true });

    // The same-asset e-mode registry (the governance admin): banks grouped by (mint, oracle_keys[0]).
    const fixed = await newBank("fixed", 1_000_000n);
    const [twinIx, twin] = await addBank(group.address, admin, usdc.mint, TOKEN_PROGRAM, bankConfig(), { seed: 1n });
    await run("add a twin bank", admin, [twinIx], [twin.address]);
    await run("twin oracle", admin, [h.configureOracle(group.address, admin, twin.address, 3, usdc.oracle!, [usdc.oracle!])], [twin.address]);
    const third = await newBank("pyth", 2_000_000n);
    const gov = await s.funded();
    const govAt = offsetOf("MarginfiGroup", "governance_admin");
    const govWas = BigInt(
      "0x" +
        Buffer.from(data(group.address).subarray(govAt, govAt + 32))
          .reverse()
          .toString("hex"),
    );
    editGroup(group.address, [["governance_admin", keyBits(gov.address), 32]]);
    const [registry] = await pda(PROGRAM, ["same_asset_emode_registry", group.address]);
    const init = (label: string, by: KeyPairSigner) =>
      run(
        `emode registry: ${label}`,
        by,
        [
          s.ix("lending_pool_init_same_asset_emode_registry", {}, [
            { address: group.address },
            { address: by.address, signer: by, writable: true },
            { address: registry, writable: true },
            { address: SYSTEM },
            { address: INSTRUCTIONS },
          ] as never),
        ],
        [registry, by.address],
      );
    const eligible = (label: string, by: KeyPairSigner, bank: Address, enabled: boolean, at: Address = registry) =>
      run(
        `same-asset emode: ${label}`,
        by,
        [
          s.ix("lending_pool_set_bank_same_asset_emode_eligibility", { enabled }, [
            { address: group.address },
            { address: by.address, signer: by },
            { address: bank, writable: true },
            { address: at, writable: true },
            { address: INSTRUCTIONS },
          ] as never),
        ],
        [bank, registry],
      );
    await eligible("before the registry", gov, usdc.address, true);
    await init("by someone else", other.owner);
    await init("created", gov);
    await init("again", gov);
    await eligible("by someone else", other.owner, usdc.address, true);
    await eligible("another account as the registry", gov, usdc.address, true, group.address);
    await eligible("a fixed price", gov, fixed.address, true);
    await eligible("usdc", gov, usdc.address, true);
    await eligible("usdc again", gov, usdc.address, true);
    await eligible("its twin", gov, twin.address, true);
    await eligible("sol", gov, sol.address, true);
    await eligible("a third", gov, third.address, true);
    await eligible("usdc off", gov, usdc.address, false);
    await eligible("sol off, its group emptied", gov, sol.address, false);
    await eligible("sol off again", gov, sol.address, false);
    editBank(third.address, [["flags", 4096n + 8n, 8]]);
    await eligible("a frozen bank", gov, third.address, false);
    editBank(third.address, [["flags", 4096n, 8]]);
    editBank(sol.address, [["config.oracle_keys[0]", 0n, 32]]);
    await eligible("no oracle key", gov, sol.address, true);
    await eligible("the twin off, its group emptied", gov, twin.address, false);
    await eligible("the third off, the registry empty", gov, third.address, false);
    await eligible("usdc back", gov, usdc.address, true);
    editGroup(group.address, [["governance_admin", govWas, 32]]);
  });
  it("keeps bank metadata, and refuses clones, as the original does", async () => {
    const usdc = await newBank("pyth", 1_000_000n);
    const sm = await mint(TOKEN_PROGRAM, 6);
    const [seededIx, seeded] = await addBank(group.address, admin, sm, TOKEN_PROGRAM, bankConfig(), { seed: 3n });
    await run("add a seeded bank", admin, [seededIx], [seeded.address]);
    const other = await s.funded();
    const mdAdmin = await s.funded();
    editGroup(group.address, [["metadata_admin", keyBits(mdAdmin.address), 32]]);
    const metadataOf = async (bank: Address) => (await pda(PROGRAM, ["metadata", bank]))[0];
    // Opening metadata (anyone pays): the bank may not exist yet; a seeded bank must be its own PDA.
    const open = async (label: string, bank: Address) =>
      run(
        `init metadata: ${label}`,
        other,
        [
          s.ix("init_bank_metadata", {}, [
            { address: bank },
            { address: other.address, signer: other, writable: true },
            { address: await metadataOf(bank), writable: true },
            { address: SYSTEM },
          ] as never),
        ],
        [await metadataOf(bank)],
      );
    await open("a bank", usdc.address);
    await open("again", usdc.address);
    await open("a seeded bank", seeded.address);
    await open("a bank to come", (await generateKeyPairSigner()).address);
    await open("an account that is no bank", group.address);
    const fake = await newBank("pyth", 1_000_000n);
    editBank(fake.address, [["flags", 256n, 8]]);
    await open("a seed known, not its PDA", fake.address);
    // Writing it (the metadata admin): each field when given, zero-filled, the index of its last byte kept.
    const bytes = (x: string | number) => (typeof x === "number" ? Buffer.alloc(x, 0x41) : Buffer.from(x));
    const write = async (label: string, by: KeyPairSigner, bank: Address, ticker: Buffer | null, description: Buffer | null, md?: Address) => {
      const metadata = md ?? (await metadataOf(bank));
      return run(
        `write metadata: ${label}`,
        by,
        [
          s.ix("write_bank_metadata", { ticker, description }, [
            { address: group.address },
            { address: bank },
            { address: by.address, signer: by, writable: true },
            { address: metadata, writable: true },
            { address: INSTRUCTIONS },
          ] as never),
        ],
        [metadata],
      );
    };
    await write("by someone else", other, usdc.address, bytes("USDC"), null);
    await write("both", mdAdmin, usdc.address, bytes("USDC"), bytes("US Dollar Coin"));
    await write("a shorter ticker only", mdAdmin, usdc.address, bytes("US"), null);
    await write("an empty description", mdAdmin, usdc.address, null, bytes(0));
    await write("an empty ticker", mdAdmin, usdc.address, bytes(0), bytes("dollars"));
    await write("nothing", mdAdmin, usdc.address, null, null);
    await write("both at their caps", mdAdmin, usdc.address, bytes(64), bytes(128));
    await write("a ticker too long", mdAdmin, usdc.address, bytes(65), null);
    await write("a description too long", mdAdmin, usdc.address, bytes("X"), bytes(129));
    await write("another bank's metadata", mdAdmin, usdc.address, bytes("X"), null, await metadataOf(seeded.address));
    await write("a seeded bank", mdAdmin, seeded.address, bytes("SEED"), bytes("seeded"));
    editBank(usdc.address, [["flags", 256n, 8]]);
    await write("a seed known, not its PDA", mdAdmin, usdc.address, bytes("X"), null);
    editBank(usdc.address, [["flags", 0n, 8]]);
    // Before the bank exists: the metadata of the PDA a seed will give.
    const um = await mint(TOKEN_PROGRAM, 6);
    const seedBytes = (n: bigint) => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(n);
      return new Uint8Array(b);
    };
    const [upcoming] = await pda(PROGRAM, [group.address, um, seedBytes(9n)]);
    await open("a seeded bank to come", upcoming);
    const preInit = async (label: string, by: KeyPairSigner, seed: bigint, ticker: Buffer | null, description: Buffer | null) =>
      run(
        `write metadata before the bank: ${label}`,
        by,
        [
          s.ix("write_bank_metadata_pre_init", { bank_seed: new BN(seed.toString()), ticker, description }, [
            { address: group.address },
            { address: um },
            { address: upcoming },
            { address: by.address, signer: by, writable: true },
            { address: await metadataOf(upcoming), writable: true },
            { address: INSTRUCTIONS },
          ] as never),
        ],
        [await metadataOf(upcoming)],
      );
    await preInit("by someone else", other, 9n, bytes("NEW"), null);
    await preInit("another seed", mdAdmin, 8n, bytes("NEW"), null);
    await preInit("written", mdAdmin, 9n, bytes("NEW"), bytes("a bank to come"));
    await preInit("a ticker too long", mdAdmin, 9n, bytes(65), null);
    editGroup(group.address, [["metadata_admin", 0n, 32]]);
    // Clones of mainnet banks exist only on staging and localnet builds: the mainnet build panics.
    const cm = await mint(TOKEN_PROGRAM, 6);
    const [cloneAt] = await pda(PROGRAM, [group.address, cm, seedBytes(1n)]);
    const v = await h.vaults(cloneAt);
    const clone = (label: string, by: KeyPairSigner, failing: boolean | "if-panics") =>
      run(
        `clone bank: ${label}`,
        by,
        [
          s.ix("lending_pool_clone_bank", { bank_seed: new BN(1) }, [
            { address: group.address, writable: true },
            { address: by.address, signer: by, writable: true },
            { address: admin.address, signer: admin, writable: true },
            { address: cm },
            { address: usdc.address },
            { address: cloneAt, writable: true },
            { address: v.liquidityAuth },
            { address: v.liquidity, writable: true },
            { address: v.insuranceAuth },
            { address: v.insurance, writable: true },
            { address: v.feeAuth },
            { address: v.fee, writable: true },
            { address: TOKEN_PROGRAM },
            { address: SYSTEM },
            { address: INSTRUCTIONS },
          ] as never),
        ],
        [cloneAt, group.address],
        failing,
      );
    await clone("by someone else", other, false);
    await clone("on the mainnet build", admin, true);
  });
  it("places and closes orders as the original does", async () => {
    const usdc = await newBank("pyth", 1_000_000n);
    const sol = await newBank("swb", 150_000_000n, {}, 9);
    const third = await newBank("pyth", 2_000_000n);
    const fixed = await newBank("fixed", 1_000_000n);
    await user([[sol, 100_000_000_000n]]);
    const u = await user([
      [usdc, 1_000_000_000n],
      [third, 500_000_000n],
    ]);
    tick();
    await b("for an order", u, sol, 1_000_000_000n);
    const other = await s.funded();
    const orderOf = async (account: Address, keys: Address[]) => {
      const sorted = keys.map(keyBytes).sort(Buffer.compare);
      const hash = createHash("sha256").update(Buffer.concat(sorted)).digest();
      return (await pda(PROGRAM, ["order", account, new Uint8Array(hash)]))[0];
    };
    const sl = (threshold: bigint, slip = U32_MAX / 100n) => ({ StopLoss: { threshold: fx(threshold), max_slippage: Number(slip) } });
    const tp = (threshold: bigint, slip = U32_MAX / 100n) => ({ TakeProfit: { threshold: fx(threshold), max_slippage: Number(slip) } });
    const both = (stop: bigint, take: bigint, slip = U32_MAX / 100n) => ({
      Both: { stop_loss: fx(stop), take_profit: fx(take), max_slippage: Number(slip) },
    });
    const place = async (label: string, by: KeyPairSigner, account: Address, keys: Address[], trigger: unknown) => {
      const order = await orderOf(account, keys);
      return run(
        `place order: ${label}`,
        by,
        [
          s.ix("marginfi_account_place_order", { bank_keys: keys.map((k) => new web3.PublicKey(k)), trigger }, [
            { address: group.address },
            { address: account, writable: true },
            { address: other.address, signer: other, writable: true },
            { address: by.address, signer: by },
            { address: order, writable: true },
            { address: h.feeState },
            { address: h.feeWallet, writable: true },
            { address: SYSTEM },
          ] as never),
        ],
        [account, order, h.feeWallet, other.address],
      );
    };
    const a = u.account;
    await place("one bank", u.owner, a, [usdc.address], sl(ONE));
    await place("one bank twice", u.owner, a, [usdc.address, usdc.address], sl(ONE));
    await place("three banks", u.owner, a, [usdc.address, sol.address, third.address], sl(ONE));
    await place("by someone else", other, a, [usdc.address, sol.address], sl(ONE));
    await place("a bank without a balance", u.owner, a, [usdc.address, fixed.address], sl(ONE));
    await place("two assets", u.owner, a, [usdc.address, third.address], sl(ONE));
    await place("a zero stop loss", u.owner, a, [usdc.address, sol.address], sl(0n));
    await place("a take profit under the stop loss", u.owner, a, [usdc.address, sol.address], both(500n * ONE, 400n * ONE));
    await place("too much slippage", u.owner, a, [usdc.address, sol.address], tp(500n * ONE, U32_MAX / 10n + 1n));
    await place("a stop loss", u.owner, a, [usdc.address, sol.address], sl(700n * ONE, U32_MAX / 10n));
    await place("the same pair again", u.owner, a, [sol.address, usdc.address], tp(900n * ONE));
    h.edit("FeeState")(h.feeState, [["order_init_flat_sol_fee", 25_000n, 4]]);
    await place("a take profit, with the flat fee", u.owner, a, [sol.address, third.address], tp(900n * ONE));
    h.edit("FeeState")(h.feeState, [["order_init_flat_sol_fee", 0n, 4]]);
    await place("both, the other way round", u.owner, a, [third.address, sol.address], both(100n * ONE, 900n * ONE));
    const flags = data(a).readBigUInt64LE(offsetOf("MarginfiAccount", "account_flags"));
    editAccount(a, [["account_flags", flags | 2n, 8]]);
    await place("in a flash loan", u.owner, a, [usdc.address, third.address], sl(ONE));
    editAccount(a, [["account_flags", flags, 8]]);
    // A second account, its deposits in several banks before a borrow: the balance search runs over them unsorted.
    const v = await user([
      [third, 100_000_000n],
      [usdc, 300_000_000n],
      [fixed, 1_000n],
    ]);
    tick();
    await b("for orders, unsorted", v, sol, 500_000_000n);
    for (const k of [usdc, third, fixed]) await place(`each pair: ${k.kind}`, v.owner, v.account, [k.address, sol.address], sl(ONE));
    // Untagging (the authority): some banks, or all; then a keeper may close the orders left without their balances.
    const untag = (label: string, by: KeyPairSigner, account: Address, keys: Address[] | null) =>
      run(
        `keeper close flags: ${label}`,
        by,
        [
          s.ix("marginfi_account_set_keeper_close_flags", { bank_keys_opt: keys && keys.map((k) => new web3.PublicKey(k)) }, [
            { address: group.address },
            { address: account, writable: true },
            { address: by.address, signer: by },
          ] as never),
        ],
        [account],
      );
    const keeperClose = async (label: string, account: Address, keys: Address[]) => {
      const order = await orderOf(account, keys);
      return run(
        `keeper close order: ${label}`,
        other,
        [
          s.ix("marginfi_account_keeper_close_order", {}, [
            { address: account, writable: true },
            { address: other.address, writable: true },
            { address: order, writable: true },
          ] as never),
        ],
        [account, order, other.address],
      );
    };
    await keeperClose("both balances tagged", a, [usdc.address, sol.address]);
    await untag("by someone else", other, a, [usdc.address]);
    await untag("a bank not held", u.owner, a, [fixed.address]);
    await untag("usdc", u.owner, a, [usdc.address]);
    await keeperClose("usdc untagged", a, [usdc.address, sol.address]);
    await keeperClose("already closed", a, [usdc.address, sol.address]);
    await place("both, the pair's order gone", u.owner, a, [usdc.address, sol.address], both(100n * ONE, 900n * ONE));
    await keeperClose("another account's order", v.account, [third.address, sol.address]);
    await untag("none given: all", v.owner, v.account, null);
    await untag("an empty list", v.owner, v.account, []);
    await keeperClose("all untagged", v.account, [third.address, sol.address]);
    // Closing (the authority or the governance admin): the rent to whom they name.
    const close = async (label: string, by: KeyPairSigner, account: Address, keys: Address[], orderAccount?: Address) => {
      const order = await orderOf(orderAccount ?? account, keys);
      return run(
        `close order: ${label}`,
        by,
        [
          s.ix("marginfi_account_close_order", {}, [
            { address: group.address },
            { address: account, writable: true },
            { address: by.address, signer: by },
            { address: order, writable: true },
            { address: other.address, writable: true },
            { address: SYSTEM },
          ] as never),
        ],
        [account, order, other.address],
      );
    };
    await close("by someone else", other, a, [sol.address, third.address]);
    await close("another account's order", u.owner, a, [usdc.address, sol.address], v.account);
    await close("by its authority", u.owner, a, [sol.address, third.address]);
    await close("again", u.owner, a, [sol.address, third.address]);
    // An account closed under its order: anyone may close the order.
    for (const vm of s.vms())
      vm.setAccount({ address: v.account, data: new Uint8Array(0), executable: false, lamports: lamports(0n), programAddress: SYSTEM, space: 0n });
    await keeperClose("its account closed", v.account, [fixed.address, sol.address]);
  });
});
