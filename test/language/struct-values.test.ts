// Struct values a function holds: a literal with `fixedArray<T, N>(fill)` fields, filled in place and updated; passed
// to a helper that writes account data, which reads it in place (it is not account data, so nothing it writes can
// change it); `@bytes` on a FixedArray of integers in the IDL.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, acct, deployFile, expectOk, fundedSigner, ix, pda, send, SYSTEM_PROGRAM, type Deployed } from "../harness.js";

const SOURCE = `import { type FixedArray, type Init, type Mut, type Signer, type SystemProgram, type u8, fixedArray, u64 } from "typesol";

export interface Tally { total: u64; counts: FixedArray<u64, 4>; tags: FixedArray<u8, 4> }
export interface Store {
  sum: u64;
  /** @bytes */
  bits: FixedArray<u64, 4>;
}

function tally(by: u64): Tally {
  const t: Tally = { total: 0n, counts: fixedArray<u64, 4>(by), tags: fixedArray<u8, 4>(7n) };
  for (let i = 0n; i < 4n; i++) {
    t.counts.set(i, t.counts.get(i) + i);
    t.total += t.counts.get(i);
  }
  return t;
}
/** Writes the account it is given, then reads the tally it was given: still the caller's values. */
function save(store: Mut<Store>, t: Tally): void {
  store.sum = 0n;
  for (let i = 0n; i < 4n; i++) store.bits.set(i, t.counts.get(i) + u64(t.tags.get(i)));
  store.sum = t.total;
}

export function open(payer: Mut<Signer>, store: Init<Store>, system_program: SystemProgram): void {
  store.create(payer, ["store"]);
}
export function run(store: Mut<Store>, by: u64): void {
  const t = tally(by);
  save(store, t);
}
`;

describe("struct values a function holds", () => {
  let d: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-structvalues-"));
    writeFileSync(path.join(dir, "sv.ts"), SOURCE);
    d = await deployFile(path.join(dir, "sv.ts"));
  });

  it("fills array fields in place and passes the value to a helper that writes accounts", async () => {
    const payer = await fundedSigner(d.svm);
    const [s] = await pda(d.programId, ["store"]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "open", {}, [{ address: payer.address, signer: payer, writable: true }, { address: s, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    expectOk(await send(d.svm, payer, [ix(d, "run", { by: new BN(10) }, [{ address: s, writable: true }])]));
    const data = Buffer.from(acct(d.svm, s).data);
    // counts 10, 11, 12, 13 (total 46); bits = counts + 7.
    expect(data.readBigUInt64LE(8)).toBe(46n);
    expect([0, 1, 2, 3].map((i) => data.readBigUInt64LE(16 + 8 * i))).toEqual([17n, 18n, 19n, 20n]);
  });

  it("shows a @bytes FixedArray as arrays of bytes in the IDL", () => {
    const store = (d.idl.types ?? []).find((t) => t.name === "Store") as { type: { fields: { name: string; type: unknown }[] } };
    expect(store.type.fields.find((f) => f.name === "bits")?.type).toEqual({ array: [{ array: ["u8", 8] }, 4] });
  });
});
