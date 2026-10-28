// Closures (local functions that read the enclosing function's variables), expanded where they are called.
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, decodeAccount, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed, compileErrors } from "./harness.js";

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

  it("make functions, bind them as values, and give closures to generic and account helpers", async () => {
    // add5(2) = 7; triple(2) = 6; adder(1)(2) = 3; applyT(t2, 7) runs track once: seen = 7.
    expect(await run("made", { x: new BN(2) })).toBe(70_000n + 600n + 3n + 7n);
    const payer = await fundedSigner(d.svm);
    const [cart] = await pda(d.programId, ["cart", payer.address]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "setup", {}, [{ address: payer.address, signer: payer, writable: true }, { address: cart, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    const before = decodeAccount<{ total: BN }>(d, d.svm, "Cart", cart).total.toNumber();
    const r = await send(d.svm, payer, [
      ix(d, "bump_total", { by: new BN(4) }, [
        { address: payer.address, signer: payer },
        { address: cart, writable: true },
      ]),
    ]);
    expect(u64(r)).toBe(BigInt(before + 4));
  });

  it("refuses recursion and functions used as values", () => {
    const errors = (body: string) => compileErrors(`import { type u64 } from "typesol";\n${body}\n`);
    expect(errors(`export function f(x: u64): u64 { const g = (v: u64): u64 => (v === 0n ? x : g(v - 1n)); return g(3n); }`)).toMatch(/calls itself/);
    expect(errors(`export function f(x: u64): u64 { const g = (v: u64): u64 => v + x; const h = g; return h(1n); }`)).toBe("");
    expect(errors(`export function f(x: u64): u64 { const g = (v: u64): u64 => v + x; let h = g; return h(1n); }`)).toMatch(/bind functions with const/);
    expect(errors(`function mk(n: u64): (x: u64) => u64 { return (x: u64): u64 => x + n; }\nexport function f(x: u64): u64 { mk(1n); return x; }`)).toMatch(
      /returns a function: bind it/,
    );
    const apply = "function apply(f: (x: u64) => u64, v: u64): u64 { return f(v); }\n";
    expect(errors(`${apply}export function f(x: u64): u64 { const g = (v: u64): u64 => v + x; return apply(g, 1n); }`)).toBe("");
    const pick = "function pick<T>(f: (x: T) => T, v: T): T { return f(v); }\n";
    expect(errors(`${pick}export function f(x: u64): u64 { return pick<u64>((v: u64): u64 => v + x, 1n); }`)).toBe("");
    expect(errors(`export function f(x: u64): u64 { const g = (v: u64): u64 => v + x; return g(1n, 2n); }`)).toMatch(/Expected 1 arguments/);
  });
});
