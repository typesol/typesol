// What porting Marginfi's zero-copy accounts needed: error codes that jump (`/** @code 6200 */`, Anchor's `X = 200`),
// integers the IDL shows as bytes (`/** @bytes */`, WrappedI80F48), IDL names the source cannot use (`/** @idlName _pad0 */`,
// a `key_` field for Rust's `key`), and the IDL's repr / serialization of zero-copy types (`/** @repr c */`,
// `/** @serialization bytemuck */`), with repr(C)'s field offsets checked.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { web3 } from "@anchor-lang/core";
import { BN, SYSTEM_PROGRAM, acct, compileErrors, customError, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

const SOURCE = `import { type Account, type FixedArray, type Init, type Mut, type Pubkey, type Signer, type SystemProgram, type i128, type u8, type u16, type u32, type u64, require } from "typesol";

export enum E {
  First = "first",
  /** @code 6200 */
  Jumped = "jumped",
  Next = "next",
}
/** @repr rust */
export enum Side {
  Bid,
  Ask,
}
/** A wrapped fixed-point value. */
/** @repr c */
export interface Wrapped {
  /** @bytes */
  value: i128;
}
/**
 * @serialization bytemuck
 * @repr c
 */
export interface Book {
  key_: Pubkey;
  flag: u8;
  /** @idlName _pad0 */
  pad0: FixedArray<u8, 7>;
  price: Wrapped;
  count: u64;
  side: Side;
  /** @idlName _pad1 */
  pad1: FixedArray<u8, 7>;
}

export function make(book: Init<Book>, payer: Mut<Signer>, system_program: SystemProgram, price: i128, owner: Pubkey): void {
  book.create(payer, ["book"]);
  book.key_ = owner;
  book.price.value = price;
  book.count = 7n;
}
export function check(book: Account<Book>, n: u8): void {
  require(n !== 1n, E.First);
  require(n !== 2n, E.Jumped);
  require(n !== 3n, E.Next);
  require(n !== 4n, "a message");
}
`;

describe("zero-copy shapes", () => {
  let dir: string;
  let d: Deployed;
  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "typesol-zc-"));
    writeFileSync(path.join(dir, "book.ts"), SOURCE);
    d = await deployFile(path.join(dir, "book.ts"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("numbers errors from a @code on, and require() messages after the highest", async () => {
    expect(d.idl.errors).toEqual([
      { code: 6000, name: "First", msg: "first" },
      { code: 6200, name: "Jumped", msg: "jumped" },
      { code: 6201, name: "Next", msg: "next" },
      { code: 6202, name: "RequireFailed202", msg: "a message" },
    ]);
    const payer = await fundedSigner(d.svm);
    const [book] = await pda(d.programId, ["book"]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "make", { price: new BN("-12345678901234567890123"), owner: new web3.PublicKey(payer.address) }, [
          { address: book, writable: true },
          { address: payer.address, signer: payer, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    for (const [n, code] of [
      [1, 6000],
      [2, 6200],
      [3, 6201],
      [4, 6202],
    ] as const)
      expect(customError(await send(d.svm, payer, [ix(d, "check", { n }, [{ address: book }])]))).toBe(code);
    // The bytes: the owner where `key` is, the i128 little-endian after the padding.
    const data = Buffer.from(acct(d.svm, book).data);
    expect(data.subarray(8, 40)).toEqual(Buffer.from(new web3.PublicKey(payer.address).toBytes()));
    expect(data.length).toBe(8 + 32 + 1 + 7 + 16 + 8 + 1 + 7);
    expect(data.readBigInt64LE(56) * (1n << 64n) + data.readBigUInt64LE(48)).toBe(-12345678901234567890123n);
    expect(data.readBigUInt64LE(64)).toBe(7n);
  });

  it("describes the types as Anchor's IDL does", () => {
    const types = Object.fromEntries((d.idl.types ?? []).map((t) => [t.name, JSON.parse(JSON.stringify(t, (k, v) => (k === "docs" ? undefined : v)))]));
    expect(types.Wrapped).toEqual({ name: "Wrapped", repr: { kind: "c" }, type: { kind: "struct", fields: [{ name: "value", type: { array: ["u8", 16] } }] } });
    expect(types.Side).toEqual({ name: "Side", repr: { kind: "rust" }, type: { kind: "enum", variants: [{ name: "Bid" }, { name: "Ask" }] } });
    expect(types.Book).toEqual({
      name: "Book",
      serialization: "bytemuck",
      repr: { kind: "c" },
      type: {
        kind: "struct",
        fields: [
          { name: "key", type: "pubkey" },
          { name: "flag", type: "u8" },
          { name: "_pad0", type: { array: ["u8", 7] } },
          { name: "price", type: { defined: { name: "Wrapped" } } },
          { name: "count", type: "u64" },
          { name: "side", type: { defined: { name: "Side" } } },
          { name: "_pad1", type: { array: ["u8", 7] } },
        ],
      },
    });
  });

  it("refuses repr(C) structs whose fields C would place elsewhere, and bad tags", () => {
    const struct = (tags: string, fields: string) =>
      compileErrors(
        `import { type FixedArray, type u8, type u16, type u32, type u64, type u128, type Pubkey } from "typesol";\n/**\n * ${tags}\n */\nexport interface S {\n${fields}\n}\nexport function f(): void {}\n`,
      );
    expect(struct("@repr c", "  a: u8;\n  b: u64;")).toMatch(/S\.b is at byte 1, which C would pad to a multiple of 8/);
    expect(struct("@repr c", "  a: u64;\n  b: u8;")).toMatch(/S is 9 bytes, which C would pad to a multiple of 8/);
    expect(struct("@repr c", "  a: u128;")).toMatch(/u128 field in a repr\(C\) zero-copy struct/);
    expect(struct("@repr c packed", "  a: u8;\n  b: u64;")).toBe("");
    expect(struct("@repr c align 8", "  a: u32;")).toMatch(/S is 4 bytes, which C would pad to a multiple of 8/);
    expect(struct("@repr c align 8", "  a: u32;\n  b: FixedArray<u8, 4>;")).toBe("");
    expect(struct("@repr c", "  a: u8;\n  b: FixedArray<u16, 2>;")).toMatch(/S\.b is at byte 1/);
    expect(struct("@repr wasm", "  a: u8;")).toMatch(/@repr is c or rust/);
    expect(struct("@serialization", "  a: u8;")).toMatch(/@serialization takes one word/);
    expect(
      compileErrors(`import { type u8 } from "typesol";\nexport interface S {\n  /** @bytes */\n  a: boolean;\n}\nexport function f(): void {}\n`),
    ).toMatch(/@bytes is for integer fields/);
    expect(
      compileErrors(`import { type u8 } from "typesol";\nexport interface S {\n  /** @idlName 9x */\n  a: u8;\n}\nexport function f(): void {}\n`),
    ).toMatch(/@idlName takes/);
    expect(compileErrors(`export enum E {\n  A = "a",\n  /** @code 5 */\n  B = "b",\n}\nexport function f(): void {}\n`)).toMatch(
      /@code must be a number from 6001 up/,
    );
    expect(
      compileErrors(
        `import { type Account, type Pubkey } from "typesol";\nexport interface S {\n  key: Pubkey;\n}\nexport function f(s: Account<S>): void {}\n`,
      ),
    ).toMatch(/key_ keeps the name "key"/);
  });
});
