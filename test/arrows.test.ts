// Arrow functions (top-level and local, capturing nothing) and generic helpers (an instance per set of types).
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSigner } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { CompileError, generate } from "../src/compiler/index.js";
import { pk } from "./ports-helpers.js";
import { BN, customError, deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "./harness.js";

describe("arrow functions and generic helpers", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/arrows.ts", import.meta.url)));
  });

  const ret = (r: Awaited<ReturnType<typeof send>>, bytes = 8) => {
    const b = Buffer.from(expectOk(r).returnData().data());
    return bytes === 16 ? b.readBigUInt64LE(0) + (b.readBigUInt64LE(8) << 64n) : b.readBigUInt64LE(0);
  };

  it("runs top-level and local arrow functions", async () => {
    const payer = await fundedSigner(d.svm);
    const call = (x: number) => send(d.svm, payer, [ix(d, "arrows", { x: new BN(x) }, [])]);
    expect(ret(await call(3))).toBe((3n * 3n + 1n) * 100n + 3n);
    expect(ret(await call(20))).toBe(40n * 100n + 3n);
    expect(customError(await call(7))).toBe(6000);
    // A local function shadows the top-level one of the same name.
    expect(ret(await send(d.svm, payer, [ix(d, "shadow", { x: new BN(5) }, [])]))).toBe(22n);
  });

  it("instantiates generic helpers for struct types", async () => {
    const payer = await fundedSigner(d.svm);
    const call = (flip: boolean) => send(d.svm, payer, [ix(d, "struct_generics", { flip, x: new BN(5) }, [])]);
    expect(ret(await call(false))).toBe(5n * 1000n + 200n);
    expect(ret(await call(true))).toBe(100n * 1000n + 6n);
  });

  it("instantiates generic helpers for the argument types", async () => {
    const payer = await fundedSigner(d.svm);
    const other = (await generateKeyPairSigner()).address;
    const call = (x: number, small: number) =>
      send(d.svm, payer, [
        ix(d, "generics", { x: new BN(x), y: new BN("100000000000000000000"), small, other: pk(other) }, [{ address: payer.address, signer: payer }]),
      ]);
    const y = 100000000000000000000n + 2n;
    expect(ret(await call(9, 1), 16)).toBe(y * 1_000_000n + 10n * 1_000n + 3n);
    expect(ret(await call(80, 200), 16)).toBe(y * 1_000_000n + 81n * 1_000n + 200n);
    const c = generate(fileURLToPath(new URL("./fixtures/arrows.ts", import.meta.url))).c;
    for (const f of ["fn_sum__u64", "fn_sum__u128", "fn_pick__pubkey", "fn_maxOf__u8", "fn_maxOf__u64", "fn_arrows__step", "fn_shadow__double"])
      expect(c).toContain(`static uint64_t ${f}(`);
  });

  it("refuses closures, missing types and what it cannot instantiate", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-arrows-"));
    const errors = (body: string) => {
      const file = path.join(dir, `p${Math.random().toString(36).slice(2)}.ts`);
      writeFileSync(file, `import { type u8, type u64, type Pubkey } from "typesol";\nexport interface S { n: u64 }\n${body}\n`);
      try {
        generate(file);
        return "";
      } catch (e) {
        if (e instanceof CompileError) return e.diagnostics.map((x) => x.message).join(" | ");
        throw e;
      }
    };
    // Closures compile now (test/closures.test.ts runs them).
    expect(errors(`export function f(x: u64): u64 { const g = (v: u64): u64 => v + x; return g(1n); }`)).toBe("");
    expect(errors(`export function f(x: u64): u64 { let k = 1n; const g = (): u64 => k; return g(); }`)).toBe("");
    expect(errors(`export function f(x: u64): u64 { let g = (v: u64): u64 => v; return g(x); }`)).toMatch(/declare local functions with const/);
    expect(errors(`export function f(x: u64): u64 { const g = (v: u64) => v; return g(x); }`)).toMatch(/explicit return type/);
    expect(errors(`export const f = (x: u64): u64 => x;`)).toMatch(/instructions are function declarations/);
    expect(errors(`function id<T>(a: T): T { return a; }\nexport function f(): u64 { return id(1n); }`)).toMatch(
      /cannot tell what T is from literal arguments/,
    );
    expect(errors(`function id<T>(a: T): T { return a; }\nexport function f(): u64 { return id<u64>(1n); }`)).toBe("");
    expect(errors(`function id<T>(a: T): T { return a; }\nexport function f(): void { id("x"); }`)).toMatch(/T stands for an integer/);
    expect(errors(`function g<T>(a: T): T { return g(a); }\nexport function f(x: u64): u64 { return g(x); }`)).toMatch(/recursion is not supported: g -> g/);
    expect(errors(`export function f(x: u64): u8 { return x as u8; }`)).toMatch(/`as` does not convert/);
    expect(errors(`export function f(x: u64): u64 { const g = (v: u64): u64 => v; const h = g; return h(x); }`)).toMatch(/"g" is a function/);
    expect(errors(`function g<T>(a: T): T { const h = (v: T): T => v; return h(a); }\nexport function f(x: u64): u64 { return g(x); }`)).toMatch(
      /inside a generic helper are not supported/,
    );
    // A generic helper is compiled per use: one never called is not checked beyond TypeScript.
    expect(errors(`function g<T>(a: T): T { for (const k in [a]) {} return a; }\nexport function f(x: u64): u64 { return x; }`)).toBe("");
    expect(errors(`function g<T>(a: T): T { for (const k in [a]) {} return a; }\nexport function f(x: u64): u64 { return g(x); }`)).toMatch(/for … in/);
    // A generic helper calling another; a generic local function.
    expect(
      errors(
        `function pick<T>(c: boolean, a: T, b: T): T { return c ? a : b; }\nfunction big<T extends bigint>(a: T, b: T): T { return pick(a > b, a, b); }\nexport function f(x: u64): u64 { const id = <T,>(a: T): T => a; return id(big(x, 2n)); }`,
      ),
    ).toBe("");
    expect(errors(`export function f(x: u64): void { const v = [1n].map((y: bigint): bigint => y); }`)).not.toBe("");
  });
});
