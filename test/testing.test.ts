// typesol/testing: accounts by name with the IDL's flags and fixed addresses, plain argument and result values.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { programHarness } from "../src/testing.js";
import { deployFile } from "./harness.js";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}.ts`, import.meta.url));

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

  it("says what is wrong with an instruction it cannot build", async () => {
    const d = await deployFile(fixture("optional"));
    const t = programHarness(d.svm, d.programId, d.idl as never);
    const owner = await t.wallet();
    expect(() => t.ix("nope")).toThrow(/no instruction "nope"/);
    expect(() => t.ix("open", {}, { owner })).toThrow(/account "bank" is required/);
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
