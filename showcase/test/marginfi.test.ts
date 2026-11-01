// showcase/mainnet/marginfi/marginfi.ts against the marginfi v2 program deployed on mainnet (test/programs/marginfi_v2.so, the
// binary at MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA): every transaction is sent to both, and the outcome, the bytes
// of the accounts it touches and the events must be the same. The original's msg! logs are not compared (the port does
// not repeat them); WARN lines are.
import { type Address, type Instruction, type KeyPairSigner, generateKeyPairSigner } from "@solana/kit";
import { type Idl, web3 } from "@anchor-lang/core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BN, TOKEN_2022, TOKEN_PROGRAM } from "../../test/harness.js";
import { SYSTEM, report } from "./jito-helpers.js";
import { INSTRUCTIONS, ONE, U32_MAX, bankConfig, fx, le, marginfiPair, offsetOf, ratio } from "./marginfi-helpers.js";

describe("Marginfi v2 port against the mainnet binary", () => {
  const h = marginfiPair();
  const {
    s,
    run,
    initFeeState,
    groupInit,
    configure,
    advanceNonce,
    mint,
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
  } = h;
  let feeState: Address;
  let admin: KeyPairSigner;
  let feeWallet: Address;
  /** Where a bank's balance sits in an account (the original's copy; both must agree). */
  const indexOf = async (account: Address, bank: Address) => {
    const data = Buffer.from((s.original.getAccount(account) as { data: Uint8Array }).data);
    const want = Buffer.from(new web3.PublicKey(bank).toBytes());
    for (let i = 0; i < 16; i++) {
      const at = offsetOf("MarginfiAccount", `lending_account.balances[${i}].bank_pk`);
      if (data.subarray(at, at + 32).equals(want)) return i;
    }
    throw new Error("no balance");
  };
  beforeAll(async () => {
    await h.load();
    ({ admin, feeState, feeWallet } = h);
  });
  afterAll(() => report("marginfi", s));

  it("describes each ported instruction and its events as the on-chain IDL does", () => {
    const onchain = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/marginfi/marginfi.idl.json", import.meta.url)), "utf8")) as Idl;
    const strip = (v: unknown) => JSON.parse(JSON.stringify(v, (k, x) => (k === "docs" ? undefined : x)));
    // Accounts with their writable / signer flags, PDA seeds, relations and addresses; discriminators; arguments.
    expect(s.d.idl.instructions.length).toBe(70);
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
      [
        configure(group.address, admin, {
          new_curve_admin: a.address,
          new_limit_admin: b.address,
          new_flow_admin: c.address,
          new_emissions_admin: a.address,
          new_metadata_admin: b.address,
        }),
      ],
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
    await run(
      "propagate: not the fee state",
      admin,
      [s.ix("propagate_fee_state", {}, [{ address: group.address }, { address: group.address, writable: true }])],
      [group.address],
    );
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
    await refused(
      "hole in the curve",
      admin,
      bankConfig(
        {},
        {
          points: [
            { util: 0, rate: 0 },
            { util: 100, rate: 100 },
            { util: 0, rate: 0 },
            { util: 0, rate: 0 },
            { util: 0, rate: 0 },
          ],
        },
      ),
    );
    await refused(
      "padding with a rate",
      admin,
      bankConfig(
        {},
        {
          points: [
            { util: 0, rate: 5 },
            { util: 0, rate: 0 },
            { util: 0, rate: 0 },
            { util: 0, rate: 0 },
            { util: 0, rate: 0 },
          ],
        },
      ),
    );
    await refused(
      "utils not ascending",
      admin,
      bankConfig(
        {},
        {
          points: [
            { util: 100, rate: 1 },
            { util: 100, rate: 2 },
            { util: 0, rate: 0 },
            { util: 0, rate: 0 },
            { util: 0, rate: 0 },
          ],
        },
      ),
    );
    await refused(
      "rate falling",
      admin,
      bankConfig(
        {},
        {
          points: [
            { util: 100, rate: 9 },
            { util: 200, rate: 8 },
            { util: 0, rate: 0 },
            { util: 0, rate: 0 },
            { util: 0, rate: 0 },
          ],
        },
      ),
    );
    await refused(
      "zero rate above hundred",
      admin,
      bankConfig(
        {},
        {
          zero_util_rate: 10,
          hundred_util_rate: 9,
          points: [
            { util: 0, rate: 0 },
            { util: 0, rate: 0 },
            { util: 0, rate: 0 },
            { util: 0, rate: 0 },
            { util: 0, rate: 0 },
          ],
        },
      ),
    );
    await refused("point above hundred", admin, bankConfig({}, { hundred_util_rate: 50 }));
    {
      const [ix, b] = await addBank(group.address, admin, usdc, TOKEN_PROGRAM, bankConfig());
      await run("add bank: durable nonce", admin, [ix, advanceNonce(admin)], watchBank(b, group.address));
    }

    const [ix, usdcBank] = await addBank(group.address, admin, usdc, TOKEN_PROGRAM, bankConfig());
    expect(await run("add bank", admin, [ix], watchBank(usdcBank, group.address))).toBe("ok");
    const [ix2, t22Bank] = await addBank(
      group.address,
      admin,
      t22,
      TOKEN_2022,
      bankConfig({ risk_tier: { Isolated: {} }, asset_weight_init: fx(0n), asset_weight_maint: fx(0n), asset_tag: 1 }),
      { seed: 7n },
    );
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
    editBank(b, [
      ...shares(0n, 10n),
      ["cache.last_oracle_price", ratio(3n, 2n), 16],
      ["cache.liquidation_price_rt", ONE, 16],
      ["cache._cb_cache_pad", 0x0102n, 7],
    ]);
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
    await run(
      "propagate the pause",
      admin,
      [s.ix("propagate_fee_state", {}, [{ address: feeState }, { address: group.address, writable: true }])],
      [group.address],
    );
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
      run(
        `configure bank: ${label}`,
        by,
        [
          s.ix("lending_pool_configure_bank", { bank_config_opt: fast(c) }, [
            { address: group.address },
            { address: by.address, signer: by },
            { address: b, writable: true },
            sysvar,
          ]),
          ...extra,
        ],
        [b],
      );

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
    await conf("curve: falling rate", admin, {
      interest_rate_config: irOpt({
        points: [
          { util: 1000, rate: 500 },
          { util: 2000, rate: 200 },
          { util: 0, rate: 0 },
          { util: 0, rate: 0 },
          { util: 0, rate: 0 },
        ],
      }),
    });
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
    await conf("breaker on", admin, {
      circuit_breaker_enabled: true,
      ...cb,
      cb_window_seconds: 3600,
      cb_window_max_up_bps: 9000,
      cb_window_max_down_bps: 10_000,
    });
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
    await run(
      "set curve and limit admins",
      admin,
      [configure(group.address, admin, { new_curve_admin: curveAdmin.address, new_limit_admin: limitAdmin.address })],
      [group.address],
    );
    const interest = (label: string, by: KeyPairSigner, ir: Record<string, unknown>) =>
      run(
        `interest only: ${label}`,
        by,
        [
          s.ix("lending_pool_configure_bank_interest_only", { interest_rate_config: irOpt(ir) }, [
            { address: group.address },
            { address: by.address, signer: by },
            { address: b, writable: true },
            sysvar,
          ]),
        ],
        [b],
      );
    const limits = (label: string, by: KeyPairSigner, d: number | null, br: number | null, init: number | null) =>
      run(
        `limits only: ${label}`,
        by,
        [
          s.ix(
            "lending_pool_configure_bank_limits_only",
            {
              deposit_limit: d === null ? null : new BN(d),
              borrow_limit: br === null ? null : new BN(br),
              total_asset_value_init_limit: init === null ? null : new BN(init),
            },
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
      points: [
        { util: 5, rate: 6 },
        { util: 0, rate: 0 },
        { util: 0, rate: 0 },
        { util: 0, rate: 0 },
        { util: 0, rate: 0 },
      ],
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
        [
          s.ix("lending_pool_update_fees_destination_account", {}, [
            { address: group.address },
            { address: b, writable: true },
            { address: by.address, signer: by },
            { address: account },
            sysvar,
          ]),
        ],
        [b],
      );
    await destination("not the admin", other, dest);
    await destination("another mint", admin, wrong);
    await destination("not a token account", admin, b);
    await destination("set", admin, dest);
  });

  it("opens accounts, takes deposits and closes balances as the original does", async () => {
    const group = await generateKeyPairSigner();
    await run("accounts group init", admin, [groupInit(group, admin)], [group.address]);
    const g = group.address;
    const usdc = await mint(TOKEN_PROGRAM, 6);
    const [ix1, usdcBank] = await addBank(g, admin, usdc, TOKEN_PROGRAM, bankConfig({ deposit_limit: new BN(1_000_000) }));
    expect(await run("accounts: add bank", admin, [ix1], watchBank(usdcBank, g))).toBe("ok");
    const sol = await mint(TOKEN_PROGRAM, 9);
    const [ix2, solBank] = await addBank(g, admin, sol, TOKEN_PROGRAM, bankConfig({ asset_tag: 1 }));
    expect(await run("accounts: add SOL bank", admin, [ix2], watchBank(solBank, g))).toBe("ok");
    const editAccount = edit("MarginfiAccount");

    // Accounts: a keypair account, and PDAs by index and third-party id.
    const user = await s.funded();
    const acct = await generateKeyPairSigner();
    const a = acct.address;
    expect(await run("account init", user, [h.accountInit(g, acct, user)], [a, user.address])).toBe("ok");
    await run("account init again", user, [h.accountInit(g, acct, user)], [a]);
    const p0 = await h.accountPda(g, user.address, 0, 0);
    await run("account init pda", user, [h.accountInitPda(g, p0, user, 0, null)], [p0]);
    await run("account init pda: taken", user, [h.accountInitPda(g, p0, user, 0, 0)], [p0]);
    const p7 = await h.accountPda(g, user.address, 7, 42);
    await run("account init pda: index 7, third party 42", user, [h.accountInitPda(g, p7, user, 7, 42)], [p7]);
    const pReg = await h.accountPda(g, user.address, 1, 10_001);
    await run("account init pda: registered id, called directly", user, [h.accountInitPda(g, pReg, user, 1, 10_001)], [pReg]);
    const pUnreg = await h.accountPda(g, user.address, 1, 20_000);
    await run("account init pda: unregistered id", user, [h.accountInitPda(g, pUnreg, user, 1, 20_000)], [pUnreg]);
    const pWrong = await h.accountPda(g, user.address, 2, 0);
    await run("account init pda: wrong address", user, [h.accountInitPda(g, pWrong, user, 3, null)], [pWrong]);

    // Deposits into the USDC bank from the user's token account.
    const from = await tokenAccount(usdc, user.address, 10_000_000_000n);
    const dep = (amount: bigint, opts: Parameters<typeof h.deposit>[7] = {}, by = user, account = a, bank = usdcBank) =>
      h.deposit(g, account, by, bank.address, from, bank.v.liquidity, amount, opts);
    const watch = [a, usdcBank.address, usdcBank.v.liquidity, from];
    setTime(1_800_300_000n);
    expect(await run("deposit", user, [dep(250_000n)], watch)).toBe("ok");
    await run("deposit: zero", user, [dep(0n)], watch);
    await run("deposit: not the authority", admin, [dep(1n, {}, admin)], watch);
    await run("deposit: wrong vault", user, [h.deposit(g, a, user, usdcBank.address, from, solBank.v.liquidity, 1n)], watch);
    await run("deposit: over the limit", user, [dep(900_000n)], watch);
    setTime(1_800_300_100n);
    await run("deposit: up to the limit", user, [dep(900_000n, { upToLimit: true })], watch);
    await run("deposit: up to a full limit", user, [dep(5n, { upToLimit: true })], watch);
    editBank(usdcBank.address, [["config.deposit_limit", (1n << 64n) - 1n, 8]]);
    await run("deposit: no limit", user, [dep(3_333_333n)], watch);
    await run("deposit: more than the user holds", user, [dep(20_000_000_000n, { upToLimit: false })], watch);
    // Interest accrues on deposit (liabilities written into the bank).
    editBank(usdcBank.address, [["total_liability_shares", 1_000_000n * ONE, 16]]);
    setTime(1_800_400_000n);
    await run("deposit: after interest", user, [dep(1_234_567n)], watch);
    // The SOL bank: a second balance, sorted by bank key.
    const solFrom = await tokenAccount(sol, user.address, 5_000_000_000n);
    expect(await run("deposit: SOL", user, [h.deposit(g, a, user, solBank.address, solFrom, solBank.v.liquidity, 777n)], [a, solBank.address, solFrom])).toBe(
      "ok",
    );

    // Token-2022: the mint comes first among the remaining accounts; with a transfer fee, the pre-fee amount moves.
    const feeMint = await h.feeMint(6, 150, 40_000n);
    const [ix3, t22Bank] = await addBank(g, admin, feeMint, TOKEN_2022, bankConfig());
    expect(await run("accounts: add Token-2022 bank", admin, [ix3], watchBank(t22Bank, g))).toBe("ok");
    const t22From = await h.t22Account(feeMint, user.address, 50_000_000_000n);
    const t22Watch = [a, t22Bank.address, t22Bank.v.liquidity, t22From];
    const t22dep = (amount: bigint, rest: Address[]) =>
      h.deposit(g, a, user, t22Bank.address, t22From, t22Bank.v.liquidity, amount, { program: TOKEN_2022, rest });
    await run("deposit Token-2022: no mint", user, [t22dep(1_000n, [])], t22Watch);
    await run("deposit Token-2022: another mint", user, [t22dep(1_000n, [usdc])], t22Watch);
    await run("deposit Token-2022: not a mint", user, [t22dep(1_000n, [t22From])], t22Watch);
    await run("deposit Token-2022: SPL token program", user, [h.deposit(g, a, user, t22Bank.address, t22From, t22Bank.v.liquidity, 1_000n)], t22Watch);
    for (const amount of [1n, 67n, 1_000n, 123_456_789n, 9_000_000_000n])
      expect(await run(`deposit Token-2022 with a fee: ${amount}`, user, [t22dep(amount, [feeMint])], t22Watch)).toBe("ok");

    // The account's own state.
    const balance0 = (field: string) => `lending_account.balances[0].${field}`;
    editAccount(a, [["account_flags", 64n, 8]]);
    await run("deposit: frozen, by its authority", user, [dep(1n)], watch);
    await run("deposit: frozen, by the governance admin", admin, [h.deposit(g, a, admin, usdcBank.address, from, usdcBank.v.liquidity, 1n)], watch);
    editAccount(a, [["account_flags", 1n, 8]]);
    await run("deposit: disabled", user, [dep(1n)], watch);
    editAccount(a, [["account_flags", 16n, 8]]);
    await run("deposit: in receivership", user, [dep(1n)], watch);
    editAccount(a, [["account_flags", 256n, 8]]);
    await run("deposit: in a rebalance, by a keeper", admin, [h.deposit(g, a, admin, usdcBank.address, from, usdcBank.v.liquidity, 1n)], watch);
    editAccount(a, [["account_flags", 0n, 8]]);
    // A liability in the bank: deposits must not repay it.
    const usdcIndex = await indexOf(a, usdcBank.address);
    editAccount(a, [[`lending_account.balances[${usdcIndex}].liability_shares`, 5n * ONE, 16]]);
    await run("deposit: would repay", user, [dep(1_000n)], watch, "if-panics");
    editAccount(a, [
      [`lending_account.balances[${usdcIndex}].liability_shares`, 0n, 16],
      [`lending_account.balances[${usdcIndex}].premium_outstanding`, 9n * ONE, 16],
      [`lending_account.balances[${usdcIndex}].premium_rate_snapshot`, 77n, 4],
    ]);
    await run("deposit: a stale premium written off", user, [dep(1_000n)], watch);
    // Bank states.
    for (const [state, name] of [
      [0n, "paused"],
      [2n, "reduce only"],
      [3n, "killed by bankruptcy"],
      [4n, "uninitialized"],
      [5n, "reduce only with borrowing power"],
      [6n, "circuit broken (was operational)"],
    ] as const) {
      editBank(usdcBank.address, [
        ["config.operational_state", state, 1],
        ["cb_pre_break_state", 1n, 1],
      ]);
      await run(`deposit: bank ${name}`, user, [dep(10n)], watch);
    }
    editBank(usdcBank.address, [
      ["config.operational_state", 1n, 1],
      ["flags", 16n | 32n, 8],
    ]);
    await run("deposit: tokenless repayments", user, [dep(10n)], watch);
    editBank(usdcBank.address, [
      ["flags", 16n | 2048n, 8],
      ["cb_tier", 1n, 1],
      ["cb_halt_ended_at", 1_900_000_000n, 8],
    ]);
    await run("deposit: halted, existing balance", user, [dep(10n)], watch);
    const fresh = await generateKeyPairSigner();
    expect(await run("account init: second", user, [h.accountInit(g, fresh, user)], [fresh.address])).toBe("ok");
    await run("deposit: halted, new balance", user, [dep(10n, {}, user, fresh.address)], [fresh.address, usdcBank.address]);
    editBank(usdcBank.address, [
      ["flags", 16n, 8],
      ["cb_tier", 0n, 1],
    ]);
    // Rate limits: the bank's windows take inflows back; the group's report them.
    editBank(usdcBank.address, [
      ["rate_limiter.hourly.max_outflow", 1_000_000n, 8],
      ["rate_limiter.hourly.window_duration", 3600n, 8],
      ["rate_limiter.hourly.window_start", 1_800_398_000n, 8],
      ["rate_limiter.hourly.cur_window_outflow", 500n, 8],
      ["rate_limiter.daily.max_outflow", 9_000_000n, 8],
      ["rate_limiter.daily.window_duration", 86_400n, 8],
      ["rate_limiter.daily.window_start", 1_800_390_000n, 8],
      ["rate_limiter.daily.prev_window_outflow", 7_000n, 8],
      ["rate_limiter.daily.cur_window_outflow", 4_000n, 8],
    ]);
    editGroup(g, [["rate_limiter.hourly.max_outflow", 1n, 8]]);
    await run("deposit: rate limits", user, [dep(1_200n)], watch);
    // A staked balance in the account: default assets cannot join it.
    editAccount(fresh.address, [
      ["lending_account.balances[0].active", 1n, 1],
      ["lending_account.balances[0].bank_pk", 0n, 32],
      ["lending_account.balances[0].bank_asset_tag", 2n, 1],
    ]);
    await run("deposit: staked account into a default bank", user, [dep(10n, {}, user, fresh.address)], [fresh.address, usdcBank.address]);
    // Sixteen balances: no slot left.
    const full = await generateKeyPairSigner();
    expect(await run("account init: third", user, [h.accountInit(g, full, user)], [full.address])).toBe("ok");
    const fills: [string, bigint, number][] = [];
    for (let i = 0; i < 16; i++) fills.push([`lending_account.balances[${i}].active`, 1n, 1], [`lending_account.balances[${i}].bank_pk`, BigInt(1000 - i), 32]);
    editAccount(full.address, fills);
    await run("deposit: no balance slot left", user, [dep(10n, {}, user, full.address)], [full.address, usdcBank.address]);

    // Close balances: refused with assets; dust closes (assets to insurance).
    const cb = (bank: Address, by = user, account = a) => h.closeBalance(g, account, by, bank);
    await run("close balance: has assets", user, [cb(usdcBank.address)], [a, usdcBank.address]);
    await run("close balance: not the authority", admin, [cb(usdcBank.address, admin)], [a, usdcBank.address]);
    await run("close balance: no balance there", user, [cb(usdcBank.address, user, fresh.address)], [fresh.address, usdcBank.address]);
    editAccount(a, [[`lending_account.balances[${usdcIndex}].asset_shares`, ONE / 20_000n, 16]]);
    setTime(1_800_500_000n);
    await run("close balance: dust", user, [cb(usdcBank.address)], [a, usdcBank.address]);
    await run("close balance: closed", user, [cb(usdcBank.address)], [a, usdcBank.address]);

    // Close the account: refused with a balance, frozen, by another; then closed.
    await run("close account: a balance left", user, [await h.accountClose(a, user)], [a, user.address]);
    const solIndex = await indexOf(a, solBank.address);
    editAccount(a, [[`lending_account.balances[${solIndex}].asset_shares`, 0n, 16]]);
    expect(await run("close balance: SOL", user, [cb(solBank.address)], [a, solBank.address])).toBe("ok");
    const t22Index = await indexOf(a, t22Bank.address);
    editAccount(a, [[`lending_account.balances[${t22Index}].asset_shares`, 0n, 16]]);
    expect(await run("close balance: Token-2022", user, [cb(t22Bank.address)], [a, t22Bank.address])).toBe("ok");
    await run("close account: not the authority", admin, [await h.accountClose(a, admin)], [a]);
    editAccount(a, [["account_flags", 64n, 8]]);
    await run("close account: frozen", user, [await h.accountClose(a, user)], [a]);
    editAccount(a, [
      ["account_flags", 0n, 8],
      ["active_orders", 1n, 1],
    ]);
    await run("close account: an active order", user, [await h.accountClose(a, user)], [a]);
    editAccount(a, [["active_orders", 0n, 1]]);
    expect(await run("close account", user, [await h.accountClose(a, user)], [a, user.address])).toBe("ok");
    await run("close account: pda, emptied", user, [await h.accountClose(p0, user)], [p0, user.address]);
  });

  it("takes repayments and moves fees as the original does", async () => {
    const group = await generateKeyPairSigner();
    const g = group.address;
    await run("repay group init", admin, [groupInit(group, admin)], [g]);
    const usdc = await mint(TOKEN_PROGRAM, 6);
    const [ix1, bank] = await addBank(g, admin, usdc, TOKEN_PROGRAM, bankConfig());
    expect(await run("repay: add bank", admin, [ix1], watchBank(bank, g))).toBe("ok");
    const b = bank.address;
    const editAccount = edit("MarginfiAccount");
    /** An I80F48 field of an account as the original holds it. */
    const read128 = (at: Address, type: string, path: string) => {
      const data = Buffer.from((s.original.getAccount(at) as { data: Uint8Array }).data);
      const o = offsetOf(type, path);
      return data.readBigInt64LE(o + 8) * (1n << 64n) + data.readBigUInt64LE(o);
    };
    // A lender's deposit fills the vault.
    const lender = await s.funded();
    const lenderAcct = await generateKeyPairSigner();
    expect(await run("repay: lender account", lender, [h.accountInit(g, lenderAcct, lender)], [lenderAcct.address])).toBe("ok");
    const lenderFrom = await tokenAccount(usdc, lender.address, 1_000_000_000_000n);
    expect(await run("repay: lender deposit", lender, [h.deposit(g, lenderAcct.address, lender, b, lenderFrom, bank.v.liquidity, 500_000_000_000n)], [b])).toBe(
      "ok",
    );

    // A borrower whose liability (borrows are not ported yet) is written into both: the balance and the bank's total.
    const borrower = await s.funded();
    const from = await tokenAccount(usdc, borrower.address, 1_000_000_000_000n);
    const owing = async (label: string, shares: bigint) => {
      const k = await generateKeyPairSigner();
      expect(await run(`repay: ${label} account`, borrower, [h.accountInit(g, k, borrower)], [k.address])).toBe("ok");
      editAccount(k.address, [
        ["lending_account.balances[0].active", 1n, 1],
        ["lending_account.balances[0].bank_pk", BigInt("0x" + Buffer.from(new web3.PublicKey(b).toBytes()).reverse().toString("hex")), 32],
        ["lending_account.balances[0].liability_shares", shares, 16],
        ["lending_account.balances[0].last_update", 1_800_000_000n, 8],
      ]);
      editBank(b, [["total_liability_shares", read128(b, "Bank", "total_liability_shares") + shares, 16]]);
      return k.address;
    };
    const rp = (account: Address, amount: bigint, opts: Parameters<typeof h.repay>[7] = {}, by = borrower) =>
      h.repay(g, account, by, b, from, bank.v.liquidity, amount, opts);
    const watch = (account: Address) => [account, b, bank.v.liquidity, from];
    setTime(1_800_600_000n);
    const a = await owing("borrower", 100_000_000n * ONE);
    expect(await run("repay: part", borrower, [rp(a, 1_234_567n)], watch(a))).toBe("ok");
    await run("repay: more than owed", borrower, [rp(a, 200_000_000n)], watch(a));
    await run("repay: not the authority", lender, [rp(a, 1_000n, {}, lender)], watch(a));
    await run("repay: another bank's vault", borrower, [h.repay(g, a, borrower, b, from, bank.v.fee, 1_000n)], watch(a));
    setTime(1_800_700_000n);
    await run("repay: after interest", borrower, [rp(a, 5_000_000n)], watch(a));
    await run("repay: leaving dust shares", borrower, [rp(a, 0n, { all: false })], watch(a));
    const left = read128(a, "MarginfiAccount", "lending_account.balances[0].liability_shares");
    const value = read128(b, "Bank", "liability_share_value");
    const owedTokens = (left * value) >> 96n;
    await run("repay: all but under one share", borrower, [rp(a, owedTokens - 1n)], watch(a), "if-panics");
    expect(await run("repay: all", borrower, [rp(a, 0n, { all: true })], watch(a))).toBe("ok");
    await run("repay: all again (closed)", borrower, [rp(a, 0n, { all: true })], watch(a));
    await run("repay: no balance", borrower, [rp(lenderAcct.address, 1n, {}, lender)], watch(lenderAcct.address));
    await run(
      "repay: all of an asset balance",
      lender,
      [h.repay(g, lenderAcct.address, lender, b, lenderFrom, bank.v.liquidity, 0n, { all: true })],
      [lenderAcct.address, b],
    );

    // Account and bank states.
    const c = await owing("states", 50_000_000n * ONE);
    editAccount(c, [["account_flags", 1n, 8]]);
    await run("repay: disabled", borrower, [rp(c, 1_000n)], watch(c));
    editAccount(c, [["account_flags", 128n, 8]]);
    await run("repay: order execution, part", borrower, [rp(c, 1_000n)], watch(c));
    await run("repay: order execution, by a keeper", lender, [rp(c, 1_000n, { all: false }, lender)], watch(c));
    editAccount(c, [["account_flags", 16n, 8]]);
    await run("repay: receivership, by a liquidator", lender, [h.repay(g, c, lender, b, lenderFrom, bank.v.liquidity, 1_000n)], [c, b, lenderFrom]);
    await run("repay: receivership, by its owner", borrower, [rp(c, 1_000n)], watch(c));
    editAccount(c, [["account_flags", 64n, 8]]);
    await run("repay: frozen, by its owner", borrower, [rp(c, 1_000n)], watch(c));
    editAccount(c, [["account_flags", 0n, 8]]);
    for (const [state, name] of [
      [0n, "paused"],
      [2n, "reduce only"],
      [3n, "killed"],
      [6n, "circuit broken"],
    ] as const) {
      editBank(b, [
        ["config.operational_state", state, 1],
        ["cb_pre_break_state", 2n, 1],
      ]);
      await run(`repay: bank ${name}`, borrower, [rp(c, 1_000n)], watch(c));
    }
    editBank(b, [["config.operational_state", 1n, 1]]);
    // The protocol paused: refused, unless the account is being deleveraged.
    await run("repay: propagate a pause", admin, [s.ix("propagate_fee_state", {}, [{ address: feeState }, { address: g, writable: true }])], [g]);
    setTime(1_799_999_000n + 100n);
    editBank(b, [["last_update", 1_799_999_000n, 8]]);
    await run("repay: protocol paused", borrower, [rp(c, 1_000n)], watch(c));
    editAccount(c, [["account_flags", 32n, 8]]);
    await run("repay: protocol paused, deleveraging", borrower, [rp(c, 1_000n)], watch(c));
    editAccount(c, [["account_flags", 0n, 8]]);
    editGroup(g, [["panic_state_cache.pause_flags", 0n, 1]]);
    setTime(1_800_800_000n);

    // Premiums: a premium-active bank books what the balance's snapshot rate earned, and repayments settle it first.
    editBank(b, [
      ["flags", 16n | 8192n, 8],
      ["premium_activated_at", 1_800_000_000n, 8],
    ]);
    const p = await owing("premium", 80_000_000n * ONE);
    editAccount(p, [["lending_account.balances[0].premium_rate_snapshot", 4_294_967_295n / 50n, 4]]);
    await run("repay: premium, part", borrower, [rp(p, 10_000n)], watch(p));
    setTime(1_800_900_000n);
    await run("repay: premium, more than the premium", borrower, [rp(p, 5_000_000n)], watch(p));
    setTime(1_801_000_000n);
    await run("repay: premium, all", borrower, [rp(p, 0n, { all: true })], watch(p));
    editBank(b, [["flags", 16n, 8]]);
    // Tokenless: the risk admin clears a debt with nothing, the premium written off; done once the bank owes nothing.
    const risk = await s.funded();
    editGroup(g, [["risk_admin", BigInt("0x" + Buffer.from(new web3.PublicKey(risk.address).toBytes()).reverse().toString("hex")), 32]]);
    editBank(b, [["flags", 16n | 32n | 8192n, 8]]);
    const tl = await owing("tokenless", 30_000_000n * ONE);
    editAccount(tl, [
      ["lending_account.balances[0].premium_rate_snapshot", 4_294_967_295n / 20n, 4],
      ["lending_account.balances[0].premium_outstanding", 77n * ONE, 16],
    ]);
    // The risk admin acts on an account in a deleverage (receivership): it may repay for it.
    editAccount(tl, [["account_flags", 16n | 32n, 8]]);
    await run("repay: tokenless, part", risk, [rp(tl, 1_000n, {}, risk)], watch(tl));
    editAccount(tl, [["account_flags", 0n, 8]]);
    await run("repay: tokenless, by its owner", borrower, [rp(tl, 0n, { all: true })], watch(tl));
    const tl2 = await owing("tokenless 2", 10_000_000n * ONE);
    editAccount(tl2, [["lending_account.balances[0].premium_outstanding", 5n * ONE, 16]]);
    editAccount(tl2, [["account_flags", 16n | 32n, 8]]);
    await run("repay: tokenless, all", risk, [rp(tl2, 0n, { all: true }, risk)], watch(tl2));
    editBank(b, [["flags", 16n, 8]]);

    // Token-2022 with a transfer fee: the repayment arrives net of it.
    const feeMint = await h.feeMint(6, 100, 50_000n);
    const [ix2, t22] = await addBank(g, admin, feeMint, TOKEN_2022, bankConfig());
    expect(await run("repay: add Token-2022 bank", admin, [ix2], watchBank(t22, g))).toBe("ok");
    const t22From = await h.t22Account(feeMint, borrower.address, 1n << 50n);
    const k = await generateKeyPairSigner();
    expect(await run("repay: Token-2022 account", borrower, [h.accountInit(g, k, borrower)], [k.address])).toBe("ok");
    editAccount(k.address, [
      ["lending_account.balances[0].active", 1n, 1],
      ["lending_account.balances[0].bank_pk", BigInt("0x" + Buffer.from(new web3.PublicKey(t22.address).toBytes()).reverse().toString("hex")), 32],
      ["lending_account.balances[0].liability_shares", 9_000_000n * ONE, 16],
    ]);
    editBank(t22.address, [
      ["total_liability_shares", 9_000_000n * ONE, 16],
      ["total_asset_shares", 20_000_000n * ONE, 16],
    ]);
    const t22rp = (amount: bigint, all: boolean | null, rest: Address[]) =>
      h.repay(g, k.address, borrower, t22.address, t22From, t22.v.liquidity, amount, { all, program: TOKEN_2022, rest });
    await run("repay Token-2022: no mint", borrower, [t22rp(1_000n, null, [])], [k.address, t22.address]);
    expect(await run("repay Token-2022: part", borrower, [t22rp(123_457n, null, [feeMint])], [k.address, t22.address, t22.v.liquidity, t22From])).toBe("ok");
    expect(await run("repay Token-2022: all", borrower, [t22rp(0n, true, [feeMint])], [k.address, t22.address, t22.v.liquidity, t22From])).toBe("ok");

    // Fees: accrue some, then collect them out of the liquidity vault and withdraw them.
    editBank(b, [["total_liability_shares", 300_000_000_000n * ONE, 16]]);
    setTime(1_810_000_000n);
    expect(await run("fees: accrue", admin, [accrue(g, b)], [b])).toBe("ok");
    const feeAta = h.tokenAccountAt(await h.ata(feeWallet, usdc), usdc, feeWallet);
    const feeWatch = [b, bank.v.liquidity, bank.v.insurance, bank.v.fee, feeAta];
    await run("fees: collect to the wrong account", lender, [h.collectFees(g, bank, lenderFrom)], feeWatch);
    expect(await run("fees: collect", lender, [h.collectFees(g, bank, feeAta)], feeWatch)).toBe("ok");
    await run("fees: collect again (nothing owed)", lender, [h.collectFees(g, bank, feeAta)], feeWatch);
    // More owed than the vault holds: whole tokens, insurance first, then the group, then the program.
    editBank(b, [
      ["collected_insurance_fees_outstanding", 400_000_000_000n * ONE + ONE / 3n, 16],
      ["collected_group_fees_outstanding", 300_000_000_000n * ONE, 16],
      ["collected_program_fees_outstanding", 200_000_000_000n * ONE, 16],
    ]);
    await run("fees: collect more than the vault holds", lender, [h.collectFees(g, bank, feeAta)], feeWatch);
    editBank(b, [["collected_group_fees_outstanding", -5n * ONE, 16]]);
    await run("fees: collect a negative balance", lender, [h.collectFees(g, bank, feeAta)], feeWatch, "if-panics");
    editBank(b, [["collected_group_fees_outstanding", 0n, 16]]);
    const dst = await tokenAccount(usdc, admin.address);
    await run("fees: withdraw, not the admin", lender, [h.withdrawVault("fees", g, bank, lender, dst, 10n)], [bank.v.fee, dst]);
    expect(await run("fees: withdraw", admin, [h.withdrawVault("fees", g, bank, admin, dst, 1_000n)], [bank.v.fee, dst])).toBe("ok");
    await run("fees: withdraw more than there is", admin, [h.withdrawVault("fees", g, bank, admin, dst, 1n << 60n)], [bank.v.fee, dst]);
    await run("fees: withdraw, durable nonce", admin, [h.withdrawVault("fees", g, bank, admin, dst, 1n), advanceNonce(admin)], [bank.v.fee, dst]);
    expect(await run("insurance: withdraw", admin, [h.withdrawVault("insurance", g, bank, admin, dst, 2_000n)], [bank.v.insurance, dst])).toBe("ok");
    await run("insurance: withdraw, not the admin", lender, [h.withdrawVault("insurance", g, bank, lender, dst, 1n)], [bank.v.insurance, dst]);
    // Permissionless: only to the destination the admin set, capped at what the vault holds.
    const dest = await tokenAccount(usdc, admin.address);
    await run("fees permissionless: no destination set", lender, [h.withdrawFeesPermissionless(g, bank, dest, 10n)], [bank.v.fee, dest]);
    expect(await run("fees: set the destination", admin, [h.updateFeesDestination(g, b, admin, dest)], [b])).toBe("ok");
    await run("fees permissionless: another account", lender, [h.withdrawFeesPermissionless(g, bank, dst, 10n)], [bank.v.fee, dst]);
    expect(await run("fees permissionless", lender, [h.withdrawFeesPermissionless(g, bank, dest, 500n)], [bank.v.fee, dest])).toBe("ok");
    expect(await run("fees permissionless: more than there is", lender, [h.withdrawFeesPermissionless(g, bank, dest, 1n << 60n)], [bank.v.fee, dest])).toBe(
      "ok",
    );
    // Token-2022: the mint among the remaining accounts, the fee taken from each transfer.
    editBank(t22.address, [
      ["collected_insurance_fees_outstanding", 1_000n * ONE, 16],
      ["collected_group_fees_outstanding", 2_000n * ONE, 16],
      ["collected_program_fees_outstanding", 3_000n * ONE, 16],
    ]);
    const t22Ata = await h.ata(feeWallet, feeMint, TOKEN_2022);
    await run("fees Token-2022: collect, no fee ATA", lender, [h.collectFees(g, t22, t22Ata, TOKEN_2022, [feeMint])], [t22.address]);
    const t22Dst = await h.t22Account(feeMint, admin.address);
    await run("fees Token-2022: withdraw, no mint", admin, [h.withdrawVault("fees", g, t22, admin, t22Dst, 1n, TOKEN_2022)], [t22.v.fee, t22Dst]);
  });
});
