// Remaining accounts spread into a CPI's account list (test/fixtures/remaining-cpi.ts calls remaining-callee.ts).
import { type Address, generateKeyPairSigner } from "@solana/kit";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { CompileError, generate } from "../src/compiler/index.js";
import { BN, customError, deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "./harness.js";

const fixture = (f: string) => fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url));

describe("remaining accounts in a CPI", () => {
  let d: Deployed;
  let callee: Deployed;
  beforeAll(async () => {
    d = await deployFile(fixture("remaining-cpi.ts"));
    callee = await deployFile(fixture("remaining-callee.ts"), { svm: d.svm });
  });

  const result = (r: unknown) => Buffer.from((r as { returnData(): { data(): Uint8Array } }).returnData().data()).readBigUInt64LE(0);

  it("passes them as passed, all read-only or all writable", async () => {
    const payer = await fundedSigner(d.svm);
    const w = (await generateKeyPairSigner()).address;
    const r1 = (await generateKeyPairSigner()).address;
    const r2 = (await generateKeyPairSigner()).address;
    const rest = [{ address: w, writable: true }, { address: r1 }, { address: r2 }];
    const call = (name: string, extra: { address: Address; writable?: boolean }[]) =>
      send(d.svm, payer, [ix(d, name, {}, [{ address: payer.address, signer: payer }, { address: callee.programId }, ...extra])]);
    expect(result(expectOk(await call("as_passed", rest)))).toBe(3n + 100n * 1n);
    expect(result(expectOk(await call("all_readonly", rest)))).toBe(3n);
    // all writable: an account passed read-only cannot be made writable (3006).
    expect(customError(await call("all_writable", rest))).toBe(3006);
    expect(
      result(
        expectOk(
          await call(
            "all_writable",
            rest.map((a) => ({ ...a, writable: true })),
          ),
        ),
      ),
    ).toBe(3n + 100n * 3n);
    // No remaining accounts: the spread adds nothing.
    expect(result(expectOk(await call("as_passed", [])))).toBe(0n);
    // Order kept after a spread: rest (read-only), rest (as passed), then the payer again (a signer). The runtime
    // merges a repeated account's privileges, so `w` is writable in both places.
    expect(result(expectOk(await call("twice", rest)))).toBe(7n + 100n * 2n + 10000n * 1n);
  });

  it("passes a slice of them, and refuses slices out of range (5104)", async () => {
    const payer = await fundedSigner(d.svm);
    const rest = await Promise.all(Array.from({ length: 5 }, async (_, i) => ({ address: (await generateKeyPairSigner()).address, writable: i === 1 })));
    const slice = (from: number, to: number) =>
      send(d.svm, payer, [
        ix(d, "sliced", { from: new BN(from), to: new BN(to) }, [{ address: payer.address, signer: payer }, { address: callee.programId }, ...rest]),
      ]);
    expect(result(expectOk(await slice(1, 4)))).toBe(3n);
    expect(result(expectOk(await slice(0, 5)))).toBe(5n);
    expect(result(expectOk(await slice(5, 5)))).toBe(0n);
    expect(customError(await slice(2, 6))).toBe(5104);
    expect(customError(await slice(3, 2))).toBe(5104);
  });

  it("refuses a CPI that would list more than 32 accounts (5113)", async () => {
    const payer = await fundedSigner(d.svm);
    const many = await Promise.all(Array.from({ length: 16 }, async () => ({ address: (await generateKeyPairSigner()).address })));
    const r = await send(d.svm, payer, [ix(d, "twice", {}, [{ address: payer.address, signer: payer }, { address: callee.programId }, ...many])]);
    expect(customError(r)).toBe(5113);
  });

  it("explains spreads it does not take", () => {
    const f = path.join(mkdtempSync(path.join(os.tmpdir(), "typesol-spread-")), "p.ts");
    writeFileSync(
      f,
      `import { type Signer, type UncheckedProgram, invoke, readonlySigner, remainingAccounts, sighash } from "typesol";
export function f(payer: Signer, callee: UncheckedProgram): void {
  invoke(callee, [...readonlySigner(remainingAccounts())], [sighash("count")]);
}`,
    );
    let message = "";
    try {
      generate(f);
    } catch (e) {
      if (!(e instanceof CompileError)) throw e;
      message = e.diagnostics.map((x) => x.message).join("\\n");
    }
    expect(message).not.toBe("");
    // A slice outside a spread: a type error (RemainingSlice has no get), and a clear message from the compiler.
    writeFileSync(
      f,
      `import { type Signer, invoke, readonlySigner, remainingAccounts, sighash, type UncheckedProgram } from "typesol";
export function f(payer: Signer, callee: UncheckedProgram): void {
  const part = remainingAccounts().slice(1n);
  invoke(callee, [readonlySigner(payer), ...part], [sighash("count")]);
}`,
    );
    let sliceMessage = "";
    try {
      generate(f);
    } catch (e) {
      if (!(e instanceof CompileError)) throw e;
      sliceMessage = e.diagnostics.map((x) => x.message).join("\n");
    }
    expect(sliceMessage).toMatch(/only for spreading into a CPI/);
  });
});
