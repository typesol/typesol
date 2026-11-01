// showcase/mainnet/marginfi/i80f48.ts against the `fixed` crate (1.28.0), which Marginfi's I80F48 is. Ground truth is
// showcase/test/fixtures/marginfi/i80f48-vectors.json, written by the Rust program in showcase/test/fixtures/marginfi/i80f48-oracle
// (`cargo run --release -- 400 > …`, then the fields the file names). A BigInt model of the same rules must give
// every vector; then the port must give the model's answer on those vectors and on random ones. Reproduce a random
// run with FUZZ_SEED=<seed>; widen it with FUZZ_RUNS=<n>.
import { FailedTransactionMetadata, type TransactionMetadata } from "litesvm";
import type { KeyPairSigner } from "@solana/kit";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, deployFile, fundedSigner, ix, send, type Deployed } from "../../test/harness.js";

const SEED = BigInt(process.env.FUZZ_SEED ?? Date.now());
const RUNS = Number(process.env.FUZZ_RUNS ?? 300);
const MIN = -(1n << 127n);
const MAX = (1n << 127n) - 1n;
const ONE = 1n << 48n;
const MATH_ERROR = 6062;
const VECTORS = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/marginfi/i80f48-vectors.json", import.meta.url)), "utf8")) as {
  fields: string[];
  rows: (string | null)[][];
};

/** null: `fixed` returns None (the port fails with MathError). */
type Answer = string | null;
const fit = (v: bigint): Answer => (v >= MIN && v <= MAX ? String(v) : null);
const sat = (v: bigint) => String(v > MAX ? MAX : v < MIN ? MIN : v);
const floorDiv = (n: bigint, d: bigint) => (n % d !== 0n && n < 0n !== d < 0n ? n / d - 1n : n / d);
const f64Bits = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(Number(v) / 2 ** 48);
  return String(b.readBigUInt64LE());
};
const MODEL: Record<string, (a: bigint, b: bigint) => Answer> = {
  add: (a, b) => fit(a + b),
  sub: (a, b) => fit(a - b),
  mul: (a, b) => fit(floorDiv(a * b, ONE)),
  div: (a, b) => (b === 0n ? null : fit((a * ONE) / b)),
  sadd: (a, b) => sat(a + b),
  ssub: (a, b) => sat(a - b),
  smul: (a, b) => sat(floorDiv(a * b, ONE)),
  abs: (a) => fit(a < 0n ? -a : a),
  uabs: (a) => String(a < 0n ? -a : a),
  int: (a) => String(floorDiv(a, ONE) * ONE),
  frac: (a) => String(a - floorDiv(a, ONE) * ONE),
  ceil: (a) => fit(-floorDiv(-a, ONE) * ONE),
  round: (a) => {
    const f = a - floorDiv(a, ONE) * ONE;
    const up = f > ONE / 2n || (f === ONE / 2n && a > 0n);
    return fit(floorDiv(a, ONE) * ONE + (up ? ONE : 0n));
  },
  u64: (a) => {
    const n = floorDiv(a, ONE);
    return n >= 0n && n < 1n << 64n ? String(n) : null;
  },
  f64: (a) => f64Bits(a),
};
const OPS = ["add", "sub", "mul", "div", "sadd", "ssub", "smul", "abs", "uabs", "int", "frac", "ceil", "round", "u64", "f64"] as const;
/**
 * What the release build does where `fixed` only debug-asserts: `*`, `/`, `from_num` and `to_num` wrap to the width
 * (`/` by zero panics). The checked forms that return the error as a value (`tmul`, `tdiv`) answer as `mul`, `div`.
 */
const WRAPPING: Record<string, (a: bigint, b: bigint) => Answer> = {
  tmul: MODEL.mul!,
  wmul: (a, b) => String(BigInt.asIntN(128, floorDiv(a * b, ONE))),
  tdiv: MODEL.div!,
  wdiv: (a, b) => (b === 0n ? null : String(BigInt.asIntN(128, (a * ONE) / b))),
  fromi128: (a) => String(BigInt.asIntN(128, a * ONE)),
  toi64: (a) => String(BigInt.asIntN(64, floorDiv(a, ONE))),
  tou32: (a) => String(BigInt.asUintN(32, floorDiv(a, ONE))),
  tou64: (a) => String(BigInt.asUintN(64, floorDiv(a, ONE))),
};
const ALL = [...OPS, ...Object.keys(WRAPPING)];

describe("I80F48 against the fixed crate", () => {
  it("the model gives every oracle vector", () => {
    const at = (name: string) => VECTORS.fields.indexOf(name);
    for (const row of VECTORS.rows) {
      const [a, b] = [BigInt(row[at("a")]!), BigInt(row[at("b")]!)];
      for (const op of OPS) expect(MODEL[op]!(a, b), `${op}(${a}, ${b})`).toBe(row[at(op)]);
    }
  });

  let d: Deployed;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/i80f48-ops.ts", import.meta.url)));
    payer = await fundedSigner(d.svm, 100n);
  });
  async function onChain(op: number, a: bigint, b: bigint): Promise<Answer | "other"> {
    const res = await send(d.svm, payer, [ix(d, "run", { op, a: new BN(a.toString()), b: new BN(b.toString()) }, [])]);
    if (res instanceof FailedTransactionMetadata) return /Custom\D*(\d+)/.exec(String(res.err()))?.[1] === String(MATH_ERROR) ? null : "other";
    const data = Buffer.from((res as TransactionMetadata).returnData().data());
    const v = data.readBigInt64LE(8) * (1n << 64n) + data.readBigUInt64LE(0);
    const u = data.readBigUInt64LE(16);
    const name = ALL[op]!;
    if (name === "uabs") return String((u << 64n) | v);
    return name === "u64" || name === "f64" || name === "tou32" || name === "tou64" ? String(u) : String(v);
  }
  const check = async (a: bigint, b: bigint, ops = ALL.length) => {
    for (let op = 0; op < ops; op++) {
      const name = ALL[op]!;
      const want = (MODEL[name] ?? WRAPPING[name])!(a, b);
      expect(await onChain(op, a, b), `${name}(${a}, ${b}) (seed ${SEED})`).toBe(want);
    }
  };

  it("the port gives the oracle's answers", async () => {
    const at = (name: string) => VECTORS.fields.indexOf(name);
    for (const row of VECTORS.rows.slice(0, 120)) await check(BigInt(row[at("a")]!), BigInt(row[at("b")]!), OPS.length);
  });

  it(`the port gives the model's answers on random values (seed ${SEED})`, async () => {
    let x = (SEED ^ 0xbb67ae8584caa73bn) & 0xffff_ffff_ffff_ffffn || 1n;
    const next = () => {
      x ^= x >> 12n;
      x ^= (x << 25n) & 0xffff_ffff_ffff_ffffn;
      x ^= x >> 27n;
      return (x * 0x2545f4914f6cdd1dn) & 0xffff_ffff_ffff_ffffn;
    };
    const value = () => {
      const raw = BigInt.asIntN(128, (next() << 64n) | next());
      switch (Number(next() % 8n)) {
        case 0:
          return (BigInt.asIntN(16, next()) * ONE) / 4n; // halves and quarters: rounding ties
        case 1:
          return BigInt.asIntN(64, next()) % ONE; // fractions
        case 2:
          return Number(next() % 2n) ? MAX - (next() % 1000n) : MIN + (next() % 1000n);
        default:
          return raw >> (next() % 128n);
      }
    };
    for (let i = 0; i < RUNS / 15; i++) await check(value(), value());
    // Products around 2^175, where the checked product stops fitting and the wrapping one starts to wrap.
    for (let i = 0; i < RUNS / 30; i++) {
      const bits = 60n + (next() % 60n);
      const a = BigInt.asIntN(128, (1n << bits) + (next() % (1n << (bits - 1n)))) * (next() % 2n ? 1n : -1n);
      const b = BigInt.asIntN(128, (1n << (175n - bits)) + (next() % (1n << (174n - bits)))) * (next() % 2n ? 1n : -1n);
      await check(a, b);
    }
  });
});
