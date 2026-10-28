// Callback methods on lists, expanded into loops: forEach / some / every / find / findIndex / reduce / includes / indexOf.
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CompileError, generate } from "../src/compiler/index.js";
import { BN, SYSTEM_PROGRAM, customError, decodeAccount, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "./harness.js";
import { pk } from "./ports-helpers.js";

describe("list methods", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/listmethods.ts", import.meta.url)));
  });

  it("run callbacks over Vec, FixedArray, FixedVec and Vec arguments", async () => {
    const payer = await fundedSigner(d.svm);
    const [book] = await pda(d.programId, ["book", payer.address]);
    const B = { address: book, writable: true };
    expectOk(await send(d.svm, payer, [ix(d, "setup", {}, [{ address: payer.address, signer: payer, writable: true }, B, { address: SYSTEM_PROGRAM }])]));
    const r = expectOk(await send(d.svm, payer, [ix(d, "sweep", { limit: new BN(6) }, [{ address: payer.address, signer: payer }, B])]));
    // 1 closed, some open, every < 10, first empty at 1 (+1), total 12.
    expect(Buffer.from(r.returnData().data()).readBigUInt64LE(0)).toBe(1_000_000n + 100_000n + 10_000n + 2_000n + 12n);
    const b = decodeAccount<{ orders: { len: number; items: { open: boolean }[] } }>(d, d.svm, "Book", book);
    expect(b.orders.items.slice(0, 3).map((o) => o.open)).toEqual([true, false, false]); // the struct reference wrote through

    const scan = (who: string) =>
      send(d.svm, payer, [
        ix(d, "scan", { xs: [new BN(3), new BN(15), new BN(20)], who: pk(who as never) }, [{ address: payer.address, signer: payer }, { address: book }]),
      ]);
    const s = expectOk(await scan(payer.address));
    expect(Buffer.from(s.returnData().data()).readBigInt64LE(0)).toBe(15n * 1000n + 3n * 100n + 10n + 7n);
    const other = await fundedSigner(d.svm);
    expect(
      Buffer.from(
        expectOk(await scan(other.address))
          .returnData()
          .data(),
      ).readBigInt64LE(0),
    ).toBe(15n * 1000n + 3n * 100n + 7n);
  });

  it("map and filter: chains fused into one loop, and lists stored on the stack", async () => {
    const payer = await fundedSigner(d.svm);
    const [book] = await pda(d.programId, ["book", payer.address]);
    const B = { address: book, writable: true };
    expectOk(await send(d.svm, payer, [ix(d, "setup", {}, [{ address: payer.address, signer: payer, writable: true }, B, { address: SYSTEM_PROGRAM }])]));
    const r = expectOk(
      await send(d.svm, payer, [ix(d, "chains", { xs: [new BN(3), new BN(15), new BN(20)] }, [{ address: payer.address, signer: payer }, { address: book }])]),
    );
    const out = Buffer.from(r.returnData().data());
    const words = Array.from({ length: 10 }, (_, k) => out.readBigUInt64LE(k * 8));
    // orders [5 open, 0 closed, 7 open]; xs [3, 15, 20] filtered (> 5) to [15, 20], mapped with the post-filter index.
    expect(words).toEqual([2n, 24n, 1n, 150n, 2n, 20n, 201n, 4n, 13n, 7n]);
    const p = expectOk(await send(d.svm, payer, [ix(d, "pairs", {}, [{ address: payer.address, signer: payer }, { address: book }])]));
    // Open orders (5, 7) as { qty, doubled }: 2 of them, the second doubled 14; names[1] is "closed" (6 bytes).
    expect(Buffer.from(p.returnData().data()).readBigUInt64LE(0)).toBe(2000n + 140n + 6n);
  });

  it("refuses a full stored list at runtime, and map / filter shapes it cannot compile", async () => {
    const payer = await fundedSigner(d.svm);
    const call = (xs: number[]) => send(d.svm, payer, [ix(d, "too_small", { xs: xs.map((x) => new BN(x)) }, [{ address: payer.address, signer: payer }])]);
    expect(
      Buffer.from(
        expectOk(await call([4]))
          .returnData()
          .data(),
      ).readBigUInt64LE(0),
    ).toBe(1n);
    expect(customError(await call([4, 5]))).toBe(5104);

    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-mapfilter-"));
    const errors = (body: string) => {
      const file = path.join(dir, `p${Math.random().toString(36).slice(2)}.ts`);
      writeFileSync(file, `import { type u64, type Vec, type FixedVec, type Pubkey, fixedArray } from "typesol";\n${body}\n`);
      try {
        generate(file);
        return "";
      } catch (e) {
        if (e instanceof CompileError) return e.diagnostics.map((x) => x.message).join(" | ");
        throw e;
      }
    };
    expect(errors(`export function f(xs: Vec<u64>): u64 { xs.map((x) => x + 1n); return 0n; }`)).toMatch(/builds a new list: store it/);
    expect(errors(`export function f(xs: Vec<u64>): u64 { const ys = xs.filter((x) => x > 1n); return ys.length; }`)).toMatch(/no fixed size: annotate/);
    expect(errors(`export function f(xs: Vec<Pubkey>): u64 { const ys: FixedVec<Pubkey, 100> = xs.filter((x) => true); return ys.length; }`)).toMatch(
      /keep it under 2 KiB/,
    );
    expect(errors(`export function f(xs: Vec<u64>): u64 { return xs.map((x) => "a").length; }`)).toMatch(/map's callback returns integers/);
    expect(errors(`const g = (x: u64): u64 => x;\nexport function f(xs: Vec<u64>): u64 { return xs.map(g).length; }`)).toMatch(/arrow function written here/);
    expect(errors(`export function f(): u64 { const a = fixedArray<u64, 3>(1n); const b = a.map((x) => x * 2n); return b.get(2n); }`)).toBe("");
  });
});
