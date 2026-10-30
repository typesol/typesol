// The Raydium CLMM port's math (examples/raydium-clmm/math.ts) on-chain, against:
//  - the vectors of the original's unit tests (tick_math: the min/max ticks and prices, the ±28861 boundaries);
//  - properties: tick ↔ sqrt price round trips, monotonicity, and 2^64·√1.0001^tick to 1e-9;
//  - a BigInt model written from the original Rust (libraries/*.rs @ 6d7a0f8), outcomes and error codes alike.
// Reproduce a failure with FUZZ_SEED=<seed>; widen with FUZZ_RUNS=<n>.
import { FailedTransactionMetadata, type TransactionMetadata } from "litesvm";
import type { KeyPairSigner } from "@solana/kit";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, deployFile, fundedSigner, ix, send, type Deployed } from "../harness.js";

const SEED = BigInt(process.env.FUZZ_SEED ?? Date.now());
const RUNS = Number(process.env.FUZZ_RUNS ?? 200);

const Q64 = 2n ** 64n;
const U64_MAX = 2n ** 64n - 1n;
const U128_MAX = 2n ** 128n - 1n;
const U256_MAX = 2n ** 256n - 1n;
const MIN_TICK = -443636;
const MAX_TICK = 443636;
const MIN_SQRT = 4295048016n;
const MAX_SQRT = 79226673521066979257578248091n;
const FEE_DEN = 1_000_000n;

// ErrorCode members in order: 6000 + index.
const names = [...readFileSync(fileURLToPath(new URL("../../examples/raydium-clmm/errors.ts", import.meta.url)), "utf8").matchAll(/^ {2}(\w+) = /gm)].map((m) => m[1]!);
const E = Object.fromEntries(names.map((n, i) => [n, 6000 + i])) as Record<string, number>;
const REQUIRE_GTE = 2506;

class Fail extends Error {
  constructor(readonly code: number) {
    super(`error ${code}`);
  }
}
const need = (cond: boolean, code: number) => {
  if (!cond) throw new Fail(code);
};

// ---- the model, from the Rust ----
const FACTORS = [
  0xfff97272373d4000n, 0xfff2e50f5f657000n, 0xffe5caca7e10f000n, 0xffcb9843d60f7000n, 0xff973b41fa98e800n, 0xff2ea16466c9b000n,
  0xfe5dee046a9a3800n, 0xfcbe86c7900bb000n, 0xf987a7253ac65800n, 0xf3392b0822bb6000n, 0xe7159475a2caf000n, 0xd097f3bdfd2f2000n,
  0xa9f746462d9f8000n, 0x70d869a156f31c00n, 0x31be135f97ed3200n, 0x9aa508b5b85a500n, 0x5d6af8dedc582cn, 0x2216e584f5fan,
];
function sqrtAt(tick: number): bigint {
  need(tick >= MIN_TICK && tick <= MAX_TICK, E.TickUpperOverflow);
  const abs = BigInt(Math.abs(tick));
  let ratio = abs & 1n ? 0xfffcb933bd6fb800n : Q64;
  FACTORS.forEach((f, i) => {
    if (abs & (1n << BigInt(i + 1))) ratio = (ratio * f) >> 64n;
  });
  if (tick > 0) ratio = U128_MAX / ratio;
  return ratio;
}
function tickAt(p: bigint): number {
  need(p >= MIN_SQRT && p < MAX_SQRT, E.SqrtPriceX64);
  const msb = BigInt(p.toString(2).length - 1);
  const intX32 = (msb - 64n) << 32n;
  let bit = 0x8000_0000_0000_0000n;
  let fraction = 0n;
  let r = msb >= 64n ? p >> (msb - 63n) : p << (63n - msb);
  for (let i = 0; i < 16 && bit > 0n; i++) {
    r = r * r;
    const more = r >> 127n;
    r >>= 63n + more;
    fraction += bit * more;
    bit >>= 1n;
  }
  const log = (intX32 + (fraction >> 32n)) * 59543866431248n;
  const low = Number((log - 184467440737095516n) >> 64n);
  const high = Number((log + 15793534762490258745n) >> 64n);
  if (low === high) return low;
  return sqrtAt(high) <= p ? high : low;
}
const mulDiv = (a: bigint, b: bigint, c: bigint, ceil: boolean, max: bigint) => {
  need(c !== 0n, E.CalculateOverflow);
  const q = (a * b) / c + (ceil && (a * b) % c !== 0n ? 1n : 0n);
  need(q <= max, max === U256_MAX ? 5100 : E.CalculateOverflow);
  return q;
};
function next0(p: bigint, l: bigint, amount: bigint, add: boolean): bigint {
  if (amount === 0n) return p;
  const n1 = l << 64n;
  if (add) return mulDiv(n1, p, n1 + amount * p, true, U256_MAX) & U128_MAX;
  const product = amount * p;
  need(n1 >= product, E.CalculateOverflow);
  return mulDiv(n1, p, n1 - product, true, U256_MAX) & U128_MAX;
}
function next1(p: bigint, l: bigint, amount: bigint, add: boolean): bigint {
  if (amount === 0n) return p;
  const n = amount << 64n;
  if (add) {
    const q = n / l;
    need(p + q <= U128_MAX, E.CalculateOverflow);
    return p + q;
  }
  const q = n / l + (n % l ? 1n : 0n);
  need(p >= q, E.CalculateOverflow);
  return p - q;
}
function nextFromInput(p: bigint, l: bigint, amount: bigint, zeroForOne: boolean) {
  need(p >= MIN_SQRT && p < MAX_SQRT, E.SqrtPriceX64);
  need(l > 0n, E.ZeroLiquidity);
  return zeroForOne ? next0(p, l, amount, true) : next1(p, l, amount, true);
}
function nextFromOutput(p: bigint, l: bigint, amount: bigint, zeroForOne: boolean) {
  need(p >= MIN_SQRT && p < MAX_SQRT, E.SqrtPriceX64);
  need(l > 0n, E.ZeroLiquidity);
  return zeroForOne ? next1(p, l, amount, false) : next0(p, l, amount, false);
}
const order = (a: bigint, b: bigint) => (a > b ? [b, a] : [a, b]) as [bigint, bigint];
function delta0(x: bigint, y: bigint, l: bigint, up: boolean): bigint {
  const [a, b] = order(x, y);
  need(a > 0n, E.ZeroSqrtPrice);
  const r = mulDiv(l << 64n, b - a, a * b, up, U256_MAX);
  need(r <= U64_MAX, E.MaxTokenOverflow);
  return r;
}
function delta1(x: bigint, y: bigint, l: bigint, up: boolean): bigint {
  const [a, b] = order(x, y);
  const r = mulDiv(l, b - a, Q64, up, U256_MAX);
  need(r <= U64_MAX, E.MaxTokenOverflow);
  return r;
}
function swapAmounts(x: bigint, y: bigint, l: bigint, zeroForOne: boolean) {
  const [a, b] = order(x, y);
  need(a > 0n, E.ZeroSqrtPrice);
  const amount1X64 = l * (b - a);
  const product = a * b;
  const amountIn = zeroForOne ? mulDiv(amount1X64, Q64, product, true, U256_MAX) : (amount1X64 + U64_MAX) >> 64n;
  const amountOut = zeroForOne ? amount1X64 >> 64n : mulDiv(amount1X64, Q64, product, false, U256_MAX);
  if (amountIn > U64_MAX || amountOut > U64_MAX) return { fits: false, amountIn: 0n, amountOut: 0n };
  return { fits: true, amountIn, amountOut };
}
function liq0(x: bigint, y: bigint, amount: bigint) {
  if (amount === 0n) return 0n;
  const [a, b] = order(x, y);
  return mulDiv(amount, mulDiv(a, b, Q64, false, U128_MAX), b - a, false, U128_MAX);
}
function liq1(x: bigint, y: bigint, amount: bigint) {
  if (amount === 0n) return 0n;
  const [a, b] = order(x, y);
  return mulDiv(amount, Q64, b - a, false, U128_MAX);
}
function liquidity(p: bigint, x: bigint, y: bigint, a0: bigint, a1: bigint) {
  const [a, b] = order(x, y);
  if (p <= a) return liq0(a, b, a0);
  if (p < b) {
    const l0 = liq0(p, b, a0);
    const l1 = liq1(a, p, a1);
    return l0 < l1 ? l0 : l1;
  }
  return liq1(a, b, a1);
}
function step(cur: bigint, target: bigint, l: bigint, remaining: bigint, fee: bigint, baseInput: boolean, zeroForOne: boolean, feeOnInput: boolean) {
  need(fee <= FEE_DEN, 5100);
  const keep = FEE_DEN - fee;
  let forPrice = remaining;
  if (baseInput && feeOnInput) forPrice = mulDiv(remaining, keep, FEE_DEN, false, U64_MAX);
  if (!baseInput && !feeOnInput) forPrice = mulDiv(remaining, FEE_DEN, keep, true, U64_MAX);
  const at = swapAmounts(target, cur, l, zeroForOne);
  let next = target;
  let amountIn: bigint;
  let amountOut: bigint;
  if (at.fits && forPrice >= (baseInput ? at.amountIn : at.amountOut)) [amountIn, amountOut] = [at.amountIn, at.amountOut];
  else {
    next = baseInput ? nextFromInput(cur, l, forPrice, zeroForOne) : nextFromOutput(cur, l, forPrice, zeroForOne);
    const s = swapAmounts(next, cur, l, zeroForOne);
    need(s.fits, E.MaxTokenOverflow);
    [amountIn, amountOut] = [s.amountIn, s.amountOut];
  }
  need(zeroForOne ? next >= target : target >= next, REQUIRE_GTE);
  let feeAmount = 0n;
  if (baseInput) {
    if (feeOnInput) {
      if (next !== target) {
        need(remaining >= amountIn, E.CalculateOverflow);
        feeAmount = remaining - amountIn;
      } else feeAmount = mulDiv(amountIn, fee, keep, true, U64_MAX);
    } else {
      feeAmount = mulDiv(amountOut, fee, FEE_DEN, true, U64_MAX);
      need(amountOut >= feeAmount, E.CalculateOverflow);
      amountOut -= feeAmount;
      if (next !== target) amountIn = remaining;
    }
  } else if (feeOnInput) {
    amountOut = amountOut < remaining ? amountOut : remaining;
    feeAmount = mulDiv(amountIn, fee, keep, true, U64_MAX);
  } else {
    feeAmount = mulDiv(amountOut, fee, FEE_DEN, true, U64_MAX);
    need(amountOut >= feeAmount, E.CalculateOverflow);
    const net = amountOut - feeAmount;
    if (net > remaining) {
      feeAmount = amountOut - remaining;
      amountOut = remaining;
    } else amountOut = net;
  }
  return { sqrtPriceNextX64: next, amountIn, amountOut, feeAmount };
}

// ---- harness ----
type Outcome<T> = { ok: T } | { err: number };
const run = <T>(f: () => T): Outcome<T> => {
  try {
    return { ok: f() };
  } catch (e) {
    if (e instanceof Fail) return { err: e.code };
    throw e;
  }
};

class Rng {
  private s: bigint;
  constructor(seed: bigint) {
    this.s = (seed ^ 0x9e3779b97f4a7c15n) & 0xffff_ffff_ffff_ffffn || 1n;
  }
  next(): bigint {
    let x = this.s;
    x ^= x >> 12n;
    x ^= (x << 25n) & 0xffff_ffff_ffff_ffffn;
    x ^= x >> 27n;
    this.s = x;
    return (x * 0x2545f4914f6cdd1dn) & 0xffff_ffff_ffff_ffffn;
  }
  below(n: bigint) {
    return ((this.next() << 64n) | this.next()) % n;
  }
  tick() {
    return Number(this.below(BigInt(MAX_TICK - MIN_TICK + 1))) + MIN_TICK;
  }
  price() {
    return MIN_SQRT + this.below(MAX_SQRT - MIN_SQRT);
  }
  /** Liquidity and amounts across magnitudes (1 … 2^bits), as pools hold them. */
  amount(bits: number) {
    return this.below(1n << BigInt(1 + Number(this.next() % BigInt(bits))));
  }
}

describe("Raydium CLMM math (examples/raydium-clmm/math.ts)", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/clmm/math-probe.ts", import.meta.url)));
    payer = await fundedSigner(d.svm, 100n);
  });
  const n = (v: bigint | number) => new BN(v.toString());
  async function call(name: string, args: Record<string, unknown>): Promise<Outcome<Buffer>> {
    const res = await send(d.svm, payer, [ix(d, name, args, [])]);
    if (res instanceof FailedTransactionMetadata) {
      const m = /Custom\D*(\d+)/.exec(String(res.err()));
      return { err: m ? Number(m[1]) : -1 };
    }
    return { ok: Buffer.from((res as TransactionMetadata).returnData().data()) };
  }
  const u128 = (b: Buffer, at = 0) => b.readBigUInt64LE(at) | (b.readBigUInt64LE(at + 8) << 64n);
  const map = <T, U>(o: Outcome<T>, f: (t: T) => U): Outcome<U> => ("ok" in o ? { ok: f(o.ok) } : o);
  const sqrtOnChain = async (tick: number) => map(await call("sqrt_at", { tick }), (b) => u128(b));
  const tickOnChain = async (p: bigint) => map(await call("tick_at", { price: n(p) }), (b) => b.readInt32LE(0));

  it("matches the original's unit-test vectors", async () => {
    expect(await sqrtOnChain(MIN_TICK)).toEqual({ ok: MIN_SQRT });
    expect(await sqrtOnChain(MAX_TICK)).toEqual({ ok: MAX_SQRT });
    expect(await tickOnChain(MIN_SQRT)).toEqual({ ok: MIN_TICK });
    expect(await tickOnChain(MAX_SQRT - 1n)).toEqual({ ok: MAX_TICK - 1 });
    for (const t of [-28861, 28861]) {
      const p = (await sqrtOnChain(t)) as { ok: bigint };
      expect(await tickOnChain(p.ok)).toEqual({ ok: t });
      expect(await tickOnChain(p.ok + 1n)).toEqual({ ok: t });
      expect(await tickOnChain(p.ok - 1n)).toEqual({ ok: t - 1 });
      const above = (await sqrtOnChain(t + 1)) as { ok: bigint };
      expect(await tickOnChain(above.ok - 1n)).toEqual({ ok: t });
    }
    expect(await sqrtOnChain(MAX_TICK + 1)).toEqual({ err: E.TickUpperOverflow });
    expect(await tickOnChain(MAX_SQRT)).toEqual({ err: E.SqrtPriceX64 });
  });

  it(`ticks and sqrt prices: properties and the model (seed ${SEED})`, async () => {
    const rng = new Rng(SEED);
    for (let i = 0; i < RUNS; i++) {
      const t = rng.tick();
      const p = await sqrtOnChain(t);
      expect(p, `tick ${t}`).toEqual(run(() => sqrtAt(t)));
      const price = (p as { ok: bigint }).ok;
      // 2^64·1.0001^(t/2), to 1e-9 relative.
      const exact = Math.pow(1.0001, t / 2);
      expect(Math.abs(Number(price) / 2 ** 64 / exact - 1), `tick ${t}`).toBeLessThan(1e-9);
      if (t < MAX_TICK) expect(await tickOnChain(price), `round trip ${t}`).toEqual({ ok: t });
      const q = rng.price();
      expect(await tickOnChain(q), `price ${q}`).toEqual(run(() => tickAt(q)));
    }
  });

  it(`sqrt price steps, token deltas, liquidity and swap steps against the model (seed ${SEED})`, async () => {
    const rng = new Rng(SEED + 1n);
    for (let i = 0; i < RUNS; i++) {
      const [pa, pb, p] = [rng.price(), rng.price(), rng.price()];
      const l = rng.amount(128);
      const amount = rng.amount(64);
      const z = rng.next() % 2n === 0n;
      const up = rng.next() % 2n === 0n;
      const ctx = `seed ${SEED} i ${i} pa=${pa} pb=${pb} p=${p} l=${l} amount=${amount} z=${z} up=${up}`;

      expect(map(await call("next_from_input", { price: n(p), liquidity: n(l), amount: n(amount), zero_for_one: z }), (b) => u128(b)), ctx).toEqual(
        run(() => nextFromInput(p, l, amount, z)),
      );
      expect(map(await call("next_from_output", { price: n(p), liquidity: n(l), amount: n(amount), zero_for_one: z }), (b) => u128(b)), ctx).toEqual(
        run(() => nextFromOutput(p, l, amount, z)),
      );
      expect(map(await call("delta0", { a: n(pa), b: n(pb), liquidity: n(l), round_up: up }), (b) => b.readBigUInt64LE(0)), ctx).toEqual(
        run(() => delta0(pa, pb, l, up)),
      );
      expect(map(await call("delta1", { a: n(pa), b: n(pb), liquidity: n(l), round_up: up }), (b) => b.readBigUInt64LE(0)), ctx).toEqual(
        run(() => delta1(pa, pb, l, up)),
      );
      expect(
        map(await call("swap_amounts", { a: n(pa), b: n(pb), liquidity: n(l), zero_for_one: z }), (b) => ({
          fits: b[0] === 1,
          amountIn: b.readBigUInt64LE(1),
          amountOut: b.readBigUInt64LE(9),
        })),
        ctx,
      ).toEqual(run(() => swapAmounts(pa, pb, l, z)));
      const [a0, a1] = [rng.amount(64), rng.amount(64)];
      expect(map(await call("liquidity", { price: n(p), a: n(pa), b: n(pb), amount0: n(a0), amount1: n(a1) }), (b) => u128(b)), ctx).toEqual(
        run(() => liquidity(p, pa, pb, a0, a1)),
      );

      // A swap step from p towards a target on the right side of it.
      const target = z ? (pa < p ? pa : MIN_SQRT + rng.below(p - MIN_SQRT + 1n)) : pa > p ? pa : p + rng.below(MAX_SQRT - p);
      const fee = rng.next() % 4n === 0n ? 0n : rng.below(100_000n);
      const baseInput = rng.next() % 2n === 0n;
      const feeOnInput = rng.next() % 2n === 0n;
      expect(
        map(
          await call("step", {
            current: n(p),
            target: n(target),
            liquidity: n(l),
            remaining: n(amount),
            fee_rate: Number(fee),
            base_input: baseInput,
            zero_for_one: z,
            fee_on_input: feeOnInput,
          }),
          (b) => ({ sqrtPriceNextX64: u128(b), amountIn: b.readBigUInt64LE(16), amountOut: b.readBigUInt64LE(24), feeAmount: b.readBigUInt64LE(32) }),
        ),
        `${ctx} target=${target} fee=${fee} baseInput=${baseInput} feeOnInput=${feeOnInput}`,
      ).toEqual(run(() => step(p, target, l, amount, fee, baseInput, z, feeOnInput)));
    }
  });
});
