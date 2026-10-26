import { FailedTransactionMetadata, type TransactionMetadata } from "litesvm";
import type { KeyPairSigner } from "@solana/kit";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, deployFile, fundedSigner, ix, send, type Deployed } from "./harness.js";

/**
 * Differential fuzzing: every operator the compiler emits is executed on-chain (LiteSVM) and
 * compared against a BigInt reference model, including which inputs must abort and with which code.
 * Reproduce a failure with FUZZ_SEED=<seed>; widen with FUZZ_RUNS=<n>.
 */
const SEED = BigInt(process.env.FUZZ_SEED ?? Date.now());
const RUNS = Number(process.env.FUZZ_RUNS ?? 250);

const OVERFLOW = 5100;
const DIV_ZERO = 5101;
const CAST = 4102;

type Outcome = { ok: bigint } | { err: number };

class Rng {
  private s: bigint;
  constructor(seed: bigint) {
    this.s = (seed ^ 0x9e3779b97f4a7c15n) & 0xffff_ffff_ffff_ffffn || 1n;
  }
  next(): bigint {
    // xorshift64*
    let x = this.s;
    x ^= x >> 12n;
    x ^= (x << 25n) & 0xffff_ffff_ffff_ffffn;
    x ^= x >> 27n;
    this.s = x;
    return (x * 0x2545f4914f6cdd1dn) & 0xffff_ffff_ffff_ffffn;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Number(this.next() % BigInt(xs.length))];
  }
}

type Width = { bits: number; signed: boolean };
const range = (w: Width) =>
  w.signed ? { min: -(1n << BigInt(w.bits - 1)), max: (1n << BigInt(w.bits - 1)) - 1n } : { min: 0n, max: (1n << BigInt(w.bits)) - 1n };

/** Edge values (0, ±1, extremes, powers of two ± 1) half the time, uniform random otherwise. */
function sample(rng: Rng, w: Width): bigint {
  const { min, max } = range(w);
  if (rng.next() % 2n === 0n) {
    const edges = [0n, 1n, 2n, max, max - 1n, min, min + 1n, max / 2n, max / 2n + 1n];
    if (w.signed) edges.push(-1n, -2n);
    const p = BigInt(Number(rng.next() % BigInt(w.bits)));
    edges.push((1n << p) - 1n, 1n << p, (1n << p) + 1n);
    if (w.signed) edges.push(-(1n << p));
    const e = rng.pick(edges);
    return e < min || e > max ? 0n : e;
  }
  const span = max - min + 1n;
  return min + (((rng.next() << 64n) | rng.next()) % span);
}

function model(op: number, a: bigint, b: bigint, w: Width): Outcome {
  const { min, max } = range(w);
  const fit = (r: bigint): Outcome => (r < min || r > max ? { err: OVERFLOW } : { ok: r });
  switch (op) {
    case 0:
      return fit(a + b);
    case 1:
      return fit(a - b);
    case 2:
      return fit(a * b);
    case 3:
      return b === 0n ? { err: DIV_ZERO } : fit(a / b); // BigInt division truncates toward zero, like C
    case 4:
      return b === 0n ? { err: DIV_ZERO } : a === min && b === -1n && w.signed ? { err: OVERFLOW } : { ok: a % b };
    // Bitwise operators on two's complement values of the width.
    case 5:
      return { ok: BigInt.asIntN(w.bits, a & b) * (w.signed ? 1n : 0n) + BigInt.asUintN(w.bits, a & b) * (w.signed ? 0n : 1n) };
    case 6:
      return { ok: w.signed ? BigInt.asIntN(w.bits, a | b) : BigInt.asUintN(w.bits, a | b) };
    case 7:
      return { ok: w.signed ? BigInt.asIntN(w.bits, a ^ b) : BigInt.asUintN(w.bits, a ^ b) };
    case 8:
      // << is checked: the amount must be below the width and the (JS) result must fit.
      return b < 0n || b >= BigInt(w.bits) ? { err: OVERFLOW } : fit(a << b);
    case 9:
      return b < 0n || b >= BigInt(w.bits) ? { err: OVERFLOW } : { ok: a >> b };
    case 10:
      return { ok: w.signed ? -(a + 1n) : max - a };
    default:
      throw new Error("bad op");
  }
}

function outcome(res: TransactionMetadata | FailedTransactionMetadata, w: Width): Outcome {
  if (res instanceof FailedTransactionMetadata) {
    const m = /Custom\D*(\d+)/.exec(String(res.err()));
    if (!m) throw new Error(`unexpected failure: ${String(res.err())}\n${res.meta().logs().join("\n")}`);
    return { err: Number(m[1]) };
  }
  const data = Buffer.from(res.returnData().data());
  const bytes = w.bits / 8;
  if (data.length !== bytes) throw new Error(`return data has ${data.length} bytes, expected ${bytes}`);
  const raw = data.reduceRight((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
  return { ok: w.signed ? BigInt.asIntN(w.bits, raw) : raw };
}

const fmt = (o: Outcome) => ("ok" in o ? `ok ${o.ok}` : `error ${o.err}`);

describe(`differential arithmetic fuzzing (seed ${SEED}, ${RUNS} runs per case)`, () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/arith.ts", import.meta.url)));
    payer = await fundedSigner(d.svm, 1000n);
  });

  const cases: { name: string; w: Width; ops: number[] }[] = [
    { name: "op_u64", w: { bits: 64, signed: false }, ops: [0, 1, 2, 3, 4] },
    { name: "op_u32", w: { bits: 32, signed: false }, ops: [0, 1, 2, 3, 4] },
    { name: "op_u16", w: { bits: 16, signed: false }, ops: [0, 1, 2, 3, 4] },
    { name: "op_i64", w: { bits: 64, signed: true }, ops: [0, 1, 2, 3, 4] },
    { name: "op_u128", w: { bits: 128, signed: false }, ops: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    { name: "op_i128", w: { bits: 128, signed: true }, ops: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    { name: "op_i32", w: { bits: 32, signed: true }, ops: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    { name: "op_i16", w: { bits: 16, signed: true }, ops: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    { name: "op_i8", w: { bits: 8, signed: true }, ops: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    { name: "op_u8", w: { bits: 8, signed: false }, ops: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
  ];

  for (const c of cases) {
    it(`${c.name}: + - * / % match BigInt, overflow and division by zero abort`, async () => {
      const rng = new Rng(SEED + BigInt(c.name.length * 7919));
      const mismatches: string[] = [];
      const seen = { ok: 0, overflow: 0, divZero: 0 };
      for (let i = 0; i < RUNS; i++) {
        const op = rng.pick(c.ops);
        const a = sample(rng, c.w);
        let b = (op === 3 || op === 4) && rng.next() % 8n === 0n ? 0n : sample(rng, c.w);
        // Shift amounts: mostly in range, sometimes at or past the width.
        if (op === 8 || op === 9) b = rng.next() % 6n === 0n ? BigInt(c.w.bits) + (c.w.bits < 128 ? 0n : -1n) * 0n : rng.next() % BigInt(c.w.bits);
        if ((op === 8 || op === 9) && range(c.w).max < b) b = range(c.w).max;
        const res = await send(d.svm, payer, [ix(d, c.name, { op, a: new BN(a.toString()), b: new BN(b.toString()) }, [])]);
        const got = outcome(res, c.w);
        const want = model(op, a, b, c.w);
        if (fmt(got) !== fmt(want)) mismatches.push(`op=${op} a=${a} b=${b}: chain ${fmt(got)}, model ${fmt(want)}`);
        if ("ok" in got) seen.ok++;
        else if (got.err === OVERFLOW) seen.overflow++;
        else if (got.err === DIV_ZERO) seen.divZero++;
      }
      expect(mismatches.slice(0, 5)).toEqual([]);
      // The run must actually exercise success, overflow and division-by-zero paths.
      expect(seen.ok).toBeGreaterThan(RUNS / 5);
      expect(seen.overflow).toBeGreaterThan(0);
      expect(seen.divZero).toBeGreaterThan(0);
      if (process.env.FUZZ_VERBOSE) console.log(c.name, seen);
    });
  }

  it("shifts by an amount of another type", async () => {
    const r = outcome(await send(d.svm, payer, [ix(d, "shift_mixed", { a: new BN(0xff), by: 8 }, [])]), { bits: 64, signed: false });
    expect(fmt(r)).toBe("ok 255");
    const over = outcome(await send(d.svm, payer, [ix(d, "shift_mixed", { a: new BN("18446744073709551615"), by: 1 }, [])]), { bits: 64, signed: false });
    expect(fmt(over)).toBe(`error ${OVERFLOW}`);
  });

  it("mulDiv, mulDivCeil, isqrt, min and max match BigInt", async () => {
    const rng = new Rng(SEED + 41n);
    const w = { bits: 64, signed: false };
    const mismatches: string[] = [];
    const sqrt = (x: bigint) => {
      if (x < 2n) return x;
      let r = BigInt(Math.floor(Math.sqrt(Number(x))));
      while (r * r > x) r--;
      while ((r + 1n) * (r + 1n) <= x) r++;
      return r;
    };
    for (let i = 0; i < RUNS; i++) {
      const op = Number(rng.next() % 5n);
      const [a, b] = [sample(rng, w), sample(rng, w)];
      const c = rng.next() % 10n === 0n ? 0n : sample(rng, w);
      let want: Outcome;
      if (op <= 1) {
        if (c === 0n) want = { err: DIV_ZERO };
        else {
          const q = op === 0 ? (a * b) / c : (a * b + c - 1n) / c;
          want = q > range(w).max ? { err: OVERFLOW } : { ok: q };
        }
      } else want = { ok: op === 2 ? sqrt(a) : op === 3 ? (a < b ? a : b) : a > b ? a : b };
      const got = outcome(
        await send(d.svm, payer, [ix(d, "math_u64", { op, a: new BN(a.toString()), b: new BN(b.toString()), c: new BN(c.toString()) }, [])]),
        w,
      );
      if (fmt(got) !== fmt(want)) mismatches.push(`op=${op} a=${a} b=${b} c=${c}: chain ${fmt(got)}, model ${fmt(want)}`);
    }
    for (let i = 0; i < Math.min(RUNS, 60); i++) {
      const x = sample(rng, { bits: 128, signed: false });
      const got = outcome(await send(d.svm, payer, [ix(d, "isqrt128", { a: new BN(x.toString()) }, [])]), { bits: 128, signed: false });
      let r = sqrt(x);
      if (fmt(got) !== fmt({ ok: r })) mismatches.push(`isqrt128 ${x}: chain ${fmt(got)}, model ${r}`);
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
  });

  it("checked casts between all widths, and 128-bit literals and text", async () => {
    const rng = new Rng(SEED + 43n);
    const w = { bits: 128, signed: true };
    const targets: Width[] = [
      { bits: 8, signed: true },
      { bits: 16, signed: true },
      { bits: 32, signed: true },
      { bits: 64, signed: true },
      { bits: 64, signed: false },
      { bits: 128, signed: false },
      { bits: 8, signed: false },
    ];
    const mismatches: string[] = [];
    for (let i = 0; i < RUNS; i++) {
      const kind = Number(rng.next() % 7n);
      const t = range(targets[kind]);
      const x =
        rng.next() % 2n === 0n
          ? sample(rng, w)
          : rng.pick([t.min, t.max, t.min - 1n, t.max + 1n, 0n, -1n].filter((v) => v >= range(w).min && v <= range(w).max));
      const got = outcome(await send(d.svm, payer, [ix(d, "cast_wide", { kind, x: new BN(x.toString()) }, [])]), w);
      const want: Outcome = x < t.min || x > t.max ? { err: CAST } : { ok: x };
      if (fmt(got) !== fmt(want)) mismatches.push(`kind=${kind} x=${x}: chain ${fmt(got)}, model ${fmt(want)}`);
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
    const text = outcome(await send(d.svm, payer, [ix(d, "big_text", {}, [])]), { bits: 64, signed: false });
    expect(fmt(text)).toBe("ok 80");
  });

  it("op_i64 negation: -min overflows, everything else matches", async () => {
    const rng = new Rng(SEED + 17n);
    const w = { bits: 64, signed: true };
    for (let i = 0; i < Math.min(RUNS, 100); i++) {
      const a = i === 0 ? range(w).min : sample(rng, w);
      const got = outcome(await send(d.svm, payer, [ix(d, "op_i64", { op: 9, a: new BN(a.toString()), b: new BN(0) }, [])]), w);
      expect(fmt(got)).toBe(fmt(a === range(w).min ? { err: OVERFLOW } : { ok: -a }));
    }
  });

  it("comparisons: <, ===, > and >= agree with BigInt", async () => {
    const rng = new Rng(SEED + 23n);
    const w = { bits: 64, signed: false };
    for (let i = 0; i < Math.min(RUNS, 150); i++) {
      const a = sample(rng, w);
      const b = rng.next() % 4n === 0n ? a : sample(rng, w);
      const cmp = outcome(await send(d.svm, payer, [ix(d, "op_u64", { op: 5, a: new BN(a.toString()), b: new BN(b.toString()) }, [])]), w);
      expect(fmt(cmp)).toBe(fmt({ ok: a < b ? 1n : a === b ? 2n : 3n }));
      const ge = outcome(await send(d.svm, payer, [ix(d, "op_u64", { op: 6, a: new BN(a.toString()), b: new BN(b.toString()) }, [])]), w);
      expect(fmt(ge)).toBe(fmt({ ok: a >= b ? 1n : 0n }));
    }
  });

  it("checked casts accept exactly the values that fit", async () => {
    const rng = new Rng(SEED + 31n);
    const i64w = { bits: 64, signed: true };
    const targets = [8, 16, 32, 64];
    const mismatches: string[] = [];
    for (let i = 0; i < RUNS; i++) {
      const kind = Number(rng.next() % 4n);
      const bits = targets[kind];
      // Bias toward the boundary of the target width.
      const x = rng.next() % 2n === 0n ? sample(rng, i64w) : rng.pick([-1n, 0n, (1n << BigInt(bits)) - 1n, 1n << BigInt(bits), 255n, 256n]);
      if (x > range(i64w).max) continue;
      const res = outcome(await send(d.svm, payer, [ix(d, "cast_i64", { kind, x: new BN(x.toString()) }, [])]), { bits: 64, signed: false });
      const fits = x >= 0n && x <= (1n << BigInt(bits)) - 1n;
      const want: Outcome = fits ? { ok: x } : { err: CAST };
      if (fmt(res) !== fmt(want)) mismatches.push(`kind=${kind} x=${x}: chain ${fmt(res)}, model ${fmt(want)}`);
    }
    for (let i = 0; i < Math.min(RUNS, 100); i++) {
      const x = sample(rng, { bits: 64, signed: false });
      const res = outcome(await send(d.svm, payer, [ix(d, "cast_u64", { x: new BN(x.toString()) }, [])]), i64w);
      const want: Outcome = x <= range(i64w).max ? { ok: x } : { err: CAST };
      if (fmt(res) !== fmt(want)) mismatches.push(`cast_u64 x=${x}: chain ${fmt(res)}, model ${fmt(want)}`);
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
  });
});
