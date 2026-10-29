// What the coral-xyz/multisig port needed (examples/multisig.ts runs against the original in test/examples): a CPI
// decided at run time (invokeInstruction), Signed<…> (Anchor's `signer` constraint), Zeroed<…> of a @layout borsh
// struct and its Anchor order (2013 first), a Seeds bump stored in another account ("@acct.field"), a Vec copied whole
// into a FixedVec, and account-member names allowed in structs that are not account data.
import { generateKeyPairSigner, lamports } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, acct, address, compileErrors, customError, decodeAccount, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";
import { web3 } from "@anchor-lang/core";

const SOURCE = `import {
  type Account, type AccountInfo, type FixedVec, type Mut, type Pubkey, type Seeds, type Signed, type Signer, type UncheckedProgram,
  type Vec, type Zeroed, type u8, type u64, invokeInstruction, remainingAccounts, require, returnData,
} from "typesol";

/** Account-member names are fine in a struct that is not account data. */
export interface Meta { pubkey: Pubkey; isSigner: boolean; isWritable: boolean }
/** @layout borsh */
export interface Book { keys: FixedVec<Pubkey, 4>; bump: u8; total: u64 }

export function open(book: Signed<Zeroed<Book>>, keys: Vec<Pubkey>, bump: u8): void {
  book.keys = keys;
  book.bump = bump;
}
export function add(book: Mut<Book>, n: u64): void {
  book.total += n;
}
/** The book's PDA, its bump read from the book. */
export function check(book: Account<Book>, auth: Seeds<AccountInfo, ["@book"], "@book.bump">): void {}
/** Called through relay: auth must have signed (the PDA, by relay's seeds). */
export function echo(auth: Signer, n: u64): u64 {
  return n * 2n;
}
export function relay(book: Account<Book>, auth: Seeds<AccountInfo, ["@book"], "@book.bump">, self: UncheckedProgram, metas: Vec<Meta>, data: Vec<u8>): u64 {
  invokeInstruction(self.key, metas, data, remainingAccounts(), [book.key, book.bump]);
  return returnData<u64>(self);
}
export function relayUnsigned(self: UncheckedProgram, metas: Vec<Meta>, data: Vec<u8>): void {
  invokeInstruction(self.key, metas, data, remainingAccounts());
}
`;

describe("invokeInstruction, Signed, Zeroed borsh, stored bumps elsewhere, Vec into FixedVec", () => {
  let d: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-dyncpi-"));
    writeFileSync(path.join(dir, "dyn.ts"), SOURCE);
    d = await deployFile(path.join(dir, "dyn.ts"));
  });
  const pk = (a: string) => new web3.PublicKey(a);
  const u64 = (r: { returnData(): { data(): Uint8Array } }) => {
    const b = Buffer.alloc(8);
    Buffer.from(r.returnData().data()).copy(b);
    return b.readBigUInt64LE();
  };
  /** A zeroed, program-owned, rent-exempt account of `space` bytes (optionally with other bytes or another owner). */
  const allocate = async (space: number, opts: { data?: Uint8Array; owner?: string } = {}) => {
    const s = await generateKeyPairSigner();
    d.svm.setAccount({
      address: s.address,
      data: opts.data ?? new Uint8Array(space),
      executable: false,
      lamports: lamports(d.svm.minimumBalanceForRentExemption(BigInt(space))),
      programAddress: address(opts.owner ?? d.programId),
      space: BigInt(space),
    });
    return s;
  };
  async function book(keys: string[] = []) {
    const payer = await fundedSigner(d.svm);
    const b = await allocate(200);
    const [auth, bump] = await pda(d.programId, [b.address]);
    expectOk(await send(d.svm, payer, [ix(d, "open", { keys: keys.map(pk), bump }, [{ address: b.address, signer: b, writable: true }])]));
    return { payer, book: b.address, auth, bump, signer: b };
  }

  it("Zeroed<borsh struct>: starts empty, written as Borsh; Signed<…> must sign (2002); reuse is 2013, before the owner", async () => {
    const k = (await generateKeyPairSigner()).address;
    const { payer, book: addr, signer, bump } = await book([k, k]);
    const v = decodeAccount<{ keys: unknown[]; bump: number; total: BN }>(d, d.svm, "Book", addr);
    expect([v.keys.length, v.bump, v.total.toNumber()]).toEqual([2, bump, 0]);
    // Borsh: 8 + 4 + 2 × 32 + 1 + 8 bytes, the rest of the account untouched.
    expect(Buffer.from(acct(d.svm, addr).data).readUInt32LE(8)).toBe(2);
    expectOk(await send(d.svm, payer, [ix(d, "add", { n: new BN(5) }, [{ address: addr, writable: true }])]));
    expect(decodeAccount<{ total: BN }>(d, d.svm, "Book", addr).total.toNumber()).toBe(5);
    const open = (a: { address: typeof addr; signer?: typeof signer }) => ix(d, "open", { keys: [], bump: 0 }, [{ ...a, writable: true }]);
    expect(customError(await send(d.svm, payer, [open({ address: addr, signer })]))).toBe(2013);
    const fresh = await allocate(200);
    expect(customError(await send(d.svm, payer, [open({ address: fresh.address })]))).toBe(2002);
    // Already holding data and not ours: Anchor's `zero` reports the data first.
    const both = await allocate(200, { data: new Uint8Array(200).fill(1), owner: "11111111111111111111111111111111" });
    expect(customError(await send(d.svm, payer, [open({ address: both.address, signer: both })]))).toBe(2013);
    const small = await allocate(20);
    expect(customError(await send(d.svm, payer, [open({ address: small.address, signer: small })]))).toBe(3003);
    // More keys than the FixedVec holds: 5104, as push.
    const over = await allocate(400);
    const five = Array.from({ length: 5 }, () => pk(k));
    expect(customError(await send(d.svm, payer, [ix(d, "open", { keys: five, bump: 0 }, [{ address: over.address, signer: over, writable: true }])]))).toBe(
      5104,
    );
    expect((d.idl.instructions.find((i) => i.name === "open")!.accounts[0] as { signer?: boolean }).signer).toBe(true);
  });

  it('Seeds<…, "@book.bump">: the PDA with the bump stored in another account (2006 otherwise)', async () => {
    const { payer, book: addr, auth } = await book();
    expectOk(await send(d.svm, payer, [ix(d, "check", {}, [{ address: addr }, { address: auth }])]));
    const other = await book();
    expect(customError(await send(d.svm, payer, [ix(d, "check", {}, [{ address: addr }, { address: other.auth }])]))).toBe(2006);
  });

  it("invokeInstruction: metas and data from arguments, the PDA signing; missing or forged accounts fail in the runtime", async () => {
    const { payer, book: addr, auth } = await book();
    const echo = (n: number) => Buffer.from(d.coder.instruction.encode("echo", { n: new BN(n) }));
    const metas = [{ pubkey: pk(auth), is_signer: true, is_writable: false }];
    const relay = (rest: { address: typeof auth; writable?: boolean }[], m = metas) =>
      ix(d, "relay", { metas: m, data: echo(21) }, [{ address: addr }, { address: auth }, { address: d.programId }, ...rest]);
    expect(u64(expectOk(await send(d.svm, payer, [relay([{ address: auth }, { address: d.programId }])])))).toBe(42n);
    // The PDA not among the accounts handed over: the CPI cannot find it.
    const missing = await send(d.svm, payer, [relay([{ address: d.programId }])]);
    expect(missing).toBeInstanceOf(FailedTransactionMetadata);
    // Without seeds nothing signs for the PDA: privilege escalation, refused by the runtime.
    const unsigned = ix(d, "relay_unsigned", { metas, data: echo(1) }, [{ address: d.programId }, { address: auth }, { address: d.programId }]);
    expect(await send(d.svm, payer, [unsigned])).toBeInstanceOf(FailedTransactionMetadata);
    // A meta claiming writable where the transaction passed the account read-only: also refused.
    const writable = [{ pubkey: pk(auth), is_signer: true, is_writable: true }];
    expect(await send(d.svm, payer, [relay([{ address: auth }, { address: d.programId }], writable)])).toBeInstanceOf(FailedTransactionMetadata);
  });

  it("refuses what it cannot check", () => {
    const head = `import { type AccountInfo, type FixedVec, type Mut, type Pubkey, type Seeds, type Signer, type UncheckedProgram, type Vec, type u8, type u64, invokeInstruction, remainingAccounts } from "typesol";\n`;
    const errors = (body: string) => compileErrors(head + body);
    expect(errors(`export interface S { isSigner: boolean }\nexport function f(s: Mut<S>): void {}`)).toMatch(/account member/);
    expect(errors(`export interface S { k: Pubkey }\nexport function f(a: Seeds<AccountInfo, ["x"], "@s.k">, s: Mut<S>): void {}`)).toMatch(/u8 field/);
    expect(errors(`export function f(a: Seeds<AccountInfo, ["x"], "@nope.bump">): void {}`)).toMatch(/struct account parameter/);
    // A struct without the three fields is a type error; the data must be bytes.
    expect(
      errors(
        `export interface M { pubkey: Pubkey; isSigner: boolean }\nexport function f(p: UncheckedProgram, m: Vec<M>, d: Vec<u8>): void { invokeInstruction(p.key, m, d, remainingAccounts()); }`,
      ),
    ).toMatch(/isWritable/);
    expect(
      errors(
        `export interface M { pubkey: Pubkey; isSigner: boolean; isWritable: boolean }\nexport function f(p: UncheckedProgram, m: Vec<M>, d: Vec<u64>): void { invokeInstruction(p.key, m, d, remainingAccounts()); }`,
      ),
    ).toMatch(/list of u8/);
  });
});
