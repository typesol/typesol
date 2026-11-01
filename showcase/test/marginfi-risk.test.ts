// Marginfi part 3 against the mainnet binary: withdrawals and borrows (lending_account_withdraw, lending_account_borrow)
// and the risk engine they run: Initial health over Pyth, Switchboard and fixed prices, the oracle errors it records or
// fails on, the isolated tier, e-mode, the deposit cap's discount, premiums, the liquidation tag, the circuit breaker's
// gate, rate limits, receivership and deleverage paths, origination fees, Token-2022. Most debts are written into both
// programs directly, to set up the withdrawals; the borrows make their own.
import { type Address, type Instruction, type KeyPairSigner, generateKeyPairSigner } from "@solana/kit";
import { web3 } from "@anchor-lang/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOKEN_2022, TOKEN_PROGRAM, pda } from "../../test/harness.js";
import { SYSTEM, report } from "./jito-helpers.js";
import { INSTRUCTIONS, ONE, PROGRAM, bankConfig, fx, marginfiPair, offsetOf, ratio } from "./marginfi-helpers.js";

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
    const banksOf = (u: User) => healthAccounts(u.account, [], true).filter((a) => banks.some((b) => b.address === a));
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
          h.endLiquidation(group.address, c.e.account, c.record, o.endBy ?? receiver, banksOf(c.e), { feePayer: o.feePayer, readonlyRest: o.readonlyRest }),
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
});
