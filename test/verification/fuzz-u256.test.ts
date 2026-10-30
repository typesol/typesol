// Differential fuzzing of u256 against BigInt: every operator, mulDiv / mulDivCeil with their 512-bit intermediate,
// comparisons and the checked narrowing casts, executed on-chain and compared, failures included (5100 overflow,
// 5101 division by zero, 4102 cast). Reproduce with FUZZ_SEED=<seed>; widen with FUZZ_RUNS=<n>.
import { FailedTransactionMetadata, type TransactionMetadata } from "litesvm";
import type { KeyPairSigner } from "@solana/kit";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, compileErrors, deployFile, fundedSigner, ix, send, type Deployed } from "../harness.js";

const SEED = BigInt(process.env.FUZZ_SEED ?? Date.now());
const RUNS = Number(process.env.FUZZ_RUNS ?? 300);
const MAX = 2n ** 256n - 1n;
const M128 = 2n ** 128n - 1n;

const SOURCE = `import { type u8, mulDiv, mulDivCeil, u128, u256, u64 } from "typesol";
export interface Pair { hi: u128; lo: u128 }
function make(hi: u128, lo: u128): u256 {
  return (u256(hi) << 128n) | u256(lo);
}
function split(x: u256): Pair {
  return { hi: u128(x >> 128n), lo: u128(x & u256(${M128}n)) };
}
export function run(op: u8, ah: u128, al: u128, bh: u128, bl: u128, ch: u128, cl: u128, s: u8): Pair {
  const a = make(ah, al);
  const b = make(bh, bl);
  const c = make(ch, cl);
  let r: u256 = 0n;
  if (op === 0n) r = a + b;
  else if (op === 1n) r = a - b;
  else if (op === 2n) r = a * b;
  else if (op === 3n) r = a / b;
  else if (op === 4n) r = a % b;
  else if (op === 5n) r = a & b;
  else if (op === 6n) r = a | b;
  else if (op === 7n) r = a ^ b;
  else if (op === 8n) r = a << s;
  else if (op === 9n) r = a >> s;
  else if (op === 10n) r = mulDiv(a, b, c);
  else if (op === 11n) r = mulDivCeil(a, b, c);
  else if (op === 12n) r = a < b ? 1n : a === b ? 2n : 3n;
  else if (op === 13n) r = u256(u128(a));
  else if (op === 14n) r = u256(u64(a));
  else if (op === 15n) {
    let x = a;
    x += b;
    x -= 1n;
    r = x;
  }
  return split(r);
}
`;

type Outcome = { ok: bigint } | { err: number };

function model(op: number, a: bigint, b: bigint, c: bigint, s: number): Outcome {
  const fit = (v: bigint): Outcome => (v > MAX || v < 0n ? { err: 5100 } : { ok: v });
  switch (op) {
    case 0:
      return fit(a + b);
    case 1:
      return fit(a - b);
    case 2:
      return fit(a * b);
    case 3:
      return b === 0n ? { err: 5101 } : { ok: a / b };
    case 4:
      return b === 0n ? { err: 5101 } : { ok: a % b };
    case 5:
      return { ok: a & b };
    case 6:
      return { ok: a | b };
    case 7:
      return { ok: a ^ b };
    case 8:
      return fit(a << BigInt(s));
    case 9:
      return { ok: a >> BigInt(s) };
    case 10:
    case 11: {
      if (c === 0n) return { err: 5101 };
      const p = a * b;
      const q = p / c + (op === 11 && p % c !== 0n ? 1n : 0n);
      return fit(q);
    }
    case 12:
      return { ok: a < b ? 1n : a === b ? 2n : 3n };
    case 13:
      return a > M128 ? { err: 4102 } : { ok: a };
    case 14:
      return a > 2n ** 64n - 1n ? { err: 4102 } : { ok: a };
    case 15:
      return a + b > MAX ? { err: 5100 } : a + b === 0n ? { err: 5100 } : { ok: a + b - 1n };
  }
  throw new Error(`op ${op}`);
}

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
}

/** Edge values (0, 1, extremes, powers of two ± 1, values near 2^64 and 2^128) half the time, else random widths. */
function sample(rng: Rng): bigint {
  if (rng.next() % 2n === 0n) {
    const p = BigInt(Number(rng.next() % 256n));
    const edges = [0n, 1n, 2n, MAX, MAX - 1n, M128, M128 + 1n, 2n ** 64n - 1n, 2n ** 64n, (1n << p) - 1n, 1n << p, (1n << p) + 1n];
    return edges[Number(rng.next() % BigInt(edges.length))]!;
  }
  const words = 1 + Number(rng.next() % 4n);
  let v = 0n;
  for (let i = 0; i < words; i++) v = (v << 64n) | rng.next();
  return v;
}

describe("u256 against BigInt", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-u256-"));
    writeFileSync(path.join(dir, "u256.ts"), SOURCE);
    d = await deployFile(path.join(dir, "u256.ts"));
    payer = await fundedSigner(d.svm, 100n);
  });

  async function onChain(op: number, a: bigint, b: bigint, c: bigint, s: number): Promise<Outcome> {
    const n = (v: bigint) => new BN(v.toString());
    const res = await send(d.svm, payer, [
      ix(d, "run", { op, ah: n(a >> 128n), al: n(a & M128), bh: n(b >> 128n), bl: n(b & M128), ch: n(c >> 128n), cl: n(c & M128), s }, []),
    ]);
    if (res instanceof FailedTransactionMetadata) {
      const m = /Custom\D*(\d+)/.exec(String(res.err()));
      return { err: m ? Number(m[1]) : -1 };
    }
    const data = Buffer.from((res as TransactionMetadata).returnData().data());
    const word = (at: number) => data.readBigUInt64LE(at) | (data.readBigUInt64LE(at + 8) << 64n);
    return { ok: (word(0) << 128n) | word(16) };
  }

  it(`matches BigInt on ${RUNS} random cases per operator (seed ${SEED})`, async () => {
    const rng = new Rng(SEED);
    for (let op = 0; op <= 15; op++) {
      for (let i = 0; i < RUNS / 8; i++) {
        let [a, b, c] = [sample(rng), sample(rng), sample(rng)];
        // Products that do not overflow, so mulDiv and * are exercised past the overflow checks too.
        if ((op === 2 || op === 10 || op === 11) && rng.next() % 2n === 0n) [a, b] = [a >> 128n, b >> 128n];
        const s = Number(rng.next() % 256n);
        const want = model(op, a, b, c, s);
        const got = await onChain(op, a, b, c, s);
        expect(got, `op ${op} a=${a} b=${b} c=${c} s=${s} (seed ${SEED})`).toEqual(want);
      }
    }
  });

  it("keeps u256 out of storage, arguments and CPI data", () => {
    expect(compileErrors(`import { type u256 } from "typesol";\nexport interface S { v: u256 }\nexport function f(): void {}`)).toMatch(
      /u256 is for computation/,
    );
    expect(compileErrors(`import { type u256 } from "typesol";\nexport function f(v: u256): void {}`)).toMatch(/u256 is for computation/);
    expect(compileErrors(`import { type u256 } from "typesol";\nexport function f(): u256 { return 1n; }`)).toMatch(/u256 is for computation|return/);
  });
});
