// Migrate<From, To> (Anchor 1.0's Migration) and the account-level @discriminator it relies on.
import { getU64Encoder } from "@solana/kit";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, acct, compileErrors, customError, decodeAccount, deployFile, expectOk, fundedSigner, ix, pda, send } from "../harness.js";

const HEAD = `import { type FixedString, type Init, type Migrate, type Mut, type Pubkey, type Signer, type SystemProgram, type Vec, type u32, u64, require } from "typesol";
/** The deployed type, kept under a new name: its accounts carry the discriminator of "Counter". */
/** @discriminator account:Counter */
export interface CounterV1 { count: u32; authority: Pubkey; }
/** The new layout: authority moves to the front, count widens, a label is added. */
export interface CounterV2 { authority: Pubkey; count: u64; label: FixedString<8>; }
`;
const PROGRAM = `${HEAD}
/** Stands in for the old program: creates CounterV1 accounts. */
export function openV1(payer: Mut<Signer>, counter: Init<CounterV1>, systemProgram: SystemProgram, id: u64): void {
  counter.create(payer, ["counter", id]);
  counter.count = 41n;
  counter.authority = payer.key;
}
export function upgrade(payer: Mut<Signer>, counter: Migrate<CounterV1, CounterV2>, systemProgram: SystemProgram): void {
  require(counter.from.authority === payer.key, "only the authority migrates");
  counter.migrate(payer, { authority: counter.from.authority, count: u64(counter.from.count) + 1n, label: "v2" });
  counter.to.count += 1n;
}
export function bump(counter: Mut<CounterV2>): void {
  counter.count += 1n;
}
`;

describe("Migrate<From, To>", () => {
  it("rewrites a CounterV1 as a CounterV2: values carried over (fields that move included), resized, rent topped up", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-migrate-"));
    writeFileSync(path.join(dir, "counter.ts"), PROGRAM);
    const d = await deployFile(path.join(dir, "counter.ts"));
    const payer = await fundedSigner(d.svm);
    const [counter] = await pda(d.programId, ["counter", new Uint8Array(getU64Encoder().encode(1n))]);
    const P = { address: payer.address, signer: payer, writable: true };
    expectOk(await send(d.svm, payer, [ix(d, "open_v1", { id: new BN(1) }, [P, { address: counter, writable: true }, { address: SYSTEM_PROGRAM }])]));
    const before = acct(d.svm, counter);
    // The old account carries Counter's discriminator, as the deployed program wrote it.
    expect(Buffer.from(before.data.slice(0, 8))).toEqual(
      Buffer.from((d.idl.accounts as { name: string; discriminator: number[] }[]).find((a) => a.name === "CounterV1")!.discriminator),
    );

    const stranger = await fundedSigner(d.svm);
    const S = { address: stranger.address, signer: stranger, writable: true };
    expect(customError(await send(d.svm, stranger, [ix(d, "upgrade", {}, [S, { address: counter, writable: true }, { address: SYSTEM_PROGRAM }])]))).toBe(6000);

    expectOk(await send(d.svm, payer, [ix(d, "upgrade", {}, [P, { address: counter, writable: true }, { address: SYSTEM_PROGRAM }])]));
    const v2 = decodeAccount<{ authority: { toBase58(): string }; count: BN; label: string }>(d, d.svm, "CounterV2", counter);
    expect([v2.authority.toBase58(), v2.count.toString()]).toEqual([payer.address, "43"]); // 41 + 1 in migrate, + 1 after
    const after = acct(d.svm, counter);
    expect(after.data.length).toBeGreaterThan(before.data.length);
    expect(after.lamports).toBeGreaterThanOrEqual(d.svm.minimumBalanceForRentExemption(BigInt(after.data.length)));

    // Already migrated: the From discriminator no longer matches (3002), as under Anchor.
    expect(customError(await send(d.svm, payer, [ix(d, "upgrade", {}, [P, { address: counter, writable: true }, { address: SYSTEM_PROGRAM }])]))).toBe(3002);
    expectOk(await send(d.svm, payer, [ix(d, "bump", {}, [{ address: counter, writable: true }])]));
    expect(decodeAccount<{ count: BN }>(d, d.svm, "CounterV2", counter).count.toString()).toBe("44");
  });

  const ix_ = (params: string, body: string) => `${HEAD}export function go(${params}): void {\n${body}\n}\n`;
  const P = "payer: Mut<Signer>, c: Migrate<CounterV1, CounterV2>, systemProgram: SystemProgram";
  it.each([
    ["acct.to before migrate", ix_(P, "c.to.count = 1n;"), /c\.to exists after c\.migrate/],
    ["acct.from after migrate", ix_(P, 'c.migrate(payer, { authority: payer.key, count: 0n, label: "" });\nconst n = c.from.count;'), /c\.from is gone after/],
    ["never migrated", ix_(P, "const n = c.from.count;"), /is never migrated/],
    // Every field of the new struct is set: a forgotten one would silently be zero.
    ["a value missing a field", ix_(P, "c.migrate(payer, { authority: payer.key, count: 1n });"), /not assignable to parameter of type 'CounterV2'/],
    [
      "migrate not at the top level",
      ix_(P, 'if (c.from.count > 0n) { c.migrate(payer, { authority: payer.key, count: 0n, label: "" }); }'),
      /must be a top-level statement/,
    ],
    [
      "a reference into from used after migrate",
      ix_(P, 'const old = c.from;\nc.migrate(payer, { authority: payer.key, count: 0n, label: "" });\nrequire(old.count > 0n, "x");'),
      /"old" still refers to data in c/,
    ],
    [
      "growing without a SystemProgram",
      ix_("payer: Mut<Signer>, c: Migrate<CounterV1, CounterV2>", 'c.migrate(payer, { authority: payer.key, count: 0n, label: "" });'),
      /needs a SystemProgram/,
    ],
    [
      "two structs with one discriminator",
      `${HEAD}/** @discriminator account:Counter */\nexport interface Same { a: u64; }\nexport function go(payer: Mut<Signer>, c: Migrate<CounterV1, Same>, systemProgram: SystemProgram): void { c.migrate(payer, { a: 0n }); }\n`,
      /have the same discriminator/,
    ],
    [
      "a growable Vec",
      `${HEAD}export interface Book { items: Vec<u64>; }\nexport function go(payer: Mut<Signer>, c: Migrate<CounterV1, Book>, systemProgram: SystemProgram): void {}\n`,
      /growable Vec; Migrate<From, To> takes fixed-size structs/,
    ],
  ])("refuses %s", (_, source, error) => {
    expect(compileErrors(source)).toMatch(error);
  });
});
