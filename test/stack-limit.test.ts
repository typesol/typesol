// SBF's 4 KiB stack frame: a function over it is a build error naming the instruction or helper, not memory corruption.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { build } from "../src/compiler/index.js";

const program = (body: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-stack-"));
  const file = path.join(dir, "p.ts");
  writeFileSync(
    file,
    `import { type Account, type FixedArray, type u64, type u8 } from "typesol";
export interface Big { xs: FixedArray<u64, 250>; tag: u64 }
export interface Holder { bump: u8; b: Big }
${body}
`,
  );
  return () => build(file, path.join(dir, "out"), "11111111111111111111111111111112");
};

describe("stack frame limit", () => {
  it("refuses copies that do not fit, naming the instruction", () => {
    const b = program(`export function f(h: Account<Holder>): u64 {
  const q: Big = h.b;
  const r: Big = h.b;
  const s: Big = h.b;
  return q.tag + r.tag + s.tag;
}`);
    expect(b).toThrow(/instruction f \(with the helpers inlined into it\) needs \d+ bytes of stack; SBF gives each function 4096/);
  });

  it("counts helpers inlined into the instruction", () => {
    const b = program(`function sum(h: Account<Holder>): u64 {
  const q: Big = h.b;
  const r: Big = h.b;
  const s: Big = h.b;
  return q.tag + r.tag + s.tag;
}
export function f(h: Account<Holder>): u64 {
  return sum(h);
}`);
    expect(b).toThrow(/(instruction f \(with the helpers inlined into it\)|helper sum\(\)) needs \d+ bytes of stack/);
  });

  it("builds the same code with references instead of copies", () => {
    const b = program(`export function f(h: Account<Holder>): u64 {
  const q = h.b;
  const r = h.b;
  const s = h.b;
  return q.tag + r.tag + s.tag;
}`);
    expect(b).not.toThrow();
  });
});
