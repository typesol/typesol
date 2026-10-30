// Account groups (Anchor's composite accounts): the IDL nests them, the constraints inside name the group's fields,
// the body reads `p.pool.reserve` and passes `p.vault` to CPIs, and typesol/testing and the client flatten them.
import { type Address, type KeyPairSigner } from "@solana/kit";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { generateClient } from "../../src/tools/clientgen.js";
import { programHarness, type TestProgram } from "../../src/testing.js";
import { compileErrors, deployFile, type Deployed } from "../harness.js";

const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

describe("account groups (test/fixtures/account-groups.ts)", () => {
  let d: Deployed;
  let t: TestProgram;
  let admin: KeyPairSigner;
  let mint: Address;
  let pool: Address;
  let vault: Address;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/account-groups.ts", import.meta.url)));
    t = programHarness(d.svm, d.programId, d.idl);
    admin = await t.wallet();
    mint = await t.mint({ authority: admin.address, decimals: 6 });
    pool = await t.pda("pool", mint);
    vault = await t.tokenAccount({ mint, owner: pool });
    t.ok(await t.send(admin, t.ix("open", {}, { admin, pPool: pool, pMint: mint, pVault: vault })));
  });

  it("nests a group's accounts in the IDL, with seeds and relations relative to the group", () => {
    const ix = (d.idl as unknown as { instructions: { name: string; accounts: Record<string, unknown>[] }[] }).instructions.find((i) => i.name === "deposit")!;
    expect(ix.accounts.map((a) => a.name)).toEqual(["user", "from", "p"]);
    const group = ix.accounts[2] as {
      accounts: { name: string; pda?: { seeds: { kind: string; path?: string }[] }; relations?: string[]; optional?: boolean }[];
    };
    expect(group.accounts.map((a) => a.name)).toEqual(["pool", "mint", "vault", "token_program", "memo"]);
    expect(group.accounts[0].pda?.seeds.at(-1)).toEqual({ kind: "account", path: "mint" });
    expect(group.accounts[2].relations).toEqual(["pool"]);
    expect(group.accounts[4].optional).toBe(true);
  });

  it("checks the group's constraints and runs the body on its fields", async () => {
    const user = await t.wallet();
    const from = await t.tokenAccount({ mint, owner: user.address, amount: 1_000n });
    const deposit = (amount: bigint, accounts: Record<string, unknown> = {}) =>
      t.send(user, t.ix("deposit", { amount }, { user, from, pPool: pool, pMint: mint, pVault: vault, pTokenProgram: TOKEN, pMemo: null, ...accounts }));
    expect(t.returned("deposit", await deposit(300n))).toBe(0n);
    expect(t.returned("deposit", await deposit(100n, { pMemo: admin.address }))).toBe(1n);
    expect(t.tokenBalance(vault)).toBe(400n);
    expect((await t.account<{ reserve: bigint }>("Pool", pool))?.reserve).toBe(400n);
    expect(t.errorCode(await deposit(0n))).toBe(6000); // constraint(p.pool, …, PoolError.ZeroAmount)

    // A vault the pool does not hold (has_one between fields of the group), another mint's pool (seeds).
    const otherVault = await t.tokenAccount({ mint, owner: pool });
    expect(t.errorCode(await deposit(1n, { pVault: otherVault }))).toBe(2001);
    const otherMint = await t.mint({ authority: admin.address });
    expect(t.errorCode(await deposit(1n, { pMint: otherMint }))).toBe(2006);
  });

  it("signs as a group's PDA, and the same group serves another instruction", async () => {
    const to = await t.tokenAccount({ mint, owner: admin.address });
    const withdraw = (who: KeyPairSigner, amount: bigint) =>
      t.send(who, t.ix("withdraw", { amount }, { admin: who, pPool: pool, pMint: mint, pVault: vault, pTokenProgram: TOKEN, pMemo: null, to }));
    const before = t.tokenBalance(vault)!;
    t.ok(await withdraw(admin, 50n));
    expect([t.tokenBalance(to), t.tokenBalance(vault)]).toEqual([50n, before - 50n]);
    expect(t.errorCode(await withdraw(await t.wallet(), 1n))).toBe(6001); // NotAdmin
  });

  it("generates a client whose input flattens the group", () => {
    const { source } = generateClient(d.idl as never);
    expect(source).toMatch(/pPool\??: /);
    expect(source).toMatch(/pVault\??: /);
  });

  it("refuses a group used as a value, an optional group and non-account fields", () => {
    const head = `import { type Mint, type Mut, type Signer, type u64 } from "typesol";\nexport interface G { mint: Mint; owner: Signer }\n`;
    expect(compileErrors(head + `export function f(g: G): void { const x = g; }`)).toMatch(/"g" is a group of accounts/);
    expect(compileErrors(head + `export function f(g: G | null): void {}`)).toMatch(/account groups cannot be optional/);
    expect(
      compileErrors(`import { type Mint, type u64 } from "typesol";\nexport interface G { mint: Mint; n: u64 }\nexport function f(g: G): void {}`),
    ).toMatch(/G is an account group: every field is an account/);
    expect(compileErrors(head + `function h(g: G): void {}\nexport function f(g: G): void { h(g); }`)).toMatch(/helpers take its accounts one by one/);
    expect(compileErrors(head + `export interface H { inner: G; mint: Mint }\nexport function f(h: H): void {}`)).toMatch(/do not nest yet/);
  });
});
