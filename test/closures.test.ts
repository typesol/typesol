// Closures (local functions that read the enclosing function's variables), expanded where they are called.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { CompileError, generate } from "../src/compiler/index.js";
import { BN, SYSTEM_PROGRAM, decodeAccount, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "./harness.js";

describe("closures", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/closures.ts", import.meta.url)));
  });
  const u64 = (r: Awaited<ReturnType<typeof send>>) => Buffer.from(expectOk(r).returnData().data()).readBigUInt64LE(0);
  const run = async (name: string, args: Record<string, unknown>) => u64(await send(d.svm, await fundedSigner(d.svm), [ix(d, name, args, [])]));

  it("write the enclosing let, and read the names they were declared with", async () => {
    // 5 → 8 → 11 (the inner `inc` is not the captured one) → twice: 14, 1 * 2 + 14.
    expect(await run("counter", { start: new BN(5), step: new BN(3) })).toBe(16n);
  });

  it("return early from block bodies and call each other", async () => {
    expect(await run("classify", { x: new BN(1), limit: new BN(5) })).toBe(92n);
    expect(await run("classify", { x: new BN(0), limit: new BN(5) })).toBe(1n);
    expect(await run("classify", { x: new BN(7), limit: new BN(5) })).toBe(22n);
  });

  it("write through captured accounts and struct references", async () => {
    const payer = await fundedSigner(d.svm);
    const [cart] = await pda(d.programId, ["cart", payer.address]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "setup", {}, [{ address: payer.address, signer: payer, writable: true }, { address: cart, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    const r = await send(d.svm, payer, [
      ix(d, "checkout", { discount: new BN(1) }, [
        { address: payer.address, signer: payer },
        { address: cart, writable: true },
      ]),
    ]);
    expect(u64(r)).toBe(25n);
    const c = decodeAccount<{ total: BN; items: { qty: BN }[] }>(d, d.svm, "Cart", cart);
    expect([c.total.toNumber(), c.items[0]!.qty.toNumber()]).toEqual([25, 5]);
  });

  it("pass named functions to helpers (an instance per function)", async () => {
    // applyTwice(inc, 5) = 7; compose(dbl, inc, 5) = applyTwice(dbl, 6) = 24.
    expect(await run("higher", { x: new BN(5) })).toBe(7024n);
  });

  it("pass arrow functions written at the call to helpers", async () => {
    // applyTwice(v => 3v, 5) = 45; compose(+10, -1, 5) = applyTwice(+10, 4) = 24.
    expect(await run("lambdas", { x: new BN(5) })).toBe(45024n);
  });

  it("pass closures to helpers: the helper is expanded where it is called", async () => {
    // applyTwice(addX, 1) = 11; compose(v => 5v, addX, 2) = applyTwice(v => 5v, 7) = 175; addX ran 3 times.
    expect(await run("capturing", { x: new BN(5) })).toBe(11_000n + 1_750n + 3n);
  });

  it("refuses recursion and functions used as values", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-closures-"));
    const errors = (body: string) => {
      const file = path.join(dir, `p${Math.random().toString(36).slice(2)}.ts`);
      writeFileSync(file, `import { type u64 } from "typesol";\n${body}\n`);
      try {
        generate(file);
        return "";
      } catch (e) {
        if (e instanceof CompileError) return e.diagnostics.map((x) => x.message).join(" | ");
        throw e;
      }
    };
    expect(errors(`export function f(x: u64): u64 { const g = (v: u64): u64 => (v === 0n ? x : g(v - 1n)); return g(3n); }`)).toMatch(/calls itself/);
    expect(errors(`export function f(x: u64): u64 { const g = (v: u64): u64 => v + x; const h = g; return h(1n); }`)).toMatch(/is a function/);
    const apply = "function apply(f: (x: u64) => u64, v: u64): u64 { return f(v); }\n";
    expect(errors(`${apply}export function f(x: u64): u64 { const g = (v: u64): u64 => v + x; return apply(g, 1n); }`)).toBe("");
    const pick = "function pick<T>(f: (x: T) => T, v: T): T { return f(v); }\n";
    expect(errors(`${pick}export function f(x: u64): u64 { return pick((v: u64): u64 => v + x, 1n); }`)).toMatch(/has type parameters/);
    expect(errors(`export function f(x: u64): u64 { const g = (v: u64): u64 => v + x; return g(1n, 2n); }`)).toMatch(/Expected 1 arguments/);
  });
});
