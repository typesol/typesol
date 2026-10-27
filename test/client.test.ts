// The generated TypeScript client (`<name>.client.ts`, src/clientgen.ts): its instructions must be byte- and
// meta-identical to the hand-built ones the other tests send, its decoders must read what the programs wrote, and the
// files must typecheck under strict settings, for TypeSOL programs and for an Anchor IDL.
import { SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM, SolanaError, type Address, type Instruction, generateKeyPairSigner, getAddressEncoder } from "@solana/kit";
import { LiteSVM } from "litesvm";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClientIdlError, TYPESOL_ERRORS, generateClient, writeClient, type ClientIdl } from "../src/clientgen.js";
import { CompileError, build } from "../src/compiler/index.js";
import { BN, SYSTEM_PROGRAM, customError, expectOk, fundedSigner, ix, pda, send, type Deployed } from "./harness.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
// Under the repository (target/ is ignored), so the generated files resolve @solana/kit from node_modules.
mkdirSync(path.join(ROOT, "target"), { recursive: true });
const OUT = mkdtempSync(path.join(ROOT, "target", "client-test-"));
afterAll(() => rmSync(OUT, { recursive: true, force: true }));

interface Loaded<C> extends Deployed {
  client: C;
  clientPath: string;
}

/** Build a program, load it into LiteSVM and import its generated client. */
async function load<C>(file: string, programId?: Address): Promise<Loaded<C>> {
  const id = programId ?? (await generateKeyPairSigner()).address;
  const out = path.join(OUT, path.basename(file, ".ts"));
  mkdirSync(out, { recursive: true });
  const res = build(path.join(ROOT, file), out, id);
  const clientPath = writeClient(res.idl, path.join(out, `${res.model.name}.client.ts`)).path;
  const svm = new LiteSVM();
  svm.addProgramFromFile(id, res.soPath);
  const mod = (await import(pathToFileURL(clientPath).href)) as Record<string, unknown>;
  const { BorshCoder } = await import("@anchor-lang/core");
  const idl = res.idl as never;
  return { svm, programId: id, coder: new BorshCoder(idl), idl, client: mod as C, clientPath };
}

/** Accounts (address, role and the signer that signs for it) and data of an instruction. */
const shape = (i: Instruction) => ({
  programAddress: i.programAddress,
  accounts: (i.accounts ?? []).map((a) => ({ address: a.address, role: a.role, signer: (a as { signer?: { address: Address } }).signer?.address })),
  data: [...(i.data ?? [])],
});
const accountData = (svm: LiteSVM, a: Address) => {
  const x = svm.getAccount(a);
  if (!x.exists) throw new Error(`no account ${a}`);
  return x.data;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

describe("generated client: counter", () => {
  let d: Loaded<Any>;
  beforeAll(async () => {
    d = await load("examples/counter.ts");
  });

  it("builds the same instructions as hand-built ones, filling in the PDA and System Program", async () => {
    const c = d.client.counter;
    const user = await fundedSigner(d.svm);
    const [counterPda] = await pda(d.programId, ["counter", user.address]);
    const init = await c.initialize({ authority: user });
    expect(shape(init)).toEqual(
      shape(
        ix(d, "initialize", {}, [
          { address: user.address, signer: user, writable: true },
          { address: counterPda, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ),
    );
    expect((await c.pdas.counter({ authority: user.address }))[0]).toBe(counterPda);
    expectOk(await send(d.svm, user, [init]));

    const inc = await c.increment({ authority: user, counter: counterPda }, { by: 5n });
    expect(shape(inc)).toEqual(
      shape(
        ix(d, "increment", { by: new BN(5) }, [
          { address: user.address, signer: user },
          { address: counterPda, writable: true },
        ]),
      ),
    );
    expectOk(await send(d.svm, user, [inc, await c.increment({ authority: user, counter: counterPda }, { by: 2 })]));

    const decoded = c.accounts.Counter.decode(accountData(d.svm, counterPda));
    expect(decoded).toEqual({ authority: user.address, count: 7n, bump: expect.any(Number) });
    const viaCoder = d.coder.accounts.decode("Counter", Buffer.from(accountData(d.svm, counterPda)));
    expect(decoded.bump).toBe(viaCoder.bump);
    expect([...c.accounts.Counter.encode(decoded)]).toEqual([...accountData(d.svm, counterPda)]);
  });

  it("names errors, from LiteSVM results and plain codes", async () => {
    const c = d.client;
    const [owner, stranger] = [await fundedSigner(d.svm), await fundedSigner(d.svm)];
    expectOk(await send(d.svm, owner, [await c.counter.initialize({ authority: owner })]));
    const [counterPda] = await c.counter.pdas.counter({ authority: owner });
    const res = await send(d.svm, stranger, [await c.counter.increment({ authority: stranger, counter: counterPda }, { by: 1n })]);
    expect(customError(res)).toBe(6000);
    expect(c.errorCode(res)).toBe(6000);
    expect(c.isError(res, "Unauthorized")).toBe(true);
    expect(c.isError(res, "ArithmeticOverflow")).toBe(false);
    expect(c.ERRORS[6000]).toEqual({ name: "Unauthorized", msg: "Only the counter's authority can change it" });
    expect(c.errorCode(new Error("custom program error: 0x13ec"))).toBe(5100);
    expect(c.ERRORS[5100].name).toBe("ArithmeticOverflow");
  });

  it("matches the checked-in client (codegen is stable)", () => {
    const golden = fileURLToPath(new URL("./golden/counter.client.ts", import.meta.url));
    const text = readFileSync(d.clientPath, "utf8").replace(/address\("[1-9A-HJ-NP-Za-km-z]{32,44}"\)/, 'address("<program>")');
    if (process.env.UPDATE_GOLDEN) writeFileSync(golden, text);
    expect(text).toBe(readFileSync(golden, "utf8"));
  });
});

describe("generated client: vault and escrow PDAs", () => {
  it("vault: open/deposit/withdraw with the vault PDA filled in", async () => {
    const d = await load<Any>("examples/vault.ts");
    const c = d.client.vault;
    const owner = await fundedSigner(d.svm);
    const [vaultPda] = await pda(d.programId, ["vault", owner.address]);
    const open = await c.open({ owner });
    expect(shape(open)).toEqual(
      shape(ix(d, "open", {}, [{ address: owner.address, signer: owner, writable: true }, { address: vaultPda, writable: true }, { address: SYSTEM_PROGRAM }])),
    );
    expectOk(await send(d.svm, owner, [open, await c.deposit({ owner, vault: vaultPda }, { amount: 1_000_000n })]));
    expect(c.accounts.Vault.decode(accountData(d.svm, vaultPda))).toMatchObject({ owner: owner.address, deposited: 1_000_000n, withdrawn: 0n });
  });

  it("escrow: make derives the offer PDA from the u64 seed argument", async () => {
    const d = await load<Any>("examples/escrow.ts");
    const maker = await fundedSigner(d.svm);
    const seed = 0x0102030405060708n;
    const [offer] = await pda(d.programId, ["offer", maker.address, new Uint8Array(new BigUint64Array([seed]).buffer)]);
    const [a, b, vault, mintB] = await Promise.all([1, 2, 3, 4].map(async () => (await generateKeyPairSigner()).address));
    const made = await d.client.escrow.make({ maker, makerTokenA: a, vault }, { seed, amountA: 10n, wantB: 3n, mintB });
    const hand = ix(
      d,
      "make",
      { seed: new BN(seed.toString()), amount_a: new BN(10), want_b: new BN(3), mint_b: { toBuffer: () => Buffer.from(getAddressEncoder().encode(mintB)) } },
      [
        { address: maker.address, signer: maker, writable: true },
        { address: offer, writable: true },
        { address: a, writable: true },
        { address: vault, writable: true },
        { address: SYSTEM_PROGRAM },
        { address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address },
      ],
    );
    expect(shape(made)).toEqual(shape(hand));
    expect((await d.client.escrow.pdas.offer({ maker: maker.address, seed }))[0]).toBe(offer);
    void b;
  });
});

describe("generated client: TypeSOL storage types", () => {
  it("ledgerbook: FixedString, Option and Vec in account data; Option and string arguments", async () => {
    const d = await load<Any>("examples/ledgerbook.ts");
    const c = d.client.ledgerbook;
    const [admin, alice, approver] = [await fundedSigner(d.svm), await fundedSigner(d.svm), await fundedSigner(d.svm)];
    const create = await c.create({ admin }, { title: "grants", approver: approver.address });
    const [bookPda] = await pda(d.programId, ["book", admin.address, new TextEncoder().encode("grants")]);
    expect(create.accounts[1].address).toBe(bookPda);
    expectOk(await send(d.svm, admin, [create]));
    expectOk(
      await send(d.svm, alice, [
        await c.file({ who: alice, book: bookPda }, { amount: 100n, note: "rent", memo: 7n }),
        await c.file({ who: alice, book: bookPda }, { amount: 250n, note: "travel", memo: null }),
      ]),
    );
    const book = c.accounts.Book.decode(accountData(d.svm, bookPda));
    expect(book.title).toBe("grants");
    expect(book.approver).toBe(approver.address);
    expect(book.lastAmount).toBe(250n);
    expect(book.entries.map((e: Any) => [e.who, e.amount, e.status, e.note])).toEqual([
      [alice.address, 100n, d.client.Status.Pending, "rent"],
      [alice.address, 250n, d.client.Status.Pending, "travel"],
    ]);
    // Round trip: encoding the decoded value reproduces the account bytes.
    expect([...c.accounts.Book.encode(book)]).toEqual([...accountData(d.svm, bookPda)]);

    const total = await send(d.svm, admin, [await c.total({ book: bookPda }, { status: d.client.Status.Pending })]);
    expect(c.returns.total(expectOk(total).returnData().data())).toBe(350n);

    const res = await send(d.svm, admin, [await c.setApprover({ admin, book: bookPda }, { approver: null })]);
    expectOk(res);
    expect(c.accounts.Book.decode(accountData(d.svm, bookPda)).approver).toBeNull();
  });

  it("fixedvec: FixedVec fields decode as arrays and encode back to the same bytes", async () => {
    const d = await load<Any>("test/fixtures/fixedvec.ts");
    const c = d.client.fixedvec;
    const payer = await fundedSigner(d.svm);
    const create = await c.create({ payer });
    expectOk(await send(d.svm, payer, [create]));
    const board = create.accounts[1].address;
    const other = (await generateKeyPairSigner()).address;
    expectOk(await send(d.svm, payer, [await c.addOwner({ payer, board }, { owner: other })]));
    expectOk(await send(d.svm, payer, [await c.addMember({ payer, board }, { key: other, weight: 9n })]));
    const b = c.accounts.Board.decode(accountData(d.svm, board));
    expect(b.owners).toEqual([payer.address, other]);
    expect(b.members).toEqual([{ who: other, weight: 9n }]);
    expect(b.last.notes).toEqual(["hi"]);
    expect(b.log).toEqual([9n]);
    expect([...c.accounts.Board.encode(b)]).toEqual([...accountData(d.svm, board)]);
  });

  it("profiles: strings in events, FixedString arrays, PDA from a string argument", async () => {
    const d = await load<Any>("examples/profiles.ts");
    const c = d.client.profiles;
    const owner = await fundedSigner(d.svm);
    expectOk(await send(d.svm, owner, [await c.register({ owner }, { name: "ada" })]));
    const [profile] = await c.pdas.profile({ owner, name: "ada" });
    const renamed = expectOk(
      await send(d.svm, owner, [await c.rename({ owner, profile }, { name: "grace" }), await c.tag({ owner, profile }, { slot: 1n, label: "math" })]),
    );
    expect(c.parseEvents(renamed.logs())).toEqual([{ name: "Renamed", data: { owner: owner.address, from: "ada", to: "grace" } }]);
    const moved = expectOk(await send(d.svm, owner, [await c.move({ owner, profile }, { dx: 3n, dy: -4n })]));
    expect(c.parseEvents(moved.logs())).toEqual([{ name: "Moved", data: { owner: owner.address, home: { x: 3n, y: -4n }, moves: 1 } }]);
    const p = c.accounts.Profile.decode(accountData(d.svm, profile));
    expect(p).toMatchObject({ owner: owner.address, name: "grace", home: { x: 3n, y: -4n }, tags: ["", "math", ""], moves: 1 });
    expect([...c.accounts.Profile.encode(p)]).toEqual([...accountData(d.svm, profile)]);
  });

  it("variants: data-enum arguments, return values and enums stored in account data", async () => {
    const d = await load<Any>("test/fixtures/variants.ts");
    const c = d.client.variants;
    const owner = await fundedSigner(d.svm);
    expectOk(await send(d.svm, owner, [await c.init({ owner })]));
    const [q] = await pda(d.programId, ["queue", owner.address]);
    const deposit = expectOk(await send(d.svm, owner, [await c.submit({ owner, q }, { action: { kind: "Deposit", amount: 40n } })]));
    expect(c.returns.submit(deposit.returnData().data())).toBe(40n);
    expectOk(await send(d.svm, owner, [await c.submit({ owner, q }, { action: { kind: "Move", x: 2n, y: -9n } })]));
    expectOk(await send(d.svm, owner, [await c.reshape({ owner, q }, { label: "home" })]));
    const queue = c.accounts.Queue.decode(accountData(d.svm, q));
    expect(queue).toMatchObject({
      owner: owner.address,
      last: { kind: "Move", x: 2n, y: -9n },
      pending: { x: 2n, y: -9n },
      shape: { kind: "Labeled", at: { x: 0n, y: 0n }, label: "home" },
      balance: 40n,
      count: 2n,
    });
    expect(queue.history[0]).toEqual({ kind: "Deposit", amount: 40n });
    expect(queue.history[3]).toEqual({ kind: "Deposit", amount: 5n });
    expect([...c.accounts.Queue.encode(queue)]).toEqual([...accountData(d.svm, q)]);
    expect(c.parseEvents(deposit.logs())).toEqual([{ name: "Applied", data: { action: { kind: "Deposit", amount: 40n }, balance: 40n } }]);
  });
});

/** Diagnostics of `files` under the strictest settings users are likely to have. */
function strictProblems(files: string[]): string[] {
  const program = ts.createProgram(files, {
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
  return ts.getPreEmitDiagnostics(program).map((x) => ts.flattenDiagnosticMessageText(x.messageText, "\n") + ` (${x.file?.fileName})`);
}

describe("generated client: typechecks", () => {
  it("every example and fixture client, and an Anchor IDL's, pass strict TypeScript", () => {
    const dir = path.join(OUT, "typecheck");
    mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    const programs = [
      ...readdirSync(path.join(ROOT, "examples"))
        .filter((f) => f.endsWith(".ts"))
        .map((f) => `examples/${f}`),
      "examples/orderbook/orderbook.ts",
      ...readdirSync(path.join(ROOT, "test/fixtures"))
        .filter((f) => f.endsWith(".ts"))
        .map((f) => `test/fixtures/${f}`),
    ];
    for (const p of programs) {
      const out = path.join(dir, p.replace(/[/.]/g, "_"));
      let res;
      try {
        res = build(path.join(ROOT, p), out, "11111111111111111111111111111112");
      } catch (e) {
        // Fixtures that only compile with others (multi-file parts) or are rejected on purpose have no client;
        // anything else, and every generator failure, fails the test.
        if (e instanceof CompileError) continue;
        throw e;
      }
      files.push(writeClient(res.idl, path.join(out, `${res.model.name}.client.ts`)).path);
      // Pinned output for the program that uses every storage type (FixedString, Option, Vec, enums, events, returns).
      if (p === "examples/ledgerbook.ts") {
        const golden = fileURLToPath(new URL("./golden/ledgerbook.client.ts", import.meta.url));
        const text = readFileSync(files.at(-1)!, "utf8");
        if (process.env.UPDATE_GOLDEN) writeFileSync(golden, text);
        expect(text).toBe(readFileSync(golden, "utf8"));
      }
    }
    const anchorIdl = JSON.parse(readFileSync(path.join(ROOT, "test/fixtures/anchor_vault.idl.json"), "utf8")) as ClientIdl;
    const anchorClient = path.join(dir, "anchor_vault.client.ts");
    writeFileSync(anchorClient, generateClient(anchorIdl).source);
    files.push(anchorClient);
    expect(files.some((f) => f.includes("orderbook"))).toBe(true);
    expect(files.length).toBeGreaterThan(25);
    expect(strictProblems(files)).toEqual([]);
  });
});

/** A minimal Anchor-style IDL with the given parts. */
const idl = (parts: Partial<ClientIdl>): ClientIdl => ({
  address: "11111111111111111111111111111112",
  metadata: { name: "probe", spec: "0.1.0" },
  instructions: [],
  ...parts,
});
async function importClient(name: string, source: string): Promise<Any> {
  const file = path.join(OUT, "hardening", `${name}.client.ts`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, source);
  expect(strictProblems([file])).toEqual([]);
  return import(pathToFileURL(file).href);
}

describe("generated client: untrusted and unusual IDLs", () => {
  it("refuses values that would be pasted into code, and pre-0.30 IDLs", () => {
    const evil = [
      idl({ accounts: [{ name: "Thing", discriminator: [0, "0]); globalThis.PWNED = 1; void ([0" as unknown as number] }] }),
      idl({ instructions: [{ name: "go(); x", discriminator: [1], accounts: [], args: [] }] }),
      idl({ instructions: [{ name: "go", discriminator: [1], accounts: [{ name: "a; b" }], args: [] }] }),
      idl({ errors: [{ code: "1 + 1" as unknown as number, name: "E" }] }),
      idl({ instructions: [{ name: "go", discriminator: [1], accounts: [{ name: "a", pda: { seeds: [{ kind: "const", value: [256] }] } }], args: [] }] }),
      idl({ instructions: [{ name: "go", discriminator: [1], accounts: [{ name: "a", address: 'not"base58' }], args: [] }] }),
      idl({ instructions: [{ name: "go", accounts: [], args: [] } as never] }),
    ];
    for (const e of evil) expect(() => generateClient(e)).toThrow(ClientIdlError);
    expect(() => generateClient(idl({}), { address: 'x"); boom(' })).toThrow(ClientIdlError);
  });

  it("keeps colliding and reserved names apart, and still typechecks", async () => {
    const c = await importClient(
      "collide",
      generateClient(
        idl({
          instructions: [
            {
              name: "deposit",
              discriminator: [1],
              accounts: [{ name: "new", writable: true }, { name: "data" }, { name: "group", accounts: [{ name: "inner" }] }, { name: "group_inner" }],
              args: [{ name: "args", type: { defined: { name: "DepositArgs" } } }],
            },
            { name: "address", discriminator: [2], accounts: [], args: [] },
          ],
          types: [
            { name: "DepositArgs", type: { kind: "struct", fields: [{ name: "amount", type: "u64" }] } },
            { name: "Event", type: { kind: "struct", fields: [{ name: "x", type: "f64" }] } },
            { name: "Wrap", generics: [{ kind: "type", name: "T" }], type: { kind: "struct", fields: [{ name: "v", type: { generic: "T" } }] } },
            { name: "Uses", type: { kind: "struct", fields: [{ name: "w", type: { defined: { name: "Wrap" } } }] } },
            { name: "Zero", serialization: "bytemuck", type: { kind: "struct", fields: [{ name: "a", type: "u8" }] } },
          ],
        }),
      ).source,
    );
    const ix: Instruction = await c.probe.deposit(
      {
        new: "11111111111111111111111111111113",
        data: "11111111111111111111111111111114",
        groupInner: "11111111111111111111111111111115",
        groupInner2: "11111111111111111111111111111116",
      },
      { args: { amount: 7n } },
    );
    expect([...ix.data!]).toEqual([1, 7, 0, 0, 0, 0, 0, 0, 0]);
    expect(ix.accounts!.map((a) => a.address)).toEqual([
      "11111111111111111111111111111113",
      "11111111111111111111111111111114",
      "11111111111111111111111111111115",
      "11111111111111111111111111111116",
    ]);
    expect(typeof c.probe.addressIx).toBe("function");
    expect(c.getEvent2Codec().decode(c.getEvent2Codec().encode({ x: 1.5 }))).toEqual({ x: 1.5 });
    const notes = generateClient(
      idl({
        types: [
          { name: "Wrap", generics: [{ kind: "type", name: "T" }], type: { kind: "struct", fields: [{ name: "v", type: { generic: "T" } }] } },
          { name: "Uses", type: { kind: "struct", fields: [{ name: "w", type: { defined: { name: "Wrap" } } }] } },
          { name: "Zero", serialization: "bytemuck", type: { kind: "struct", fields: [{ name: "a", type: "u8" }] } },
        ],
      }),
    ).notes;
    expect(notes.join("\n")).toMatch(/Wrap is generic/);
    expect(notes.join("\n")).toMatch(/bytemuck/);
  });

  it("leaves optional accounts out with null, fills them in when omitted, and seeds PDAs with raw bytes arguments", async () => {
    const c = await importClient(
      "optional",
      generateClient(
        idl({
          instructions: [
            {
              name: "go",
              discriminator: [9],
              accounts: [
                { name: "fee", optional: true, address: "11111111111111111111111111111113" },
                {
                  name: "vault",
                  optional: true,
                  pda: {
                    seeds: [
                      { kind: "const", value: [118] },
                      { kind: "arg", path: "blob" },
                    ],
                  },
                },
              ],
              args: [{ name: "blob", type: "bytes" }],
            },
          ],
        }),
      ).source,
    );
    const blob = new Uint8Array([1, 2, 3]);
    const left = await c.probe.go({ fee: null, vault: null }, { blob });
    expect(left.accounts.map((a: { address: string; role: number }) => [a.address, a.role])).toEqual([
      ["11111111111111111111111111111112", 0],
      ["11111111111111111111111111111112", 0],
    ]);
    const filled = await c.probe.go({}, { blob });
    const [vault] = await (
      await import("@solana/kit")
    ).getProgramDerivedAddress({ programAddress: "11111111111111111111111111111112" as Address, seeds: [new Uint8Array([118]), blob] });
    expect(filled.accounts.map((a: { address: string }) => a.address)).toEqual(["11111111111111111111111111111113", vault]);
  });

  it("reads custom codes from kit errors, nested causes and messages", async () => {
    const c = await importClient("errors", generateClient(idl({ errors: [{ code: 6000, name: "Nope", msg: "no" }] })).source);
    const custom = new SolanaError(SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM, { code: 6000, index: 0 });
    expect(c.errorCode(custom)).toBe(6000);
    expect(c.isError(new Error("simulation failed", { cause: custom }), "Nope")).toBe(true);
    expect(c.errorCode("Program failed: custom program error: 0x1770")).toBe(6000);
    expect(c.errorCode(new Error("blockhash not found"))).toBeNull();
  });

  it("names every TypeSOL runtime error the C runtime defines", () => {
    const header = readFileSync(path.join(ROOT, "runtime/typesol_rt.h"), "utf8");
    const codes = [...header.matchAll(/^#define TS_ERR_\w+ (\d+)/gm)].map((m) => Number(m[1]));
    expect(codes.length).toBeGreaterThan(30);
    for (const code of codes) expect(TYPESOL_ERRORS[code], `TS_ERR code ${code}`).toBeDefined();
  });
});
