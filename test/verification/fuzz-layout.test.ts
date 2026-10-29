// Model-based fuzzing of account layout and aliasing, the two classes the October 2026 security review found:
// - an account with two growable Vecs: random pushes, pops, sets, in-place additions, moves between the Vecs and
//   clears, honest and out of range; after every step the decoded account must equal a plain TypeScript model, so a
//   write that lands in the other Vec's bytes is caught;
// - remaining accounts loaded with loadAccountMut: random index pairs and remaining-account lists that repeat an
//   account; any two views of one account must be refused (2040) and the total balance must be conserved.
// Every run prints its seed; reproduce with FUZZ_SEED=<n>, widen with FUZZ_STEPS.
import { getU64Encoder } from "@solana/kit";
import { FailedTransactionMetadata, type TransactionMetadata } from "litesvm";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, decodeAccount, deployFile, expectOk, fundedSigner, ix, pda, send } from "../harness.js";

const SEED = BigInt(process.env.FUZZ_SEED ?? Date.now());
const STEPS = Number(process.env.FUZZ_STEPS ?? 200);

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
  int(n: number): number {
    return Number(this.next() % BigInt(n));
  }
}

const code = (res: TransactionMetadata | FailedTransactionMetadata): number | "ok" | string => {
  if (!(res instanceof FailedTransactionMetadata)) return "ok";
  const m = /Custom\D*(\d+)/.exec(String(res.err()));
  return m ? Number(m[1]) : String(res.err());
};
const source = (name: string, text: string) => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "typesol-fuzz-layout-")), `${name}.ts`);
  writeFileSync(file, text);
  return file;
};

const BOOK = `import { type HasOne, type Init, type Mut, type Pubkey, type Seeds, type Signer, type SystemProgram, type Vec, type u8, type u64 } from "typesol";
export interface Entry { qty: u64; px: u64; }
export interface Book { owner: Pubkey; bump: u8; bids: Vec<Entry>; asks: Vec<Entry>; }

export function open(owner: Mut<Signer>, book: Init<Book>, systemProgram: SystemProgram): void {
  book.bump = book.create(owner, ["book", owner.key]);
  book.owner = owner.key;
}
export function push(owner: Mut<Signer>, book: Seeds<HasOne<Mut<Book>, "owner">, ["book", "@owner"], "bump">, systemProgram: SystemProgram, side: u8, qty: u64): void {
  if (side === 0n) book.bids.push({ qty, px: qty + 1n }, owner);
  else book.asks.push({ qty, px: qty + 1n }, owner);
}
export function pop(owner: Mut<Signer>, book: Seeds<HasOne<Mut<Book>, "owner">, ["book", "@owner"], "bump">, side: u8): void {
  if (side === 0n) book.bids.pop();
  else book.asks.pop();
}
export function set(owner: Mut<Signer>, book: Seeds<HasOne<Mut<Book>, "owner">, ["book", "@owner"], "bump">, side: u8, i: u64, qty: u64): void {
  if (side === 0n) book.bids.get(i).qty = qty;
  else book.asks.get(i).qty = qty;
}
export function add(owner: Mut<Signer>, book: Seeds<HasOne<Mut<Book>, "owner">, ["book", "@owner"], "bump">, side: u8, i: u64, v: u64): void {
  if (side === 0n) book.bids.get(i).px += v;
  else book.asks.get(i).px += v;
}
/** The last bid moves to the asks (through locals: the Vecs move under the element). Empty bids: length - 1 underflows (5100). */
export function cross(owner: Mut<Signer>, book: Seeds<HasOne<Mut<Book>, "owner">, ["book", "@owner"], "bump">, systemProgram: SystemProgram): void {
  const last = book.bids.get(book.bids.length - 1n);
  const qty = last.qty;
  const px = last.px;
  book.bids.pop();
  book.asks.push({ qty, px }, owner);
}
export function clear(owner: Mut<Signer>, book: Seeds<HasOne<Mut<Book>, "owner">, ["book", "@owner"], "bump">, side: u8): void {
  if (side === 0n) book.bids.clear();
  else book.asks.clear();
}
`;

const PURSE = `import { type Init, type Mut, type Signer, type SystemProgram, type u64, loadAccountMut, remainingAccounts } from "typesol";
export interface Purse { id: u64; balance: u64; }
export function open(payer: Mut<Signer>, purse: Init<Purse>, systemProgram: SystemProgram, id: u64): void {
  purse.create(payer, ["purse", id]);
  purse.id = id;
  purse.balance = 1000n;
}
/** Reads both balances, then writes both: two views of one account would create value. */
export function move(payer: Signer, i: u64, j: u64, amount: u64): void {
  const rest = remainingAccounts();
  const a = loadAccountMut<Purse>(rest.get(i));
  const b = loadAccountMut<Purse>(rest.get(j));
  const fa = a.balance;
  const fb = b.balance;
  a.balance = fa - amount;
  b.balance = fb + amount;
}
`;

describe(`layout and aliasing fuzzing (seed ${SEED}, ${STEPS} steps)`, () => {
  it("two growable Vecs: every step leaves the account equal to the model; hostile and out-of-range calls refused", async () => {
    const d = await deployFile(source("book", BOOK));
    const { svm } = d;
    const rng = new Rng(SEED);
    const owners = await Promise.all([0, 1].map(() => fundedSigner(svm, 50n)));
    const books = await Promise.all(owners.map(async (o) => (await pda(d.programId, ["book", o.address]))[0]));
    // One at a time: each send moves the blockhash on.
    for (const [k, o] of owners.entries())
      expectOk(
        await send(svm, o, [
          ix(d, "open", {}, [{ address: o.address, signer: o, writable: true }, { address: books[k]!, writable: true }, { address: SYSTEM_PROGRAM }]),
        ]),
      );
    type E = { qty: bigint; px: bigint };
    const model: [E[], E[]][] = [
      [[], []],
      [[], []],
    ];
    const stats: Record<string, number> = {};
    for (let step = 0; step < STEPS; step++) {
      const who = rng.int(2);
      // 10% of calls name the other owner's book: seeds + has_one must refuse them (2006).
      const target = rng.int(10) === 0 ? 1 - who : who;
      const o = owners[who]!;
      const accounts = (withSystem: boolean) => [
        { address: o.address, signer: o, writable: true },
        { address: books[target]!, writable: true },
        ...(withSystem ? [{ address: SYSTEM_PROGRAM }] : []),
      ];
      const m = model[target]!;
      const side = rng.int(2);
      const len = m[side]!.length;
      // Indices are sometimes one past the end (5104).
      const i = len && rng.int(4) ? rng.int(len) : len;
      const v = BigInt(1 + rng.int(1_000_000));
      const op = ["push", "push", "push", "pop", "set", "add", "cross", "clear"][rng.int(8)]!;
      let expect: number | "ok" = "ok";
      let apply = () => {};
      let res;
      if (op === "push") {
        res = await send(svm, o, [ix(d, "push", { side, qty: new BN(v.toString()) }, accounts(true))]);
        apply = () => m[side]!.push({ qty: v, px: v + 1n });
      } else if (op === "pop") {
        res = await send(svm, o, [ix(d, "pop", { side }, accounts(false))]);
        if (!len) expect = 5104;
        apply = () => void m[side]!.pop();
      } else if (op === "set") {
        res = await send(svm, o, [ix(d, "set", { side, i: new BN(i), qty: new BN(v.toString()) }, accounts(false))]);
        if (i >= len) expect = 5104;
        apply = () => void (m[side]![i]!.qty = v);
      } else if (op === "add") {
        res = await send(svm, o, [ix(d, "add", { side, i: new BN(i), v: new BN(v.toString()) }, accounts(false))]);
        if (i >= len) expect = 5104;
        apply = () => void (m[side]![i]!.px += v);
      } else if (op === "cross") {
        res = await send(svm, o, [ix(d, "cross", {}, accounts(true))]);
        if (!m[0]!.length) expect = 5100;
        apply = () => void m[1]!.push(m[0]!.pop()!);
      } else {
        res = await send(svm, o, [ix(d, "clear", { side }, accounts(false))]);
        apply = () => void (m[side]!.length = 0);
      }
      if (target !== who) expect = 2006;
      const got = code(res);
      if (got !== expect)
        throw new Error(`step ${step} (${op} side ${side} i ${i} by ${who} on ${target}): expected ${expect}, got ${got} (FUZZ_SEED=${SEED})`);
      if (got === "ok") apply();
      stats[`${op}:${got}`] = (stats[`${op}:${got}`] ?? 0) + 1;
      const onChain = decodeAccount<{ bids: { qty: BN; px: BN }[]; asks: { qty: BN; px: BN }[] }>(d, svm, "Book", books[target]!);
      const show = (es: { qty: BN | bigint; px: BN | bigint }[]) => es.map((e) => `${e.qty}/${e.px}`).join(",");
      expect_(`${show(onChain.bids)} | ${show(onChain.asks)}`, `${show(m[0]!)} | ${show(m[1]!)}`, step, op);
    }
    console.log("vec layout fuzz:", JSON.stringify(stats));
  });

  it("loadAccountMut: random index pairs and repeated accounts; aliasing refused (2040), balances conserved", async () => {
    const d = await deployFile(source("purse", PURSE));
    const { svm } = d;
    const rng = new Rng(SEED ^ 0x5bd1e995n);
    const payer = await fundedSigner(svm, 50n);
    const le64 = (n: bigint) => new Uint8Array(getU64Encoder().encode(n));
    const purses: Awaited<ReturnType<typeof pda>>[0][] = [];
    for (const id of [0n, 1n, 2n]) {
      const [p] = await pda(d.programId, ["purse", le64(id)]);
      expectOk(
        await send(svm, payer, [
          ix(d, "open", { id: new BN(id.toString()) }, [
            { address: payer.address, signer: payer, writable: true },
            { address: p, writable: true },
            { address: SYSTEM_PROGRAM },
          ]),
        ]),
      );
      purses.push(p);
    }
    const balance = [1000n, 1000n, 1000n];
    const stats: Record<string, number> = {};
    for (let step = 0; step < STEPS; step++) {
      // Half the time two or three distinct purses; otherwise 2–4 entries drawn freely, so repeats are common.
      const list = rng.int(2) ? [0, 1, 2].sort(() => rng.int(3) - 1).slice(0, 2 + rng.int(2)) : Array.from({ length: 2 + rng.int(3) }, () => rng.int(3));
      const i = rng.int(list.length);
      const j = rng.int(list.length);
      const amount = BigInt(rng.int(400));
      const res = await send(svm, payer, [
        ix(d, "move", { i: new BN(i), j: new BN(j), amount: new BN(amount.toString()) }, [
          { address: payer.address, signer: payer },
          ...list.map((k) => ({ address: purses[k]!, writable: true })),
        ]),
      ]);
      const [a, b] = [list[i]!, list[j]!];
      // Same slot, or a purse that appears more than once in the list (the loader shares its record): 2040.
      const aliased = i === j || list.filter((k) => k === a).length > 1 || list.filter((k) => k === b).length > 1;
      const expect: number | "ok" = aliased ? 2040 : balance[a]! < amount ? 5100 : "ok";
      const got = code(res);
      if (got !== expect) throw new Error(`step ${step} (list ${list} i ${i} j ${j} amount ${amount}): expected ${expect}, got ${got} (FUZZ_SEED=${SEED})`);
      if (got === "ok") {
        balance[a]! -= amount;
        balance[b]! += amount;
      }
      stats[String(got)] = (stats[String(got)] ?? 0) + 1;
      const onChain = purses.map((p) => BigInt(decodeAccount<{ balance: BN }>(d, svm, "Purse", p).balance.toString()));
      expect_(onChain.join(","), balance.join(","), step, "move");
    }
    expect(balance.reduce((x, y) => x + y)).toBe(3000n);
    console.log("aliasing fuzz:", JSON.stringify(stats));
  });
});

function expect_(got: string, want: string, step: number, op: string) {
  if (got !== want) throw new Error(`step ${step} (${op}): chain ${got} != model ${want} (FUZZ_SEED=${SEED})`);
}
