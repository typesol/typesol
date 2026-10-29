// Instruction introspection (the Instructions sysvar: length, currentIndex, get(i) and what an instruction holds) and
// stackHeight(): the reads, their bounds (5104), `is(program, name)`, and refusing CPI callers.
import { type Address, address, getAddressEncoder } from "@solana/kit";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, customError, deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "../harness.js";

const IXS = address("Sysvar1nstructions1111111111111111111111111");
const SOURCE = `import { type InstructionsSysvar, type Pubkey, type UncheckedProgram, type u64, type u8, invoke, require, returnData, sighash, stackHeight } from "typesol";

/** length, current index, and the shape of instruction i, packed in one number. */
export function shape(ixs: InstructionsSysvar, i: u64): u64 {
  const ix = ixs.get(i);
  return ixs.length * 1000000n + ixs.currentIndex() * 10000n + ix.accountsLength * 100n + ix.dataLength;
}
export function word(ixs: InstructionsSysvar, i: u64, offset: u64): u64 {
  return ixs.get(i).readU64(offset);
}
export function key(ixs: InstructionsSysvar, i: u64, j: u64): Pubkey {
  return ixs.get(i).accountKey(j);
}
export function flags(ixs: InstructionsSysvar, i: u64, j: u64): u8 {
  const ix = ixs.get(i);
  let f: u8 = 0n;
  if (ix.accountIsSigner(j)) f += 1n;
  if (ix.accountIsWritable(j)) f += 2n;
  return f;
}
/** This program's \`marker\` must come right after. */
export function needsMarker(ixs: InstructionsSysvar, self: UncheckedProgram): void {
  const next = ixs.get(ixs.currentIndex() + 1n);
  require(next.is(self.key, "marker"), "marker must follow");
  require(next.programId === self.key, "same program");
}
export function marker(): void {}
export function height(): u64 {
  return stackHeight();
}
/** height() called through a CPI into this same program: 2. */
export function nested(self: UncheckedProgram): u64 {
  invoke(self, [], [sighash("height")]);
  return returnData<u64>(self);
}
export function topLevelOnly(): void {
  require(stackHeight() === 1n, "no CPI callers");
}
export function viaCpi(self: UncheckedProgram): void {
  invoke(self, [], [sighash("top_level_only")]);
}
`;

describe("instruction introspection and stackHeight", () => {
  let d: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-ixs-"));
    writeFileSync(path.join(dir, "ixs.ts"), SOURCE);
    d = await deployFile(path.join(dir, "ixs.ts"));
  });
  // Return data drops trailing zero bytes (Solana's rule): pad back to 8.
  const u64 = (r: { returnData(): { data(): Uint8Array } }) => {
    const b = Buffer.alloc(8);
    Buffer.from(r.returnData().data()).copy(b);
    return b.readBigUInt64LE();
  };

  it("reads the transaction's instructions; out-of-range reads fail with 5104", async () => {
    const payer = await fundedSigner(d.svm);
    const other = await fundedSigner(d.svm);
    // Instruction 1 (marker) gets two extra accounts so it has a shape: [other: signer+writable, IXS: readonly].
    const marker = ix(d, "marker", {}, [{ address: other.address, signer: other, writable: true }, { address: IXS }]);
    // The instruction read back goes last: a transaction's return data is its last instruction's.
    const shape = (i: number) => ix(d, "shape", { i: new BN(i) }, [{ address: IXS }]);
    // 2 instructions, current 1; instruction 0 (marker) has 2 accounts and 8 bytes of data (its discriminator).
    expect(u64(expectOk(await send(d.svm, payer, [marker, shape(0)])))).toBe(2_000_000n + 10_000n + 200n + 8n);
    // 3 instructions, current 2; instruction 2 is shape itself: 1 account, 16 bytes (discriminator + i).
    expect(u64(expectOk(await send(d.svm, payer, [marker, marker, shape(2)])))).toBe(3_000_000n + 20_000n + 100n + 16n);
    const word = (i: number, off: number) => ix(d, "word", { i: new BN(i), offset: new BN(off) }, [{ address: IXS }]);
    // Instruction 0 is `word` itself: its data is discriminator + i + offset; offset 8 is i (0).
    expect(u64(expectOk(await send(d.svm, payer, [word(0, 8)])))).toBe(0n);
    expect(u64(expectOk(await send(d.svm, payer, [word(0, 16)])))).toBe(16n); // reads its own `offset`
    expect(customError(await send(d.svm, payer, [word(0, 17)]))).toBe(5104); // 8 bytes from 17 pass the end (24)
    expect(customError(await send(d.svm, payer, [word(5, 0)]))).toBe(5104); // no instruction 5

    const key = ix(d, "key", { i: new BN(0), j: new BN(0) }, [{ address: IXS }]);
    const got = expectOk(await send(d.svm, payer, [marker, key]));
    expect(Buffer.from(got.returnData().data())).toEqual(Buffer.from(getAddressEncoder().encode(other.address as Address)));
    const flags = (j: number) => ix(d, "flags", { i: new BN(0), j: new BN(j) }, [{ address: IXS }]);
    expect(
      Buffer.from(
        expectOk(await send(d.svm, payer, [marker, flags(0)]))
          .returnData()
          .data(),
      )[0],
    ).toBe(3);
    expect(
      Buffer.from(
        expectOk(await send(d.svm, payer, [marker, flags(1)]))
          .returnData()
          .data(),
      )[0] ?? 0,
    ).toBe(0);
    expect(customError(await send(d.svm, payer, [marker, flags(2)]))).toBe(5104);
    // Another address than the sysvar: 3008.
    expect(customError(await send(d.svm, payer, [ix(d, "shape", { i: new BN(0) }, [{ address: other.address }])]))).toBe(3008);
  });

  it("is(program, name): the next instruction must be this program's marker", async () => {
    const payer = await fundedSigner(d.svm);
    const needs = ix(d, "needs_marker", {}, [{ address: IXS }, { address: d.programId }]);
    const marker = ix(d, "marker", {}, []);
    expectOk(await send(d.svm, payer, [needs, marker]));
    expect(customError(await send(d.svm, payer, [needs, ix(d, "height", {}, [])]))).toBe(6000); // another instruction
    expect(customError(await send(d.svm, payer, [needs]))).toBe(5104); // none at all
  });

  it("stackHeight(): 1 at the top level, 2 through a CPI, and CPI callers can be refused", async () => {
    const payer = await fundedSigner(d.svm);
    expect(u64(expectOk(await send(d.svm, payer, [ix(d, "height", {}, [])])))).toBe(1n);
    expect(u64(expectOk(await send(d.svm, payer, [ix(d, "nested", {}, [{ address: d.programId }])])))).toBe(2n);
    expectOk(await send(d.svm, payer, [ix(d, "top_level_only", {}, [])]));
    expect(customError(await send(d.svm, payer, [ix(d, "via_cpi", {}, [{ address: d.programId }])]))).toBe(6002);
  });
});
