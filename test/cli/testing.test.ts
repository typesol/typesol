// typesol/testing: accounts by name with the IDL's flags and fixed addresses, plain argument and result values.
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import type { Address } from "@solana/kit";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { programHarness } from "../../src/testing.js";
import { deployFile } from "../harness.js";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}.ts`, import.meta.url));

describe("typesol/testing", () => {
  it("fills signer/writable flags and fixed program addresses, leaves optional accounts out with null", async () => {
    const d = await deployFile(fixture("optional"));
    const t = programHarness(d.svm, d.programId, d.idl as never);
    const owner = await t.wallet();
    const bank = await t.pda("bank", owner);
    t.ok(await t.send(owner, t.ix("open", {}, { owner, bank }))); // systemProgram from the IDL's address
    const add = (b: typeof bank | null) => t.ix("maybeAdd", { amount: 7n }, { owner, bank: b, referrer: null });
    expect(t.returned("maybeAdd", await t.send(owner, add(bank)))).toBe(1n);
    expect(t.returned("maybe_add", await t.send(owner, add(null)))).toBe(0n);
    expect(await t.account<{ owner: string; total: bigint }>("Bank", bank)).toEqual({ owner: owner.address, total: 7n });
    expect(t.balance(bank)).toBeGreaterThan(0n);
  });

  it("derives PDA accounts from the IDL's seeds when they are left out", async () => {
    const d = await deployFile(fixture("optional"));
    const t = programHarness(d.svm, d.programId, d.idl as never);
    const owner = await t.wallet();
    t.ok(await t.send(owner, t.ix("open", {}, { owner }))); // bank = PDA ["bank", owner]
    const bank = await t.pda("bank", owner);
    expect((await t.account<{ owner: string }>("Bank", bank))?.owner).toBe(owner.address);

    const f = await deployFile(fixture("forof"));
    const u = programHarness(f.svm, f.programId, f.idl as never);
    const admin = await u.wallet();
    const who = (await u.wallet()).address;
    u.ok(await u.send(admin, u.ix("setup", {}, { admin }))); // created at its PDA: derived
    const ledger = await u.pda("ledger", admin);
    u.ok(await u.send(admin, u.ix("add", { who, amount: 5n }, { admin, ledger }))); // no seeds in this instruction: passed
    expect((await u.account<{ entries: { amount: bigint }[] }>("Ledger", ledger))?.entries[0].amount).toBe(5n);
  });

  it("derives ATAs whose token program has a fixed address, and PDAs seeded by unit-enum arguments", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-testing-"));
    const file = path.join(dir, "seeds.ts");
    writeFileSync(
      file,
      `import { type AccountInfo, type Ata, type Mint, type Seeds, type Signer, type TokenAccount, type TokenProgram } from "typesol";
export enum Side { Bid, Ask }
export function holder(owner: AccountInfo, mint: Mint, ata: Ata<TokenAccount, "owner", "mint">, tokenProgram: TokenProgram): void {}
export function book(payer: Signer, book: Seeds<AccountInfo, ["book", "@side"]>, side: Side): void {}
`,
    );
    const d = await deployFile(file);
    const t = programHarness(d.svm, d.programId, d.idl as never);
    const owner = (await t.wallet()).address;
    const mint = (await t.wallet()).address;
    const built = t.ix("holder", {}, { owner, mint });
    const [expected] = await findAssociatedTokenPda({ owner, mint, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address });
    expect(built.accounts![2].address).toBe(expected);
    const payer = await t.wallet();
    expect(t.ix("book", { side: 1 }, { payer }).accounts![1].address).toBe(await t.pda("book", Uint8Array.of(1)));
    expect(t.ix("book", { side: { ask: {} } }, { payer }).accounts![1].address).toBe(await t.pda("book", Uint8Array.of(1)));
  });

  it("converts data-enum variants with fields like structs", async () => {
    const d = await deployFile(fileURLToPath(new URL("../fixtures/enumstr.ts", import.meta.url)));
    const t = programHarness(d.svm, d.programId, d.idl as never);
    const owner = await t.wallet();
    const board = await t.pda("board", owner);
    t.ok(await t.send(owner, t.ix("setup", {}, { owner })));
    // A bigint for a u8 field and a camelCase variant key, both converted for the Anchor coder.
    expect(t.returned("run", await t.send(owner, t.ix("run", { cmd: { say: { text: "abc", times: 2n } } }, { owner, board })))).toBe(6n);
  });

  it("says what is wrong with an instruction it cannot build", async () => {
    const d = await deployFile(fixture("optional"));
    const t = programHarness(d.svm, d.programId, d.idl as never);
    const owner = await t.wallet();
    expect(() => t.ix("nope")).toThrow(/no instruction "nope"/);
    expect(() => t.ix("open", {}, {})).toThrow(/account "owner" is required/);
    expect(() => t.ix("open", {}, { owner, bank: owner.address, extra: owner.address })).toThrow(/has no account "extra"/);
    expect(() => t.errorCode(t.ok as never)).toThrow();
  });

  it("converts arguments (Options, Pubkeys, u16) and decodes struct return data", async () => {
    const d = await deployFile(fixture("retdata"));
    const t = programHarness(d.svm, d.programId, d.idl as never);
    const owner = await t.wallet();
    const q = t.returned<Record<string, unknown>>("preview", await t.send(owner, t.ix("preview", { price: 21n, limit: 4n }, { owner })));
    expect(q).toMatchObject({ owner: owner.address, price: 42n, fee: 5, open: false });
    expect(q).toMatchObject({ limit: 4n, label: "preview" }); // fixed-layout Option and FixedString as plain values
    const n = await t.send(owner, t.ix("preview", { price: 1n, limit: null }, { owner }));
    expect(t.returned<{ limit: bigint | null }>("preview", n).limit).toBeNull();
    expect(() => t.ix("preview", { price: 1n, limit: null }, { owner: owner.address })).toThrow(/signs; pass its keypair/);
  });
});
