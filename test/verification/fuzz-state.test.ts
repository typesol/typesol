import { AccountState, getMintEncoder, getMintSize, getTokenDecoder, getTokenEncoder, getTokenSize } from "@solana-program/token";
import { type Address, type KeyPairSigner, generateKeyPairSigner, getAddressEncoder, getU64Encoder, lamports, none } from "@solana/kit";
import { FailedTransactionMetadata, type LiteSVM, type TransactionMetadata } from "litesvm";
import { describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, TOKEN_PROGRAM, deployExample, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

/**
 * Model-based fuzzing: random sequences of honest and hostile actions against the example programs.
 * After every step the chain must agree with a plain TypeScript model of what should have happened,
 * and value must be conserved (SOL up to fees, tokens exactly).
 */
const SEED = BigInt(process.env.FUZZ_SEED ?? Date.now());
const STEPS = Number(process.env.FUZZ_STEPS ?? 300);
const FEE = 5000n;

class Rng {
  private s: bigint;
  constructor(seed: bigint) {
    this.s = (seed ^ 0x2545f4914f6cdd1dn) & 0xffff_ffff_ffff_ffffn || 1n;
  }
  next(): bigint {
    let x = this.s;
    x ^= x >> 12n;
    x ^= (x << 25n) & 0xffff_ffff_ffff_ffffn;
    x ^= x >> 27n;
    this.s = x;
    return (x * 0x2545f4914f6cdd1dn) & 0xffff_ffff_ffff_ffffn;
  }
  int(n: number): number {
    return Number(this.next() % BigInt(n));
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)];
  }
}

const code = (res: TransactionMetadata | FailedTransactionMetadata): number | "ok" | string => {
  if (!(res instanceof FailedTransactionMetadata)) return "ok";
  const m = /Custom\D*(\d+)/.exec(String(res.err()));
  return m ? Number(m[1]) : String(res.err());
};

describe(`model-based fuzzing (seed ${SEED}, ${STEPS} steps)`, () => {
  it("vault: random deposits, withdrawals, closes and thefts keep chain == model and conserve SOL", async () => {
    const d: Deployed = await deployExample("vault");
    const { svm } = d;
    const rng = new Rng(SEED);
    const users = await Promise.all([0, 1, 2].map(() => fundedSigner(svm, 50n)));
    const vaults = await Promise.all(users.map(async (u) => (await pda(d.programId, ["vault", u.address]))[0]));
    // model: per-user vault balance above rent, or undefined when closed / never opened
    const model: (bigint | undefined)[] = [undefined, undefined, undefined];
    const stats = { deposits: 0, withdraws: 0, opens: 0, shuts: 0, rejected: 0 };

    const total = () => [...users.map((u) => u.address), ...vaults].reduce((s, a) => s + (svm.getBalance(a) ?? 0n), 0n);
    let expectedTotal = total();
    let rent = 0n;

    for (let step = 0; step < STEPS; step++) {
      const actor = rng.int(3);
      const target = rng.next() % 4n === 0n ? rng.int(3) : actor; // 25% of actions aim at someone else's vault
      const me = { address: users[actor].address, signer: users[actor], writable: true };
      const v = { address: vaults[target], writable: true };
      const action = rng.pick(["open", "deposit", "deposit", "withdraw", "withdraw", "shut"] as const);
      const amount = rng.pick([0n, 1n, 1_000n, 10_000_000n, BigInt(rng.int(2_000_000_000)), (model[target] ?? 0n) + 1n, model[target] ?? 0n]);

      let res: TransactionMetadata | FailedTransactionMetadata;
      let want: number | "ok";
      const open = model[target] !== undefined;
      const owner = actor === target;
      if (action === "open") {
        res = await send(svm, users[actor], [ix(d, "open", {}, [me, { address: vaults[actor], writable: true }, { address: SYSTEM_PROGRAM }])]);
        want = model[actor] === undefined ? "ok" : 0; // AccountAlreadyInUse from the System Program, as under Anchor
        if (want === "ok") {
          model[actor] = 0n;
          stats.opens++;
        }
      } else if (action === "deposit") {
        // The fee comes out first; the System transfer then needs the whole amount (custom error 1, insufficient funds).
        const spendable = (svm.getBalance(users[actor].address) ?? 0n) - FEE;
        res = await send(svm, users[actor], [ix(d, "deposit", { amount: new BN(amount.toString()) }, [me, v, { address: SYSTEM_PROGRAM }])]);
        want = !open ? 3012 : amount === 0n ? 6001 : !owner ? 6000 : amount > spendable ? 1 : "ok";
        if (want === "ok") {
          model[target]! += amount;
          stats.deposits++;
        }
      } else if (action === "withdraw") {
        res = await send(svm, users[actor], [ix(d, "withdraw", { amount: new BN(amount.toString()) }, [me, v])]);
        // `vault.lamports - amount` is checked: asking for more than rent + balance overflows (5100) before the rent test.
        want = !open ? 3012 : amount === 0n ? 6001 : !owner ? 6000 : amount > model[target]! + rent ? 5100 : amount > model[target]! ? 6002 : "ok";
        if (want === "ok") {
          model[target]! -= amount;
          stats.withdraws++;
        }
      } else {
        res = await send(svm, users[actor], [ix(d, "shut", {}, [me, v])]);
        want = !open ? 3012 : !owner ? 6000 : "ok";
        if (want === "ok") {
          model[target] = undefined;
          stats.shuts++;
        }
      }
      const got = code(res);
      if (got !== "ok") stats.rejected++;
      expect(got, `step ${step}: ${action} by ${actor} on vault ${target} amount ${amount}`).toBe(want);

      // Fees are the only leak. Failed transactions still pay the fee.
      expectedTotal -= FEE;
      expect(total(), `SOL conservation after step ${step}`).toBe(expectedTotal);
      for (let i = 0; i < 3; i++) {
        const bal = svm.getBalance(vaults[i]) ?? 0n;
        if (model[i] === undefined) expect(bal, `vault ${i} closed`).toBe(0n);
        else {
          if (rent === 0n) rent = bal - model[i]!;
          expect(bal, `vault ${i} balance after step ${step}`).toBe(rent + model[i]!);
        }
      }
    }
    // A sanity check that the run exercised the paths (not a property): seed 1793122244741 lands exactly on 5%.
    expect(stats.deposits + stats.withdraws).toBeGreaterThanOrEqual(STEPS / 20);
    expect(stats.rejected).toBeGreaterThan(STEPS / 10);
    if (process.env.FUZZ_VERBOSE) console.log("vault", stats);
  });

  it("escrow: random make / take / refund / hostile takes keep token balances == model and supply constant", async () => {
    const d: Deployed = await deployExample("escrow");
    const { svm } = d;
    const rng = new Rng(SEED + 1n);
    const RENT = lamports(10_000_000n);
    const SUPPLY = 1_000_000n;

    const mint = async () => {
      const a = (await generateKeyPairSigner()).address;
      const data = getMintEncoder().encode({ mintAuthority: none(), supply: SUPPLY * 4n, decimals: 0, isInitialized: true, freezeAuthority: none() });
      svm.setAccount({
        address: a,
        data: new Uint8Array(data),
        executable: false,
        lamports: RENT,
        programAddress: TOKEN_PROGRAM,
        space: BigInt(getMintSize()),
      });
      return a;
    };
    const tokenAcct = async (m: Address, owner: Address, amount: bigint) => {
      const a = (await generateKeyPairSigner()).address;
      const data = getTokenEncoder().encode({
        mint: m,
        owner,
        amount,
        delegate: none(),
        state: AccountState.Initialized,
        isNative: none(),
        delegatedAmount: 0n,
        closeAuthority: none(),
      });
      svm.setAccount({
        address: a,
        data: new Uint8Array(data),
        executable: false,
        lamports: RENT,
        programAddress: TOKEN_PROGRAM,
        space: BigInt(getTokenSize()),
      });
      return a;
    };
    const bal = (a: Address) => {
      const acct = svm.getAccount(a);
      return acct.exists ? getTokenDecoder().decode(acct.data).amount : 0n;
    };

    const [mintA, mintB] = [await mint(), await mint()];
    const people: { s: KeyPairSigner; a: Address; b: Address }[] = [];
    for (let i = 0; i < 4; i++) {
      const s = await fundedSigner(svm, 100n);
      people.push({ s, a: await tokenAcct(mintA, s.address, SUPPLY), b: await tokenAcct(mintB, s.address, SUPPLY) });
    }
    const balances = new Map<Address, bigint>();
    for (const p of people) {
      balances.set(p.a, SUPPLY);
      balances.set(p.b, SUPPLY);
    }
    type Offer = { maker: number; seed: bigint; pda: Address; vault: Address; amountA: bigint; wantB: bigint; open: boolean };
    const offers: Offer[] = [];
    const stats = { made: 0, taken: 0, refunded: 0, rejected: 0, hostileBlocked: 0 };
    let nextSeed = 1n;

    const sumA = () => [...people.map((p) => p.a), ...offers.map((o) => o.vault)].reduce((s, a) => s + bal(a), 0n);
    const sumB = () => people.reduce((s, p) => s + bal(p.b), 0n);

    for (let step = 0; step < STEPS; step++) {
      const action = offers.some((o) => o.open) ? rng.pick(["make", "take", "take", "refund", "hostile"] as const) : "make";
      let got: number | "ok" | string;
      let want: number | "ok";
      if (action === "make") {
        const m = rng.int(4);
        const seed = nextSeed++;
        const [offerPda] = await pda(d.programId, ["offer", people[m].s.address, new Uint8Array(getU64Encoder().encode(seed))]);
        const vault = await tokenAcct(mintA, offerPda, 0n);
        const amountA = rng.pick([0n, 1n, BigInt(rng.int(5000)), bal(people[m].a) + 1n]);
        const wantB = rng.pick([0n, 1n, BigInt(rng.int(5000))]);
        const res = await send(svm, people[m].s, [
          ix(
            d,
            "make",
            {
              seed: new BN(seed.toString()),
              amount_a: new BN(amountA.toString()),
              want_b: new BN(wantB.toString()),
              mint_b: { toBuffer: () => Buffer.from(getAddressEncoder().encode(mintB)) },
            },
            [
              { address: people[m].s.address, signer: people[m].s, writable: true },
              { address: offerPda, writable: true },
              { address: people[m].a, writable: true },
              { address: vault, writable: true },
              { address: SYSTEM_PROGRAM },
              { address: TOKEN_PROGRAM },
            ],
          ),
        ]);
        got = code(res);
        // amount > balance fails inside the SPL Token CPI (token error 1: insufficient funds)
        want = amountA === 0n || wantB === 0n ? 6000 : amountA > balances.get(people[m].a)! ? 1 : "ok";
        if (want === "ok") {
          balances.set(people[m].a, balances.get(people[m].a)! - amountA);
          offers.push({ maker: m, seed, pda: offerPda, vault, amountA, wantB, open: true });
          stats.made++;
        }
      } else {
        const open = offers.filter((o) => o.open);
        const o = rng.pick(open);
        const maker = people[o.maker];
        if (action === "refund") {
          const caller = rng.next() % 3n === 0n ? rng.int(4) : o.maker;
          const res = await send(svm, people[caller].s, [
            ix(d, "refund", {}, [
              { address: people[caller].s.address, signer: people[caller].s, writable: true },
              { address: o.pda, writable: true },
              { address: people[caller].a, writable: true },
              { address: o.vault, writable: true },
              { address: TOKEN_PROGRAM },
            ]),
          ]);
          got = code(res);
          want = caller === o.maker ? "ok" : 6002;
          if (want === "ok") {
            balances.set(maker.a, balances.get(maker.a)! + o.amountA);
            o.open = false;
            stats.refunded++;
          }
        } else {
          const t = rng.pick([0, 1, 2, 3].filter((i) => i !== o.maker));
          const taker = people[t];
          // hostile: redirect the maker's payment to the taker's own B account, or claim a different maker
          const hostile = action === "hostile" ? rng.pick(["redirect", "redirectSelf", "fakeMaker", "fakeMakerSelf"] as const) : undefined;
          // A third party who is neither maker nor taker, to get past the aliasing check.
          const accomplice = people[[0, 1, 2, 3].find((i) => i !== o.maker && i !== t)!];
          const makerB = hostile === "redirect" ? await tokenAcct(mintB, taker.s.address, 0n) : hostile === "redirectSelf" ? taker.b : maker.b;
          if (hostile === "redirect") balances.set(makerB, 0n);
          const makerAddr = hostile === "fakeMaker" ? accomplice.s.address : hostile === "fakeMakerSelf" ? taker.s.address : maker.s.address;
          const res = await send(svm, taker.s, [
            ix(d, "take", {}, [
              { address: taker.s.address, signer: taker.s, writable: true },
              { address: makerAddr, writable: true },
              { address: o.pda, writable: true },
              { address: taker.a, writable: true },
              { address: taker.b, writable: true },
              { address: makerB, writable: true },
              { address: o.vault, writable: true },
              { address: TOKEN_PROGRAM },
            ]),
          ]);
          got = code(res);
          if (hostile && got !== "ok") stats.hostileBlocked++;
          if (hostile === "redirectSelf" || hostile === "fakeMakerSelf")
            want = 2040; // same account in two writable slots
          else if (hostile === "redirect")
            want = 6005; // WrongRecipient: maker's B account must be owned by the maker
          else if (hostile === "fakeMaker")
            want = 6002; // WrongMaker
          else want = o.wantB > balances.get(taker.b)! ? 1 : "ok";
          if (want === "ok") {
            balances.set(taker.b, balances.get(taker.b)! - o.wantB);
            balances.set(maker.b, balances.get(maker.b)! + o.wantB);
            balances.set(taker.a, balances.get(taker.a)! + o.amountA);
            o.open = false;
            stats.taken++;
          }
        }
      }
      if (got !== "ok") stats.rejected++;
      expect(got, `step ${step}: ${action}`).toBe(want);
      for (const [a, b] of balances) expect(bal(a), `token balance after step ${step}`).toBe(b);
      for (const o of offers) {
        expect(svm.getAccount(o.pda).exists, `offer ${o.seed} existence after step ${step}`).toBe(o.open);
        expect(bal(o.vault), `vault ${o.seed} after step ${step}`).toBe(o.open ? o.amountA : 0n);
      }
      expect(sumA(), "mint A conserved").toBe(SUPPLY * 4n);
      expect(sumB(), "mint B conserved").toBe(SUPPLY * 4n);
    }
    expect(stats.taken + stats.refunded).toBeGreaterThan(0);
    expect(stats.rejected).toBeGreaterThan(0);
    if (process.env.FUZZ_VERBOSE) console.log("escrow", stats);
  });

  it("ledgerbook: random filings, decisions, batch approvals and resets keep the Vec, account size and rent == model", async () => {
    const d: Deployed = await deployExample("ledgerbook");
    const { svm } = d;
    const rng = new Rng(SEED + 2n);
    const admin = await fundedSigner(svm, 100n);
    const approver = await fundedSigner(svm, 10n);
    const filers = await Promise.all([0, 1, 2].map(() => fundedSigner(svm, 100n)));
    const [book] = await pda(d.programId, ["book", admin.address, new TextEncoder().encode("fuzz")]);
    expect(
      code(
        await send(svm, admin, [
          ix(d, "create", { title: "fuzz", approver: { toBuffer: () => Buffer.from(getAddressEncoder().encode(approver.address)) } }, [
            { address: admin.address, signer: admin, writable: true },
            { address: book, writable: true },
            { address: SYSTEM_PROGRAM },
          ]),
        ]),
      ),
    ).toBe("ok");
    const ENTRY = 32 + 8 + 1 + 4 + 16;
    const FIXED = 8 + 32 + 28 + 33 + 9 + 4;
    type E = { who: string; amount: bigint; status: string };
    const model: E[] = [];
    const stats = { filed: 0, decided: 0, batch: 0, resets: 0, rejected: 0 };

    for (let step = 0; step < STEPS; step++) {
      const action = rng.pick(["file", "file", "file", "decide", "batch", "reset"] as const);
      let got: number | "ok" | string;
      let want: number | "ok";
      if (action === "file") {
        const who = rng.pick(filers);
        const amount = BigInt(rng.int(1_000_000));
        got = code(
          await send(svm, who, [
            ix(d, "file", { amount: new BN(amount.toString()), note: "n", memo: null }, [
              { address: who.address, signer: who, writable: true },
              { address: book, writable: true },
              { address: SYSTEM_PROGRAM },
            ]),
          ]),
        );
        // 10 KiB growth per instruction is far away; each filing adds one entry.
        want = "ok";
        model.push({ who: who.address, amount, status: "Pending" });
        stats.filed++;
      } else if (action === "decide") {
        const index = rng.int(model.length + 2);
        const approve = rng.next() % 2n === 0n;
        const caller = rng.next() % 5n === 0n ? rng.pick(filers) : approver;
        got = code(
          await send(svm, caller, [
            ix(d, "decide", { index: new BN(index), approve }, [
              { address: caller.address, signer: caller },
              { address: book, writable: true },
            ]),
          ]),
        );
        want = caller !== approver ? 6002 : index >= model.length ? 5104 : model[index].status !== "Pending" ? 6003 : "ok";
        if (want === "ok") {
          model[index].status = approve ? "Approved" : "Rejected";
          stats.decided++;
        }
      } else if (action === "batch") {
        const idx = Array.from({ length: rng.int(4) }, () => rng.int(model.length + 1));
        got = code(
          await send(svm, approver, [
            ix(d, "approve_many", { indices: idx.map((i) => new BN(i)) }, [
              { address: approver.address, signer: approver },
              { address: book, writable: true },
            ]),
          ]),
        );
        want = idx.some((i) => i >= model.length) ? 5104 : "ok";
        if (want === "ok") {
          for (const i of idx) if (model[i].status === "Pending") model[i].status = "Approved";
          stats.batch++;
        }
      } else {
        got = code(
          await send(svm, admin, [
            ix(d, "reset", {}, [
              { address: admin.address, signer: admin },
              { address: book, writable: true },
            ]),
          ]),
        );
        want = "ok";
        model.length = 0;
        stats.resets++;
      }
      if (got !== "ok") stats.rejected++;
      expect(got, `step ${step}: ${action}`).toBe(want);

      const acct = svm.getAccount(book) as { data: Uint8Array };
      expect(acct.data.length, `account size after step ${step}`).toBe(FIXED + model.length * ENTRY);
      expect(svm.getBalance(book)! >= svm.minimumBalanceForRentExemption(BigInt(acct.data.length)), `rent-exempt after step ${step}`).toBe(true);
      const entries = (
        d.coder.accounts.decode("Book", Buffer.from(acct.data)) as {
          entries: { who: { toBase58(): string }; amount: { toString(): string }; status: object }[];
        }
      ).entries;
      expect(
        entries.map((e) => [e.who.toBase58(), e.amount.toString(), Object.keys(e.status)[0]]),
        `entries after step ${step}`,
      ).toEqual(model.map((e) => [e.who, e.amount.toString(), e.status]));
    }
    expect(stats.filed).toBeGreaterThan(0);
    expect(stats.resets).toBeGreaterThan(0);
    if (process.env.FUZZ_VERBOSE) console.log("ledgerbook", stats);
  });
});
