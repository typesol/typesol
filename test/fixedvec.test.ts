// FixedVec<T, N>: lists with a fixed capacity anywhere in account data (several per struct, nested), next to a
// trailing Vec; their IDL types decode with Anchor's coder and the generated client.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSigner } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { CompileError, generate } from "../src/compiler/index.js";
import { BN, SYSTEM_PROGRAM, customError, decodeAccount, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "./harness.js";
import { pk } from "./ports-helpers.js";

type Board = {
  bump: number;
  owners: { len: number; items: { toBase58(): string }[] };
  members: { len: number; items: { who: { toBase58(): string }; weight: BN }[] };
  last: { choice: number; notes: { len: number; items: { len: number; bytes: number[] }[] } };
  total: BN;
  log: BN[];
};

describe("FixedVec", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/fixedvec.ts", import.meta.url)));
  });

  it("describes each FixedVec as a { len, items } IDL type", () => {
    const types = d.idl.types as { name: string; type: { fields?: { name: string; type: unknown }[] } }[];
    expect(types.find((t) => t.name === "FixedVec3_Pubkey")?.type.fields).toEqual([
      { name: "len", type: "u32" },
      { name: "items", type: { array: ["pubkey", 3] } },
    ]);
    expect(types.find((t) => t.name === "FixedVec4_Member")?.type.fields?.[1]).toEqual({
      name: "items",
      type: { array: [{ defined: { name: "Member" } }, 4] },
    });
  });

  it("pushes, iterates, pops and refuses a push past the capacity", async () => {
    const payer = await fundedSigner(d.svm);
    const [board] = await pda(d.programId, ["board", payer.address]);
    const B = { address: board, writable: true };
    const P = { address: payer.address, signer: payer, writable: true };
    expectOk(await send(d.svm, payer, [ix(d, "create", {}, [P, B, { address: SYSTEM_PROGRAM }])]));
    const read = () => decodeAccount<Board>(d, d.svm, "Board", board);
    expect(read().owners.len).toBe(1);
    expect(read().owners.items[0]!.toBase58()).toBe(payer.address);

    const others = await Promise.all([0, 1, 2].map(async () => (await generateKeyPairSigner()).address));
    const addOwner = (o: string) => send(d.svm, payer, [ix(d, "add_owner", { owner: pk(o as never) }, [P, B])]);
    expectOk(await addOwner(others[0]!));
    expect(customError(await addOwner(others[0]!))).toBe(6000); // for…of found it
    expectOk(await addOwner(others[1]!));
    expect(customError(await addOwner(others[2]!))).toBe(5104); // full: 3 owners
    expect(read().owners.len).toBe(3);

    for (const [i, w] of [5, 7].entries())
      expectOk(await send(d.svm, payer, [ix(d, "add_member", { key: pk(others[i]! as never), weight: new BN(w) }, [P, B, { address: SYSTEM_PROGRAM }])]));
    let b = read();
    expect(b.members.len).toBe(2);
    expect(b.members.items[1]!.who.toBase58()).toBe(others[1]);
    expect(b.total.toNumber()).toBe(12);
    expect(b.log.map((x) => x.toNumber())).toEqual([5, 7]); // the trailing Vec still grows after the fixed ones

    const r = expectOk(await send(d.svm, payer, [ix(d, "drop_member", {}, [P, B])]));
    expect(Buffer.from(r.returnData().data()).readBigUInt64LE(0)).toBe(1n);
    expect(read().total.toNumber()).toBe(5);

    // A FixedVec inside a nested struct, of FixedStrings.
    for (const t of ["a", "b", "c"]) expectOk(await send(d.svm, payer, [ix(d, "note", { text: t }, [P, B])]));
    b = read();
    const text = (s: { len: number; bytes: number[] }) => Buffer.from(s.bytes.slice(0, s.len)).toString();
    expect(b.last.notes.len).toBe(2);
    expect(b.last.notes.items.map(text)).toEqual(["hi", "c"]);

    expectOk(await send(d.svm, payer, [ix(d, "reset", {}, [P, B])]));
    b = read();
    expect([b.owners.len, b.members.len, b.total.toNumber()]).toEqual([1, 0, 0]);
    expect(b.owners.items[1]!.toBase58()).toBe("11111111111111111111111111111111"); // the rest zeroed
  });

  it("refuses FixedVec where it has no fixed layout", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-fixedvec-"));
    const errors = (body: string) => {
      const file = path.join(dir, `p${Math.random().toString(36).slice(2)}.ts`);
      writeFileSync(file, `import { type Account, type FixedVec, type Mut, type Vec, type u64, emit, fixedVec } from "typesol";\n${body}\n`);
      try {
        generate(file);
        return "";
      } catch (e) {
        if (e instanceof CompileError) return e.diagnostics.map((x) => x.message).join(" | ");
        throw e;
      }
    };
    expect(errors(`export interface S { a: Vec<u64>; n: u64 }\nexport function f(s: Account<S>): void {}`)).toMatch(/use FixedVec<T, N>/);
    expect(errors(`export interface S { a: FixedVec<u64, 0>; n: u64 }\nexport function f(s: Account<S>): void {}`)).toMatch(/literal capacity/);
    expect(errors(`export interface S { a: FixedVec<string, 2> }\nexport function f(s: Account<S>): void {}`)).toMatch(/fixed size/);
    expect(errors(`export interface S { a: FixedVec<u64, 2> }\nexport function f(s: S): void {}`)).toMatch(/only account data can/);
    expect(errors(`export interface E { a: FixedVec<u64, 2> }\nexport function f(): void { emit<E>({ a: fixedVec([]) }); }`)).toMatch(
      /not supported in events/,
    );
    expect(errors(`export interface S { a: FixedVec<u64, 2> }\nexport function f(s: Mut<S>): void { s.a = fixedVec([1n, 2n, 3n]); }`)).toMatch(/do not fit/);
    expect(errors(`export interface S { a: FixedVec<u64, 2> }\nexport function f(s: Mut<S>): void { s.a.push(1n); s.a.set(0n, 2n); }`)).toBe("");
  });
});
