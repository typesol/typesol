// Seeds<…, ["@acct.field"]>: PDA seeds taken from a struct account's fields (test/fixtures/seed-fields.ts).
import { generateKeyPairSigner, getAddressDecoder, getAddressEncoder } from "@solana/kit";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { CompileError, generate } from "../src/compiler/index.js";
import { BN, SYSTEM_PROGRAM, customError, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "./harness.js";
import { pk } from "./ports-helpers.js";

const u64le = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};

describe("Seeds from account fields", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/seed-fields.ts", import.meta.url)));
  });

  it("checks an account against seeds from its own fields and another account's", async () => {
    const payer = await fundedSigner(d.svm);
    const [book, bookBump] = await pda(d.programId, ["book", payer.address, u64le(7n)]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "open", { id: new BN(7), tier: { Pro: {} } }, [
          { address: payer.address, signer: payer, writable: true },
          { address: book, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const t = expectOk(await send(d.svm, payer, [ix(d, "touch", {}, [{ address: book }])]));
    expect([...t.returnData().data()]).toEqual([bookBump]);

    const [vault, vaultBump] = await pda(d.programId, ["vault", payer.address, new Uint8Array([1])]);
    const v = expectOk(await send(d.svm, payer, [ix(d, "vault", {}, [{ address: book }, { address: vault }])]));
    expect([...v.returnData().data()]).toEqual([vaultBump]);

    // Seeds from the wrong field values: another owner's vault, or the Basic tier's.
    const other = (await generateKeyPairSigner()).address;
    const [wrongOwner] = await pda(d.programId, ["vault", other, new Uint8Array([1])]);
    expect(customError(await send(d.svm, payer, [ix(d, "vault", {}, [{ address: book }, { address: wrongOwner }])]))).toBe(2006);
    const [wrongTier] = await pda(d.programId, ["vault", payer.address, new Uint8Array([0])]);
    expect(customError(await send(d.svm, payer, [ix(d, "vault", {}, [{ address: book }, { address: wrongTier }])]))).toBe(2006);
    expect(getAddressEncoder().encode(vault).length).toBe(32);
    // findProgramAddress with the enum field as a seed derives the same vault.
    const found = expectOk(await send(d.svm, payer, [ix(d, "vault_address", { program: pk(d.programId) }, [{ address: book }])]));
    expect(getAddressDecoder().decode(found.returnData().data())).toBe(vault);
  });

  it("records the field seeds in the IDL as account paths", () => {
    const ixs = d.idl.instructions as { name: string; accounts: { name: string; pda?: { seeds: unknown[] } }[] }[];
    const vault = ixs.find((i) => i.name === "vault")!.accounts.find((a) => a.name === "vault")!;
    expect(vault.pda!.seeds.slice(1)).toEqual([
      { kind: "account", path: "book.owner", account: "Book" },
      { kind: "account", path: "book.tier", account: "Book" },
    ]);
  });

  it("explains fields that cannot be seeds", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-seedfields-"));
    const head = `import { type Account, type AccountInfo, type Pubkey, type Seeds, type u64 } from "typesol";\nexport interface Book { owner: Pubkey; id: u64; flag: boolean; }\n`;
    const errors = (body: string) => {
      const f = path.join(dir, `p${Math.random().toString(36).slice(2)}.ts`);
      writeFileSync(f, head + body);
      try {
        generate(f);
      } catch (e) {
        if (e instanceof CompileError) return e.diagnostics.map((x) => x.message).join("\n");
        throw e;
      }
      return "";
    };
    expect(errors(`export function f(book: Account<Book>, v: Seeds<AccountInfo, ["@book.nope"]>): void {}`)).toMatch(/Book has no field "nope"/);
    expect(errors(`export function f(book: Account<Book>, v: Seeds<AccountInfo, ["@book.flag"]>): void {}`)).toMatch(/cannot be a seed/);
    expect(errors(`export function f(info: AccountInfo, v: Seeds<AccountInfo, ["@info.owner"]>): void {}`)).toMatch(/field of a struct account parameter/);
  });
});
