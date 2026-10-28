// typesol port: a skeleton from an IDL compiles, and keeps instruction discriminators, arguments, account flags,
// account layouts and error codes. Round trip: example → IDL → port → compile → IDL.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildIdl } from "../src/compiler/idl.js";
import { build, generate } from "../src/compiler/index.js";
import { generatePort, type PortIdl } from "../src/portgen.js";

const ADDRESS = "11111111111111111111111111111112";
const sighash = (preimage: string) => [...createHash("sha256").update(preimage).digest().subarray(0, 8)];
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "typesol-port-"));
type AnyIdl = PortIdl & {
  instructions: {
    name: string;
    discriminator: number[];
    args: unknown[];
    accounts: { name: string; signer?: boolean; writable?: boolean; optional?: boolean }[];
  }[];
};

function roundTrip(example: string) {
  const original = build(fileURLToPath(new URL(`../examples/${example}.ts`, import.meta.url)), tmp(), ADDRESS).idl as unknown as AnyIdl;
  const { source, notes } = generatePort(original);
  const file = path.join(tmp(), `${example}.ts`);
  writeFileSync(file, source);
  const ported = buildIdl(generate(file).model, ADDRESS) as unknown as AnyIdl;
  return { original, ported, notes, source };
}

describe("typesol port", () => {
  for (const example of ["counter", "vault", "escrow", "minter", "profiles", "ledgerbook", "airdrop", "relay"])
    it(`round-trips examples/${example}.ts`, () => {
      const { original, ported } = roundTrip(example);
      const shape = (idl: AnyIdl) =>
        idl.instructions.map((ix) => ({
          name: ix.name,
          discriminator: ix.discriminator,
          args: ix.args,
          accounts: ix.accounts.map((a) => ({ name: a.name, signer: !!a.signer, writable: !!a.writable, optional: !!a.optional })),
        }));
      expect(shape(ported)).toEqual(shape(original));
      // Same codes and messages (RequireFailedN errors come back as CheckN), then NotPorted.
      const errs = (idl: AnyIdl) => (idl.errors ?? []).map((e) => ({ code: e.code, msg: e.msg }));
      expect(errs(ported)).toEqual([...errs(original), { code: 6000 + (original.errors ?? []).length, msg: "This instruction is not ported yet" }]);
      // Account structs keep their layouts (the skeleton's IDL lists them as types until they are used as accounts).
      for (const a of original.accounts ?? []) {
        const t = (idl: AnyIdl) => idl.types?.find((x) => x.name === a.name)?.type;
        expect(t(ported), a.name).toEqual(t(original));
      }
    });

  it("keeps a discriminator the name would not derive, and Anchor's account bytes (@layout borsh)", () => {
    const idl: PortIdl = {
      metadata: { name: "legacy" },
      instructions: [
        {
          name: "doIt",
          discriminator: [1, 2, 3, 4, 5, 6, 7, 8],
          accounts: [{ name: "payer", signer: true, writable: true }],
          args: [{ name: "label", type: "string" }],
        },
      ],
      accounts: [{ name: "Thing", discriminator: [9, 9, 9, 9, 9, 9, 9, 9] }],
      types: [
        {
          name: "Thing",
          type: {
            kind: "struct",
            fields: [
              { name: "name", type: "string" },
              { name: "items", type: { vec: "u64" } },
              { name: "best", type: { option: "u64" } },
            ],
          },
        },
      ],
      errors: [{ code: 6100, name: "Bad", msg: "bad" }],
    };
    const { source, notes } = generatePort(idl);
    expect(source).toContain("@discriminator 0x0102030405060708");
    const file = path.join(tmp(), "legacy.ts");
    writeFileSync(file, source);
    const ported = buildIdl(generate(file).model, ADDRESS) as unknown as AnyIdl;
    expect(ported.instructions[0].discriminator).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // The account keeps Anchor's layout: its IDL type is Anchor's own.
    expect(source).toContain("@layout borsh");
    expect(ported.types?.find((t: { name: string }) => t.name === "Thing")).toMatchObject({ type: idl.types![0]!.type });
    expect(notes.join("\n")).toMatch(/Thing\.name: set the String's capacity to Anchor's #\[max_len\]/);
    expect(notes.join("\n")).toMatch(/Thing\.items: set the Vec's capacity/);
    expect(notes.join("\n")).not.toMatch(/layout differs/);
    expect(notes.join("\n")).toMatch(/errors: .*6100/);
    expect(notes.join("\n")).toMatch(/account Thing: its discriminator is not/);
  });

  it("compiles awkward IDLs: comment ends in docs, clashing names, reserved words, expressions, tuples, generics", () => {
    const idl: PortIdl = {
      metadata: { name: "9lives" },
      constants: [
        { name: "DAY", type: "i64", value: "60 * 60 * 24" },
        { name: "MAX", type: "u64", value: "1_000" },
      ],
      instructions: [
        {
          name: "deposit",
          docs: ["Deposit */ tokens"],
          discriminator: sighash("global:deposit"),
          accounts: [
            { name: "amount", writable: true },
            { name: "require", signer: true },
            { name: "group", accounts: [{ name: "long", writable: true }] },
          ],
          args: [
            { name: "amount", type: "u64" },
            { name: "pair", type: { defined: { name: "Pair" } } },
            { name: "act", type: { defined: { name: "Act" } } },
          ],
        },
      ],
      accounts: [{ name: "Market", discriminator: sighash("account:Market") }],
      types: [
        { name: "Pair", type: { kind: "struct", fields: ["u64", "u64"] as never } },
        { name: "Wrap", generics: [{ kind: "type", name: "T" }], type: { kind: "struct", fields: [] } },
        { name: "Act", type: { kind: "enum", variants: [{ name: "A", fields: ["u64", "bool"] as never }, { name: "B" }] } },
        {
          name: "Market",
          type: {
            kind: "struct",
            fields: [
              { name: "signed", type: "u8" },
              { name: "blob", type: "bytes" },
              { name: "last", type: { defined: { name: "Act" } } },
              { name: "fee", type: { coption: "u64" } },
            ],
          },
        },
      ],
    };
    const { source, notes } = generatePort(idl);
    const file = path.join(tmp(), "awkward.ts");
    writeFileSync(file, source);
    const ported = buildIdl(generate(file).model, ADDRESS) as unknown as AnyIdl;
    expect(ported.instructions[0].discriminator).toEqual(sighash("global:deposit"));
    expect(ported.instructions[0].accounts.map((a) => a.name)).toEqual(["amount", "require_value", "group_long"]);
    const all = notes.join("\n");
    expect(all).toMatch(/constant DAY = 60 \* 60 \* 24: not a literal/);
    expect(all).toMatch(/arg "amount" renamed to "amountArg"/);
    expect(all).toMatch(/Pair could not be ported/);
    expect(all).toMatch(/Market\.blob: a Vec here/);
    expect(all).toMatch(/Market\.last: Act is a data enum/);
    expect(all).toMatch(/Market\.fee: a COption/);
    expect(source).toContain("f0: u64; f1: boolean");
  });

  it("ports the Anchor vault IDL into a program that compiles", () => {
    const idl = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/anchor_vault.idl.json", import.meta.url)), "utf8")) as PortIdl;
    const { source, notes } = generatePort(idl);
    const file = path.join(tmp(), "vault.ts");
    writeFileSync(file, source);
    const ported = buildIdl(generate(file).model, ADDRESS) as unknown as AnyIdl;
    expect(ported.instructions.map((i) => i.discriminator)).toEqual(idl.instructions.map((i) => i.discriminator));
    expect(notes).toEqual([]);
    expect(ported.errors?.slice(0, 4)).toEqual(idl.errors);
  });
});
