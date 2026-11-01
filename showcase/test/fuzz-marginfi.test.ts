// Random sequences of Marginfi's group and bank administration against the program deployed on mainnet
// (test/programs/marginfi_v2.so) and showcase/mainnet/marginfi, side by side (showcase/test/marginfi-helpers.ts): every transaction must
// have the same outcome, account bytes and events in both. Bank configs, interest curves, fees, balances, clocks and
// the circuit breaker's state come from the seed, and so do the keys: reproduce a failure with FUZZ_SEED=<seed>;
// lengthen with FUZZ_STEPS=<n>.
//
// Borrows are not ported yet: the fuzzer writes a bank's asset and liability shares into both, then accrues. Oracles
// are Pyth and Switchboard accounts it writes into both, their prices a random walk with jumps; withdrawals run the
// risk engine over them. An input the original panics on (a negative fee rate trips its asserts) only has to fail in the port too.
import { type Address, type KeyPairSigner } from "@solana/kit";
import { describe, it } from "vitest";
import { BN, TOKEN_2022, TOKEN_PROGRAM } from "../../test/harness.js";
import { Rng } from "./fuzz-rng.js";
import { report } from "./jito-helpers.js";
import { ONE, U32_MAX, bankConfig, fx, marginfiPair, offsetOf } from "./marginfi-helpers.js";
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
    const group = await s.key();
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
      const k = await s.key();
      if ((await run(label, owner, [h.accountInit(group.address, k, signer(owner), owner)], [k.address])) === "ok")
        accounts.push({ address: k.address, owner });
    };
    while (accounts.length < 3) await openAccount(`account ${accounts.length}`);
    const editAccount = h.edit("MarginfiAccount");
    /** Accounts holding a liability (written into both: borrows are not ported yet), and the bank it is in. */
    const borrowers: { address: Address; owner: KeyPairSigner; bank: FuzzBank }[] = [];
    const feeAtas = new Map<string, Address>();
    for (const m of mints) feeAtas.set(m.mint, await h.createAta(h.feeWallet, m.mint, m.program));
    const destinations = new Map<string, Address>();
    const read128 = (at: Address, type: string, path: string) => {
      const data = Buffer.from((s.original.getAccount(at) as { data: Uint8Array }).data);
      const o = offsetOf(type, path);
      return data.readBigInt64LE(o + 8) * (1n << 64n) + data.readBigUInt64LE(o);
    };
    const read64 = (at: Address, type: string, path: string) =>
      Buffer.from((s.original.getAccount(at) as { data: Uint8Array }).data).readBigUInt64LE(offsetOf(type, path));
    const keyBits = (a: Address) => BigInt("0x" + Buffer.from(new web3.PublicKey(a).toBytes()).reverse().toString("hex"));
    /** An amount across scales: dust, ordinary, large. */
    const amount = (): bigint => [rng.next() % 10n, rng.next() % 100_000n, rng.next() % 1_000_000_000n, rng.next() % (1n << 50n)][rng.int(4)]!;

    // Each bank's Pyth and Switchboard accounts, rewritten before a pulse: a random walk with jumps, random
    // confidence, exponent and age, now and then a broken account.
    let slot = 388_800_007n;
    const feeds = new Map<string, { pyth: Address; swb: Address; price: bigint }>();
    const feedsOf = async (b: Address) => {
      let f = feeds.get(b);
      if (!f) {
        f = { pyth: (await s.key()).address, swb: (await s.key()).address, price: 100_000_000n };
        feeds.set(b, f);
      }
      return f;
    };
    const writeFeeds = (f: { pyth: Address; swb: Address; price: bigint }) => {
      const move = rng.chance(15) ? BigInt(rng.int(8000)) - 4000n : BigInt(rng.int(800)) - 400n;
      f.price = f.price + (f.price * move) / 10_000n;
      if (f.price <= 0n || rng.chance(2)) f.price = BigInt(rng.int(1_000_000_000)) - (rng.chance(5) ? 1000n : 0n);
      const age = rng.chance(10) ? BigInt(rng.int(200)) : BigInt(rng.int(20));
      const expo = rng.chance(90) ? -6 : rng.pick([0, 2, -2, -8, -12, 23, -23, 24, -24]);
      const conf = rng.chance(80) ? (f.price > 0n ? f.price : 1n) / BigInt(50 + rng.int(500)) : rng.next() % 100_000_000n;
      h.setPyth(f.pyth, {
        price: f.price,
        conf,
        expo,
        publishTime: rng.chance(5) ? t + BigInt(rng.int(100)) : t - age,
        emaPrice: rng.chance(70) ? f.price : f.price + BigInt(rng.int(2_000_000)) - 1_000_000n,
        emaConf: rng.chance(70) ? conf : conf * 2n,
        partial: rng.chance(5),
        len: rng.chance(3) ? rng.int(140) : undefined,
      });
      h.setSwb(f.swb, {
        value: rng.chance(97) ? f.price * 10n ** 12n : rng.next() * rng.next(),
        lastUpdate: t - age,
        owner: rng.chance(3) ? h.feeWallet : undefined,
        len: rng.chance(3) ? rng.int(3300) : undefined,
      });
    };

    for (let step = 0; step < STEPS; step++) {
      const label = (what: string) => `step ${step} (seed ${SEED}): ${what}`;
      const bank = rng.pick(banks);
      const b = bank.address;
      t += rng.chance(10) ? 0n : rng.chance(5) ? rng.next() % 40_000_000n : rng.next() % 100_000n;
      slot += rng.chance(10) ? 1n : BigInt(2 + rng.int(20));
      h.setClock(t, slot);
      switch (rng.int(30)) {
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
        case 14: {
          // A liability, written into both: a fresh account owing a random amount in this bank.
          const owner = rng.pick(users);
          const k = await s.key();
          if ((await run(label("borrower init"), owner, [h.accountInit(group.address, k, owner)], [k.address])) !== "ok") break;
          const shares = (amount() + 2n) * ONE + (rng.next() % ONE);
          editAccount(k.address, [
            ["lending_account.balances[0].active", 1n, 1],
            ["lending_account.balances[0].bank_pk", keyBits(b), 32],
            ["lending_account.balances[0].liability_shares", shares, 16],
            ["lending_account.balances[0].last_update", t - (rng.next() % 100_000n), 8],
            ["lending_account.balances[0].premium_rate_snapshot", rng.chance(30) ? rng.next() % 400_000_000n : 0n, 4],
          ]);
          h.editBank(b, [["total_liability_shares", read128(b, "Bank", "total_liability_shares") + shares, 16]]);
          if (rng.chance(20))
            h.editBank(b, [
              ["flags", rng.pick([16n, 16n | 8192n, 16n | 32n]), 8],
              ["premium_activated_at", t - 50_000n, 8],
            ]);
          borrowers.push({ address: k.address, owner, bank });
          break;
        }
        case 15:
        case 16: {
          // A repayment: part (premium first) or all, now and then by a wrong signer or with a wrong mint.
          if (!borrowers.length) break;
          const debt = rng.pick(borrowers);
          const by = signer(debt.owner);
          const from = wallets.get(`${debt.owner.address}:${debt.bank.mint.mint}`)!;
          const t22 = debt.bank.mint.program === TOKEN_2022;
          const rest = t22 ? (rng.chance(90) ? [debt.bank.mint.mint] : []) : [];
          if (rng.chance(8)) editAccount(debt.address, [["account_flags", rng.pick([1n, 16n, 48n, 64n, 128n]), 8]]);
          await run(
            label("repay"),
            by,
            [
              h.repay(group.address, debt.address, by, debt.bank.address, from, debt.bank.v.liquidity, amount(), {
                all: rng.chance(30) ? true : rng.chance(50) ? null : false,
                program: debt.bank.mint.program,
                rest,
              }),
            ],
            [debt.address, debt.bank.address, debt.bank.v.liquidity, from],
            "if-panics",
          );
          editAccount(debt.address, [["account_flags", 0n, 8]]);
          break;
        }
        case 17: {
          // Fees: collect them out of the liquidity vault, then the admin withdraws, or anyone sends them to the
          // destination the admin set.
          const rest = bank.mint.program === TOKEN_2022 ? [bank.mint.mint] : [];
          const feeAta = feeAtas.get(bank.mint.mint)!;
          const choice = rng.int(4);
          if (choice === 0)
            await run(
              label("collect fees"),
              other,
              [h.collectFees(group.address, bank, feeAta, bank.mint.program, rest)],
              [b, bank.v.liquidity, bank.v.insurance, bank.v.fee, feeAta],
              "if-panics",
            );
          else if (choice === 1) {
            const dst = wallets.get(`${users[0]!.address}:${bank.mint.mint}`)!;
            await run(
              label("withdraw fees or insurance"),
              h.admin,
              [
                h.withdrawVault(
                  rng.chance(50) ? "fees" : "insurance",
                  group.address,
                  bank,
                  signer(h.admin),
                  dst,
                  amount() % 1_000_000n,
                  bank.mint.program,
                  rest,
                ),
              ],
              [bank.v.fee, bank.v.insurance, dst],
            );
          } else if (choice === 2) {
            const dst = wallets.get(`${rng.pick(users).address}:${bank.mint.mint}`)!;
            if ((await run(label("set fees destination"), h.admin, [h.updateFeesDestination(group.address, b, signer(h.admin), dst)], [b])) === "ok")
              destinations.set(b, dst);
          } else {
            const dst = destinations.get(b) ?? wallets.get(`${users[1]!.address}:${bank.mint.mint}`)!;
            await run(
              label("withdraw fees permissionless"),
              other,
              [h.withdrawFeesPermissionless(group.address, bank, dst, amount(), bank.mint.program, rest)],
              [bank.v.fee, dst],
            );
          }
          break;
        }
        case 18:
        case 19: {
          // Point the bank at a feed: mostly its own Pyth or Switchboard account, sometimes a wrong count, key or setup.
          const f = await feedsOf(b);
          writeFeeds(f);
          // Not 19 or 22 on a default bank: their mSOL / LST validation is not ported (docs/case-study-marginfi.md).
          const setup = rng.chance(80) ? rng.pick([3, 4]) : rng.pick([0, 1, 5, 6, 8, 18, 20, 23, 25, rng.int(19)]);
          const feed = setup === 4 ? f.swb : f.pyth;
          const oracle = rng.chance(90) ? feed : rng.pick([f.pyth, f.swb]);
          const rest = rng.chance(85) ? [feed] : rng.pick([[], [feed, feed], [f.pyth, f.swb, other.address]]);
          // Mostly with the frozen-settings flag cleared (the fast admin's steps set it now and then).
          if (rng.chance(85)) h.editBank(b, [["flags", read64(b, "Bank", "flags") & ~8n, 8]]);
          if (rng.chance(5)) h.editBank(b, [["flags", rng.pick([0n, 8n, 4096n, 16n]), 8]]);
          await run(label("configure oracle"), h.admin, [h.configureOracle(group.address, signer(h.admin), b, setup, oracle, rest)], [b], "if-panics");
          break;
        }
        case 20: {
          // A fixed price (or a PT start price), now and then negative, with a wrong setup or accounts.
          // Not a PT start price that passes its checks on a default bank: the Exponent vault's validation is not ported.
          const setup = rng.chance(80) ? 8 : rng.pick([3, 13, 4, 29 + rng.int(10)]);
          const price = rng.chance(10) ? -(rng.next() % ONE) : rng.next() % (ONE * 1000n);
          const rest = rng.chance(85) ? [] : [other.address];
          await run(label("set oracle price"), h.admin, [h.setOraclePrice(group.address, signer(h.admin), b, price, setup, rest)], [b], "if-panics");
          break;
        }
        case 21: {
          // Pulse the price into the cache and the circuit breaker, with the feed the bank is set to (usually).
          const f = await feedsOf(b);
          writeFeeds(f);
          const setup = read64(b, "Bank", "config.oracle_setup") & 0xffn;
          const own = setup === 3n ? [f.pyth] : setup === 4n ? [f.swb] : [];
          const rest = rng.chance(80) ? own : rng.pick([[f.pyth], [f.swb], [], [f.pyth, f.swb]]);
          await run(label("pulse"), other, [h.pulse(group.address, b, rest)], [b], "if-panics");
          break;
        }
        case 22:
        case 23:
        case 24: {
          // A withdrawal (part, or all), with the account's banks and their oracles after it: as the client sends
          // them, now and then one left out, out of order or with something extra; prices freshly written mostly.
          const pool = [...accounts, ...borrowers];
          if (!pool.length) break;
          const acct = rng.pick(pool);
          const d = Buffer.from((s.original.getAccount(acct.address) as { data: Uint8Array }).data);
          const held: FuzzBank[] = [];
          for (let i = 0; i < 16; i++) {
            const at = offsetOf("MarginfiAccount", `lending_account.balances[${i}].active`);
            if (d[at] === 0) continue;
            const k = d.subarray(at + 1, at + 33);
            const hb = banks.find((x) => Buffer.from(new web3.PublicKey(x.address).toBytes()).equals(k));
            if (hb) held.push(hb);
          }
          const target = held.length && rng.chance(85) ? rng.pick(held) : bank;
          // What the account holds there, in tokens: most withdrawals ask for part of it.
          let deposit = 0n;
          for (let i = 0; i < 16; i++) {
            const at = offsetOf("MarginfiAccount", `lending_account.balances[${i}].bank_pk`);
            if (!d.subarray(at, at + 32).equals(Buffer.from(new web3.PublicKey(target.address).toBytes()))) continue;
            const sv = read128(target.address, "Bank", "asset_share_value");
            const so = offsetOf("MarginfiAccount", `lending_account.balances[${i}].asset_shares`);
            const shares = d.readBigInt64LE(so + 8) * (1n << 64n) + d.readBigUInt64LE(so);
            deposit = (shares * sv) >> 96n;
          }
          const all = rng.chance(20);
          const groups: Address[][] = [];
          const sorted = [...held].sort((x, y) =>
            Buffer.compare(Buffer.from(new web3.PublicKey(y.address).toBytes()), Buffer.from(new web3.PublicKey(x.address).toBytes())),
          );
          for (const hb of sorted) {
            if (all && hb.address === target.address) continue;
            const f = await feedsOf(hb.address);
            if (rng.chance(70)) writeFeeds(f);
            const setup = read64(hb.address, "Bank", "config.oracle_setup") & 0xffn;
            groups.push(setup === 8n ? [hb.address] : [hb.address, setup === 4n ? f.swb : f.pyth]);
          }
          if (all && rng.chance(50)) {
            const f = await feedsOf(target.address);
            groups.push([target.address, f.pyth]);
          }
          if (groups.length > 1 && rng.chance(5)) groups.reverse();
          let rest = groups.flat();
          if (rest.length && rng.chance(5)) rest = rest.slice(0, rest.length - 1);
          if (rng.chance(5)) rest.push(other.address);
          const t22 = target.mint.program === TOKEN_2022;
          const owner = acct.owner;
          const by = signer(owner);
          const to = wallets.get(`${owner.address}:${target.mint.mint}`)!;
          // Mostly an operational bank (the administration steps leave banks paused, killed or broken at random).
          if (rng.chance(75)) h.editBank(target.address, [["config.operational_state", 1n, 1]]);
          // Half the time no interest to accrue first (the accrual steps leave some banks past what accrual can hold).
          if (rng.chance(50)) h.editBank(target.address, [["last_update", t, 8]]);
          if (rng.chance(6)) editAccount(acct.address, [["account_flags", rng.pick([1n, 2n, 16n, 32n, 48n, 64n]), 8]]);
          if (rng.chance(5)) editAccount(acct.address, [["liquidation_tagged_at", t - 10n, 8]]);
          await run(
            label("withdraw"),
            by,
            [
              h.withdraw(group.address, acct.address, by, target, to, deposit > 0n && rng.chance(70) ? rng.next() % (deposit + 1n) : amount(), {
                all: all ? true : rng.chance(20) ? false : null,
                program: target.mint.program,
                rest: [...(t22 && rng.chance(95) ? [target.mint.mint] : []), ...rest],
              }),
            ],
            [acct.address, target.address, target.v.liquidity, target.v.insurance, to],
            "if-panics",
          );
          editAccount(acct.address, [["account_flags", 0n, 8]]);
          break;
        }
        case 25:
        case 26:
        case 27: {
          // A borrow: the account's banks and the one it borrows from, with their oracles, as the client sends them
          // (now and then short or with extras); origination fees and the group's program fee rate now and then.
          const acct = rng.pick(accounts);
          const d = Buffer.from((s.original.getAccount(acct.address) as { data: Uint8Array }).data);
          const keys = new Set<Address>();
          for (let i = 0; i < 16; i++) {
            const at = offsetOf("MarginfiAccount", `lending_account.balances[${i}].active`);
            if (d[at] === 0) continue;
            const k = d.subarray(at + 1, at + 33);
            const hb = banks.find((x) => Buffer.from(new web3.PublicKey(x.address).toBytes()).equals(k));
            if (hb) keys.add(hb.address);
          }
          keys.add(b);
          const sorted = [...keys].sort((x, y) => Buffer.compare(Buffer.from(new web3.PublicKey(y).toBytes()), Buffer.from(new web3.PublicKey(x).toBytes())));
          let rest: Address[] = [];
          for (const k of sorted) {
            const f = await feedsOf(k);
            if (rng.chance(70)) writeFeeds(f);
            const setup = read64(k, "Bank", "config.oracle_setup") & 0xffn;
            rest.push(...(setup === 8n ? [k] : [k, setup === 4n ? f.swb : f.pyth]));
          }
          if (rest.length && rng.chance(5)) rest = rest.slice(0, rest.length - 1);
          if (rng.chance(5)) rest.push(other.address);
          if (rng.chance(75)) h.editBank(b, [["config.operational_state", 1n, 1]]);
          if (rng.chance(50)) h.editBank(b, [["last_update", t, 8]]);
          if (rng.chance(20)) h.editBank(b, [["config.interest_rate_config.protocol_origination_fee", rng.next() % (ONE / 20n), 16]]);
          if (rng.chance(10)) h.editGroup(group.address, [["fee_state_cache.program_fee_rate", rng.next() % ONE, 16]]);
          if (rng.chance(6)) editAccount(acct.address, [["account_flags", rng.pick([1n, 2n, 16n, 64n]), 8]]);
          const t22 = bank.mint.program === TOKEN_2022;
          const by = signer(acct.owner);
          const to = wallets.get(`${acct.owner.address}:${bank.mint.mint}`)!;
          if (
            (await run(
              label("borrow"),
              by,
              [
                h.borrow(group.address, acct.address, by, bank, to, rng.chance(70) ? rng.next() % 100_000_000n : amount(), {
                  program: bank.mint.program,
                  rest: [...(t22 && rng.chance(95) ? [bank.mint.mint] : []), ...rest],
                }),
              ],
              [acct.address, b, bank.v.liquidity, to],
              "if-panics",
            )) === "ok"
          )
            borrowers.push({ address: acct.address, owner: acct.owner, bank });
          editAccount(acct.address, [["account_flags", 0n, 8]]);
          break;
        }
        case 28:
        case 29: {
          // Pulse an account's health (anyone): its banks and oracles in the order its balances sit, now and then
          // short, reversed or with extras, its flags and tag now and then set.
          const pool = [...accounts, ...borrowers];
          if (!pool.length) break;
          const acct = rng.pick(pool);
          const d = Buffer.from((s.original.getAccount(acct.address) as { data: Uint8Array }).data);
          const groups: Address[][] = [];
          for (let i = 0; i < 16; i++) {
            const at = offsetOf("MarginfiAccount", `lending_account.balances[${i}].active`);
            if (d[at] === 0) continue;
            const k = d.subarray(at + 1, at + 33);
            const hb = banks.find((x) => Buffer.from(new web3.PublicKey(x.address).toBytes()).equals(k));
            if (!hb) continue;
            const f = await feedsOf(hb.address);
            if (rng.chance(70)) writeFeeds(f);
            const setup = read64(hb.address, "Bank", "config.oracle_setup") & 0xffn;
            groups.push(setup === 8n ? [hb.address] : [hb.address, setup === 4n ? f.swb : f.pyth]);
          }
          if (groups.length > 1 && rng.chance(5)) groups.reverse();
          let rest = groups.flat();
          if (rest.length && rng.chance(5)) rest = rest.slice(0, rest.length - 1);
          if (rng.chance(5)) rest.push(other.address);
          if (rng.chance(8)) editAccount(acct.address, [["account_flags", rng.pick([2n, 16n]), 8]]);
          if (rng.chance(10)) editAccount(acct.address, [["liquidation_tagged_at", t - 10n, 8]]);
          await run(label("pulse health"), other, [h.pulseHealth(acct.address, group.address, rest)], [acct.address], "if-panics");
          editAccount(acct.address, [["account_flags", 0n, 8]]);
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
