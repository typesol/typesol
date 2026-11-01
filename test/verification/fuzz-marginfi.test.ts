// Random sequences of Marginfi's group and bank administration against the program deployed on mainnet
// (test/programs/marginfi_v2.so) and examples/marginfi, side by side (test/marginfi-helpers.ts): every transaction must
// have the same outcome, account bytes and events in both. Bank configs, interest curves, fees, balances, clocks and
// the circuit breaker's state come from the seed: reproduce a failure with FUZZ_SEED=<seed>; lengthen with FUZZ_STEPS=<n>.
//
// Deposits and borrows are not ported yet: the fuzzer writes a bank's asset and liability shares into both, then
// accrues. An input the original panics on (a negative fee rate trips its asserts) only has to fail in the port too.
import { type Address, type KeyPairSigner, generateKeyPairSigner } from "@solana/kit";
import { describe, it } from "vitest";
import { BN, TOKEN_2022, TOKEN_PROGRAM } from "../harness.js";
import { Rng } from "../fuzz-rng.js";
import { report } from "../jito-helpers.js";
import { ONE, U32_MAX, bankConfig, fx, marginfiPair, offsetOf } from "../marginfi-helpers.js";
import { web3 } from "@anchor-lang/core";

const SEED = BigInt(process.env.FUZZ_SEED ?? Date.now());
const STEPS = Number(process.env.FUZZ_STEPS ?? 150);
const STATES = ["Paused", "Operational", "ReduceOnly", "KilledByBankruptcy", "Uninitialized", "ReduceOnlyWithBorrowingPower", "CircuitBroken"];

describe(`fuzz: Marginfi administration against mainnet (seed ${SEED}, ${STEPS} steps)`, () => {
  it("configures banks and accrues interest the same through random settings, balances and times", async () => {
    const rng = new Rng(SEED);
    const h = marginfiPair();
    await h.load();
    const { s, run } = h;
    const u32 = () => Number(rng.next() % (U32_MAX + 1n));
    /** An I80F48 across scales: small fractions, ordinary rates, large values, rarely negative. */
    const fixed = (): bigint => {
      switch (rng.int(8)) {
        case 0:
          return 0n;
        case 1:
          return rng.next() % ONE;
        case 2:
          return rng.next() % (ONE * 3n);
        case 3:
          return rng.chance(20) ? -(rng.next() % ONE) : rng.next() % (ONE * 1000n);
        default:
          return rng.next() % (ONE / 4n);
      }
    };
    /** A seven-point curve: usually valid (ascending utils, rates between the ends), sometimes broken in one way. */
    const curve = () => {
      const n = rng.int(6);
      const utils = Array.from({ length: n }, () => u32()).sort((a, b) => a - b);
      let zero = Number(rng.next() % (U32_MAX / 10n));
      let hundred = zero + Number(rng.next() % (U32_MAX - BigInt(zero)));
      const rates = Array.from({ length: n }, () => zero + Number(rng.next() % BigInt(hundred - zero + 1))).sort((a, b) => a - b);
      const points = Array.from({ length: 5 }, (_, i) => (i < n ? { util: utils[i]!, rate: rates[i]! } : { util: 0, rate: 0 }));
      switch (rng.int(12)) {
        case 0:
          [zero, hundred] = [hundred, zero];
          break;
        case 1:
          if (n > 1) points[0]!.rate = points[n - 1]!.rate + 1;
          break;
        case 2:
          if (n > 0 && n < 5) points[n] = { util: 0, rate: 1 };
          break;
        case 3:
          if (n > 1) points[1]!.util = points[0]!.util;
          break;
      }
      return { zero_util_rate: zero, hundred_util_rate: hundred, points };
    };
    const fees = () => ({
      insurance_fee_fixed_apr: fx(fixed()),
      insurance_ir_fee: fx(fixed()),
      protocol_fixed_fee_apr: fx(fixed()),
      protocol_ir_fee: fx(fixed()),
      protocol_origination_fee: fx(fixed()),
    });
    const state = () => ({ [rng.pick(STATES)]: {} });
    const weights = () => {
      const init = rng.chance(80) ? rng.next() % (ONE + 1n) : rng.next() % (ONE * 2n);
      const maint = rng.chance(80) ? init + (rng.next() % (ONE + 1n - (init > ONE ? ONE : init))) : rng.next() % (ONE * 2n);
      const liabInit = rng.chance(85) ? ONE + (rng.next() % ONE) : rng.next() % (ONE * 2n);
      const liabMaint = rng.chance(85) ? ONE + (liabInit > ONE ? rng.next() % (liabInit - ONE + 1n) : 0n) : rng.next() % (ONE * 2n);
      return {
        asset_weight_init: fx(init),
        asset_weight_maint: fx(maint),
        liability_weight_init: fx(liabInit),
        liability_weight_maint: fx(liabMaint),
      };
    };
    const randomConfig = () =>
      bankConfig(
        {
          ...weights(),
          operational_state: state(),
          risk_tier: rng.chance(80) ? { Collateral: {} } : { Isolated: {} },
          asset_tag: rng.chance(85) ? rng.int(2) : rng.int(7),
          oracle_max_age: rng.chance(90) ? 10 + rng.int(1000) : rng.int(10),
          deposit_limit: new BN(rng.next().toString()),
          borrow_limit: new BN(rng.next().toString()),
        },
        { ...fees(), ...curve() },
      );

    await run("init fee state", h.admin, [h.initFeeState(h.admin, h.feeWallet)], [h.feeState]);
    const group = await generateKeyPairSigner();
    await run("group init", h.admin, [h.groupInit(group, h.admin)], [group.address]);
    const curveAdmin = await s.funded();
    const limitAdmin = await s.funded();
    await run(
      "set admins",
      h.admin,
      [h.configure(group.address, h.admin, { new_curve_admin: curveAdmin.address, new_limit_admin: limitAdmin.address })],
      [group.address],
    );
    const feeMint = await h.feeMint(6, rng.int(500), BigInt(rng.int(1_000_000)));
    const mints = [
      { mint: await h.mint(TOKEN_PROGRAM, 6), program: TOKEN_PROGRAM },
      { mint: await h.mint(TOKEN_2022, 9), program: TOKEN_2022 },
      { mint: feeMint, program: TOKEN_2022 },
    ];
    type FuzzBank = Awaited<ReturnType<typeof h.addBank>>[1] & { mint: (typeof mints)[number] };
    const banks: FuzzBank[] = [];
    let t = 1_800_000_000n;
    h.setTime(t);
    // Banks that exist, so the steps have something to work on (random configs may be refused).
    while (banks.length < 3) {
      const m = mints[banks.length]!;
      const [ix, b] = await h.addBank(group.address, h.admin, m.mint, m.program, bankConfig({}, { ...curve(), points: curve().points.map((p) => p) }), {});
      if ((await run(`add bank ${banks.length}`, h.admin, [ix], h.watchBank(b, group.address))) === "ok") banks.push({ ...b, mint: m });
    }
    const other = await s.funded();
    const signer = (want: KeyPairSigner): KeyPairSigner => (rng.chance(5) ? other : want);
    // Users, each with marginfi accounts and a funded token account per mint.
    const users = [await s.funded(), await s.funded()];
    const wallets = new Map<string, Address>();
    for (const u of users)
      for (const m of mints)
        wallets.set(
          `${u.address}:${m.mint}`,
          m.mint === feeMint ? await h.t22Account(m.mint, u.address, 1n << 60n) : await h.tokenAccount(m.mint, u.address, 1n << 60n, m.program),
        );
    const accounts: { address: Address; owner: KeyPairSigner }[] = [];
    const openAccount = async (label: string) => {
      const owner = rng.pick(users);
      const k = await generateKeyPairSigner();
      if ((await run(label, owner, [h.accountInit(group.address, k, signer(owner), owner)], [k.address])) === "ok")
        accounts.push({ address: k.address, owner });
    };
    while (accounts.length < 3) await openAccount(`account ${accounts.length}`);
    const editAccount = h.edit("MarginfiAccount");
    /** An amount across scales: dust, ordinary, large. */
    const amount = (): bigint => [rng.next() % 10n, rng.next() % 100_000n, rng.next() % 1_000_000_000n, rng.next() % (1n << 50n)][rng.int(4)]!;

    for (let step = 0; step < STEPS; step++) {
      const label = (what: string) => `step ${step} (seed ${SEED}): ${what}`;
      const bank = rng.pick(banks);
      const b = bank.address;
      t += rng.chance(10) ? 0n : rng.chance(5) ? rng.next() % 40_000_000n : rng.next() % 100_000n;
      h.setTime(t);
      switch (rng.int(14)) {
        case 0:
        case 1:
        case 2: {
          // Balances, sometimes a locked cache or a recorded halt, then accrue.
          const assets = rng.chance(10) ? 0n : rng.lamports() * ONE + (rng.next() % ONE);
          const liabilities = rng.chance(10) ? 0n : rng.chance(70) && assets > 0n ? (assets * BigInt(rng.int(1200))) / 1000n : rng.lamports() * ONE;
          const fields: [string, bigint, number][] = [
            ["total_asset_shares", assets, 16],
            ["total_liability_shares", liabilities, 16],
            ["cache.liq_cache_flags", rng.chance(5) ? 1n : 0n, 1],
          ];
          if (rng.chance(10))
            fields.push(
              ["cb_halt_started_at", t - (rng.next() % 1000n), 8],
              ["cb_halt_ended_at", t + (rng.next() % 1000n) - 500n, 8],
              ["cb_frozen_seconds_pending", rng.next() % 100n, 8],
            );
          if (rng.chance(10))
            fields.push(["asset_share_value", ONE + (rng.next() % (ONE * 3n)), 16], ["liability_share_value", ONE + (rng.next() % (ONE * 3n)), 16]);
          h.editBank(b, fields);
          await run(label("accrue"), h.admin, [h.accrue(group.address, b)], [b], "if-panics");
          break;
        }
        case 3:
        case 4: {
          // The fast admin's settings: a random handful of fields.
          const c: Record<string, unknown> = {};
          if (rng.chance(30)) c.deposit_limit = new BN(rng.next().toString());
          if (rng.chance(30)) c.borrow_limit = new BN(rng.next().toString());
          if (rng.chance(25)) c.operational_state = state();
          if (rng.chance(40)) c.interest_rate_config = h.irOpt(Object.fromEntries(Object.entries({ ...fees(), ...curve() }).filter(() => rng.chance(50))));
          if (rng.chance(20)) c.total_asset_value_init_limit = new BN(rng.next().toString());
          if (rng.chance(20)) c.permissionless_bad_debt_settlement = rng.chance(50);
          if (rng.chance(25)) c.liquidation_liquidator_fee = Number(rng.next() % (U32_MAX / 2n + (rng.chance(10) ? 10n : 1n)));
          if (rng.chance(25)) c.liquidation_insurance_fee = Number(rng.next() % (U32_MAX / 2n + (rng.chance(10) ? 10n : 1n)));
          if (rng.chance(20)) {
            c.circuit_breaker_enabled = rng.chance(60);
            if (rng.chance(70)) {
              const tiers = [1 + rng.int(1000), 1001 + rng.int(1000), 2001 + rng.int(3000)];
              c.cb_deviation_bps_tiers = rng.chance(85) ? tiers : [tiers[2], tiers[1], tiers[0]];
              c.cb_tier_durations_seconds = [1 + rng.int(100), 101 + rng.int(100), 201 + rng.int(100)];
              c.cb_escalation_window_mult = rng.int(12);
              c.cb_ema_alpha_bps = rng.int(2500);
              c.cb_window_seconds = rng.int(700_000);
              c.cb_window_max_up_bps = rng.int(11_000);
              c.cb_window_max_down_bps = rng.int(11_000);
            }
            // A cache warm enough to seed the breaker, most of the time.
            if (rng.chance(70))
              h.editBank(b, [
                ["cache.last_oracle_price", rng.chance(90) ? 1n + (rng.next() % (ONE * 1000n)) : 0n, 16],
                ["cache.last_oracle_price_timestamp", t - BigInt(rng.int(40)), 8],
                ["cache.price_multiplier", rng.chance(80) ? ONE : rng.next() % (ONE * 2n), 16],
              ]);
          }
          if (rng.chance(10)) h.editBank(b, [["flags", rng.chance(50) ? 16n | 8n : 16n, 8]]);
          if (rng.chance(10)) h.editBank(b, [["config.operational_state", BigInt(rng.int(7)), 1]]);
          const by = signer(h.admin);
          await run(
            label("configure bank"),
            by,
            [
              s.ix("lending_pool_configure_bank", { bank_config_opt: h.fast(c) }, [
                { address: group.address },
                { address: by.address, signer: by },
                { address: b, writable: true },
                h.sysvar,
              ]),
            ],
            [b],
            "if-panics",
          );
          break;
        }
        case 5: {
          const by = signer(curveAdmin);
          const ir = Object.fromEntries(Object.entries({ ...fees(), ...curve() }).filter(() => rng.chance(60)));
          await run(
            label("interest only"),
            by,
            [
              s.ix("lending_pool_configure_bank_interest_only", { interest_rate_config: h.irOpt(ir) }, [
                { address: group.address },
                { address: by.address, signer: by },
                { address: b, writable: true },
                h.sysvar,
              ]),
            ],
            [b],
          );
          break;
        }
        case 6: {
          const by = signer(limitAdmin);
          const opt = () => (rng.chance(50) ? new BN(rng.next().toString()) : null);
          await run(
            label("limits only"),
            by,
            [
              s.ix("lending_pool_configure_bank_limits_only", { deposit_limit: opt(), borrow_limit: opt(), total_asset_value_init_limit: opt() }, [
                { address: group.address },
                { address: by.address, signer: by },
                { address: b, writable: true },
                h.sysvar,
              ]),
            ],
            [b],
          );
          break;
        }
        case 7: {
          // A new bank, its config random (often refused).
          const m = rng.pick(mints);
          const [ix, nb] = await h.addBank(group.address, signer(h.admin), m.mint, m.program, randomConfig(), rng.chance(50) ? { seed: rng.next() % 4n } : {});
          if ((await run(label("add bank"), h.admin, [ix], h.watchBank(nb, group.address))) === "ok") banks.push({ ...nb, mint: m });
          break;
        }
        case 9:
        case 10:
        case 11: {
          // A deposit: any account, bank and amount; now and then a wrong signer, flag or Token-2022 mistake.
          const acct = rng.pick(accounts);
          const by = signer(acct.owner);
          const from = wallets.get(`${acct.owner.address}:${bank.mint.mint}`)!;
          const t22 = bank.mint.program === TOKEN_2022;
          const rest = t22 ? (rng.chance(90) ? [bank.mint.mint] : rng.chance(50) ? [] : [mints[0]!.mint]) : [];
          if (rng.chance(8)) editAccount(acct.address, [["account_flags", rng.pick([1n, 16n, 64n, 256n]), 8]]);
          const watch = [acct.address, b, bank.v.liquidity, from];
          await run(
            label("deposit"),
            by,
            [
              h.deposit(group.address, acct.address, by, b, from, bank.v.liquidity, amount(), {
                upToLimit: rng.chance(30) ? rng.chance(70) : null,
                program: bank.mint.program,
                rest,
              }),
            ],
            watch,
            "if-panics",
          );
          editAccount(acct.address, [["account_flags", 0n, 8]]);
          break;
        }
        case 12: {
          // Close a balance, often after its assets are written down to dust.
          const acct = rng.pick(accounts);
          if (rng.chance(60)) {
            const data = Buffer.from((s.original.getAccount(acct.address) as { data: Uint8Array }).data);
            for (let i = 0; i < 16; i++) {
              const at = offsetOf("MarginfiAccount", `lending_account.balances[${i}].bank_pk`);
              if (data.subarray(at, at + 32).equals(Buffer.from(new web3.PublicKey(b).toBytes())))
                editAccount(acct.address, [[`lending_account.balances[${i}].asset_shares`, rng.chance(50) ? 0n : rng.next() % (ONE / 1000n), 16]]);
            }
          }
          await run(label("close balance"), signer(acct.owner), [h.closeBalance(group.address, acct.address, acct.owner, b)], [acct.address, b], "if-panics");
          break;
        }
        case 13: {
          // Open an account, or close one (most still hold balances and are refused).
          if (rng.chance(50) || accounts.length < 2) await openAccount(label("account init"));
          else {
            const i = rng.int(accounts.length);
            const acct = accounts[i]!;
            if (
              (await run(
                label("close account"),
                acct.owner,
                [await h.accountClose(acct.address, signer(acct.owner), acct.owner)],
                [acct.address, acct.owner.address],
                "if-panics",
              )) === "ok"
            )
              accounts.splice(i, 1);
          }
          break;
        }
        default: {
          // The protocol pause the fee state carries, propagated to the group.
          h.edit("FeeState")(h.feeState, [
            ["panic_state.pause_flags", rng.chance(30) ? 1n : 0n, 1],
            ["panic_state.pause_start_timestamp", t - (rng.next() % 30_000n), 8],
          ]);
          await run(
            label("propagate"),
            h.admin,
            [s.ix("propagate_fee_state", {}, [{ address: h.feeState }, { address: group.address, writable: true }])],
            [group.address],
          );
          break;
        }
      }
    }
    report(`fuzz marginfi (seed ${SEED})`, s);
  });
});
