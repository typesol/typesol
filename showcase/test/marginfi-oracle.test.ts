// Marginfi part 3a against the mainnet binary: pointing banks at oracles (lending_pool_configure_bank_oracle), fixed
// prices (lending_pool_set_oracle_price) and the price cache with its circuit breaker (lending_pool_pulse_bank_price_cache),
// over Pyth push and Switchboard pull accounts written byte for byte into both programs' ledgers.
import { type Address, type KeyPairSigner, generateKeyPairSigner } from "@solana/kit";
import { afterAll, beforeAll, describe, it } from "vitest";
import { TOKEN_PROGRAM } from "../../test/harness.js";
import { SYSTEM, report } from "./jito-helpers.js";
import { INSTRUCTIONS, ONE, PYTH_RECEIVER, U32_MAX, bankConfig, marginfiPair, offsetOf, ratio } from "./marginfi-helpers.js";

describe("Marginfi v2 port against the mainnet binary: oracles", () => {
  const h = marginfiPair();
  const { s, run, initFeeState, groupInit, mint, addBank, editBank, editGroup, advanceNonce, fast, setPyth, setSwb, setClock } = h;
  let admin: KeyPairSigner;
  let group: KeyPairSigner;

  const newAddress = async () => (await generateKeyPairSigner()).address;
  const configureOracle = (
    bank: Address,
    setup: number,
    oracle: Address,
    extra: Address[] = [],
    by: KeyPairSigner = admin,
    g: Address = group.address,
    sysvar: Address = INSTRUCTIONS,
  ) => h.configureOracle(g, by, bank, setup, oracle, extra, sysvar);
  const setPrice = (bank: Address, price: bigint, setup: number, extra: Address[] = [], by: KeyPairSigner = admin, g: Address = group.address) =>
    h.setOraclePrice(g, by, bank, price, setup, extra);
  const pulse = (bank: Address, extra: Address[] = [], g: Address = group.address) => h.pulse(g, bank, extra);
  /** The original's breaker state (MARGINFI_VERBOSE): tier, ended-at, consecutive tier-3 trips, operational state, references. */
  const cbState = (bank: Address) => {
    if (!process.env.MARGINFI_VERBOSE) return;
    const d = Buffer.from((s.original.getAccount(bank) as { data: Uint8Array }).data);
    const at = (f: string) => offsetOf("Bank", f);
    console.log(
      `  tier ${d[at("cb_tier")]} until ${d.readBigInt64LE(at("cb_halt_ended_at"))} t3 ${d[at("cb_tier3_consecutive_trips")]} state ${d[at("config.operational_state")]} ref ${d.readBigInt64LE(at("cb_reference_price") + 6)} wref ${d.readBigInt64LE(at("cb_window_reference_price") + 6)}`,
    );
  };
  const configureBank = (bank: Address, c: Record<string, unknown>) =>
    s.ix("lending_pool_configure_bank", { bank_config_opt: fast(c) }, [
      { address: group.address },
      { address: admin.address, signer: admin },
      { address: bank, writable: true },
      { address: INSTRUCTIONS },
    ]);
  const newBank = async (over: Record<string, unknown> = {}, g: KeyPairSigner = group) => {
    const m = await mint(TOKEN_PROGRAM, 6);
    const [ix, b] = await addBank(g.address, admin, m, TOKEN_PROGRAM, bankConfig(over));
    await run("add bank", admin, [ix], [b.address]);
    return b.address;
  };

  beforeAll(async () => {
    await h.load();
    admin = h.admin;
    await run("init fee state", admin, [initFeeState(admin, h.feeWallet)], [h.feeState]);
    group = await generateKeyPairSigner();
    await run("group init", admin, [groupInit(group, admin)], [group.address]);
  });
  afterAll(() => report("marginfi-oracle", s));

  it("points banks at Pyth and Switchboard feeds as the original does", async () => {
    const t = 1_800_300_000n;
    setClock(t, 400_000_000n);
    const bank = await newBank();
    const sol = await newBank({ asset_tag: 1 });
    const pyth = await newAddress();
    const swb = await newAddress();
    setPyth(pyth, { price: 150_000_000n, conf: 50_000n, expo: -6, publishTime: t });
    setSwb(swb, { value: 150n * 10n ** 18n, lastUpdate: t });
    const w = [bank];
    const other = await s.funded();

    // Constraints, then the body's order: durable nonce, frozen (a panic), the setup byte (a panic past 28), the kinds
    // that go elsewhere, same-asset e-mode, validation.
    await run("oracle: not the governance admin", other, [configureOracle(bank, 3, pyth, [pyth], other)], w);
    const g2 = await generateKeyPairSigner();
    await run("second group", admin, [groupInit(g2, admin)], [g2.address]);
    const foreign = await newBank({}, g2);
    await run("oracle: bank of another group", admin, [configureOracle(foreign, 3, pyth, [pyth])], [foreign]);
    await run("oracle: wrong sysvar", admin, [configureOracle(bank, 3, pyth, [pyth], admin, group.address, SYSTEM)], w);
    await run("oracle: durable nonce", admin, [configureOracle(bank, 3, pyth, [pyth]), advanceNonce(admin)], w);
    editBank(bank, [["flags", 8n, 8]]);
    await run("oracle: frozen bank", admin, [configureOracle(bank, 3, pyth, [pyth])], w, "if-panics");
    editBank(bank, [["flags", 0n, 8]]);
    await run("oracle: setup 29", admin, [configureOracle(bank, 29, pyth, [pyth])], w, "if-panics");
    await run("oracle: setup 255", admin, [configureOracle(bank, 255, pyth, [pyth])], w, "if-panics");
    for (const setup of [1, 2]) await run(`oracle: deprecated setup ${setup}`, admin, [configureOracle(bank, setup, pyth, [pyth])], w, "if-panics");
    await run("oracle: none", admin, [configureOracle(bank, 0, pyth)], w);
    for (const setup of [8, 13, 14, 17, 25, 26]) await run(`oracle: setup ${setup} takes a set price`, admin, [configureOracle(bank, setup, pyth, [pyth])], w);
    for (const setup of [18, 27, 28]) await run(`oracle: setup ${setup} is Scope`, admin, [configureOracle(bank, setup, pyth, [pyth])], w);

    // Pyth: the number of accounts, the key, the account (length, discriminator, Borsh); no age or verification here.
    await run("pyth: no account", admin, [configureOracle(bank, 3, pyth)], w);
    await run("pyth: two accounts", admin, [configureOracle(bank, 3, pyth, [pyth, swb])], w);
    await run("pyth: wrong key", admin, [configureOracle(bank, 3, pyth, [swb])], w);
    const odd = await newAddress();
    setPyth(odd, { price: 1n, conf: 0n, expo: 0, publishTime: t, len: 7 });
    await run("pyth: 7 bytes", admin, [configureOracle(bank, 3, odd, [odd])], w);
    setPyth(odd, { price: 1n, conf: 0n, expo: 0, publishTime: t, disc: [1, 2, 3, 4, 5, 6, 7, 8] });
    await run("pyth: wrong discriminator", admin, [configureOracle(bank, 3, odd, [odd])], w);
    setPyth(odd, { price: 1n, conf: 0n, expo: 0, publishTime: t, len: 132 });
    await run("pyth: too short to decode", admin, [configureOracle(bank, 3, odd, [odd])], w, "if-panics");
    setPyth(odd, { price: 1n, conf: 0n, expo: 0, publishTime: t, len: 40 });
    await run("pyth: no verification level", admin, [configureOracle(bank, 3, odd, [odd])], w, "if-panics");
    setPyth(odd, { price: 1n, conf: 0n, expo: 0, publishTime: t, level: 2 });
    await run("pyth: unknown verification level", admin, [configureOracle(bank, 3, odd, [odd])], w, "if-panics");
    setPyth(odd, { price: 1n, conf: 0n, expo: 0, publishTime: t, partial: true, len: 133 });
    await run("pyth: partial, one byte short", admin, [configureOracle(bank, 3, odd, [odd])], w, "if-panics");
    setPyth(odd, { price: 1n, conf: 0n, expo: 0, publishTime: t - 100_000n, partial: true });
    await run("pyth: partial and stale (checked when priced)", admin, [configureOracle(bank, 3, odd, [odd])], w);
    await run("pyth", admin, [configureOracle(bank, 3, pyth, [pyth])], w);
    await run("pyth on a SOL bank", admin, [configureOracle(sol, 3, pyth, [pyth])], [sol]);

    // Switchboard: the owner, then the discriminator and size.
    const swbOdd = await newAddress();
    setSwb(swbOdd, { value: 1n, lastUpdate: t, owner: PYTH_RECEIVER });
    await run("switchboard: wrong owner", admin, [configureOracle(bank, 4, swbOdd, [swbOdd])], w);
    setSwb(swbOdd, { value: 1n, lastUpdate: t, len: 3207 });
    await run("switchboard: short", admin, [configureOracle(bank, 4, swbOdd, [swbOdd])], w);
    setSwb(swbOdd, { value: 1n, lastUpdate: t, disc: [0, 0, 0, 0, 0, 0, 0, 1] });
    await run("switchboard: wrong discriminator", admin, [configureOracle(bank, 4, swbOdd, [swbOdd])], w);
    setSwb(swbOdd, { value: 1n, lastUpdate: 0n, len: 4000 });
    await run("switchboard: longer, never updated", admin, [configureOracle(bank, 4, swbOdd, [swbOdd])], w);
    await run("switchboard", admin, [configureOracle(sol, 4, swb, [swb])], [sol]);

    // Venue setups refuse a default bank on its asset tag; mSOL and LST count their accounts first.
    for (const setup of [6, 7, 9, 10, 11, 12, 15, 16]) await run(`venue setup ${setup}`, admin, [configureOracle(bank, setup, pyth, [pyth])], w);
    for (const setup of [20, 21, 23, 24]) {
      await run(`setup ${setup}: two accounts`, admin, [configureOracle(bank, setup, pyth, [pyth, swb])], w);
      await run(`setup ${setup}: three accounts`, admin, [configureOracle(bank, setup, pyth, [pyth, swb, odd])], w);
    }
    for (const setup of [19, 22]) {
      await run(`setup ${setup}: one account`, admin, [configureOracle(bank, setup, pyth, [pyth])], w);
      await run(`setup ${setup} on a SOL bank`, admin, [configureOracle(sol, setup, pyth, [pyth, swb])], [sol]);
    }
    await run("staked setup on a default bank", admin, [configureOracle(bank, 5, pyth, [pyth])], w);
    // A staked bank (its tag written into both): only the staked setup, validated lightly.
    const staked = await newBank();
    editBank(staked, [["config.asset_tag", 2n, 1]]);
    await run("pyth on a staked bank", admin, [configureOracle(staked, 3, pyth, [pyth])], [staked]);
    await run("staked setup", admin, [configureOracle(staked, 5, pyth, [pyth])], [staked]);

    // Same-asset e-mode: the same feed account and kind of feed only.
    await run("same-asset: before", admin, [configureOracle(bank, 3, pyth, [pyth])], w);
    editBank(bank, [["flags", 4096n, 8]]);
    await run("same-asset: other account", admin, [configureOracle(bank, 3, swb, [swb])], w);
    await run("same-asset: other kind of feed", admin, [configureOracle(bank, 4, pyth, [pyth])], w);
    await run("same-asset: same feed", admin, [configureOracle(bank, 3, pyth, [pyth])], w);
    editBank(bank, [["flags", 0n, 8]]);
  });

  it("sets fixed prices as the original does", async () => {
    const bank = await newBank();
    const sol = await newBank({ asset_tag: 1 });
    const w = [bank];
    const other = await s.funded();
    const extra = await newAddress();
    await run("fixed: not the governance admin", other, [setPrice(bank, ONE, 8, [], other)], w);
    const g2 = await generateKeyPairSigner();
    await run("fixed: second group", admin, [groupInit(g2, admin)], [g2.address]);
    const foreign = await newBank({}, g2);
    await run("fixed: bank of another group", admin, [setPrice(foreign, ONE, 8)], [foreign]);
    editBank(bank, [["flags", 8n, 8]]);
    await run("fixed: frozen bank", admin, [setPrice(bank, ONE, 8)], w, "if-panics");
    editBank(bank, [["flags", 4096n, 8]]);
    await run("fixed: same-asset e-mode", admin, [setPrice(bank, ONE, 8)], w);
    editBank(bank, [["flags", 0n, 8]]);
    await run("fixed: setup 29", admin, [setPrice(bank, ONE, 29)], w, "if-panics");
    await run("fixed: setup 3", admin, [setPrice(bank, ONE, 3)], w);
    await run("fixed: negative", admin, [setPrice(bank, -1n, 8)], w);
    await run("fixed: SOL bank", admin, [setPrice(sol, ONE, 8)], [sol]);
    await run("fixed: an account", admin, [setPrice(bank, ONE, 8, [extra])], w);
    await run("fixed", admin, [setPrice(bank, ratio(3n, 2n), 8)], w);
    await run("fixed: zero", admin, [setPrice(bank, 0n, 8)], w);
    for (const [label, price, n] of [
      ["no price", 0n, 2],
      ["above 1", ONE + 1n, 2],
      ["one account", ONE, 1],
      ["valid, not ported (Exponent vault)", ONE / 2n, 2],
    ] as const) {
      const accounts = Array.from({ length: n }, () => extra);
      await run(`PT Pyth: ${label}`, admin, [setPrice(sol, price, 25, accounts)], [sol]);
    }
    await run("PT fixed: two accounts", admin, [setPrice(sol, ONE, 26, [extra, extra])], [sol]);
    await run("PT fixed: on a SOL bank", admin, [setPrice(sol, ONE, 26, [extra])], [sol]);
    const staked = await newBank();
    editBank(staked, [["config.asset_tag", 2n, 1]]);
    await run("fixed: staked bank", admin, [setPrice(staked, ONE, 8)], [staked]);
  });

  it("prices banks into their cache as the original does", async () => {
    let t = 1_800_400_000n;
    let slot = 500_000_000n;
    setClock(t, slot);
    const bank = await newBank();
    const pyth = await newAddress();
    const swb = await newAddress();
    const w = [bank];
    const next = (dt = 10n) => {
      t += dt;
      slot += 5n;
      setClock(t, slot);
    };
    await run("pulse: no oracle", admin, [pulse(bank)], w);
    setPyth(pyth, { price: 150_000_000n, conf: 50_000n, expo: -6, publishTime: t, emaPrice: 149_000_000n, emaConf: 60_000n });
    await run("pulse setup", admin, [configureOracle(bank, 3, pyth, [pyth])], w);
    await run("pulse: no account", admin, [pulse(bank)], w);
    await run("pulse: two accounts", admin, [pulse(bank, [pyth, pyth])], w);
    await run("pulse: wrong account", admin, [pulse(bank, [swb])], w);
    await run("pulse: pyth", admin, [pulse(bank, [pyth])], w);
    next(61n);
    await run("pulse: stale (61 s, max 60)", admin, [pulse(bank, [pyth])], w);
    setPyth(pyth, { price: 150_000_000n, conf: 50_000n, expo: -6, publishTime: t, partial: true });
    await run("pulse: partial", admin, [pulse(bank, [pyth])], w);
    setPyth(pyth, { price: 150_000_000n, conf: 50_000n, expo: -6, publishTime: t + 1000n });
    await run("pulse: published in the future", admin, [pulse(bank, [pyth])], w);
    next();
    // The confidence: 2.12 × conf against 10% of the price, or the bank's maximum; at most 5% kept.
    setPyth(pyth, { price: 150_000_000n, conf: 7_100_000n, expo: -6, publishTime: t });
    await run("pulse: 10% of the price passed", admin, [pulse(bank, [pyth])], w);
    setPyth(pyth, { price: 150_000_000n, conf: 7_000_000n, expo: -6, publishTime: t });
    await run("pulse: wide confidence", admin, [pulse(bank, [pyth])], w);
    editBank(bank, [["config.oracle_max_confidence", U32_MAX / 4n, 4]]);
    next();
    setPyth(pyth, { price: 150_000_000n, conf: 7_100_000n, expo: -6, publishTime: t });
    await run("pulse: within the bank's maximum", admin, [pulse(bank, [pyth])], w);
    editBank(bank, [["config.oracle_max_confidence", 0n, 4]]);
    for (const expo of [0, 2, -8, -23, 23, -24, 24, 100]) {
      next();
      setPyth(pyth, { price: 1234n, conf: 1n, expo, publishTime: t });
      await run(`pulse: exponent ${expo}`, admin, [pulse(bank, [pyth])], w, "if-panics");
    }
    next();
    setPyth(pyth, { price: 9_223_372_036_854_775_807n, conf: 1n, expo: 10, publishTime: t });
    await run("pulse: price × 10^10 overflows", admin, [pulse(bank, [pyth])], w);
    next();
    setPyth(pyth, { price: -5n, conf: 0n, expo: -8, publishTime: t });
    await run("pulse: tiny negative price", admin, [pulse(bank, [pyth])], w);
    next();
    setPyth(pyth, { price: -150_000_000n, conf: 0n, expo: -6, publishTime: t });
    await run("pulse: negative price", admin, [pulse(bank, [pyth])], w);
    setPyth(pyth, { price: 1n, conf: 0n, expo: 0, publishTime: t, len: 100 });
    await run("pulse: undecodable", admin, [pulse(bank, [pyth])], w, "if-panics");

    // Switchboard: owner, account, age; the price is result.value / 10^18 (a value past 2^79 wraps in from_num).
    await run("switchboard: no account yet", admin, [configureOracle(bank, 4, swb, [swb])], w);
    setSwb(swb, { value: 150n * 10n ** 18n, lastUpdate: t });
    await run("pulse setup switchboard", admin, [configureOracle(bank, 4, swb, [swb])], w);
    await run("pulse: switchboard", admin, [pulse(bank, [swb])], w);
    next(61n);
    await run("pulse: switchboard stale", admin, [pulse(bank, [swb])], w);
    for (const [label, value] of [
      ["cents", 10n ** 16n + 3n],
      ["negative", -(150n * 10n ** 18n)],
      ["past 2^79", (1n << 80n) + 12345n],
      ["i128 max", (1n << 127n) - 1n],
    ] as const) {
      next();
      setSwb(swb, { value, lastUpdate: t + 5n });
      await run(`pulse: switchboard ${label}`, admin, [pulse(bank, [swb])], w);
    }
    editBank(bank, [["config.oracle_max_confidence", U32_MAX / 100n, 4]]);
    next();
    setSwb(swb, { value: 150n * 10n ** 18n, lastUpdate: t });
    await run("pulse: switchboard with confidence", admin, [pulse(bank, [swb])], w);
    editBank(bank, [["config.oracle_max_confidence", U32_MAX, 4]]);
    next();
    setSwb(swb, { value: 150n * 10n ** 18n, lastUpdate: t });
    await run("pulse: switchboard confidence capped", admin, [pulse(bank, [swb])], w);
    setSwb(swb, { value: 1n, lastUpdate: t, owner: PYTH_RECEIVER });
    await run("pulse: switchboard wrong owner", admin, [pulse(bank, [swb])], w);

    // Fixed: no accounts; a negative price written into the config is refused.
    await run("pulse: fixed price", admin, [setPrice(bank, ratio(7n, 3n), 8)], w);
    await run("pulse: fixed", admin, [pulse(bank)], w);
    await run("pulse: fixed with an account", admin, [pulse(bank, [swb])], w);
    editBank(bank, [["config.fixed_price", -1n, 16]]);
    await run("pulse: fixed negative", admin, [pulse(bank)], w);
    editBank(bank, [["config.fixed_price", ONE, 16]]);

    // Interest accrues first (not while paused); a locked liquidation cache keeps its price.
    editBank(bank, [
      ["total_asset_shares", 1_000_000n * ONE, 16],
      ["total_liability_shares", 400_000n * ONE, 16],
    ]);
    next(3600n);
    await run("pulse: accrues", admin, [pulse(bank)], w);
    editGroup(group.address, [
      ["panic_state_cache.pause_flags", 1n, 1],
      ["panic_state_cache.pause_start_timestamp", t - 10n, 8],
    ]);
    next(3600n);
    await run("pulse: protocol paused", admin, [pulse(bank)], w);
    editGroup(group.address, [["panic_state_cache.pause_flags", 0n, 1]]);
    editBank(bank, [["cache.liq_cache_flags", 1n, 1]]);
    next();
    await run("pulse: locked cache", admin, [setPrice(bank, ratio(9n, 4n), 8), pulse(bank)], w);
    editBank(bank, [["cache.liq_cache_flags", 0n, 1]]);
  });

  it("runs the circuit breaker on pulses as the original does", async () => {
    let t = 1_800_500_000n;
    let slot = 600_000_000n;
    setClock(t, slot);
    const bank = await newBank();
    const pyth = await newAddress();
    const w = [bank];
    let price = 100_000_000n;
    const at = (p: bigint, dt = 10n, dslot = 3n, conf = 10_000n) => {
      t += dt;
      slot += dslot;
      setClock(t, slot);
      price = p;
      setPyth(pyth, { price: p, conf, expo: -6, publishTime: t });
    };
    at(price, 0n, 0n);
    await run("cb: setup", admin, [configureOracle(bank, 3, pyth, [pyth])], w);
    // Not enabled: the cache only.
    await run("cb: off", admin, [pulse(bank, [pyth])], w);
    cbState(bank);
    const cb = { cb_deviation_bps_tiers: [500, 1000, 2000], cb_tier_durations_seconds: [60, 300, 900], cb_escalation_window_mult: 2, cb_ema_alpha_bps: 2000 };
    await run("cb: enable", admin, [configureBank(bank, { circuit_breaker_enabled: true, ...cb })], w);
    // Clean moves pull the reference (at most 5% a pulse); dedup on slots and publish times.
    for (const p of [102_000_000n, 104_000_000n, 103_000_000n, 99_000_000n]) {
      at(p);
      await run(`cb: clean ${p}`, admin, [pulse(bank, [pyth])], w);
      cbState(bank);
    }
    at(price, 10n, 1n);
    await run("cb: one slot later", admin, [pulse(bank, [pyth])], w);
    cbState(bank);
    t += 5n;
    slot += 3n;
    setClock(t, slot);
    await run("cb: same publication", admin, [pulse(bank, [pyth])], w);
    cbState(bank);
    // Tier 1, its halt (frozen), escalation within the window, expiry back to operational.
    at(106_000_000n);
    await run("cb: tier 1", admin, [pulse(bank, [pyth])], w);
    cbState(bank);
    at(130_000_000n, 30n);
    await run("cb: halted", admin, [pulse(bank, [pyth])], w);
    cbState(bank);
    at(108_000_000n, 40n);
    await run("cb: re-breach escalates", admin, [pulse(bank, [pyth])], w);
    cbState(bank);
    at(100_000_000n, 2000n);
    await run("cb: window expired, cleared", admin, [pulse(bank, [pyth])], w);
    cbState(bank);
    // Three tier-3 trips in a row break the bank.
    for (let i = 0; i < 3; i++) {
      at(130_000_000n + BigInt(i), 1000n);
      await run(`cb: tier 3 #${i + 1}`, admin, [pulse(bank, [pyth])], w);
      cbState(bank);
    }
    at(100_000_000n, 2000n);
    await run("cb: circuit-broken, frozen", admin, [pulse(bank, [pyth])], w);
    cbState(bank);

    // The long window: a slow walk within the tiers trips the window cap; after it ran out the anchor creeps.
    const walk = await newBank();
    const feed = await newAddress();
    const ww = [walk];
    const go = (p: bigint, dt: bigint) => {
      t += dt;
      slot += 3n;
      setClock(t, slot);
      setPyth(feed, { price: p, conf: 0n, expo: -6, publishTime: t });
    };
    go(100_000_000n, 1n);
    await run("window: setup", admin, [configureOracle(walk, 3, feed, [feed]), pulse(walk, [feed])], ww);
    await run(
      "window: enable",
      admin,
      [
        configureBank(walk, {
          circuit_breaker_enabled: true,
          ...cb,
          cb_ema_alpha_bps: 2000,
          cb_window_seconds: 600,
          cb_window_max_up_bps: 1500,
          cb_window_max_down_bps: 1200,
        }),
      ],
      ww,
    );
    let p = 100_000_000n;
    for (let i = 0; i < 8; i++) {
      p = (p * 104n) / 100n;
      go(p, 30n);
      await run(`window: walk up ${i}`, admin, [pulse(walk, [feed])], ww);
      cbState(walk);
    }
    go(p, 1200n);
    await run("window: after the halt, past the window", admin, [pulse(walk, [feed])], ww);
    cbState(walk);
    for (let i = 0; i < 6; i++) {
      p = (p * 97n) / 100n;
      go(p, 700n);
      await run(`window: walk down ${i}`, admin, [pulse(walk, [feed])], ww);
      cbState(walk);
    }
    // Back to operational (written into both): a reference at or below the floor reseeds; a tier past 3 in raw state
    // panics indexing its duration.
    editBank(walk, [
      ["config.operational_state", 1n, 1],
      ["cb_tier3_consecutive_trips", 0n, 1],
      ["cb_tier", 0n, 1],
      ["cb_reference_price", 1048576n, 16],
    ]);
    go(p, 5000n);
    await run("window: reference at the floor", admin, [pulse(walk, [feed])], ww);
    cbState(walk);
    editBank(walk, [
      ["cb_tier", 4n, 1],
      ["cb_halt_ended_at", 0n, 8],
    ]);
    go(p, 10n);
    await run("window: tier 4 in raw state", admin, [pulse(walk, [feed])], ww, "if-panics");
    editBank(walk, [["cb_tier", 0n, 1]]);
  });
});
