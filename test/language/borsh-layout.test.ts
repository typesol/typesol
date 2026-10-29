// `@layout borsh`: accounts stored as Anchor stores them. The account is unpacked into the fixed-layout struct when an
// instruction starts and packed back when it returns. Checked against Anchor's own coder, against bad bytes, and (when
// test/anchor-twins is built) against the Anchor twin byte for byte, including taking over accounts the twin created.
import { mkdtempSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, type KeyPairSigner, address, generateKeyPairSigner } from "@solana/kit";
import { BorshCoder } from "@anchor-lang/core";
import { LiteSVM } from "litesvm";
import { beforeAll, describe, expect, it } from "vitest";
import { build } from "../../src/compiler/index.js";
import { BN, SYSTEM_PROGRAM, acct, customError, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed, compileErrors } from "../harness.js";

const fixture = (f: string) => fileURLToPath(new URL(`../fixtures/${f}`, import.meta.url));

describe("@layout borsh", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fixture("borsh-features.ts"));
  });

  type Book = {
    bump: number;
    title: string;
    open: boolean;
    mood: { calm?: object; busy?: object };
    pages: { x: number; y: number }[];
    tags: string[];
    home: { x: number; y: number } | null;
    code: number[];
    count: BN;
  };
  const decode = (a: Address) => {
    const data = Buffer.from(acct(d.svm, a).data);
    const book = d.coder.accounts.decode("Book", data) as Book;
    // Anchor's encoder gives back exactly the bytes the program wrote (and nothing past them but zeros).
    const enc = d.coder.accounts.encode("Book", book) as unknown as Promise<Buffer> | Buffer;
    return { book, data, enc };
  };

  it("writes Anchor's bytes, through helpers, InitIfNeeded, struct references and for…of", async () => {
    const payer = await fundedSigner(d.svm);
    const [book] = await pda(d.programId, ["book", payer.address]);
    const P = { address: payer.address, signer: payer, writable: true };
    const B = { address: book, writable: true };
    const upsert = (title: string, tag: string) => send(d.svm, payer, [ix(d, "upsert", { title, tag }, [P, B, { address: SYSTEM_PROGRAM }])]);
    expectOk(await upsert("first", "a"));
    expectOk(await upsert("a longer title", "bb"));
    for (const [x, y] of [
      [1, 2],
      [3, 4],
      [5, 6],
    ])
      expectOk(await send(d.svm, payer, [ix(d, "page", { x, y }, [{ address: payer.address, signer: payer }, B])]));
    const { book: b, data, enc } = decode(book);
    expect(b.title).toBe("a longer title");
    expect(b.open).toBe(false);
    expect(Object.keys(b.mood)).toEqual(["Calm"]);
    expect(b.tags).toEqual(["a", "bb"]);
    expect(b.pages.map((p) => [p.x, p.y])).toEqual([
      [1, 5],
      [3, 4],
      [5, 6],
    ]); // first.y bumped once per page call
    expect(b.home && [b.home.x, b.home.y]).toEqual([1, 5]);
    expect(b.code).toEqual([3, 0, 0, 0]);
    expect(b.count.toNumber()).toBe(2);
    const bytes = Buffer.from(await enc);
    expect(data.subarray(0, bytes.length).equals(bytes)).toBe(true);
    // Its space is the largest Borsh form (Anchor's InitSpace): 8 + 1 + (4+16) + 1 + 1 + (4+4*4) + (4+3*(4+8)) + (1+4) + 4 + 8.
    expect(data.length).toBe(8 + 1 + 20 + 1 + 1 + 20 + 40 + 5 + 4 + 8);

    expectOk(await send(d.svm, payer, [ix(d, "done", {}, [P, B])]));
    expect(d.svm.getAccount(book).exists ? acct(d.svm, book).data.length : 0).toBe(0);
  });

  it("refuses bytes that are not a valid Borsh value (3003) and a value the account cannot hold (3004)", async () => {
    const payer = await fundedSigner(d.svm);
    const [book] = await pda(d.programId, ["book", payer.address]);
    const P = { address: payer.address, signer: payer, writable: true };
    const B = { address: book, writable: true };
    expectOk(await send(d.svm, payer, [ix(d, "upsert", { title: "t", tag: "x" }, [P, B, { address: SYSTEM_PROGRAM }])]));
    const good = Buffer.from(acct(d.svm, book).data);
    const put = (data: Buffer) => {
      const a = d.svm.getAccount(book);
      if (!a.exists) throw new Error("no book");
      d.svm.setAccount({ ...a, address: book, data: new Uint8Array(data) } as never);
    };
    const pageIx = () => send(d.svm, payer, [ix(d, "page", { x: 1, y: 1 }, [{ address: payer.address, signer: payer }, B])]);
    // title length 17 > FixedString<16>
    const longTitle = Buffer.from(good);
    longTitle.writeUInt32LE(17, 9);
    put(longTitle);
    expect(customError(await pageIx())).toBe(3003);
    // bool 2
    const badBool = Buffer.from(good);
    badBool[8 + 1 + 4 + 1] = 2;
    put(badBool);
    expect(customError(await pageIx())).toBe(3003);
    put(good);
    expectOk(await pageIx());
    // An account sized for exactly what it holds (as a hand-sized Anchor account may be): read and written as long as
    // the value fits, and a value that no longer fits fails with 3004.
    const tight = Buffer.from(
      await d.coder.accounts.encode("Book", {
        bump: 0,
        title: "t",
        open: false,
        mood: { Calm: {} },
        pages: [],
        tags: [],
        home: null,
        code: [0, 0, 0, 0],
        count: new BN(1),
      }),
    );
    expect(tight.length).toBe(8 + 1 + 5 + 1 + 1 + 4 + 4 + 1 + 4 + 8);
    put(tight);
    expect(customError(await pageIx())).toBe(3004);
    expectOk(await send(d.svm, payer, [ix(d, "done", {}, [P, B])])); // read, packed unchanged, closed
  });

  it("refuses what has no Borsh account layout", () => {
    const errors = (body: string) =>
      compileErrors(
        `import { type Account, type FixedArray, type FixedString, type FixedVec, type Mut, type Vec, type Zeroed, type u64, emit, loadAccount, remainingAccounts } from "typesol";\n${body}\n`,
      );
    const S = "/** @layout borsh */\nexport interface S { n: u64; name: FixedString<8> }\n";
    expect(errors(`${S}export function f(s: Mut<S>): void { s.n += 1n; }`)).toBe("");
    expect(errors(`/** @layout borsh */\nexport interface S { n: u64; xs: Vec<u64> }\nexport function f(s: Mut<S>): void {}`)).toBe(""); // Anchor's Vec (borsh-vec.test.ts)
    expect(errors(`/** @layout packed */\nexport interface S { n: u64 }\nexport function f(s: Mut<S>): void {}`)).toMatch(/@layout is borsh/);
    expect(
      errors(`export interface In { name: FixedString<8> }\n/** @layout borsh */\nexport interface S { inner: In }\nexport function f(s: Mut<S>): void {}`),
    ).toMatch(/nested structs and lists hold fixed-size values only/);
    // Whole arguments, return values and events are Borsh (test/language/borsh-values.test.ts); inside a list they are not.
    expect(errors(`${S}export function f(s: S): S { return s; }`)).toBe("");
    expect(errors(`${S}export function f(s: FixedArray<S, 2>): void {}`)).toMatch(/pass it as a whole argument/);
    expect(errors(`${S}export function f(s: Zeroed<S>): void { s.n = 1n; }`)).toBe(""); // starts empty (test/language/multisig-features.test.ts)
    expect(errors(`${S}export function f(): void { emit<S>({ n: 1n, name: "x" }); }`)).toBe("");
    expect(errors(`${S}export function f(): void { const s = loadAccount<S>(remainingAccounts().get(0n)); }`)).toMatch(/instruction parameter/);
    expect(errors(`${S}export interface T { s: S }\nexport function f(t: Mut<T>): void {}`)).toMatch(/account data only/);
  });
});

// ---- The Anchor twin (test/anchor-twins/programs/profile) ----------------------------------------------------------------
const TWIN = fileURLToPath(new URL("../../test/anchor-twins/target/deploy/anchor_profile.so", import.meta.url));
const ID = address("EaiwmXTVEwU6sh1wAizeXHmPkHS4s6HaHr4EX3vZ6kJq");

describe.skipIf(!existsSync(TWIN))("@layout borsh against Anchor (test/anchor-twins/programs/profile)", () => {
  let typesolSo: string;
  let coder: Deployed["coder"];
  let idl: Deployed["idl"];
  beforeAll(() => {
    const res = build(fixture("borsh-profile.ts"), mkdtempSync(path.join(os.tmpdir(), "typesol-borsh-profile-")), ID);
    typesolSo = res.soPath;
    idl = res.idl as unknown as Deployed["idl"];
    coder = new BorshCoder(idl);
  });

  const str = (s: string) => ({ name: s });
  const steps: [string, Record<string, unknown>][] = [
    ["bump", { by: new BN(5) }],
    ["add_tag", { tag: new BN(10) }],
    ["add_tag", { tag: new BN(20) }],
    ["set_badge", { badge: new BN(7) }],
    ["rename", str("alexander-the-great-of-macedon")],
    ["bump", { by: new BN(1) }],
    ["rename", str("al")],
    ["set_badge", { badge: null }],
    ["add_tag", { tag: new BN(30) }],
  ];

  /** Run `create` then `steps` on one program, switching to `then` (another .so at the same address) after `switchAt` steps. */
  async function run(first: string, then: string, switchAt: number, owner: KeyPairSigner) {
    const svm = new LiteSVM();
    svm.addProgramFromFile(ID, first);
    svm.airdrop(owner.address, 10_000_000_000n as never);
    const D: Deployed = { svm, programId: ID, coder, idl };
    const [profile] = await pda(ID, ["profile", owner.address]);
    const O = { address: owner.address, signer: owner };
    const snapshots: Buffer[] = [];
    expectOk(
      await send(svm, owner, [
        ix(D, "create", { name: "alice" }, [{ ...O, writable: true }, { address: profile, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    snapshots.push(Buffer.from(acct(svm, profile).data));
    for (const [i, [name, args]] of steps.entries()) {
      if (i === switchAt) svm.addProgramFromFile(ID, then);
      expectOk(await send(svm, owner, [ix(D, name, args, [O, { address: profile, writable: true }])]));
      snapshots.push(Buffer.from(acct(svm, profile).data));
    }
    const total = expectOk(await send(svm, owner, [ix(D, "total", {}, [{ address: profile }])]));
    return { snapshots, total: Buffer.from(total.returnData().data()).readBigUInt64LE(0) };
  }

  it("writes the same bytes as Anchor after every instruction", async () => {
    const owner = await generateKeyPairSigner();
    const a = await run(TWIN, TWIN, Infinity, owner);
    const t = await run(typesolSo, typesolSo, Infinity, owner);
    t.snapshots.forEach((s, i) => expect(s.equals(a.snapshots[i]!), `after step ${i}`).toBe(true));
    expect(t.total).toBe(a.total);
    expect(t.total).toBe(5n + 1n + 10n + 20n + 30n);
  });

  it("takes over accounts Anchor created (and hands them back): no migration", async () => {
    const owner = await generateKeyPairSigner();
    const anchorOnly = await run(TWIN, TWIN, Infinity, owner);
    for (const at of [1, 4, 7]) {
      const toTypesol = await run(TWIN, typesolSo, at, owner);
      const toAnchor = await run(typesolSo, TWIN, at, owner);
      for (const r of [toTypesol, toAnchor]) {
        r.snapshots.forEach((s, i) => expect(s.equals(anchorOnly.snapshots[i]!), `switch at ${at}, step ${i}`).toBe(true));
        expect(r.total).toBe(anchorOnly.total);
      }
    }
  });
});
