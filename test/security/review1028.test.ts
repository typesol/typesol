// Regressions from the 2026-10-28 review: dangling struct results in ternaries, for-of and replaced references,
// ** evaluation order, duplicate hoisted declarations.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { CompileError, generate } from "../../src/compiler/index.js";
import { programHarness, type TestProgram } from "../../src/testing.js";
import { deployFile } from "../harness.js";

describe("review 2026-10-28 regressions", () => {
  let t: TestProgram;
  beforeAll(async () => {
    const d = await deployFile(fileURLToPath(new URL("../fixtures/review1028.ts", import.meta.url)));
    t = programHarness(d.svm, d.programId, d.idl as never);
  });

  it("keeps a ternary's struct result alive after its branch", async () => {
    const w = await t.wallet();
    expect(t.returned("pick", await t.send(w, t.ix("pick", { c: true })))).toBe(103n);
    expect(t.returned("pick", await t.send(w, t.ix("pick", { c: false })))).toBe(504n);
  });

  it("reads the base of ** before the exponent runs, and builds helpers bound without a type", async () => {
    const admin = await t.wallet();
    const s = await t.pda("s", admin);
    t.ok(await t.send(admin, t.ix("setup", {}, { admin, s })));
    expect(t.returned("pw", await t.send(admin, t.ix("pw", {}, { s })))).toBe(9n);
    expect(t.returned("chained", await t.send(admin, t.ix("chained", {}, { s })))).toBe(8n);
    expect((await t.account<{ pos: { n: bigint } }>("S", s))?.pos.n).toBe(2n);
  });

  it("refuses a reference that a later for-of step would read after it was replaced", () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "typesol-review-")), "p.ts");
    writeFileSync(
      file,
      `import { type Mut, type Vec, type u64 } from "typesol";
export interface Pos { amount: u64; n: u64 }
export interface S { pos: Pos; list: Vec<u64> }
export function f(s: Mut<S>): u64 {
  const o = s.pos;
  let total = 0n;
  for (const x of s.list) {
    total += o.amount;
    s.pos = { amount: x, n: 0n };
  }
  return total;
}
`,
    );
    expect(() => generate(file)).toThrow(CompileError);
    try {
      generate(file);
    } catch (e) {
      expect((e as CompileError).diagnostics.map((d) => d.message).join()).toMatch(/"o" still refers to s\.pos/);
    }
  });
});
