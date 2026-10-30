// Accounts an instruction loads itself, as Raydium CLMM's tick arrays: big-endian integer seeds (`"@start:be"`,
// `bigEndian(x)`), loadAccount / loadAccountMut on AccountInfo parameters (Anchor's AccountLoader::try_from on an
// UncheckedAccount) including two Dup<…> views of one account, a loaded struct passed to helpers as Mut<T>, and a seed
// list chosen at run time (`cond ? signer(a) : signer(b)`).
import { type Address, lamports } from "@solana/kit";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, acct, compileErrors, customError, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

const SOURCE = `import {
  type AccountInfo,
  type Dup,
  type Mut,
  type Pubkey,
  type Seeds,
  type Signer,
  type SystemProgram,
  type i32,
  type u64,
  bigEndian,
  findProgramAddress,
  findProgramAddressBump,
  initAccount,
  loadAccount,
  loadAccountMut,
  programId,
  rentExempt,
  require,
  signer,
} from "typesol";

export interface Slot { owner: Pubkey; start: i32; count: u64 }
export interface Jar { lamports: u64 }

/** A field named like an account property stays the field. */
export function jar(a: AccountInfo): u64 {
  const j = loadAccount<Jar>(a);
  return j.lamports;
}

/** Created at ["slot", owner, start as big-endian bytes] when it does not exist yet. */
export function open(
  payer: Mut<Signer>,
  slot: Seeds<Mut<AccountInfo>, ["slot", "@payer", "@start:be"]>,
  system: SystemProgram,
  start: i32,
): void {
  if (slot.lamports === 0n) {
    system.createAccount(payer, slot, rentExempt(52n), 52n, programId(), ["slot", payer.key, bigEndian(start), slot.pdaBump]);
    const s = initAccount<Slot>(slot);
    s.owner = payer.key;
    s.start = start;
  }
}

function bump(s: Mut<Slot>, by: u64): void {
  s.count += by;
}

/** Two slots, possibly one account passed twice: each loaded, both counted through a helper. */
export function count(a: Mut<AccountInfo>, b: Dup<Mut<AccountInfo>>): void {
  const x = loadAccountMut<Slot>(a);
  const y = loadAccountMut<Slot>(b);
  bump(x, 1n);
  bump(y, 10n);
  require(x.key === a.key, "the loaded struct is its account");
}

/** The same parameter loaded twice: refused (2040). */
export function twice(a: Mut<AccountInfo>): void {
  const x = loadAccountMut<Slot>(a);
  const y = loadAccountMut<Slot>(a);
  x.count += y.count;
}

/** Pays out of a PDA vault ["vault", owner] or ["vault", owner, index], whichever this one is. */
export function pay(vault: Mut<AccountInfo>, owner: AccountInfo, to: Mut<AccountInfo>, system: SystemProgram, index: u64, amount: u64): void {
  const plain = vault.key === findProgramAddress(["vault", owner.key], programId());
  const b0 = findProgramAddressBump(["vault", owner.key], programId());
  const b1 = findProgramAddressBump(["vault", owner.key, index], programId());
  const seeds = plain ? signer(["vault", owner.key, b0]) : signer(["vault", owner.key, index, b1]);
  system.transfer(vault, to, amount, seeds);
}
`;

describe("accounts loaded in the body", () => {
  let d: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-loaded-"));
    writeFileSync(path.join(dir, "slots.ts"), SOURCE);
    d = await deployFile(path.join(dir, "slots.ts"));
  });
  const be32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n);
    return b;
  };
  const open = (payer: Awaited<ReturnType<typeof fundedSigner>>, slot: Address, start: number) =>
    ix(d, "open", { start }, [{ address: payer.address, signer: payer, writable: true }, { address: slot, writable: true }, { address: SYSTEM_PROGRAM }]);

  it("derives and signs with big-endian integer seeds, and records them as Anchor does", async () => {
    const payer = await fundedSigner(d.svm);
    for (const start of [-3600, 7, 92_580]) {
      const [slot] = await pda(d.programId, ["slot", payer.address, be32(start)]);
      expectOk(await send(d.svm, payer, [open(payer, slot, start)]));
      expect(Buffer.from(acct(d.svm, slot).data).readInt32LE(40)).toBe(start);
    }
    // The little-endian address is not the PDA.
    const le = Buffer.alloc(4);
    le.writeInt32LE(5);
    const [wrong] = await pda(d.programId, ["slot", payer.address, le]);
    expect(customError(await send(d.svm, payer, [open(payer, wrong, 5)]))).toBe(2006);
    const seeds = (d.idl.instructions.find((i) => i.name === "open")!.accounts[1] as { pda: { seeds: unknown[] } }).pda.seeds;
    expect(seeds[2]).toEqual({ kind: "arg", path: "start" });
  });

  it("loads AccountInfo parameters, two views of one account with Dup, and passes them to helpers", async () => {
    const payer = await fundedSigner(d.svm);
    const [a] = await pda(d.programId, ["slot", payer.address, be32(1)]);
    const [b] = await pda(d.programId, ["slot", payer.address, be32(2)]);
    expectOk(await send(d.svm, payer, [open(payer, a, 1), open(payer, b, 2)]));
    const count = (x: Address, y: Address) =>
      ix(d, "count", {}, [
        { address: x, writable: true },
        { address: y, writable: true },
      ]);
    const n = (k: Address) => Buffer.from(acct(d.svm, k).data).readBigUInt64LE(44);
    expectOk(await send(d.svm, payer, [count(a, b)]));
    expect([n(a), n(b)]).toEqual([1n, 10n]);
    // One account as both: each write is seen through the other view.
    expectOk(await send(d.svm, payer, [count(a, a)]));
    expect(n(a)).toBe(12n);
    expect(customError(await send(d.svm, payer, [ix(d, "twice", {}, [{ address: a, writable: true }])]))).toBe(2040);
    // An account of another program, and an empty one.
    d.svm.setAccount({ address: b, data: new Uint8Array(52), executable: false, lamports: lamports(10_000_000n), programAddress: SYSTEM_PROGRAM, space: 52n });
    expect(customError(await send(d.svm, payer, [count(a, b)]))).toBe(3007);
  });

  it("reads a struct field named like an account property as the field", async () => {
    const payer = await fundedSigner(d.svm);
    const k = (await fundedSigner(d.svm)).address;
    const data = Buffer.concat([createHash("sha256").update("account:Jar").digest().subarray(0, 8), Buffer.from(new BigUint64Array([42n]).buffer)]);
    d.svm.setAccount({ address: k, data: new Uint8Array(data), executable: false, lamports: lamports(10_000_000n), programAddress: d.programId, space: 16n });
    const res = expectOk(await send(d.svm, payer, [ix(d, "jar", {}, [{ address: k }])]));
    expect(Buffer.from(res.returnData().data()).readBigUInt64LE(0)).toBe(42n);
  });

  it("signs with a seed list picked at run time", async () => {
    const payer = await fundedSigner(d.svm);
    const to = await fundedSigner(d.svm);
    const index = 3n;
    const idx = Buffer.alloc(8);
    idx.writeBigUInt64LE(index);
    for (const seeds of [
      ["vault", payer.address],
      ["vault", payer.address, idx],
    ] as const) {
      const [vault] = await pda(d.programId, [...seeds]);
      d.svm.airdrop(vault, lamports(1_000_000_000n));
      const pay = ix(d, "pay", { index: new BN(3), amount: new BN(1_000) }, [
        { address: vault, writable: true },
        { address: payer.address },
        { address: to.address, writable: true },
        { address: SYSTEM_PROGRAM },
      ]);
      expectOk(await send(d.svm, payer, [pay]));
    }
  });

  it("explains misuse", () => {
    const errs = (body: string) =>
      compileErrors(
        `import { type AccountInfo, type Mut, type Seeds, type i32, type u64, type Pubkey, bigEndian, findProgramAddress, loadAccountMut, programId } from "typesol";\n` +
          `export interface Slot { owner: Pubkey; count: u64 }\n${body}`,
      );
    expect(errs(`export function f(a: AccountInfo): void { const x = loadAccountMut<Slot>(a); x.count = 1n; }`)).toContain("Mut<AccountInfo>");
    expect(errs(`export function f(a: Seeds<Mut<AccountInfo>, ["s", "@a:be"]>): void { a.lamports; }`)).toContain("only integers have a byte order");
    expect(errs(`export function f(x: i32): Pubkey { return findProgramAddress(["s", bigEndian(7n)], programId()); }`)).toContain("not a literal");
    expect(errs(`export function f(x: i32): void { const s = bigEndian(x); }`)).toContain("inside a seeds list");
    expect(
      errs(
        `function h(a: Mut<AccountInfo>): void { const x = loadAccountMut<Slot>(a); x.count = 1n; }\nexport function f(a: Mut<AccountInfo>): void { h(a); }`,
      ),
    ).toContain("load a in the instruction");
  });
});
