// typesol port: a skeleton from an IDL compiles, and keeps instruction discriminators, arguments, account flags,
// account layouts and error codes. Round trip: example → IDL → port → compile → IDL.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildIdl } from "../src/compiler/idl.js";
import { build, generate } from "../src/compiler/index.js";
import { generatePort, type PortIdl } from "../src/portgen.js";

const ADDRESS = "11111111111111111111111111111112";
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

  it("keeps a discriminator the name would not derive, and notes layout differences from Anchor", () => {
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
    expect(notes.join("\n")).toMatch(/Thing\.name: a Borsh String/);
    expect(notes.join("\n")).toMatch(/Thing\.items: a Vec that is not the last field/);
    expect(notes.join("\n")).toMatch(/Thing\.best: Option in account data/);
    expect(notes.join("\n")).toMatch(/errors: .*6100/);
    expect(notes.join("\n")).toMatch(/account Thing: its discriminator is not/);
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
