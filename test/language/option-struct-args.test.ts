// Option<S> instruction arguments of a fixed-size struct (Anchor's `Option<WrappedI80F48>` arguments): a Borsh tag
// byte, then the struct only when Some; `x !== null` before reading its fields; `{ option: { defined } }` in the IDL.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { web3 } from "@anchor-lang/core";
import { beforeAll, describe, expect, it } from "vitest";
import { CompileError, generate } from "../../src/compiler/index.js";
import { BN, acct, deployFile, expectOk, fundedSigner, ix, pda, send, SYSTEM_PROGRAM, type Deployed } from "../harness.js";

const SOURCE = `import { type Init, type Mut, type Option, type Pubkey, type Signer, type SystemProgram, type u64 } from "typesol";
export interface Pair { a: u64; b: u64 }
export interface Flagged { on: boolean; n: u64 }
export interface Acc { total: u64; other: u64 }
export function open(payer: Mut<Signer>, acc: Init<Acc>, system_program: SystemProgram): void {
  acc.create(payer, ["acc"]);
}
export function go(acc: Mut<Acc>, first: Option<Pair>, n: u64, second: Pair | null, who: Option<Pubkey>, flag: Option<Flagged>): void {
  acc.total = n;
  if (first !== null) acc.total += first.a + first.b;
  acc.other = 0n;
  if (second !== null) acc.other = second.a * second.b;
  if (who !== null) acc.other += 1n;
  if (flag !== null && flag.on) acc.other += flag.n;
}
`;

describe("Option<struct> instruction arguments", () => {
  let d: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-optstructarg-"));
    writeFileSync(path.join(dir, "opt.ts"), SOURCE);
    d = await deployFile(path.join(dir, "opt.ts"));
  });

  it("describes them as Anchor does", () => {
    const go = d.idl.instructions.find((i) => i.name === "go")!;
    expect(go.args.map((a) => a.type)).toEqual([
      { option: { defined: { name: "Pair" } } },
      "u64",
      { option: { defined: { name: "Pair" } } },
      { option: "pubkey" },
      { option: { defined: { name: "Flagged" } } },
    ]);
  });

  it("reads the struct when it is there, and skips it when it is not", async () => {
    const payer = await fundedSigner(d.svm);
    const [a] = await pda(d.programId, ["acc"]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "open", {}, [{ address: payer.address, signer: payer, writable: true }, { address: a, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    const go = (args: Record<string, unknown>) => ix(d, "go", args, [{ address: a, writable: true }]);
    const read = () => {
      const data = Buffer.from(acct(d.svm, a).data);
      return [data.readBigUInt64LE(8), data.readBigUInt64LE(16)];
    };
    const pair = (x: number, y: number) => ({ a: new BN(x), b: new BN(y) });
    expectOk(await send(d.svm, payer, [go({ first: pair(3, 4), n: new BN(1), second: null, who: null, flag: null })]));
    expect(read()).toEqual([8n, 0n]);
    expectOk(
      await send(d.svm, payer, [
        go({ first: null, n: new BN(2), second: pair(5, 6), who: new web3.PublicKey(payer.address), flag: { on: true, n: new BN(100) } }),
      ]),
    );
    expect(read()).toEqual([2n, 131n]);
    expectOk(await send(d.svm, payer, [go({ first: pair(1, 1), n: new BN(0), second: pair(2, 2), who: null, flag: { on: false, n: new BN(100) } })]));
    expect(read()).toEqual([2n, 4n]);
  });

  it("refuses a bad tag, short data and a bad bool inside", async () => {
    const payer = await fundedSigner(d.svm);
    const [a] = await pda(d.programId, ["acc"]);
    const good = ix(d, "go", { first: null, n: new BN(0), second: null, who: null, flag: null }, [{ address: a, writable: true }]);
    const head = Buffer.from(good.data!).subarray(0, 8);
    const raw = (bytes: number[]) => ({ ...good, data: Uint8Array.from([...head, ...bytes]) });
    const u64 = [0, 0, 0, 0, 0, 0, 0, 0];
    const failsWith = async (bytes: number[], code: number) => {
      const r = await send(d.svm, payer, [raw(bytes)]);
      expect(String((r as { err: () => unknown }).err?.())).toContain(`code: ${code}`);
    };
    // tag 2; Some with too few bytes; Flagged.on = 2.
    await failsWith([2], 102);
    await failsWith([1, 1, 2, 3], 102);
    await failsWith([0, ...u64, 0, 0, 1, 2, ...u64], 102);
  });

  it("are not helper parameters", () => {
    const helper = `import { type Option, type u64 } from "typesol";
export interface Pair { a: u64; b: u64 }
export interface Acc { total: u64 }
function sum(p: Option<Pair>): u64 { return 0n; }
export function go(p: Option<Pair>): void {}
`;
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-optstructarg-"));
    writeFileSync(path.join(dir, "bad.ts"), helper);
    let messages: string[] = [];
    try {
      generate(path.join(dir, "bad.ts"));
    } catch (e) {
      if (!(e instanceof CompileError)) throw e;
      messages = e.diagnostics.map((x) => x.message);
    }
    expect(messages.join("\n")).toMatch(/helpers take the struct itself/);
  });
});
