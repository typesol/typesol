// Remaining accounts passed to helpers, one (`function price(feed: RemainingAccount)`) or the list
// (`function health(rest: RemainingAccounts)`), as Marginfi's risk engine reads one
// oracle per bank: the helper reads the account's key, owner, data length and raw data, loads a struct of this program
// from it (a read-only view sees what the instruction already wrote through the same account), and writes one; an error
// it returns as a value fails the instruction with that code (`require(r.err === 0n, r.err)`).
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Address } from "@solana/kit";
import { web3 } from "@anchor-lang/core";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, acct, customError, deployFile, expectOk, fundedSigner, ix, pda, send, SYSTEM_PROGRAM, type Deployed } from "../harness.js";

const SOURCE = `import {
  type Init,
  type Mut,
  type Pubkey,
  type RemainingAccount,
  type RemainingAccounts,
  type Signer,
  type SystemProgram,
  type u32,
  type u64,
  loadAccount,
  loadAccountMut,
  readData,
  remainingAccounts,
  require,
} from "typesol";

export interface Counter { n: u64; owner: Pubkey }
export interface Reading { err: u32; n: u64 }
export enum E { Stale = "stale" }

/** A struct result instead of an abort: the caller decides what a failed read means. */
function rawCount(a: RemainingAccount, owner: Pubkey): Reading {
  if (a.dataLen < 24n || a.owner !== owner) return { err: 6100n, n: 0n };
  return { err: 0n, n: readData<u64>(a, 8n) };
}
function loaded(a: RemainingAccount): u64 {
  const c = loadAccount<Counter>(a);
  return c.n;
}
function add(a: RemainingAccount, by: u64): void {
  const c = loadAccountMut<Counter>(a);
  c.n += by;
}

/** A walk over the list, as Marginfi's risk engine walks [bank, oracle…] groups: the sum of the counters it finds. */
function total(rest: RemainingAccounts, from: u64): u64 {
  let sum = 0n;
  for (let i = from; i < rest.length; i++) sum += loaded(rest.get(i));
  return sum;
}
/** Passed on to another helper. */
function totalTwice(rest: RemainingAccounts): u64 {
  return total(rest, 0n) + total(rest, rest.length - 1n);
}

export function open(payer: Mut<Signer>, counter: Init<Counter>, system_program: SystemProgram): void {
  counter.create(payer, ["counter"]);
}
export function bump(user: Signer, counter: Mut<Counter>, program: Pubkey): void {
  counter.n += 1n;
  const rem = remainingAccounts();
  for (let i = 0n; i < rem.length; i++) {
    const r = rawCount(rem.get(i), program);
    require(r.err === 0n, r.err);
    require(r.n === counter.n && loaded(rem.get(i)) === counter.n, E.Stale);
  }
}
export function sum(user: Signer, counter: Mut<Counter>, want: u64): void {
  const rest = remainingAccounts();
  require(totalTwice(rest) === want && total(remainingAccounts(), 1n) + counter.n === want - counter.n, E.Stale);
}
export function grow(user: Signer, by: u64): void {
  add(remainingAccounts().get(0n), by);
}
export function regrow(user: Signer, by: u64): void {
  add(remainingAccounts().get(0n), by);
  add(remainingAccounts().get(0n), by);
}
`;

describe("remaining accounts as helper parameters", () => {
  let d: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-remhelper-"));
    writeFileSync(path.join(dir, "rem.ts"), SOURCE);
    d = await deployFile(path.join(dir, "rem.ts"));
  });

  it("reads raw data and loads structs, seeing the instruction's own writes", async () => {
    const payer = await fundedSigner(d.svm);
    const [c] = await pda(d.programId, ["counter"]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "open", {}, [{ address: payer.address, signer: payer, writable: true }, { address: c, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    const bump = (program: Address, rest: Address[]) =>
      ix(d, "bump", { program: new web3.PublicKey(program) }, [
        { address: payer.address, signer: payer },
        { address: c, writable: true },
        ...rest.map((address) => ({ address })),
      ]);
    expectOk(await send(d.svm, payer, [bump(d.programId, [c, c])]));
    expect(Buffer.from(acct(d.svm, c).data).readBigUInt64LE(8)).toBe(1n);
    // A wrong owner is a value the helper returns; the instruction fails with it (require with a run-time code).
    expect(customError(await send(d.svm, payer, [bump(SYSTEM_PROGRAM, [c])]))).toBe(6100);
    const addTo = (by: number) =>
      ix(d, "grow", { by: new BN(by) }, [
        { address: payer.address, signer: payer },
        { address: c, writable: true },
      ]);
    expectOk(await send(d.svm, payer, [addTo(5)]));
    expect(Buffer.from(acct(d.svm, c).data).readBigUInt64LE(8)).toBe(6n);
    // The whole list in a helper: counters at 6, the list [c, c, c]: 18 + 6 = 24, and 12 + 6 = 24 - 6.
    const sum = (want: number) =>
      ix(d, "sum", { want: new BN(want) }, [
        { address: payer.address, signer: payer },
        { address: c, writable: true },
        { address: c },
        { address: c },
        { address: c },
      ]);
    expectOk(await send(d.svm, payer, [sum(24)]));
    expect(customError(await send(d.svm, payer, [sum(25)]))).toBe(6000);
    // A helper's loadAccountMut claims the account for the rest of the instruction, as one in the instruction does:
    // a second call on the same account is refused (2040) and nothing is written.
    const twice = ix(d, "regrow", { by: new BN(2) }, [
      { address: payer.address, signer: payer },
      { address: c, writable: true },
    ]);
    expect(customError(await send(d.svm, payer, [twice]))).toBe(2040);
    expect(Buffer.from(acct(d.svm, c).data).readBigUInt64LE(8)).toBe(6n);
  });
});
