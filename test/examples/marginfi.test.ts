// examples/marginfi/marginfi.ts against the marginfi v2 program deployed on mainnet (test/programs/marginfi_v2.so, the
// binary at MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA): every transaction is sent to both, and the outcome, the bytes
// of the accounts it touches and the events must be the same. The original's msg! logs are not compared (the port does
// not repeat them); WARN lines are.
import { type Address, type Instruction, type KeyPairSigner, generateKeyPairSigner } from "@solana/kit";
import { type Idl } from "@anchor-lang/core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BN, TOKEN_2022, TOKEN_PROGRAM } from "../harness.js";
import { SYSTEM, report } from "../jito-helpers.js";
import { INSTRUCTIONS, ONE, U32_MAX, bankConfig, fx, le, marginfiPair, offsetOf, ratio } from "../marginfi-helpers.js";

describe("Marginfi v2 port against the mainnet binary", () => {
  const h = marginfiPair();
  const { s, run, initFeeState, groupInit, configure, advanceNonce, mint, addBank, watchBank, accrue, editBank, editGroup, setTime, fast, irOpt, sysvar, tokenAccount } = h;
  let feeState: Address;
  let admin: KeyPairSigner;
  let feeWallet: Address;
  beforeAll(async () => {
    await h.load();
    ({ admin, feeState, feeWallet } = h);
  });
  afterAll(() => report("marginfi", s));

  it("describes each ported instruction and its events as the on-chain IDL does", () => {
    const onchain = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/marginfi/marginfi.idl.json", import.meta.url)), "utf8")) as Idl;
    const strip = (v: unknown) => JSON.parse(JSON.stringify(v, (k, x) => (k === "docs" ? undefined : x)));
    // Accounts with their writable / signer flags, PDA seeds, relations and addresses; discriminators; arguments.
    expect(s.d.idl.instructions.length).toBe(11);
    for (const ix of s.d.idl.instructions) expect(strip(ix), ix.name).toEqual(strip(onchain.instructions.find((o) => o.name === ix.name)));
    for (const e of s.d.idl.events ?? []) expect(e, e.name).toEqual(onchain.events!.find((o) => o.name === e.name));
  });

  it("creates the fee state and groups, and sets group roles, as the original does", async () => {
    await run("init fee state", admin, [initFeeState(admin, feeWallet)], [feeState]);
    await run("init fee state twice", admin, [initFeeState(admin, feeWallet)], [feeState]);

    const group = await generateKeyPairSigner();
    await run("group init: wrong fee state", admin, [groupInit(group, admin, (await generateKeyPairSigner()).address)], [group.address]);
    await run("group init: wrong instructions sysvar", admin, [groupInit(group, admin, feeState, SYSTEM)], [group.address]);
    // The durable-nonce check runs before anything else of the body; the advance-nonce ix after it never runs.
    await run("group init: durable nonce", admin, [groupInit(group, admin), advanceNonce(admin)], [group.address]);
    await run("group init", admin, [groupInit(group, admin)], [group.address, feeState]);
    await run("group init again", admin, [groupInit(group, admin)], [group.address]);

    const other = await s.funded();
    const [a, b, c] = [await generateKeyPairSigner(), await generateKeyPairSigner(), await generateKeyPairSigner()];
    await run("configure: not the admin", other, [configure(group.address, other, { new_admin: other.address })], [group.address]);
    await run("configure: durable nonce", admin, [configure(group.address, admin, { new_curve_admin: a.address }), advanceNonce(admin)], [group.address]);
    await run("configure: nothing", admin, [configure(group.address, admin, {})], [group.address]);
    await run(
      "configure: every role",
      admin,
      [configure(group.address, admin, { new_curve_admin: a.address, new_limit_admin: b.address, new_flow_admin: c.address, new_emissions_admin: a.address, new_metadata_admin: b.address })],
      [group.address],
    );
    await run("configure: same admin", admin, [configure(group.address, admin, { new_admin: admin.address })], [group.address]);
    await run("configure: hand over", admin, [configure(group.address, admin, { new_admin: other.address })], [group.address]);
    await run("configure: old admin", admin, [configure(group.address, admin, { new_limit_admin: a.address })], [group.address]);
    await run("configure: new admin", other, [configure(group.address, other, { new_limit_admin: c.address })], [group.address]);

    // Propagate: the fee state's panic state reaches the group (set straight into the fee state, in both).
    const propagate = s.ix("propagate_fee_state", {}, [{ address: feeState }, { address: group.address, writable: true }]);
    await run("propagate", admin, [propagate], [group.address]);
    for (const vm of s.vms()) {
      const f = vm.getAccount(feeState);
      if (!f.exists) throw new Error("no fee state");
      const data = Buffer.from(f.data);
      // FeeState.panic_state (8 + 32 × 3 + 4 + 4 + 4 + 1 + 3 + 16 × 3 = 168): pause_flags, then pause_start_timestamp at +8.
      data[168] = 1;
      data.writeBigInt64LE(1_799_999_000n, 176);
      vm.setAccount({ ...f, address: feeState, data: new Uint8Array(data) });
    }
    s.epoch(901n);
    await run("propagate a pause", admin, [propagate], [group.address]);
    await run("propagate: not the fee state", admin, [s.ix("propagate_fee_state", {}, [{ address: group.address }, { address: group.address, writable: true }])], [group.address]);
  });

  it("adds banks and accrues their interest as the original does", async () => {
    const group = await generateKeyPairSigner();
    await run("bank group init", admin, [groupInit(group, admin)], [group.address]);
    const usdc = await mint(TOKEN_PROGRAM, 6);
    const t22 = await mint(TOKEN_2022, 9);
    const other = await s.funded();

    const refused = async (label: string, by: KeyPairSigner, config: ReturnType<typeof bankConfig>, opts: { seed?: bigint; wallet?: Address } = {}) => {
      const [ix, b] = await addBank(group.address, by, usdc, TOKEN_PROGRAM, config, opts);
      await run(`add bank: ${label}`, by, [ix], watchBank(b, group.address));
    };
    await refused("not the governance admin", other, bankConfig());
    await refused("wrong fee wallet", admin, bankConfig(), { wallet: other.address });
    await refused("staked asset tag", admin, bankConfig({ asset_tag: 2 }));
    await refused("asset weight above 1", admin, bankConfig({ asset_weight_init: fx(ONE + 1n), asset_weight_maint: fx(ONE + 1n) }));
    await refused("maint below init", admin, bankConfig({ asset_weight_maint: fx(ratio(4n, 10n)) }));
    await refused("liability weight below 1", admin, bankConfig({ liability_weight_init: fx(ONE - 1n), liability_weight_maint: fx(ONE - 1n) }));
    await refused("liability maint above init", admin, bankConfig({ liability_weight_maint: fx(ratio(14n, 10n)) }));
    await refused("isolated with asset weight", admin, bankConfig({ risk_tier: { Isolated: {} } }));
    await refused("oracle age 9", admin, bankConfig({ oracle_max_age: 9 }));
    await refused("hole in the curve", admin, bankConfig({}, { points: [{ util: 0, rate: 0 }, { util: 100, rate: 100 }, { util: 0, rate: 0 }, { util: 0, rate: 0 }, { util: 0, rate: 0 }] }));
    await refused("padding with a rate", admin, bankConfig({}, { points: [{ util: 0, rate: 5 }, { util: 0, rate: 0 }, { util: 0, rate: 0 }, { util: 0, rate: 0 }, { util: 0, rate: 0 }] }));
    await refused("utils not ascending", admin, bankConfig({}, { points: [{ util: 100, rate: 1 }, { util: 100, rate: 2 }, { util: 0, rate: 0 }, { util: 0, rate: 0 }, { util: 0, rate: 0 }] }));
    await refused("rate falling", admin, bankConfig({}, { points: [{ util: 100, rate: 9 }, { util: 200, rate: 8 }, { util: 0, rate: 0 }, { util: 0, rate: 0 }, { util: 0, rate: 0 }] }));
    await refused("zero rate above hundred", admin, bankConfig({}, { zero_util_rate: 10, hundred_util_rate: 9, points: [{ util: 0, rate: 0 }, { util: 0, rate: 0 }, { util: 0, rate: 0 }, { util: 0, rate: 0 }, { util: 0, rate: 0 }] }));
    await refused("point above hundred", admin, bankConfig({}, { hundred_util_rate: 50 }));
    {
      const [ix, b] = await addBank(group.address, admin, usdc, TOKEN_PROGRAM, bankConfig());
      await run("add bank: durable nonce", admin, [ix, advanceNonce(admin)], watchBank(b, group.address));
    }

    const [ix, usdcBank] = await addBank(group.address, admin, usdc, TOKEN_PROGRAM, bankConfig());
    expect(await run("add bank", admin, [ix], watchBank(usdcBank, group.address))).toBe("ok");
    const [ix2, t22Bank] = await addBank(group.address, admin, t22, TOKEN_2022, bankConfig({ risk_tier: { Isolated: {} }, asset_weight_init: fx(0n), asset_weight_maint: fx(0n), asset_tag: 1 }), { seed: 7n });
    await run("add bank with seed, Token-2022", admin, [ix2], watchBank(t22Bank, group.address));
    const [ix3, again] = await addBank(group.address, admin, t22, TOKEN_2022, bankConfig(), { seed: 7n });
    await run("add bank with seed: seed taken", admin, [ix3], watchBank(again, group.address));
    const [ix4, seed0] = await addBank(group.address, admin, usdc, TOKEN_PROGRAM, bankConfig(), { seed: 0n });
    await run("add bank with seed 0", admin, [ix4], watchBank(seed0, group.address));

    // Accrual on an empty bank: the event with no fees, nothing else.
    const b = usdcBank.address;
    setTime(1_800_100_000n);
    await run("accrue: empty bank", admin, [accrue(group.address, b)], [b]);
    await run("accrue: same second", admin, [accrue(group.address, b)], [b]);
    await run("accrue: wrong group", admin, [accrue(feeState, b)], [b]);
    const otherGroup = await generateKeyPairSigner();
    await run("other group init", admin, [groupInit(otherGroup, admin)], [otherGroup.address]);
    await run("accrue: another group's bank", admin, [accrue(otherGroup.address, b)], [b]);

    // Deposits and borrows (not ported yet) written into both: accrual over a range of utilizations and times.
    const shares = (assets: bigint, liabilities: bigint): [string, bigint, number][] => [
      ["total_asset_shares", assets * ONE, 16],
      ["total_liability_shares", liabilities * ONE, 16],
    ];
    let t = 1_800_100_000n;
    for (const [assets, liabilities, dt] of [
      [1_000_000n, 1n, 1n],
      [1_000_000n, 250_000n, 60n],
      [1_000_000n, 500_000n, 3_600n],
      [1_000_000n, 650_000n, 86_400n],
      [1_000_000n, 800_000n, 31_536_000n],
      [1_000_000n, 950_000n, 7n],
      [1_000_000n, 1_000_000n, 1_000n],
      [1_000_000n, 2_000_000n, 1_000n],
      [123_456_789_012n, 98_765_432_101n, 12_345n],
      [5n, 3n, 999_999n],
    ] as const) {
      editBank(b, shares(assets, liabilities));
      t += dt;
      setTime(t);
      await run(`accrue: ${liabilities}/${assets} over ${dt}s`, admin, [accrue(group.address, b)], [b]);
    }
    // Liabilities only, and assets only: the cache resets (keeping the oracle price), the bank's time stays.
    editBank(b, [...shares(0n, 10n), ["cache.last_oracle_price", ratio(3n, 2n), 16], ["cache.liquidation_price_rt", ONE, 16], ["cache._cb_cache_pad", 0x0102n, 7]]);
    t += 100n;
    setTime(t);
    await run("accrue: liabilities only", admin, [accrue(group.address, b)], [b]);
    // A locked liquidation cache is left alone.
    editBank(b, [...shares(10n, 5n), ["cache.liq_cache_flags", 1n, 1]]);
    t += 100n;
    setTime(t);
    await run("accrue: cache locked", admin, [accrue(group.address, b)], [b]);
    // Program fees off (group_flags written into both), then a clock behind the bank's: the original panics.
    for (const vm of s.vms()) {
      const a = vm.getAccount(group.address);
      if (!a.exists) throw new Error("no group");
      const data = Buffer.from(a.data);
      data.writeBigUInt64LE(0n, 8 + 32);
      vm.setAccount({ ...a, address: group.address, data: new Uint8Array(data) });
    }
    editBank(b, [...shares(1_000n, 500n), ["cache.liq_cache_flags", 0n, 1]]);
    t += 100n;
    setTime(t);
    await run("accrue: no program fees", admin, [accrue(group.address, b)], [b]);
    setTime(t - 1n);
    await run("accrue: clock behind", admin, [accrue(group.address, b)], [b], true);
    setTime(t + 50n);
    // A halt the circuit breaker recorded (cb_halt_*), and seconds pending from an earlier one.
    editBank(b, [
      ["cb_halt_started_at", t + 10n, 8],
      ["cb_halt_ended_at", t + 30n, 8],
      ["cb_frozen_seconds_pending", 5n, 8],
    ]);
    await run("accrue: halted seconds", admin, [accrue(group.address, b)], [b]);
    // Paused: the fee state's pause propagated to the group (set in the first test) refuses accrual.
    await run("propagate the pause", admin, [s.ix("propagate_fee_state", {}, [{ address: feeState }, { address: group.address, writable: true }])], [group.address]);
    setTime(1_799_999_000n + 3600n);
    editBank(b, [["last_update", 1_799_999_000n, 8]]);
    await run("accrue: protocol paused", admin, [accrue(group.address, b)], [b]);
    setTime(1_799_999_000n + 21_600n);
    await run("accrue: pause over", admin, [accrue(group.address, b)], [b]);
  });

  it("configures banks as the original does", async () => {
    const group = await generateKeyPairSigner();
    await run("config group init", admin, [groupInit(group, admin)], [group.address]);
    const m = await mint(TOKEN_PROGRAM, 6);
    const [ix, bank] = await addBank(group.address, admin, m, TOKEN_PROGRAM, bankConfig());
    expect(await run("config add bank", admin, [ix], watchBank(bank, group.address))).toBe("ok");
    const b = bank.address;
    const other = await s.funded();
    const conf = (label: string, by: KeyPairSigner, c: Record<string, unknown>, extra: Instruction[] = []) =>
      run(`configure bank: ${label}`, by, [s.ix("lending_pool_configure_bank", { bank_config_opt: fast(c) }, [{ address: group.address }, { address: by.address, signer: by }, { address: b, writable: true }, sysvar]), ...extra], [b]);

    await conf("not the admin", other, { deposit_limit: new BN(5) });
    await conf("durable nonce", admin, { deposit_limit: new BN(5) }, [advanceNonce(admin)]);
    await conf("nothing", admin, {});
    await conf("limits", admin, { deposit_limit: new BN(77), borrow_limit: new BN(66), total_asset_value_init_limit: new BN(55) });
    await conf("reduce only", admin, { operational_state: { ReduceOnly: {} } });
    await conf("back to operational", admin, { operational_state: { Operational: {} } });
    await conf("killed", admin, { operational_state: { KilledByBankruptcy: {} } });
    await conf("reduce only with borrowing power from reduce only", admin, { operational_state: { ReduceOnlyWithBorrowingPower: {} } });
    await conf("paused", admin, { operational_state: { Paused: {} } });
    await conf("reduce only from paused", admin, { operational_state: { ReduceOnly: {} } });
    // Operational again (governance's job; written into both).
    editBank(b, [["config.operational_state", 1n, 1]]);
    await conf("reduce only with borrowing power", admin, { operational_state: { ReduceOnlyWithBorrowingPower: {} } });
    editBank(b, [["config.operational_state", 6n, 1]]);
    await conf("paused while circuit-broken", admin, { operational_state: { Paused: {} } });
    editBank(b, [["config.operational_state", 1n, 1]]);
    await conf("curve: fees", admin, { interest_rate_config: irOpt({ insurance_ir_fee: fx(ratio(3n, 100n)), protocol_fixed_fee_apr: fx(ratio(2n, 100n)) }) });
    await conf("curve: points", admin, {
      interest_rate_config: irOpt({
        zero_util_rate: 10,
        hundred_util_rate: Number(U32_MAX),
        points: [
          { util: 1000, rate: 100 },
          { util: 2000, rate: 200 },
          { util: 3000, rate: 300 },
          { util: 4000, rate: 400 },
          { util: 5000, rate: 500 },
        ],
      }),
    });
    await conf("curve: falling rate", admin, { interest_rate_config: irOpt({ points: [{ util: 1000, rate: 500 }, { util: 2000, rate: 200 }, { util: 0, rate: 0 }, { util: 0, rate: 0 }, { util: 0, rate: 0 }] }) });
    await conf("liquidator fee too high", admin, { liquidation_liquidator_fee: Number(U32_MAX / 2n + 1n) });
    await conf("insurance fee too high", admin, { liquidation_insurance_fee: Number(U32_MAX / 2n + 1n) });
    await conf("liquidation fees", admin, { liquidation_liquidator_fee: Number(U32_MAX / 50n), liquidation_insurance_fee: Number(U32_MAX / 100n) });
    await conf("bad debt flag on", admin, { permissionless_bad_debt_settlement: true });
    await conf("bad debt flag off", admin, { permissionless_bad_debt_settlement: false });

    // The circuit breaker: a cold cache refuses it; a warm one seeds the references; bad settings are refused.
    const cb = { cb_deviation_bps_tiers: [100, 200, 300], cb_tier_durations_seconds: [60, 120, 180], cb_escalation_window_mult: 2, cb_ema_alpha_bps: 500 };
    await conf("breaker on, cold cache", admin, { circuit_breaker_enabled: true, ...cb });
    const t = 1_800_200_000n;
    setTime(t);
    editBank(b, [
      ["cache.last_oracle_price", ratio(123n, 1n), 16],
      ["cache.last_oracle_price_timestamp", t - 31n, 8],
      ["cache.price_multiplier", ratio(3n, 2n), 16],
    ]);
    await conf("breaker on, stale price", admin, { circuit_breaker_enabled: true, ...cb });
    editBank(b, [["cache.last_oracle_price_timestamp", t + 1n, 8]]);
    await conf("breaker on, price from the future", admin, { circuit_breaker_enabled: true, ...cb });
    editBank(b, [["cache.last_oracle_price_timestamp", t - 30n, 8]]);
    await conf("breaker on, bad tiers", admin, { circuit_breaker_enabled: true, ...cb, cb_deviation_bps_tiers: [100, 100, 300] });
    await conf("breaker on, no alpha", admin, { circuit_breaker_enabled: true, ...cb, cb_ema_alpha_bps: 0 });
    await conf("breaker on, window too long", admin, { circuit_breaker_enabled: true, ...cb, cb_window_seconds: 604_801 });
    await conf("breaker on", admin, { circuit_breaker_enabled: true, ...cb, cb_window_seconds: 3600, cb_window_max_up_bps: 9000, cb_window_max_down_bps: 10_000 });
    await conf("breaker on again", admin, { circuit_breaker_enabled: true });
    // Off during a recorded halt, with interest to accrue: the accrual runs first (its event), then the halt ends.
    editBank(b, [
      ["total_asset_shares", 1_000n * ONE, 16],
      ["total_liability_shares", 400n * ONE, 16],
      ["cb_halt_started_at", t - 100n, 8],
      ["cb_halt_ended_at", t + 500n, 8],
      ["cb_tier", 2n, 1],
      ["cb_last_observed_slot", 99n, 8],
      ["config.operational_state", 6n, 1],
      ["cb_pre_break_state", 2n, 1],
    ]);
    setTime(t + 200n);
    await conf("breaker off during a halt", admin, { circuit_breaker_enabled: false });

    // E-mode entries (set by config_bank_emode, not ported: written into both) are checked against the new weights.
    const rawBank = (fields: [number, bigint, number][]) => {
      for (const vm of s.vms()) {
        const a = vm.getAccount(b);
        if (!a.exists) throw new Error("no bank");
        const data = Buffer.from(a.data);
        for (const [at, value, bytes] of fields) le(value, bytes).copy(data, at);
        vm.setAccount({ ...a, address: b, data: new Uint8Array(data) });
      }
    };
    const entries = offsetOf("Bank", "emode.emode_config.entries");
    const setEntry = (i: number, tag: bigint, init: bigint, maint: bigint) =>
      rawBank([
        [entries + i * 40, tag, 2],
        [entries + i * 40 + 8, init, 16],
        [entries + i * 40 + 24, maint, 16],
      ]);
    setEntry(0, 5n, ratio(9n, 10n), ratio(95n, 100n));
    await conf("emode: fits", admin, { deposit_limit: new BN(1) });
    setEntry(1, 5n, ratio(9n, 10n), ratio(95n, 100n));
    await conf("emode: duplicate tag", admin, { deposit_limit: new BN(2) });
    setEntry(1, 6n, ratio(129n, 100n), ratio(129n, 100n));
    await conf("emode: init leverage over the cap", admin, { deposit_limit: new BN(3) });
    setEntry(1, 6n, ratio(5n, 10n), ratio(4n, 10n));
    await conf("emode: maint below init", admin, { deposit_limit: new BN(4) });
    setEntry(1, 6n, ratio(5n, 10n), ratio(119n, 100n));
    await conf("emode: fees leave no room", admin, { deposit_limit: new BN(5) });
    setEntry(1, 0n, 0n, 0n);
    // Same-asset e-mode: an eligible bank's fees against the group's same-asset leverage (both written into both).
    editBank(b, [["flags", 16n | 4096n | 2048n, 8]]);
    editGroup(group.address, [["same_asset_emode_maint_leverage", U32_MAX / 2n, 4]]);
    await conf("same asset: fees", admin, { liquidation_insurance_fee: Number(U32_MAX / 100n) });
    editGroup(group.address, [["same_asset_emode_maint_leverage", U32_MAX / 100n, 4]]);
    await conf("same asset: fees at 1x", admin, { liquidation_insurance_fee: Number(U32_MAX / 100n) });

    // Frozen settings: only the limits move, with a warning and its own event.
    editBank(b, [["flags", 16n | 8n, 8]]);
    await conf("frozen", admin, { deposit_limit: new BN(1234), borrow_limit: new BN(5678), operational_state: { Paused: {} }, liquidation_insurance_fee: 7 });

    // The curve admin and the limit admin.
    const curveAdmin = await s.funded();
    const limitAdmin = await s.funded();
    await run("set curve and limit admins", admin, [configure(group.address, admin, { new_curve_admin: curveAdmin.address, new_limit_admin: limitAdmin.address })], [group.address]);
    const interest = (label: string, by: KeyPairSigner, ir: Record<string, unknown>) =>
      run(`interest only: ${label}`, by, [s.ix("lending_pool_configure_bank_interest_only", { interest_rate_config: irOpt(ir) }, [{ address: group.address }, { address: by.address, signer: by }, { address: b, writable: true }, sysvar])], [b]);
    const limits = (label: string, by: KeyPairSigner, d: number | null, br: number | null, init: number | null) =>
      run(
        `limits only: ${label}`,
        by,
        [
          s.ix(
            "lending_pool_configure_bank_limits_only",
            { deposit_limit: d === null ? null : new BN(d), borrow_limit: br === null ? null : new BN(br), total_asset_value_init_limit: init === null ? null : new BN(init) },
            [{ address: group.address }, { address: by.address, signer: by }, { address: b, writable: true }, sysvar],
          ),
        ],
        [b],
      );
    await interest("frozen", curveAdmin, { zero_util_rate: 1 });
    await limits("frozen", limitAdmin, 1, 2, 3);
    editBank(b, [["flags", 16n, 8]]);
    await interest("not the curve admin", admin, { zero_util_rate: 1 });
    await interest("zero rate", curveAdmin, { zero_util_rate: 1 });
    await interest("bad curve", curveAdmin, { zero_util_rate: Number(U32_MAX) });
    await interest("every field", curveAdmin, {
      insurance_fee_fixed_apr: fx(1n),
      insurance_ir_fee: fx(2n),
      protocol_fixed_fee_apr: fx(3n),
      protocol_ir_fee: fx(4n),
      protocol_origination_fee: fx(5n),
      zero_util_rate: 0,
      hundred_util_rate: 9,
      points: [{ util: 5, rate: 6 }, { util: 0, rate: 0 }, { util: 0, rate: 0 }, { util: 0, rate: 0 }, { util: 0, rate: 0 }],
    });
    await limits("not the limit admin", admin, 1, null, null);
    await limits("some", limitAdmin, null, 9, null);
    await limits("all", limitAdmin, 10, 11, 12);

    // The fees destination: a token account of the bank's mint.
    const dest = await tokenAccount(m, other.address);
    const wrong = await tokenAccount(await mint(TOKEN_PROGRAM, 6), other.address);
    const destination = (label: string, by: KeyPairSigner, account: Address) =>
      run(
        `fees destination: ${label}`,
        by,
        [s.ix("lending_pool_update_fees_destination_account", {}, [{ address: group.address }, { address: b, writable: true }, { address: by.address, signer: by }, { address: account }, sysvar])],
        [b],
      );
    await destination("not the admin", other, dest);
    await destination("another mint", admin, wrong);
    await destination("not a token account", admin, b);
    await destination("set", admin, dest);
  });
});
