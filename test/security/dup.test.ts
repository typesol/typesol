// Dup<…> (Anchor's `dup`): a writable account that may be the same account as another writable parameter, for
// accounts read and written in place only.
import { getU64Encoder } from "@solana/kit";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, compileErrors, customError, decodeAccount, deployFile, expectOk, fundedSigner, ix, pda, send } from "../harness.js";

const HEAD = `import { type CloseTo, type Dup, type FixedString, type Init, type Mut, type Signer, type SystemProgram, type u64 } from "typesol";
export interface Wallet { id: u64; balance: u64; }
/** @layout borsh */
export interface Note { id: u64; text: FixedString<16>; }
`;

describe("Dup<…>", () => {
  it.each([
    ["a @layout borsh account", "export function f(a: Dup<Mut<Note>>, b: Mut<Note>): void {}"],
    ["an account it closes", 'export function f(a: Dup<CloseTo<Mut<Wallet>, "b">>, b: Mut<Signer>): void {}'],
    ["a close destination", 'export function f(a: Dup<Mut<Signer>>, w: CloseTo<Mut<Wallet>, "a">): void {}'],
    ["an account created here", "export function f(p: Mut<Signer>, a: Dup<Init<Wallet>>, s: SystemProgram): void { a.create(p, null); }"],
  ])("is refused on %s", (_, fn) => {
    expect(compileErrors(HEAD + fn)).toMatch(/Dup<…> is for accounts read and written in place/);
  });

  it("is refused on a read-only account", () => {
    expect(compileErrors(HEAD + "import type { Account } from 'typesol';\nexport function f(a: Dup<Account<Wallet>>, b: Mut<Wallet>): void {}")).toMatch(
      /this one is not writable/,
    );
  });

  it("lets two slots name one account; reads through either see writes through the other", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-dup-"));
    writeFileSync(
      path.join(dir, "dup.ts"),
      `${HEAD}export function open(payer: Mut<Signer>, w: Init<Wallet>, systemProgram: SystemProgram, id: u64): void {
  w.create(payer, ["w", id]);
  w.id = id;
  w.balance = 100n;
}
/** Moves amount from one wallet to the other, in place: from one wallet to itself it changes nothing. */
export function move(from: Dup<Mut<Wallet>>, to: Mut<Wallet>, amount: u64): void {
  from.balance -= amount;
  to.balance += amount;
}
export function strict(from: Mut<Wallet>, to: Mut<Wallet>, amount: u64): void {
  from.balance -= amount;
  to.balance += amount;
}
`,
    );
    const d = await deployFile(path.join(dir, "dup.ts"));
    const payer = await fundedSigner(d.svm);
    const le64 = (n: bigint) => new Uint8Array(getU64Encoder().encode(n));
    const wallet = async (id: bigint) => {
      const [w] = await pda(d.programId, ["w", le64(id)]);
      expectOk(
        await send(d.svm, payer, [
          ix(d, "open", { id: new BN(id.toString()) }, [
            { address: payer.address, signer: payer, writable: true },
            { address: w, writable: true },
            { address: SYSTEM_PROGRAM },
          ]),
        ]),
      );
      return w;
    };
    const a = await wallet(1n);
    const b = await wallet(2n);
    const balance = (w: typeof a) => decodeAccount<{ balance: BN }>(d, d.svm, "Wallet", w).balance.toString();
    const call = (name: string, from: typeof a, to: typeof a) =>
      send(d.svm, payer, [
        ix(d, name, { amount: new BN(30) }, [
          { address: from, writable: true },
          { address: to, writable: true },
        ]),
      ]);
    expectOk(await call("move", a, b));
    expect([balance(a), balance(b)]).toEqual(["70", "130"]);
    expectOk(await call("move", a, a)); // allowed: in place, so -30 then +30
    expect(balance(a)).toBe("70");
    expect(customError(await call("strict", a, a))).toBe(2040); // without Dup, still refused
  });
});
