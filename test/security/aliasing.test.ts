// Aliasing of account data found by the 2026-10 security review: a place written after the right side moved it, and
// one remaining account loaded mutably twice.
import { getU64Encoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, compileErrors, customError, deployFile, expectOk, fundedSigner, ix, pda, send } from "../harness.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BOOK = `import { type Init, type Mut, type Signer, type SystemProgram, type Vec, type u64 } from "typesol";
export interface Entry { qty: u64; px: u64; }
export interface Book { owner: u64; bids: Vec<Entry>; asks: Vec<Entry>; }
function drop(book: Mut<Book>): u64 {
  book.bids.pop();
  return 1n;
}
function pure(x: u64): u64 {
  return x + 1n;
}
`;
const ix_ = (body: string) => `${BOOK}export function go(payer: Mut<Signer>, book: Mut<Book>, systemProgram: SystemProgram, v: u64): void {\n${body}\n}\n`;

describe("a Vec element written after the right side may resize the Vec", () => {
  it.each([
    ["compound assignment, helper with the account", "book.bids.get(0n).qty += drop(book);"],
    ["closure", "const f = (): u64 => { book.bids.pop(); return v; };\nbook.bids.get(0n).qty = f();"],
    ["helper inside an expression", "book.asks.get(0n).qty = 1n + drop(book);"],
    ["pop on the right side", "book.asks.get(0n).qty = book.bids.pop().qty;"],
    ["clear on the right side, compound", "book.asks.get(0n).px *= (book.bids.clear(), 2n);"],
  ])("%s: refused", (_, body) => {
    expect(compileErrors(ix_(body))).toMatch(/the right side may change this Vec/);
  });

  it.each([
    ["a helper without writable accounts", "book.bids.get(0n).qty = pure(v);"],
    ["a plain value", "book.bids.get(0n).qty += v;"],
    ["the result in a local first", "const n = drop(book);\nbook.asks.get(0n).qty = n;"],
  ])("%s: compiles", (_, body) => {
    expect(compileErrors(ix_(body))).toBe("");
  });
});

describe("loadAccountMut on one remaining account twice", () => {
  const le64 = (n: bigint) => new Uint8Array(getU64Encoder().encode(n));
  const SOURCE = `import { type Init, type Mut, type Signer, type SystemProgram, type u64, loadAccountMut, remainingAccounts } from "typesol";
export interface Purse { owner: u64; balance: u64; }
export function open(payer: Mut<Signer>, purse: Init<Purse>, systemProgram: SystemProgram, id: u64): void {
  purse.create(payer, ["purse", id]);
  purse.balance = 100n;
}
/** Reads both balances, then writes both: with i == j the two views are one account. */
export function move(payer: Signer, i: u64, j: u64, amount: u64): void {
  const rest = remainingAccounts();
  const a = loadAccountMut<Purse>(rest.get(i));
  const b = loadAccountMut<Purse>(rest.get(j));
  const fa = a.balance;
  const fb = b.balance;
  a.balance = fa - amount;
  b.balance = fb + amount;
}
`;

  it("is refused with 2040; two different accounts still move", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-alias-"));
    const file = path.join(dir, "purse.ts");
    writeFileSync(file, SOURCE);
    const d = await deployFile(file);
    const payer = await fundedSigner(d.svm);
    const purse = async (id: bigint) => {
      const [p] = await pda(d.programId, ["purse", le64(id)]);
      expectOk(
        await send(d.svm, payer, [
          ix(d, "open", { id: new BN(id.toString()) }, [
            { address: payer.address, signer: payer, writable: true },
            { address: p, writable: true },
            { address: SYSTEM_PROGRAM },
          ]),
        ]),
      );
      return p;
    };
    const p1 = await purse(1n);
    const p2 = await purse(2n);
    const move = (i: number, j: number, rest: string[]) =>
      send(d.svm, payer, [
        ix(d, "move", { i: new BN(i), j: new BN(j), amount: new BN(50) }, [
          { address: payer.address, signer: payer },
          ...rest.map((address) => ({ address: address as never, writable: true })),
        ]),
      ]);
    expect(customError(await move(0, 0, [p1]))).toBe(2040);
    expectOk(await move(0, 1, [p1, p2]));
  });
});

describe("an associated token account with two token program parameters", () => {
  it("is refused: the address depends on which program the mint uses", () => {
    const head = `import { type AssociatedTokenProgram, type Ata, type Init, type Mint, type Mut, type Signer, type SystemProgram, type Token2022Program, type TokenAccount, type TokenProgram, type AccountInfo } from "typesol";\n`;
    expect(
      compileErrors(
        head +
          `export function go(payer: Mut<Signer>, mint: Mint, vault: Ata<Init<TokenAccount>, "payer", "mint">, ata: AssociatedTokenProgram, tokenProgram: TokenProgram, token2022Program: Token2022Program, systemProgram: SystemProgram): void {\n  vault.create(payer);\n}\n`,
      ),
    ).toMatch(/needs to know the token program: pass it, vault\.create\(payer, tokenProgram\) \(found tokenProgram, token2022Program\)/);
    expect(
      compileErrors(
        head +
          `export function go(payer: Signer, mint: Mint, vault: Ata<AccountInfo, "payer", "mint">, tokenProgram: TokenProgram, token2022Program: Token2022Program): void {}\n`,
      ),
    ).toMatch(/Ata<AccountInfo, …> needs exactly one token program parameter/);
  });
});
