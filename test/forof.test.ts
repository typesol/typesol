// for (const x of list) over Vec and FixedArray: JS semantics (left-to-right, length read every step, break/continue),
// element references into account data, and the forms that are refused.
import { generateKeyPairSigner, getAddressDecoder, getAddressEncoder } from "@solana/kit";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { CompileError, generate } from "../src/compiler/index.js";
import { BN, SYSTEM_PROGRAM, decodeAccount, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "./harness.js";

const pk = (a: string) => ({ toBuffer: () => Buffer.from(getAddressEncoder().encode(a as never)) });
type Ledger = { marks: BN[]; entries: { who: { toBase58(): string }; amount: BN }[] };

describe("for (const x of list)", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/forof.ts", import.meta.url)));
  });

  const u64 = (r: Awaited<ReturnType<typeof send>>) => {
    const data = expectOk(r).returnData().data();
    return Buffer.from(data).readBigUInt64LE(0);
  };

  it("sums a Vec argument with continue and break", async () => {
    const payer = await fundedSigner(d.svm);
    const run = async (values: number[], stop: number) =>
      u64(await send(d.svm, payer, [ix(d, "sum_arg", { values: values.map((v) => new BN(v)), stop: new BN(stop) }, [])]));
    const js = (values: number[], stop: number) => {
      let t = 0;
      for (const v of values) {
        if (v === 0) continue;
        if (v > stop) break;
        t += v;
      }
      return BigInt(t);
    };
    for (const [values, stop] of [
      [[], 5],
      [[1, 2, 3], 10],
      [[4, 0, 5, 99, 7], 50],
      [[0, 0], 1],
    ] as [number[], number][])
      expect(await run(values, stop)).toBe(js(values, stop));
  });

  it("reads, writes and grows account data through the loop variable", async () => {
    const admin = await fundedSigner(d.svm);
    const [ledger] = await pda(d.programId, ["ledger", admin.address]);
    const me = { address: admin.address, signer: admin, writable: true };
    const l = { address: ledger, writable: true };
    expectOk(await send(d.svm, admin, [ix(d, "setup", {}, [me, l, { address: SYSTEM_PROGRAM }])]));
    const alice = (await generateKeyPairSigner()).address;
    const bob = (await generateKeyPairSigner()).address;
    for (const [who, amount] of [
      [alice, 5],
      [bob, 7],
      [alice, 11],
    ] as [string, number][])
      expectOk(await send(d.svm, admin, [ix(d, "add", { who: pk(who), amount: new BN(amount) }, [me, l, { address: SYSTEM_PROGRAM }])]));

    const total = async (who: string) => u64(await send(d.svm, admin, [ix(d, "total_of", { who: pk(who) }, [{ address: ledger }])]));
    expect([await total(alice), await total(bob)]).toEqual([16n, 7n]);

    expectOk(await send(d.svm, admin, [ix(d, "bump", { by: new BN(100) }, [l])]));
    let s = decodeAccount<Ledger>(d, d.svm, "Ledger", ledger);
    expect(s.entries.map((e) => e.amount.toNumber())).toEqual([105, 107, 111]);
    // Each mark: sum of amounts (323) + previous mark value (0) + its index.
    expect(s.marks.map((m) => m.toNumber())).toEqual([323, 324, 325, 326]);

    // Pushing inside the loop: 3 elements, 2 extra pushed and visited too.
    expect(u64(await send(d.svm, admin, [ix(d, "grow", { extra: new BN(2) }, [me, l, { address: SYSTEM_PROGRAM }])]))).toBe(5n);
    s = decodeAccount<Ledger>(d, d.svm, "Ledger", ledger);
    expect(s.entries.map((e) => e.amount.toNumber())).toEqual([105, 107, 111, 1, 1]);
    expect(getAddressDecoder().decode(new Uint8Array(pk(s.entries[3].who.toBase58()).toBuffer()))).toBe(alice);
  });

  it("refuses the forms it does not support, with a reason", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-forof-"));
    const errors = (body: string) => {
      const file = path.join(dir, `p${Math.random().toString(36).slice(2)}.ts`);
      writeFileSync(
        file,
        `import { type Account, type Vec, type u64, type Pubkey, remainingAccounts, log } from "typesol";\nexport interface S { owner: Pubkey; xs: Vec<u64> }\n${body}`,
      );
      try {
        generate(file);
        return [];
      } catch (e) {
        if (e instanceof CompileError) return e.diagnostics.map((x) => x.message);
        throw e;
      }
    };
    expect(errors(`export function f(s: Account<S>): void { for (let x of s.xs) log(x); }`)).toEqual([expect.stringMatching(/one const name/)]);
    expect(errors(`export function f(s: Account<S>): void { for (const x: u64 of s.xs) log(x); }`)).toEqual([
      expect.stringMatching(/cannot use a type annotation/),
    ]);
    expect(errors(`export function f(): void { for (const a of remainingAccounts()) log(1n); }`)).toEqual([
      expect.stringMatching(/iterate remaining accounts with for \(let i/),
    ]);
    expect(errors(`export function f(s: Account<S>): void { for (const x in s) log(1n); }`).join()).toMatch(/for \(const x of list\)/);
  });
});
