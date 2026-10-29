// Vec<T> in a @layout borsh struct: Anchor's Vec. Any field position, held on the heap while the instruction runs,
// bounded only by the account when it is written back (3004); the bytes are Borsh, as Anchor writes them.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { web3 } from "@anchor-lang/core";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, acct, compileErrors, customError, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

const SOURCE = `import { type Init, type Mut, type Pubkey, type Signer, type SystemProgram, type Vec, type u64, realloc } from "typesol";

/** @layout borsh */
export interface Roster { ids: Vec<u64>; admin: Pubkey; members: Vec<Pubkey>; count: u64 }

export function open(payer: Mut<Signer>, roster: Init<Roster>, systemProgram: SystemProgram, ids: Vec<u64>, space: u64): void {
  roster.create(payer, ["roster", payer.key], space);
  roster.ids = ids;
  roster.admin = payer.key;
  roster.count = ids.length;
}
export function add(roster: Mut<Roster>, member: Pubkey, times: u64): void {
  for (let i = 0n; i < times; i++) roster.members.push(member);
  roster.count += times;
}
/** Over the account in the middle, back under it by the end: fine, only the written value counts. */
export function surge(roster: Mut<Roster>, member: Pubkey, times: u64): void {
  for (let i = 0n; i < times; i++) roster.members.push(member);
  for (let i = 0n; i < times; i++) roster.members.pop();
}
export function edit(roster: Mut<Roster>): void {
  roster.ids.set(0n, roster.ids.get(0n) + 100n);
  roster.members.clear();
}
/** @layout borsh */
export interface Batch { label: u64; xs: Vec<u64>; tail: u64 }
/** A whole Borsh argument holding a Vec, as an Anchor client sends it. */
export function total(b: Batch): u64 {
  let t = b.label + b.tail;
  for (const x of b.xs) t += x;
  return t;
}
export function grow(payer: Mut<Signer>, roster: Mut<Roster>, systemProgram: SystemProgram, space: u64): void {
  realloc(roster, space, payer);
}
`;

describe("Vec<T> in a @layout borsh struct", () => {
  let d: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-borshvec-"));
    writeFileSync(path.join(dir, "r.ts"), SOURCE);
    d = await deployFile(path.join(dir, "r.ts"));
  });
  const decode = (a: Parameters<typeof acct>[1]) =>
    d.coder.accounts.decode("Roster", Buffer.from(acct(d.svm, a).data)) as { ids: BN[]; members: unknown[]; count: BN };

  it("is stored as Borsh in any position and bounded only by the account (3004)", async () => {
    const payer = await fundedSigner(d.svm);
    const [roster] = await pda(d.programId, ["roster", payer.address]);
    // 8 + (4 + 3×8) + 32 + (4 + n×32) + 8 bytes: room for 5 members in 240 bytes.
    const open = ix(d, "open", { ids: [1, 2, 3].map((n) => new BN(n)), space: new BN(240) }, [
      { address: payer.address, signer: payer, writable: true },
      { address: roster, writable: true },
      { address: SYSTEM_PROGRAM },
    ]);
    expectOk(await send(d.svm, payer, [open]));
    const m = d.programId; // any key
    const add = async (times: number) => ix(d, "add", { member: new web3.PublicKey(m), times: new BN(times) }, [{ address: roster, writable: true }]);
    expectOk(await send(d.svm, payer, [await add(5)]));
    let v = decode(roster);
    expect([v.ids.map((x) => x.toNumber()), v.members.length, v.count.toNumber()]).toEqual([[1, 2, 3], 5, 8]);
    // A sixth member does not fit when the account is written back.
    expect(customError(await send(d.svm, payer, [await add(1)]))).toBe(3004);
    // Past the account in the middle of an instruction and back: fine (only the value written back counts).
    const surge = ix(d, "surge", { member: new web3.PublicKey(m), times: new BN(50) }, [{ address: roster, writable: true }]);
    expectOk(await send(d.svm, payer, [surge]));
    expectOk(await send(d.svm, payer, [ix(d, "edit", {}, [{ address: roster, writable: true }])]));
    v = decode(roster);
    expect([v.ids[0]!.toNumber(), v.members.length]).toEqual([101, 0]);
    // A larger account holds more: realloc, then six fit.
    expectOk(
      await send(d.svm, payer, [
        ix(d, "grow", { space: new BN(400) }, [
          { address: payer.address, signer: payer, writable: true },
          { address: roster, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    expectOk(await send(d.svm, payer, [await add(6)]));
    expect(decode(roster).members.length).toBe(6);
  });

  it("takes a whole Borsh argument holding a Vec", async () => {
    const payer = await fundedSigner(d.svm);
    const res = expectOk(
      await send(d.svm, payer, [ix(d, "total", { b: { label: new BN(1000), xs: [1, 2, 3, 4].map((n) => new BN(n)), tail: new BN(5) } }, [])]),
    );
    const b = Buffer.alloc(8);
    Buffer.from(res.returnData().data()).copy(b);
    expect(b.readBigUInt64LE()).toBe(1015n);
  });

  it("refuses what would share or outlive a list on the heap", () => {
    const head = `import { type FixedArray, type Init, type Mut, type Pubkey, type Signer, type SystemProgram, type Vec, type u64, emit } from "typesol";\n/** @layout borsh */\nexport interface R { xs: Vec<u64>; n: u64 }\n`;
    const errors = (body: string) => compileErrors(head + body);
    expect(errors(`export function f(p: Mut<Signer>, r: Init<R>, s: SystemProgram): void { r.create(p, ["r"]); }`)).toMatch(/pass the account's space/);
    expect(errors(`export function f(r: R): u64 { return r.xs.length; }`)).toBe(""); // a whole argument, read-only
    expect(errors(`export function f(): void { emit<R>({ xs: [] as never, n: 1n }); }`)).toMatch(/events take a struct with FixedVec/);
    expect(errors(`export function f(a: Mut<R>, b: Mut<R>): void { a.xs = b.xs; }`)).toBe("");
    expect(errors(`/** @layout borsh */\nexport interface Q { xs: Vec<FixedArray<u64, 2>> }\nexport function f(q: Mut<Q>): void {}`)).toMatch(
      /its elements are/,
    );
  });
});
