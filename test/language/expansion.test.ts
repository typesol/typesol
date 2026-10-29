// Helpers and closures expanded where they are called see what their own code means: their file's types, the module's
// constants (not the caller's arguments), their own parameters (not the caller's accounts), and no reference into a
// list that moved under them.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CompileError, generate } from "../../src/compiler/index.js";

function compile(files: Record<string, string>, entry = "main.ts"): { c: string; errors: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-expansion-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  try {
    const r = generate(path.join(dir, entry)) as unknown as { c: string };
    return { c: r.c, errors: "" };
  } catch (e) {
    if (e instanceof CompileError) return { c: "", errors: e.diagnostics.map((x) => x.message).join(" | ") };
    throw e;
  }
}

describe("expanded helpers and closures", () => {
  it("read the module's constant, not an instruction argument of the same name", () => {
    const { c, errors } = compile({
      "main.ts": `import { type u64 } from "typesol";
const fee = 5n;
function apply(x: u64, f: (v: u64) => u64): u64 { return f(x) + fee; }
function adder(n: u64): (x: u64) => u64 { return (x: u64): u64 => x + n + fee; }
export function a(fee: u64, amount: u64): u64 { let t = 0n; return apply(amount, (v) => { t += 1n; return v; }); }
export function b(fee: u64, amount: u64): u64 { const add = adder(1n); return add(amount); }`,
    });
    expect(errors).toBe("");
    expect(c).not.toMatch(/, arg_fee, &t/);
    expect(c.match(/5ULL/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("refuse a closure parameter named like an account it would hide", () => {
    const { errors } = compile({
      "main.ts": `import { type Account, type Vec, type u64 } from "typesol";
export interface Cfg { limit: u64; }
export function b(cfg: Account<Cfg>, x: u64, list: Vec<Cfg>): u64 { let t = 0n; list.forEach((cfg) => { t += cfg.limit; }); return t; }`,
    });
    expect(errors).toMatch(/"cfg" shadows the account "cfg"/);
  });

  it("resolve a helper's types with its own file's imports, from an arrow or when expanded", () => {
    const lib = `import { type u32 as Small, type u8, type u64 } from "typesol";
export function applyS(f: (x: Small) => Small, v: Small): Small { return f(v); }
export function applyT<T>(f: (x: T) => T, v: T): T { return f(v); }
export function wrap(x: u8, f: (v: u8) => void): void { f(x + 100n); }`;
    const main = `import { type Mut, type u32, type u64, u64 as toU64 } from "typesol";
import { applyS, applyT, wrap } from "./lib";
export interface A { n: u64; m: u32; }
export function run(acc: Mut<A>, x: u32, y: u64): void {
  acc.m = applyS((v) => v * 2n, x);
  acc.n = applyT<u64>((v) => v * 3n, y);
  let t = 0n;
  wrap(200n, (v) => { t += toU64(v); });
  acc.n += t;
}`;
    const { c, errors } = compile({ "lib.ts": lib, "main.ts": main });
    expect(errors).toBe("");
    // wrap's x is a u8 (its own file's type), so x + 100 is checked as u8 arithmetic.
    expect(c).toMatch(/uint8_t l_x_\d+ = /);
    const generic = compile({ "lib.ts": lib, "main.ts": main.replace("applyT<u64>(", "applyT(") });
    expect(generic.errors).toMatch(/write the types here: the parameter's type uses the helper's type parameter/);
  });

  it("refuse a struct parameter used after a Vec before it moved", () => {
    const head = `import { type Mut, type Signer, type SystemProgram, type Vec, type u64 } from "typesol";
export interface Entry { score: u64; }
export interface Bag { tags: Vec<u64>; entries: Vec<Entry>; marks: Vec<u64>; }
`;
    const moved = compile({
      "main.ts": `${head}export function f(payer: Mut<Signer>, bag: Mut<Bag>, s: SystemProgram): u64 { let t = 0n; bag.entries.forEach((e) => { bag.tags.push(7n, payer); t += e.score; }); return t; }`,
    });
    expect(moved.errors).toMatch(/"e" still refers to bag\.entries\[\]/);
    const helper = compile({
      "main.ts": `${head}function grow(bag: Mut<Bag>, e: Entry, payer: Mut<Signer>, f: (x: u64) => void): void { bag.tags.push(1n, payer); f(e.score); }
export function g(payer: Mut<Signer>, bag: Mut<Bag>, s: SystemProgram): u64 { let t = 0n; grow(bag, bag.entries.get(0n), payer, (x) => { t += x; }); return t; }`,
    });
    expect(helper.errors).toMatch(/"e" still refers to bag\.entries\[\]/);
    // Read before the move: fine.
    const before = compile({
      "main.ts": `${head}export function f(payer: Mut<Signer>, bag: Mut<Bag>, s: SystemProgram): u64 { let t = 0n; bag.entries.forEach((e) => { t += e.score; bag.tags.push(7n, payer); }); return t; }`,
    });
    expect(before.errors).toBe("");
  });

  it("keep a struct in a data enum variant in its fixed layout when it is also an argument", () => {
    const { errors } = compile({
      "main.ts": `import { type Account, type FixedVec, type Signer, type u64 } from "typesol";
export interface Legs { legs: FixedVec<u64, 3>; tag: u64; }
export type Act = { kind: "None" } | { kind: "Go"; l: Legs };
export interface Box { act: Act; }
export function take(s: Signer, b: Account<Box>, l: Legs): u64 { return l.tag; }`,
    });
    expect(errors).toMatch(/Legs holds a FixedVec and is also account data, nested or returned/);
  });
});
