import { AccountState, getMintEncoder, getMintSize, getTokenDecoder, getTokenEncoder, getTokenSize } from "@solana-program/token";
import { type Address, type KeyPairSigner, address, generateKeyPairSigner, getAddressEncoder, getU64Encoder, lamports, none } from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from "litesvm";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, TOKEN_PROGRAM, deployExample, ix, pda, send, type Deployed } from "../harness.js";

/**
 * Differential testing against hand-written Anchor twins (test/anchor-twins). Both implementations get the
 * same random transactions from the same wallets; after every step their outcomes, program account
 * contents and every wallet / token balance must match. Compute units and binary sizes are reported.
 *
 * Build the twins first: (cd test/anchor-twins && cargo-build-sbf). Skipped when they are missing.
 */
const SEED = BigInt(process.env.FUZZ_SEED ?? Date.now());
const STEPS = Number(process.env.FUZZ_STEPS ?? 200);
const ANCHOR_DIR = fileURLToPath(new URL("../../test/anchor-twins/target/deploy/", import.meta.url));
const ANCHOR_IDS = {
  counter: address("EqGyjYr2RHtEV5zQXCPpZ8neqU9tMgmruvuJRW4Pz2aN"),
  vault: address("HVWmZ4JYMsvmLQoZMXDcjoat1GHHfC1GsgQjSjbGFGX"),
  escrow: address("aHbra6ogev5FhFznpsWa1obufi5NkUkHtkGw5hJNuPW"),
};
const haveTwins = Object.keys(ANCHOR_IDS).every((n) => existsSync(`${ANCHOR_DIR}anchor_${n}.so`));

class Rng {
  private s: bigint;
  constructor(seed: bigint) {
    this.s = (seed ^ 0x5851f42d4c957f2dn) & 0xffff_ffff_ffff_ffffn || 1n;
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

/** One side of the comparison. */
interface Side {
  name: "typesol" | "anchor";
  d: Deployed;
  /** Custom code each implementation uses for checked-arithmetic overflow. */
  overflowCode: number;
}

/**
 * Outcome classes that must agree. User errors (6000+) must match exactly; framework account
 * rejections may use different codes (TypeSOL 3xxx vs Anchor 2xxx/3xxx) but must both reject.
 */
function classify(res: TransactionMetadata | FailedTransactionMetadata, side: Side): string {
  if (!(res instanceof FailedTransactionMetadata)) return "ok";
  const text = String(res.err());
  const m = /Custom\D*(\d+)/.exec(text);
  if (!m) return `runtime:${text.replace(/\{.*index: \d+, /, "{")}`;
  const n = Number(m[1]);
  const fromProgram = res
    .meta()
    .logs()
    .some((l) => l.includes("Program Tokenkeg") && l.includes("failed"));
  if (fromProgram && n < 100) return `token:${n}`;
  if (n === side.overflowCode || n === 5100) return "overflow";
  if (n >= 6000) return `user:${n}`;
  return "rejected";
}

const cu = new Map<string, { typesol: bigint[]; anchor: bigint[] }>();
function recordCu(label: string, side: Side, res: TransactionMetadata | FailedTransactionMetadata) {
  if (res instanceof FailedTransactionMetadata) return;
  const e = cu.get(label) ?? { typesol: [], anchor: [] };
  e[side.name].push(res.computeUnitsConsumed());
  cu.set(label, e);
}

async function twin(name: keyof typeof ANCHOR_IDS): Promise<[Side, Side]> {
  const ts = await deployExample(name);
  const svm = new LiteSVM();
  svm.addProgramFromFile(ANCHOR_IDS[name], `${ANCHOR_DIR}anchor_${name}.so`);
  // Same ABI: TypeSOL's IDL coder encodes instructions and decodes accounts for the Anchor twin too.
  const anchor: Deployed = { svm, programId: ANCHOR_IDS[name], coder: ts.coder, idl: ts.idl };
  const anchorOverflow = { counter: 6002, vault: 6003, escrow: -1 }[name];
  return [
    { name: "typesol", d: ts, overflowCode: 5100 },
    { name: "anchor", d: anchor, overflowCode: anchorOverflow },
  ];
}

async function sameWallets(sides: Side[], n: number, sol: bigint): Promise<KeyPairSigner[]> {
  const ws = await Promise.all(Array.from({ length: n }, () => generateKeyPairSigner()));
  for (const s of sides) for (const w of ws) s.d.svm.airdrop(w.address, lamports(sol * 1_000_000_000n));
  return ws;
}

/** Decoded account with `bump` dropped (bumps differ because the program ids differ). */
function state(side: Side, name: string, addr: Address): unknown {
  const a = side.d.svm.getAccount(addr);
  if (!a.exists) return null;
  const decoded = side.d.coder.accounts.decode(name, Buffer.from(a.data)) as Record<string, unknown>;
  const { bump: _bump, ...rest } = decoded;
  return JSON.parse(JSON.stringify(rest, (_, v) => (v && typeof v === "object" && "toBase58" in v ? (v as { toBase58(): string }).toBase58() : v)));
}

describe.skipIf(!haveTwins)(`differential vs Anchor twins (seed ${SEED}, ${STEPS} steps)`, () => {
  afterAll(() => {
    const sizes = Object.keys(ANCHOR_IDS).map((n) => {
      const a = statSync(`${ANCHOR_DIR}anchor_${n}.so`).size;
      return `${n}: anchor ${a} B`;
    });
    const rows = [...cu.entries()].map(([label, e]) => {
      const avg = (xs: bigint[]) => (xs.length ? Number(xs.reduce((s, x) => s + x, 0n) / BigInt(xs.length)) : NaN);
      const t = avg(e.typesol);
      const a = avg(e.anchor);
      return `  ${label.padEnd(22)} typesol ${String(t).padStart(6)} CU   anchor ${String(a).padStart(6)} CU   (${((t / a) * 100).toFixed(0)}%)`;
    });
    if (process.env.FUZZ_VERBOSE) console.log(`compute units (mean over successful calls)\n${rows.join("\n")}\n${sizes.join("\n")}`);
  });

  it("counter", async () => {
    const sides = await twin("counter");
    const rng = new Rng(SEED);
    const users = await sameWallets(sides, 3, 10n);
    for (let step = 0; step < STEPS; step++) {
      const actor = users[rng.int(3)];
      const target = users[rng.int(3)];
      const action = rng.pick(["initialize", "increment", "increment", "increment", "assert_at_least"] as const);
      const by = rng.pick([0n, 1n, 7n, BigInt(rng.int(1_000_000)), 2n ** 64n - 1n, 2n ** 63n]);
      const outcomes: string[] = [];
      for (const side of sides) {
        const [ctr] = await pda(side.d.programId, ["counter", target.address]);
        const ixn =
          action === "initialize"
            ? ix(side.d, "initialize", {}, [
                { address: actor.address, signer: actor, writable: true },
                { address: (await pda(side.d.programId, ["counter", actor.address]))[0], writable: true },
                { address: SYSTEM_PROGRAM },
              ])
            : action === "increment"
              ? ix(side.d, "increment", { by: new BN(by.toString()) }, [
                  { address: actor.address, signer: actor },
                  { address: ctr, writable: true },
                ])
              : ix(side.d, "assert_at_least", { min: new BN(by.toString()) }, [{ address: ctr }]);
        const res = await send(side.d.svm, actor, [ixn]);
        recordCu(`counter.${action}`, side, res);
        outcomes.push(classify(res, side));
      }
      expect(outcomes[0], `step ${step} ${action}: typesol vs anchor`).toBe(outcomes[1]);
      for (const u of users) {
        const st = await Promise.all(sides.map(async (s) => state(s, "Counter", (await pda(s.d.programId, ["counter", u.address]))[0])));
        expect(st[0], `counter state after step ${step}`).toEqual(st[1]);
        expect(sides[0].d.svm.getBalance(u.address), `wallet balance after step ${step}`).toBe(sides[1].d.svm.getBalance(u.address));
      }
    }
  });

  it("vault", async () => {
    const sides = await twin("vault");
    const rng = new Rng(SEED + 1n);
    const users = await sameWallets(sides, 3, 50n);
    for (let step = 0; step < STEPS; step++) {
      const actor = users[rng.int(3)];
      const target = rng.next() % 4n === 0n ? users[rng.int(3)] : actor;
      const action = rng.pick(["open", "deposit", "deposit", "withdraw", "withdraw", "shut"] as const);
      const amount = rng.pick([0n, 1n, 1_000n, 10_000_000n, BigInt(rng.int(3_000_000_000)), 2n ** 64n - 1n]);
      const outcomes: string[] = [];
      for (const side of sides) {
        const [v] = await pda(side.d.programId, ["vault", target.address]);
        const [own] = await pda(side.d.programId, ["vault", actor.address]);
        const me = { address: actor.address, signer: actor, writable: true };
        const ixn =
          action === "open"
            ? ix(side.d, "open", {}, [me, { address: own, writable: true }, { address: SYSTEM_PROGRAM }])
            : action === "deposit"
              ? ix(side.d, "deposit", { amount: new BN(amount.toString()) }, [me, { address: v, writable: true }, { address: SYSTEM_PROGRAM }])
              : action === "withdraw"
                ? ix(side.d, "withdraw", { amount: new BN(amount.toString()) }, [me, { address: v, writable: true }])
                : ix(side.d, "shut", {}, [me, { address: v, writable: true }]);
        const res = await send(side.d.svm, actor, [ixn]);
        recordCu(`vault.${action}`, side, res);
        outcomes.push(classify(res, side));
      }
      // Depositing more SOL than the wallet holds fails inside the System Program on both sides.
      expect(outcomes[0], `step ${step} ${action} amount ${amount}`).toBe(outcomes[1]);
      for (const u of users) {
        const vs = await Promise.all(sides.map(async (s) => (await pda(s.d.programId, ["vault", u.address]))[0]));
        expect(state(sides[0], "Vault", vs[0]), `vault state after step ${step}`).toEqual(state(sides[1], "Vault", vs[1]));
        expect(sides[0].d.svm.getBalance(vs[0]) ?? 0n, `vault lamports after step ${step}`).toBe(sides[1].d.svm.getBalance(vs[1]) ?? 0n);
        expect(sides[0].d.svm.getBalance(u.address), `wallet after step ${step}`).toBe(sides[1].d.svm.getBalance(u.address));
      }
    }
  });

  it("escrow", async () => {
    const sides = await twin("escrow");
    const rng = new Rng(SEED + 2n);
    const RENT = lamports(10_000_000n);
    const people = await sameWallets(sides, 4, 100n);
    // Same token account addresses on both sides; only the vault owner (the offer PDA) differs.
    const put = (side: Side, addr: Address, mint: Address, owner: Address, amount: bigint) => {
      const data = getTokenEncoder().encode({
        mint,
        owner,
        amount,
        delegate: none(),
        state: AccountState.Initialized,
        isNative: none(),
        delegatedAmount: 0n,
        closeAuthority: none(),
      });
      side.d.svm.setAccount({
        address: addr,
        data: new Uint8Array(data),
        executable: false,
        lamports: RENT,
        programAddress: TOKEN_PROGRAM,
        space: BigInt(getTokenSize()),
      });
    };
    const mints = [(await generateKeyPairSigner()).address, (await generateKeyPairSigner()).address];
    for (const side of sides)
      for (const m of mints) {
        const data = getMintEncoder().encode({ mintAuthority: none(), supply: 10n ** 9n, decimals: 0, isInitialized: true, freezeAuthority: none() });
        side.d.svm.setAccount({
          address: m,
          data: new Uint8Array(data),
          executable: false,
          lamports: RENT,
          programAddress: TOKEN_PROGRAM,
          space: BigInt(getMintSize()),
        });
      }
    const tokens: { a: Address; b: Address }[] = [];
    for (const p of people) {
      const t = { a: (await generateKeyPairSigner()).address, b: (await generateKeyPairSigner()).address };
      for (const side of sides) {
        put(side, t.a, mints[0], p.address, 100_000n);
        put(side, t.b, mints[1], p.address, 100_000n);
      }
      tokens.push(t);
    }
    const bal = (side: Side, a: Address) => {
      const acct = side.d.svm.getAccount(a);
      return acct.exists ? getTokenDecoder().decode(acct.data).amount : null;
    };
    type Offer = { maker: number; seed: bigint; vault: Address; open: boolean };
    const offers: Offer[] = [];
    let nextSeed = 1n;
    const offerPda = async (side: Side, o: Offer) =>
      (await pda(side.d.programId, ["offer", people[o.maker].address, new Uint8Array(getU64Encoder().encode(o.seed))]))[0];

    for (let step = 0; step < STEPS; step++) {
      const openOffers = offers.filter((o) => o.open);
      const action = openOffers.length ? rng.pick(["make", "take", "take", "refund", "hostile"] as const) : "make";
      const outcomes: string[] = [];
      if (action === "make") {
        const m = rng.int(4);
        const o: Offer = { maker: m, seed: nextSeed++, vault: (await generateKeyPairSigner()).address, open: false };
        const amountA = rng.pick([0n, 1n, BigInt(rng.int(5000)), 200_000n]);
        const wantB = rng.pick([0n, 1n, BigInt(rng.int(5000))]);
        for (const side of sides) {
          const op = await offerPda(side, o);
          put(side, o.vault, mints[0], op, 0n);
          const res = await send(side.d.svm, people[m], [
            ix(
              side.d,
              "make",
              {
                seed: new BN(o.seed.toString()),
                amount_a: new BN(amountA.toString()),
                want_b: new BN(wantB.toString()),
                mint_b: { toBuffer: () => Buffer.from(getAddressEncoder().encode(mints[1])) },
              },
              [
                { address: people[m].address, signer: people[m], writable: true },
                { address: op, writable: true },
                { address: tokens[m].a, writable: true },
                { address: o.vault, writable: true },
                { address: SYSTEM_PROGRAM },
                { address: TOKEN_PROGRAM },
              ],
            ),
          ]);
          recordCu("escrow.make", side, res);
          outcomes.push(classify(res, side));
        }
        if (outcomes[0] === "ok") o.open = true;
        offers.push(o);
      } else {
        const o = rng.pick(openOffers);
        const t = rng.pick([0, 1, 2, 3].filter((i) => i !== o.maker));
        const third = [0, 1, 2, 3].find((i) => i !== o.maker && i !== t)!;
        const hostile = action === "hostile" ? rng.pick(["fakeMaker", "wrongVault"] as const) : undefined;
        for (const side of sides) {
          const op = await offerPda(side, o);
          const res =
            action === "refund"
              ? await send(side.d.svm, people[o.maker], [
                  ix(side.d, "refund", {}, [
                    { address: people[o.maker].address, signer: people[o.maker], writable: true },
                    { address: op, writable: true },
                    { address: tokens[o.maker].a, writable: true },
                    { address: o.vault, writable: true },
                    { address: TOKEN_PROGRAM },
                  ]),
                ])
              : await send(side.d.svm, people[t], [
                  ix(side.d, "take", {}, [
                    { address: people[t].address, signer: people[t], writable: true },
                    { address: hostile === "fakeMaker" ? people[third].address : people[o.maker].address, writable: true },
                    { address: op, writable: true },
                    { address: tokens[t].a, writable: true },
                    { address: tokens[t].b, writable: true },
                    { address: tokens[o.maker].b, writable: true },
                    { address: hostile === "wrongVault" ? tokens[third].a : o.vault, writable: true },
                    { address: TOKEN_PROGRAM },
                  ]),
                ]);
          recordCu(`escrow.${action === "hostile" ? "take(hostile)" : action}`, side, res);
          outcomes.push(classify(res, side));
        }
        if (outcomes[0] === "ok") o.open = false;
      }
      expect(outcomes[0], `step ${step} ${action}: typesol vs anchor`).toBe(outcomes[1]);
      for (const tk of tokens) {
        expect(bal(sides[0], tk.a), `token A after step ${step}`).toBe(bal(sides[1], tk.a));
        expect(bal(sides[0], tk.b), `token B after step ${step}`).toBe(bal(sides[1], tk.b));
      }
      for (const o of offers) {
        const st = await Promise.all(sides.map(async (s) => state(s, "Offer", await offerPda(s, o))));
        expect(st[0], `offer ${o.seed} after step ${step}`).toEqual(st[1]);
        expect(bal(sides[0], o.vault), `vault ${o.seed} after step ${step}`).toBe(bal(sides[1], o.vault));
      }
      for (const p of people) expect(sides[0].d.svm.getBalance(p.address), `wallet after step ${step}`).toBe(sides[1].d.svm.getBalance(p.address));
    }
  });
});
