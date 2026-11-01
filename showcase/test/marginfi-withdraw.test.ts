// Marginfi part 3b against the mainnet binary: withdrawals (lending_account_withdraw) and the risk engine they run:
// Initial health over Pyth, Switchboard and fixed prices, the oracle errors it records or fails on, the isolated
// tier, e-mode, the deposit cap's discount, premiums, the liquidation tag, the circuit breaker's gate, rate limits,
// receivership and deleverage paths, Token-2022. Liabilities are written into both programs (borrows come in 3c).
import { type Address, type KeyPairSigner, generateKeyPairSigner } from "@solana/kit";
import { web3 } from "@anchor-lang/core";
import { afterAll, beforeAll, describe, it } from "vitest";
import { TOKEN_2022, TOKEN_PROGRAM } from "../../test/harness.js";
import { report } from "./jito-helpers.js";
import { ONE, bankConfig, fx, marginfiPair, offsetOf, ratio } from "./marginfi-helpers.js";

type Bank = Awaited<ReturnType<ReturnType<typeof marginfiPair>["addBank"]>>[1];

describe("Marginfi v2 port against the mainnet binary: withdrawals", () => {
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

  /** The account's [bank, oracle] groups in balance order (descending bank key), leaving out `skip`. */
  const healthAccounts = (account: Address, skip: Address[] = []) => {
    const d = data(account);
    const keys: Address[] = [];
    for (let i = 0; i < 16; i++) {
      const at = offsetOf("MarginfiAccount", `lending_account.balances[${i}].active`);
      if (d[at] === 0) continue;
      const k = d.subarray(at + 1, at + 33);
      const b = banks.find((x) => keyBytes(x.address).equals(k));
      if (b && !skip.includes(b.address)) keys.push(b.address);
    }
    keys.sort((x, y) => Buffer.compare(keyBytes(y), keyBytes(x)));
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

  beforeAll(async () => {
    await h.load();
    admin = h.admin;
    await run("init fee state", admin, [initFeeState(admin, h.feeWallet)], [h.feeState]);
    group = await generateKeyPairSigner();
    setClock(t, slot);
    await run("group init", admin, [groupInit(group, admin)], [group.address]);
  });
  afterAll(() => report("marginfi-withdraw", s));

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

  it("withdraws Token-2022 with its transfer fee as the original does", async () => {
    const m = await h.feeMint(6, 150, 1_000_000n);
    const [ix, b] = await addBank(group.address, admin, m, TOKEN_2022, bankConfig());
    await run("add t22 bank", admin, [ix], [b.address]);
    const oracle = (await generateKeyPairSigner()).address;
    const p: Priced = { ...b, oracle, kind: "pyth", price: 1_000_000n, decimals: 6, mint: m, program: TOKEN_2022 };
    banks.push(p);
    refresh();
    await run("t22 oracle", admin, [h.configureOracle(group.address, admin, b.address, 3, oracle, [oracle])], [b.address]);
    const a = await user([[p, 1_000_000_000n]]);
    tick();
    await w("t22 with fee", a, p, 100_000_000n);
    await w("t22 no mint", a, p, 1n, { rest: [] });
    await w("t22 all", a, p, 0n, { all: true });
  });
});
