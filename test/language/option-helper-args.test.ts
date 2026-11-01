// A narrowed Option of a struct or fixed array (`args.inner !== null` before it) passed straight to a helper that takes
// the struct or array: the helper reads the value inside (Marginfi's InterestRateConfigOpt inside BankConfigFast).
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, acct, deployFile, expectOk, fundedSigner, ix, pda, send, SYSTEM_PROGRAM, type Deployed } from "../harness.js";

const SOURCE = `import { type FixedArray, type Init, type Mut, type Option, type Signer, type SystemProgram, type u64 } from "typesol";
export interface Inner { a: u64; b: u64 }
/** @layout borsh */
export interface Args { inner: Option<Inner>; arr: Option<FixedArray<u64, 3>> }
export interface Acc { total: u64 }
function sum(i: Inner): u64 { return i.a + i.b; }
function sum3(x: FixedArray<u64, 3>): u64 { return x.get(0n) + x.get(1n) + x.get(2n); }
export function open(payer: Mut<Signer>, acc: Init<Acc>, system_program: SystemProgram): void {
  acc.create(payer, ["acc"]);
}
export function go(acc: Mut<Acc>, args: Args): void {
  if (args.inner !== null) acc.total = sum(args.inner);
  if (args.arr !== null) acc.total += sum3(args.arr);
}
`;

describe("narrowed Options as helper arguments", () => {
  let d: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-opthelper-"));
    writeFileSync(path.join(dir, "opt.ts"), SOURCE);
    d = await deployFile(path.join(dir, "opt.ts"));
  });

  it("passes the value inside, and skips what is empty", async () => {
    const payer = await fundedSigner(d.svm);
    const [a] = await pda(d.programId, ["acc"]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "open", {}, [{ address: payer.address, signer: payer, writable: true }, { address: a, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    const go = (args: Record<string, unknown>) => ix(d, "go", { args }, [{ address: a, writable: true }]);
    const total = () => Buffer.from(acct(d.svm, a).data).readBigUInt64LE(8);
    expectOk(await send(d.svm, payer, [go({ inner: { a: new BN(3), b: new BN(4) }, arr: null })]));
    expect(total()).toBe(7n);
    expectOk(await send(d.svm, payer, [go({ inner: null, arr: [new BN(10), new BN(20), new BN(30)] })]));
    expect(total()).toBe(67n);
    expectOk(await send(d.svm, payer, [go({ inner: { a: new BN(1), b: new BN(1) }, arr: [new BN(1), new BN(1), new BN(1)] })]));
    expect(total()).toBe(5n);
  });
});
