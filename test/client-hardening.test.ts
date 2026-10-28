// The client generator against hostile and unusual IDLs (src/clientgen.ts): shapes it must refuse with a
// ClientIdlError rather than crash or hang on, notes that are safe to print, account names that are also
// Object.prototype properties, and resolve filling in has_one accounts read from a PDA the builder derives.
import { type Address, generateKeyPairSigner, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { ClientIdlError, generateClient, type ClientIdl } from "../src/clientgen.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
mkdirSync(path.join(ROOT, "target"), { recursive: true });
const OUT = mkdtempSync(path.join(ROOT, "target", "client-hardening-"));
afterAll(() => rmSync(OUT, { recursive: true, force: true }));

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const PROGRAM = "11111111111111111111111111111112" as Address;
const idl = (parts: Partial<ClientIdl>): ClientIdl => ({ address: PROGRAM, metadata: { name: "probe", spec: "0.1.0" }, instructions: [], ...parts });

/** Write a generated client, check it under strict TypeScript, and import it. */
async function importClient(name: string, source: string): Promise<Any> {
  const file = path.join(OUT, `${name}.client.ts`);
  writeFileSync(file, source);
  const program = ts.createProgram([file], {
    strict: true,
    noUnusedLocals: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    erasableSyntaxOnly: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: [],
  });
  expect(ts.getPreEmitDiagnostics(program).map((x) => ts.flattenDiagnosticMessageText(x.messageText, "\n"))).toEqual([]);
  return ((await import(pathToFileURL(file).href)) as Record<string, Any>).probe;
}

const refused = (i: ClientIdl) => {
  try {
    generateClient(i);
  } catch (e) {
    expect(e).toBeInstanceOf(ClientIdlError);
    return (e as Error).message;
  }
  throw new Error("expected the IDL to be refused");
};

describe("client generator: IDLs it must refuse cleanly", () => {
  it("sizes a deep chain of structs that each hold the next one twice in linear time", () => {
    const types = Array.from({ length: 32 }, (_, i) => ({
      name: `T${i}`,
      type: {
        kind: "struct",
        fields:
          i === 31
            ? [
                { name: "a", type: "u64" },
                { name: "b", type: "u64" },
              ]
            : [
                { name: "a", type: { defined: { name: `T${i + 1}` } } },
                { name: "b", type: { defined: { name: `T${i + 1}` } } },
              ],
      },
    }));
    const start = Date.now();
    const { source } = generateClient(
      idl({ types, instructions: [{ name: "go", discriminator: [1], accounts: [], args: [{ name: "x", type: { coption: { defined: { name: "T0" } } } }] }] }),
    );
    expect(Date.now() - start).toBeLessThan(2000);
    expect(source).toContain(`fixedOption(getT0Codec(), ${2 ** 35}, getU32Codec(), 4)`);
    // A struct that holds itself has no fixed size (not a stack overflow).
    expect(
      refused(
        idl({
          types: [{ name: "Loop", type: { kind: "struct", fields: [{ name: "me", type: { defined: { name: "Loop" } } }] } }],
          instructions: [{ name: "go", discriminator: [1], accounts: [], args: [{ name: "x", type: { coption: { defined: { name: "Loop" } } } }] }],
        }),
      ),
    ).toMatch(/fixed-size/);
  });

  it("refuses bad generic arguments and generic types that instantiate without end", () => {
    const uses = (generics: unknown) =>
      idl({
        types: [
          { name: "Wrap", generics: [{ kind: "type", name: "T" }], type: { kind: "struct", fields: [{ name: "v", type: { generic: "T" } }] } },
          { name: "Uses", type: { kind: "struct", fields: [{ name: "w", type: { defined: { name: "Wrap", generics: generics as never } } }] } },
        ],
      });
    expect(refused(uses([{ kind: "type", type: null }]))).toMatch(/bad type null/);
    expect(refused(uses([{ kind: "type" }]))).toMatch(/bad type/);
    expect(refused(uses([{ kind: "const", value: "abc" }]))).toMatch(/bad generic argument/);
    expect(refused(uses([null]))).toMatch(/bad generic argument/);
    expect(refused(uses("u64"))).toMatch(/generic arguments must be a list/);
    expect(generateClient(uses([{ kind: "type", type: "u64" }])).source).toContain("export interface WrapU64 {");

    // A<T> { n: Option<A<Vec<T>>> }: every instantiation asks for a new one.
    const growing = idl({
      types: [
        {
          name: "A",
          generics: [{ kind: "type", name: "T" }],
          type: {
            kind: "struct",
            fields: [{ name: "n", type: { option: { defined: { name: "A", generics: [{ kind: "type", type: { vec: { generic: "T" } } }] } } } }],
          },
        },
        { name: "B", type: { kind: "struct", fields: [{ name: "a", type: { defined: { name: "A", generics: [{ kind: "type", type: "u64" }] } } }] } },
      ],
    });
    expect(refused(growing)).toMatch(/generic type A is instantiated more than 16 levels deep/);
    // Many distinct uses: capped too.
    const many = idl({
      types: [
        {
          name: "Wrap",
          generics: [{ kind: "const", name: "N", type: "usize" }],
          type: { kind: "struct", fields: [{ name: "v", type: { array: ["u8", { generic: "N" }] } }] },
        },
        {
          name: "Uses",
          type: {
            kind: "struct",
            fields: Array.from({ length: 300 }, (_, i) => ({
              name: `f${i}`,
              type: { defined: { name: "Wrap", generics: [{ kind: "const", value: String(i) }] } },
            })),
          },
        },
      ],
    });
    expect(refused(many)).toMatch(/more than 256 times/);
    // Anything else that throws is still a ClientIdlError, with the original as its cause.
    let caught: unknown;
    try {
      generateClient(idl({ instructions: [null as never] }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClientIdlError);
    expect((caught as Error).cause).toBeInstanceOf(TypeError);
  });

  it("refuses array lengths that are not whole numbers and alignments that are not powers of two", () => {
    const withLen = (len: unknown) => idl({ types: [{ name: "S", type: { kind: "struct", fields: [{ name: "a", type: { array: ["u8", len] } }] } }] });
    expect(refused(withLen(-1))).toMatch(/array length -1 is not a whole number/);
    expect(refused(withLen("abc"))).toMatch(/array length "abc" is not a whole number/);
    expect(refused(withLen(1.5))).toMatch(/array length 1.5/);
    expect(refused(withLen({ generic: "1x" }))).toMatch(/is not an identifier/);
    expect(generateClient(withLen(4)).source).toContain("fixCodecSize(getBytesCodec(), 4)");
    const aligned = (repr: unknown) =>
      idl({ types: [{ name: "Z", serialization: "bytemuck", repr, type: { kind: "struct", fields: [{ name: "a", type: "u8" }] } }] });
    expect(refused(aligned({ kind: "c", align: 3 }))).toMatch(/repr align 3 is not a power of two/);
    expect(refused(aligned({ kind: "c", align: 0 }))).toMatch(/repr align 0/);
    expect(refused(aligned("c"))).toMatch(/bad repr/);
    expect(generateClient(aligned({ kind: "c", align: 8 })).source).toContain("Zero-copy (#[repr(C)]) layout: 8 bytes");
  });

  it("escapes control characters from the IDL in notes and errors", () => {
    const { notes } = generateClient(
      idl({
        types: [
          { name: "Weird", type: { kind: "struct", fields: [{ name: "x", type: "u256\u001b[2J\u009b31m‮" }] } },
          { name: "Kind", type: { kind: "evil\u001b]0;title\u0007" } },
          { name: "Ser", serialization: "x\u009b", type: { kind: "struct", fields: [] } },
        ],
      }),
    );
    expect(notes.length).toBe(3);
    for (const n of notes) expect(n).not.toMatch(/[\u0000-\u001f\u007f-\u009f‮]/);
    expect(notes[0]).toContain('type "u256\\u001b[2J\\u009b31m\\u202e" is not supported');
    expect(refused(idl({ instructions: [{ name: "go\u009b", discriminator: [1], accounts: [], args: [] }] }))).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
});

describe("client generator: generated code", () => {
  it("reads accounts named after Object.prototype properties as given, never inherited", async () => {
    const FEE = "SysvarRent111111111111111111111111111111111";
    const c = await importClient(
      "proto",
      generateClient(
        idl({
          instructions: [
            {
              name: "go",
              discriminator: [1],
              accounts: [
                { name: "constructor", writable: true },
                { name: "to_string" },
                { name: "value_of", address: FEE },
                { name: "has_own_property", optional: true },
              ],
              args: [],
            },
            { name: "sign", discriminator: [2], accounts: [{ name: "constructor", signer: true }], args: [] },
          ],
        }),
      ).source,
    );
    await expect(c.go({ toString: PROGRAM })).rejects.toThrow(/account constructor is required/);
    const a = (await generateKeyPairSigner()).address;
    const b = (await generateKeyPairSigner()).address;
    const ix = await c.go({ constructor: a, toString: b });
    // valueOf is filled in with its fixed address; hasOwnProperty is optional and left out (the program id).
    expect(ix.accounts.map((m: Any) => m.address)).toEqual([a, b, FEE, PROGRAM]);
    const signer = await generateKeyPairSigner();
    expect(await c.resolve.sign({}, {}, { signer })).toEqual({ constructor: signer });
  });

  it("derives a has_one source that is a PDA before reading the relation (resolve)", async () => {
    const CONFIG = [1, 1, 1, 1, 1, 1, 1, 1];
    const POOL = [2, 2, 2, 2, 2, 2, 2, 2];
    const FEE = "SysvarRent111111111111111111111111111111111" as Address;
    const config = [...new TextEncoder().encode("config")];
    const c = await importClient(
      "relations",
      generateClient(
        idl({
          accounts: [
            { name: "Config", discriminator: CONFIG },
            { name: "Pool", discriminator: POOL },
          ],
          types: [
            { name: "Config", type: { kind: "struct", fields: [{ name: "vault", type: "pubkey" }] } },
            { name: "Pool", type: { kind: "struct", fields: [{ name: "treasury", type: "pubkey" }] } },
          ],
          instructions: [
            {
              name: "withdraw",
              discriminator: [1],
              accounts: [
                { name: "config", pda: { seeds: [{ kind: "const", value: config }] } },
                { name: "vault", writable: true, relations: ["config"] },
              ],
              args: [],
            },
            {
              // A pool PDA seeded from the signer, a fixed address and an argument.
              name: "sweep",
              discriminator: [2],
              accounts: [
                { name: "user", signer: true },
                { name: "fee", address: FEE },
                {
                  name: "pool",
                  pda: {
                    seeds: [
                      { kind: "account", path: "user" },
                      { kind: "account", path: "fee" },
                      { kind: "arg", path: "id" },
                    ],
                  },
                },
                { name: "treasury", writable: true, relations: ["pool"] },
              ],
              args: [{ name: "id", type: "u8" }],
            },
            {
              name: "poke",
              discriminator: [3],
              accounts: [{ name: "holder" }, { name: "vault", relations: ["holder"] }],
              args: [],
            },
          ],
        }),
      ).source,
    );
    const user = await generateKeyPairSigner();
    const vault = (await generateKeyPairSigner()).address;
    const treasury = (await generateKeyPairSigner()).address;
    const [configPda] = await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: [new Uint8Array(config)] });
    const [poolPda] = await getProgramDerivedAddress({
      programAddress: PROGRAM,
      seeds: [getAddressEncoder().encode(user.address), getAddressEncoder().encode(FEE), new Uint8Array([7])],
    });
    const stored: Record<string, Uint8Array> = {
      [configPda]: new Uint8Array([...CONFIG, ...getAddressEncoder().encode(vault)]),
      [poolPda]: new Uint8Array([...POOL, ...getAddressEncoder().encode(treasury)]),
    };
    const rpc = {
      getAccountInfo: (a: Address) => ({
        send: async () => ({
          context: { slot: 1n },
          value: stored[a]
            ? {
                data: [Buffer.from(stored[a]).toString("base64"), "base64"],
                executable: false,
                lamports: 1n,
                owner: PROGRAM,
                space: BigInt(stored[a].length),
                rentEpoch: 0n,
              }
            : null,
        }),
      }),
    };
    expect(await c.resolve.withdraw(rpc, {})).toEqual({ config: configPda, vault });
    // The builder derives the same config.
    expect((await c.withdraw(await c.resolve.withdraw(rpc, {}))).accounts.map((m: Any) => m.address)).toEqual([configPda, vault]);
    expect(await c.resolve.sweep(rpc, {}, { id: 7 }, { signer: user })).toEqual({ user, pool: poolPda, treasury });
    // A source that is neither given nor derived: a clear error naming it.
    await expect(c.resolve.poke(rpc, {})).rejects.toThrow(/cannot fill in vault: pass holder, the account it is read from/);
  });

  it("reads custom codes from the JSON errors RPC nodes return", async () => {
    const c = await importClient("errors", generateClient(idl({ errors: [{ code: 6000, name: "Nope" }] })).source);
    expect(c.errorCode({ InstructionError: [0, { Custom: 6000 }] })).toBe(6000);
    expect(c.errorCode({ InstructionError: [2, { Custom: 6000n }] })).toBe(6000);
    expect(c.isError(new Error("failed", { cause: { InstructionError: [0, { Custom: 6000 }] } }), "Nope")).toBe(true);
    expect(c.errorCode({ InstructionError: [0, "InvalidArgument"] })).toBeNull();
  });
});
