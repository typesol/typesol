// Several growable Vecs in one account: each push / pop / clear moves the Vecs stored after it, the account's size
// follows every length, and the bytes are what the IDL (and Anchor's coder) say.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CompileError, generate } from "../src/compiler/index.js";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, customError, decodeAccount, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "./harness.js";

const TOO_SMALL = 3003; // AccountDidNotDeserialize

describe("several growable Vecs in one account", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/multivec.ts", import.meta.url)));
  });

  it("grows and shrinks each Vec, moving the ones after it", async () => {
    const payer = await fundedSigner(d.svm);
    const [bag] = await pda(d.programId, ["bag", payer.address]);
    const P = { address: payer.address, signer: payer, writable: true };
    const B = { address: bag, writable: true };
    expectOk(await send(d.svm, payer, [ix(d, "open", {}, [P, B, { address: SYSTEM_PROGRAM }])]));
    for (const [tag, id, mark] of [
      [1, 10, 7],
      [2, 20, 8],
      [3, 30, 9],
    ])
      expectOk(await send(d.svm, payer, [ix(d, "add", { tag: new BN(tag), id, mark }, [P, B, { address: SYSTEM_PROGRAM }])]));
    type BagData = { owner: unknown; count: BN; tags: BN[]; entries: { id: number; score: BN }[]; marks: number[] | Buffer };
    const read = () => {
      const b = decodeAccount<BagData>(d, d.svm, "Bag", bag);
      return {
        count: b.count.toNumber(),
        tags: b.tags.map((x) => x.toNumber()),
        entries: b.entries.map((e) => [e.id, e.score.toNumber()]),
        marks: [...b.marks],
      };
    };
    const size = () => {
      const a = d.svm.getAccount(bag);
      return a.exists ? a.data.length : 0;
    };
    // The IDL lists the stored order (owner, count, then the Vecs), which Anchor's coder reads as Borsh.
    expect(d.idl.types!.find((t) => t.name === "Bag")!.type).toMatchObject({
      fields: [{ name: "owner" }, { name: "count" }, { name: "tags" }, { name: "entries" }, { name: "marks" }],
    });
    expect(read()).toEqual({
      count: 3,
      tags: [1, 2, 3],
      entries: [
        [10, 2],
        [20, 4],
        [30, 6],
      ],
      marks: [7, 8, 9],
    });
    expect(size()).toBe(8 + 32 + 8 + (4 + 3 * 8) + (4 + 3 * 12) + (4 + 3));

    const total = async () =>
      Buffer.from(
        expectOk(await send(d.svm, payer, [ix(d, "total", {}, [{ address: bag }])]))
          .returnData()
          .data(),
      ).readBigUInt64LE(0);
    expect(await total()).toBe(3000n + 6n + 1200n + 240_000n);

    const popped = expectOk(await send(d.svm, payer, [ix(d, "drop_tag", {}, [P, B])]));
    expect(Buffer.from(popped.returnData().data()).readBigUInt64LE(0)).toBe(3n);
    expect(read()).toEqual({
      count: 3,
      tags: [1, 2],
      entries: [
        [10, 2],
        [20, 4],
        [30, 6],
      ],
      marks: [7, 8, 9],
    });
    expectOk(await send(d.svm, payer, [ix(d, "clear_entries", {}, [P, B])]));
    expect(read()).toEqual({ count: 3, tags: [1, 2], entries: [], marks: [7, 8, 9] });
    expect(size()).toBe(8 + 32 + 8 + (4 + 2 * 8) + 4 + (4 + 3));
    expect(await total()).toBe(3000n + 3n + 240_000n);

    // A length that does not match the account's size is refused before the body runs (each length read in bounds).
    const a = d.svm.getAccount(bag);
    if (!a.exists) throw new Error("no bag");
    const bad = Uint8Array.from(a.data);
    bad[8 + 32 + 8 + 4 + 16] = 200; // entries' length, past what the account holds
    d.svm.setAccount({
      address: bag,
      data: bad,
      executable: false,
      lamports: a.lamports,
      programAddress: a.programAddress,
      space: BigInt(bad.length),
    } as never);
    expect(customError(await send(d.svm, payer, [ix(d, "total", {}, [{ address: bag }])]))).toBe(TOO_SMALL);
  });

  it("refuses references into a Vec that moves, and a Vec before other fields in Anchor's layout", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-multivec-"));
    const errors = (body: string) => {
      const file = path.join(dir, `p${Math.random().toString(36).slice(2)}.ts`);
      writeFileSync(file, `import { type Mut, type Signer, type SystemProgram, type Vec, type u64 } from "typesol";\n${body}\n`);
      try {
        generate(file);
        return "";
      } catch (e) {
        if (e instanceof CompileError) return e.diagnostics.map((x) => x.message).join(" | ");
        throw e;
      }
    };
    const bag = "export interface E { v: u64; }\nexport interface B { a: Vec<u64>; b: Vec<E>; }\n";
    const ok = `${bag}export function f(p: Mut<Signer>, x: Mut<B>, s: SystemProgram): void { x.a.push(1n, p); const e = x.b.get(0n); e.v = 2n; }`;
    expect(errors(ok)).toBe("");
    const moved = `${bag}export function f(p: Mut<Signer>, x: Mut<B>, s: SystemProgram): void { const e = x.b.get(0n); x.a.push(1n, p); e.v = 2n; }`;
    expect(errors(moved)).toMatch(/still refers to x\.b\[\]/);
    const borsh = "/** @layout borsh */\nexport interface B { a: Vec<u64>; n: u64; }\nexport function f(x: Mut<B>): void {}";
    expect(errors(borsh)).toMatch(/@layout borsh struct a Vec<T> field must be the last field/);
  });
});
