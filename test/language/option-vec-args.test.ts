// Option<Vec<T>> instruction arguments and event fields (Anchor's `Option<Vec<u8>>`, written `bytes` in the IDL): a Borsh tag byte, then
// the Vec only when Some; `x !== null` before reading it as a list or passing it to a helper that takes the list.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { web3 } from "@anchor-lang/core";
import { beforeAll, describe, expect, it } from "vitest";
import { CompileError, generate } from "../../src/compiler/index.js";
import { BN, acct, deployFile, expectOk, fundedSigner, ix, pda, send, SYSTEM_PROGRAM, type Deployed } from "../harness.js";

const SOURCE = `import { emit, type FixedArray, type FixedVec, type Init, type Mut, type Option, type Pubkey, type Signer, type SystemProgram, type Vec, type u8, type u64 } from "typesol";
export interface Pair { a: u64; b: u64 }
export interface Acc { n: u64; sum: u64; pairs: u64; bytes: FixedArray<u8, 8> }
export function open(payer: Mut<Signer>, acc: Init<Acc>, system_program: SystemProgram): void {
  acc.create(payer, ["acc"]);
}
export interface Header { signer: Option<Pubkey>; n: u64 }
export interface Keys { header: Header; keys: Option<Vec<Pubkey>>; none: Option<Vec<Pubkey>>; some: Option<Vec<u64>> }
export function keys(who: Signer, list: Option<Vec<Pubkey>>, plain: Vec<u64>): void {
  emit<Keys>({ keys: list, none: null, some: plain, header: { n: 5n, signer: list === null ? null : who.key } });
}
function hundred(xs: Vec<u8>): u64 {
  return xs.length * 100n;
}
export function go(acc: Mut<Acc>, ticker: Option<Vec<u8>>, n: u64, desc: Vec<u8> | null, pairs: Option<Vec<Pair>>, small: Option<FixedVec<u64, 2>>, raw: Vec<u8>, tag: FixedVec<u8, 4>): void {
  acc.n = n + raw.length + tag.length;
  acc.sum = 0n;
  if (ticker !== null) {
    acc.sum += ticker.length + 1000n;
    for (let i = 0n; i < 8n; i++) acc.bytes.set(i, i < ticker.length ? ticker.get(i) : 0n);
  }
  if (desc !== null) acc.sum += hundred(desc);
  acc.pairs = 0n;
  if (pairs !== null) for (const p of pairs) acc.pairs += p.a * p.b;
  if (small === null) return;
  for (const x of small) acc.pairs += x * 1000000n;
}
`;

describe("Option<Vec<T>> instruction arguments and event fields", () => {
  let d: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-optvecarg-"));
    writeFileSync(path.join(dir, "opt.ts"), SOURCE);
    d = await deployFile(path.join(dir, "opt.ts"));
  });

  it("describes them as Anchor does, Vec<u8> as bytes", () => {
    const go = d.idl.instructions.find((i) => i.name === "go")!;
    expect(go.args.map((a) => a.type)).toEqual([
      { option: "bytes" },
      "u64",
      { option: "bytes" },
      { option: { vec: { defined: { name: "Pair" } } } },
      { option: { vec: "u64" } },
      "bytes",
      "bytes",
    ]);
  });

  it("emits Option<Vec<T>> event fields as Anchor does", async () => {
    const payer = await fundedSigner(d.svm);
    expect(d.idl.events?.map((e) => e.name)).toEqual(["Keys"]);
    expect(d.idl.types?.find((t) => t.name === "Keys")?.type).toEqual({
      kind: "struct",
      fields: [
        { name: "header", type: { defined: { name: "Header" } } },
        { name: "keys", type: { option: { vec: "pubkey" } } },
        { name: "none", type: { option: { vec: "pubkey" } } },
        { name: "some", type: { option: { vec: "u64" } } },
      ],
    });
    const emitted = async (list: unknown) => {
      const r = expectOk(await send(d.svm, payer, [ix(d, "keys", { list, plain: [new BN(1), new BN(2)] }, [{ address: payer.address, signer: payer }])]));
      const ev = r
        .logs()
        .filter((l) => l.startsWith("Program data: "))
        .map((l) => d.coder.events.decode(l.slice("Program data: ".length)));
      return JSON.parse(JSON.stringify(ev[0]!.data));
    };
    const k = new web3.PublicKey(payer.address);
    expect(await emitted([k, k])).toEqual({ header: { signer: k.toBase58(), n: "05" }, keys: [k.toBase58(), k.toBase58()], none: null, some: ["01", "02"] });
    expect(await emitted(null)).toEqual({ header: { signer: null, n: "05" }, keys: null, none: null, some: ["01", "02"] });
    expect(await emitted([])).toEqual({ header: { signer: k.toBase58(), n: "05" }, keys: [], none: null, some: ["01", "02"] });
  });

  it("refuses them outside events", () => {
    const bad = `import { type Init, type Mut, type Option, type Pubkey, type Signer, type SystemProgram, type Vec } from "typesol";
export interface Acc { keys: Option<Vec<Pubkey>> }
export function open(payer: Mut<Signer>, acc: Init<Acc>, system_program: SystemProgram): void {
  acc.create(payer, ["acc"]);
}
`;
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-optvecarg-"));
    writeFileSync(path.join(dir, "bad.ts"), bad);
    let messages: string[] = [];
    try {
      generate(path.join(dir, "bad.ts"));
    } catch (e) {
      if (!(e instanceof CompileError)) throw e;
      messages = e.diagnostics.map((x) => x.message);
    }
    expect(messages.join("\n")).toMatch(/Option<Vec<T>> fields are for events/);
  });

  it("reads the list when it is there, and skips it when it is not", async () => {
    const payer = await fundedSigner(d.svm);
    const [a] = await pda(d.programId, ["acc"]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "open", {}, [{ address: payer.address, signer: payer, writable: true }, { address: a, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    const go = (args: Record<string, unknown>) => ix(d, "go", { raw: Buffer.from([9]), tag: Buffer.from([7]), ...args }, [{ address: a, writable: true }]);
    const read = () => {
      const data = Buffer.from(acct(d.svm, a).data);
      return [data.readBigUInt64LE(8), data.readBigUInt64LE(16), data.readBigUInt64LE(24), [...data.subarray(32, 40)]];
    };
    const pair = (x: number, y: number) => ({ a: new BN(x), b: new BN(y) });
    expectOk(await send(d.svm, payer, [go({ ticker: Buffer.from("USDC"), n: new BN(1), desc: null, pairs: null, small: null })]));
    expect(read()).toEqual([3n, 1004n, 0n, [85, 83, 68, 67, 0, 0, 0, 0]]);
    expectOk(await send(d.svm, payer, [go({ ticker: null, n: new BN(2), desc: Buffer.alloc(3), pairs: [pair(2, 3), pair(4, 5)], small: [new BN(7)] })]));
    expect(read()).toEqual([4n, 300n, 7_000_026n, [85, 83, 68, 67, 0, 0, 0, 0]]);
    // Some of an empty list is not None.
    expectOk(await send(d.svm, payer, [go({ ticker: Buffer.alloc(0), n: new BN(0), desc: Buffer.alloc(0), pairs: [], small: [] })]));
    expect(read()).toEqual([2n, 1000n, 0n, [0, 0, 0, 0, 0, 0, 0, 0]]);
  });

  it("refuses a bad tag, short data and a FixedVec over its capacity", async () => {
    const payer = await fundedSigner(d.svm);
    const [a] = await pda(d.programId, ["acc"]);
    const good = ix(d, "go", { ticker: null, n: new BN(0), desc: null, pairs: null, small: null, raw: Buffer.alloc(0), tag: Buffer.alloc(0) }, [
      { address: a, writable: true },
    ]);
    const head = Buffer.from(good.data!).subarray(0, 8);
    const raw = (bytes: number[]) => ({ ...good, data: Uint8Array.from([...head, ...bytes]) });
    const u64 = [0, 0, 0, 0, 0, 0, 0, 0];
    const none = [0, ...u64, 0, 0];
    const failsWith = async (bytes: number[], code: number) => {
      const r = await send(d.svm, payer, [raw(bytes)]);
      expect(String((r as { err: () => unknown }).err?.())).toContain(`code: ${code}`);
    };
    // tag 2; Some with a length past the data; three u64s in a FixedVec<u64, 2>; then the same bytes with two.
    await failsWith([2], 102);
    await failsWith([1, 9, 0, 0, 0, 1, 2], 102);
    await failsWith([...none, 1, 3, 0, 0, 0, ...u64, ...u64, ...u64, 0, 0, 0, 0, 0, 0, 0, 0], 102);
    expectOk(await send(d.svm, payer, [raw([...none, 1, 2, 0, 0, 0, ...u64, ...u64, 0, 0, 0, 0, 0, 0, 0, 0])]));
    // A FixedVec<u8, 4> argument of five bytes.
    await failsWith([...none, 0, 0, 0, 0, 0, 5, 0, 0, 0, 1, 2, 3, 4, 5], 102);
  });

  it("are not helper parameters", () => {
    const helper = `import { type Option, type Vec, type u8, type u64 } from "typesol";
export interface Acc { total: u64 }
function count(p: Option<Vec<u8>>): u64 { return 0n; }
export function go(p: Option<Vec<u8>>): void {}
`;
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-optvecarg-"));
    writeFileSync(path.join(dir, "bad.ts"), helper);
    let messages: string[] = [];
    try {
      generate(path.join(dir, "bad.ts"));
    } catch (e) {
      if (!(e instanceof CompileError)) throw e;
      messages = e.diagnostics.map((x) => x.message);
    }
    expect(messages.join("\n")).toMatch(/helpers take the list itself/);
  });
});
