// loadAccountMut in a loop: a view declared in the loop body ends with the iteration, so a later iteration may load
// the same account again; with loadAccountMut<Dup<T>>, even one passed more than once among the remaining accounts
// (Raydium's route through one pool twice). Without Dup<…> a repeat is refused as before. Two live views of one account are still refused (2040): two in one iteration, or one of an account that
// is also an instruction parameter.
import { lamports } from "@solana/kit";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { acct, compileErrors, customError, deployFile, expectOk, fundedSigner, ix, type Deployed } from "../harness.js";
import { generateKeyPairSigner, type Address } from "@solana/kit";
import { send } from "../harness.js";

const SOURCE = `import { type Dup, type Mut, type Signer, type u64, loadAccountMut, remainingAccounts } from "typesol";

export interface Counter {
  n: u64;
}

/** Each remaining account, repeats included (Dup), counted once per visit. */
export function visit(payer: Signer): void {
  const rest = remainingAccounts();
  for (let i = 0n; i < rest.length; i++) {
    const c = loadAccountMut<Dup<Counter>>(rest.get(i));
    c.n += 1n;
  }
}
/** Without Dup<…>: a repeated account is refused, as before. */
export function plain(payer: Signer): void {
  const rest = remainingAccounts();
  for (let i = 0n; i < rest.length; i++) {
    const c = loadAccountMut<Counter>(rest.get(i));
    c.n += 1n;
  }
}
/** The same, with a closure in the body reading the view. */
export function visitWithClosure(payer: Signer): void {
  const rest = remainingAccounts();
  let i = 0n;
  while (i < rest.length) {
    const c = loadAccountMut<Dup<Counter>>(rest.get(i));
    const next = (): u64 => c.n + 1n;
    c.n = next();
    i++;
    if (c.n > 1000n) continue;
  }
}
/** Two views in one iteration: adjacent remaining accounts. */
export function pairs(payer: Signer): void {
  const rest = remainingAccounts();
  for (let i = 0n; i + 1n < rest.length; i++) {
    const a = loadAccountMut<Dup<Counter>>(rest.get(i));
    const b = loadAccountMut<Dup<Counter>>(rest.get(i + 1n));
    a.n += b.n + 1n;
  }
}
/** A closure using the view, passed to a helper: expanded where it runs, within the iteration. */
export function kept(payer: Signer): void {
  const rest = remainingAccounts();
  for (let i = 0n; i < rest.length; i++) {
    const c = loadAccountMut<Dup<Counter>>(rest.get(i));
    const bump = (): void => {
      c.n += 1n;
    };
    run(bump);
  }
}
function run(f: () => void): void {
  f();
}
/** An instruction parameter, and the same account among the remaining ones. */
export function withParam(own: Mut<Counter>): void {
  const rest = remainingAccounts();
  for (let i = 0n; i < rest.length; i++) {
    const c = loadAccountMut<Dup<Counter>>(rest.get(i));
    c.n += own.n;
  }
}
`;

describe("loadAccountMut in a loop", () => {
  let d: Deployed;
  const disc = createHash("sha256").update("account:Counter").digest().subarray(0, 8);
  const counter = async (n = 0n) => {
    const a = (await generateKeyPairSigner()).address;
    const data = Buffer.alloc(16);
    disc.copy(data);
    data.writeBigUInt64LE(n, 8);
    d.svm.setAccount({ address: a, data: new Uint8Array(data), executable: false, lamports: lamports(10_000_000n), programAddress: d.programId, space: 16n });
    return a;
  };
  const count = (a: Address) => Buffer.from(acct(d.svm, a).data).readBigUInt64LE(8);
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-loop-loads-"));
    writeFileSync(path.join(dir, "loops.ts"), SOURCE);
    d = await deployFile(path.join(dir, "loops.ts"));
  });

  it("loads one account again in later iterations, repeats among the remaining accounts included", async () => {
    const payer = await fundedSigner(d.svm);
    const [a, b] = [await counter(), await counter()];
    const rest = [a, b, a, a].map((address) => ({ address, writable: true }));
    expectOk(await send(d.svm, payer, [ix(d, "visit", {}, [{ address: payer.address, signer: payer }, ...rest])]));
    expect([count(a), count(b)]).toEqual([3n, 1n]);
    expectOk(await send(d.svm, payer, [ix(d, "visit_with_closure", {}, [{ address: payer.address, signer: payer }, ...rest])]));
    expect([count(a), count(b)]).toEqual([6n, 2n]);
  });

  it("still refuses two live views of one account", async () => {
    const payer = await fundedSigner(d.svm);
    const [a, b] = [await counter(), await counter()];
    const call = (name: string, accounts: Address[], own: Address[] = []) =>
      send(d.svm, payer, [
        ix(d, name, {}, [
          ...own.map((address) => ({ address, writable: true })),
          ...(own.length ? [] : [{ address: payer.address, signer: payer }]),
          ...accounts.map((address) => ({ address, writable: true })),
        ]),
      ]);
    // Without Dup<…> a repeat is refused (a payout per member must not pay one twice), with it each visit counts.
    expect(customError(await call("plain", [a, b, a]))).toBe(2040);
    expectOk(await call("plain", [a, b]));
    // Different accounts side by side are fine; one account twice in one iteration is not.
    expectOk(await call("pairs", [a, b, a]));
    expect(customError(await call("pairs", [a, a]))).toBe(2040);
    // A closure over the view, run by a helper, still runs within the iteration.
    expectOk(await call("kept", [a, b, a]));
    // The instruction's own account among the remaining ones.
    expect(customError(await call("with_param", [b, a], [a]))).toBe(2040);
    expectOk(await call("with_param", [b, b], [a]));
  });

  it("has no way to keep a view past its iteration", () => {
    // Loaded accounts are bound with const, and cannot be stored in another name or an object.
    const program = (body: string) =>
      compileErrors(
        `import { type Dup, type Signer, type u64, loadAccountMut, remainingAccounts } from "typesol";\nexport interface Counter { n: u64; }\nexport function f(payer: Signer): void {\n  const rest = remainingAccounts();\n${body}\n}\n`,
      );
    expect(program("  let last = loadAccountMut<Counter>(rest.get(0n));")).toMatch(/bind loaded accounts with const/);
    expect(program("  for (let i = 0n; i < rest.length; i++) { const c = loadAccountMut<Counter>(rest.get(i)); const o = { c }; }")).toMatch(/object literals/);
    // Dup<…> outside a loop iteration's scope, or on loadAccount, is refused.
    expect(program("  const c = loadAccountMut<Dup<Counter>>(rest.get(0n));")).toMatch(/is for remaining accounts loaded in a loop/);
  });
});
