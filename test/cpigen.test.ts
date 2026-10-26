import { type Address, address, getAddressEncoder } from "@solana/kit";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { build, generate } from "../src/compiler/index.js";
import { generateCpi, type Idl } from "../src/cpigen.js";
import { BN, SYSTEM_PROGRAM, deployFile, expectOk, fundedSigner, ix, pda, send } from "./harness.js";

const VAULT_IDL = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/anchor_vault.idl.json", import.meta.url)), "utf8")) as Idl;
const VAULT_SO = fileURLToPath(new URL("../bench/anchor/target/deploy/anchor_vault.so", import.meta.url));
const VAULT_ID = address(VAULT_IDL.address!);

/** A caller program next to the generated helpers: deposits through the Anchor vault, as a wallet and as a PDA. */
const CALLER = `import { type Mut, type Program, type Signer, type SystemProgram, type AccountInfo, type u8, type u64, signer } from "typesol";
import { vaultDeposit, vaultOpen, vaultWithdraw } from "./vault_cpi";

export function openAndDeposit(owner: Mut<Signer>, vault: Mut<AccountInfo>, systemProgram: SystemProgram, vaultProgram: Program<"${VAULT_IDL.address}">, amount: u64): void {
  vaultOpen(vaultProgram, owner, vault, systemProgram, signer([]));
  vaultDeposit(vaultProgram, owner, vault, systemProgram, amount, signer([]));
}

/** The caller's PDA ["wallet"] owns a vault of its own: it signs the CPIs with its seeds. */
export function pdaVault(payer: Mut<Signer>, wallet: Mut<AccountInfo>, vault: Mut<AccountInfo>, systemProgram: SystemProgram, vaultProgram: Program<"${VAULT_IDL.address}">, bump: u8, amount: u64): void {
  systemProgram.transfer(payer, wallet, 100000000n);
  vaultOpen(vaultProgram, wallet, vault, systemProgram, signer(["wallet", bump]));
  vaultDeposit(vaultProgram, wallet, vault, systemProgram, amount, signer(["wallet", bump]));
  vaultWithdraw(vaultProgram, wallet, vault, amount / 2n, signer(["wallet", bump]));
}
`;

describe("typesol cpi: helpers generated from an IDL", () => {
  it("turns an Anchor-built IDL into typed helpers with the right metas and discriminators", () => {
    const res = generateCpi(VAULT_IDL);
    expect(res.skipped).toEqual([]);
    expect(res.generated.sort()).toEqual(["vaultDeposit", "vaultOpen", "vaultShut", "vaultWithdraw"]);
    expect(res.source).toContain(
      `export function vaultDeposit(program: Program<"${VAULT_IDL.address}">, owner: Mut<AccountMeta>, vault: Mut<AccountMeta>, systemProgram: AccountMeta, amount: u64, seeds: SignerSeeds): void {`,
    );
    expect(res.source).toContain(
      `invoke(program, [writableSigner(owner), writable(vault), readonly(systemProgram)], [hex("f223c68952e1f2b6"), amount], seeds);`,
    );
  });

  it.skipIf(!existsSync(VAULT_SO))("calls the real Anchor vault through generated helpers, as a wallet and as a signing PDA", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-cpigen-"));
    writeFileSync(path.join(dir, "vault_cpi.ts"), generateCpi(VAULT_IDL).source);
    writeFileSync(path.join(dir, "caller.ts"), CALLER);
    const d = await deployFile(path.join(dir, "caller.ts"));
    d.svm.addProgramFromFile(VAULT_ID, VAULT_SO);
    const payer = await fundedSigner(d.svm);
    const [vault] = await pda(VAULT_ID, ["vault", payer.address]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "open_and_deposit", { amount: new BN(5_000_000) }, [
          { address: payer.address, signer: payer, writable: true },
          { address: vault, writable: true },
          { address: SYSTEM_PROGRAM },
          { address: VAULT_ID },
        ]),
      ]),
    );
    const rent = d.svm.minimumBalanceForRentExemption(BigInt(8 + 32 + 8 + 1));
    expect(d.svm.getBalance(vault)! - rent).toBeGreaterThanOrEqual(5_000_000n);

    const [wallet, bump] = await pda(d.programId, ["wallet"]);
    const [pdaVaultAddr] = await pda(VAULT_ID, ["vault", wallet]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "pda_vault", { bump, amount: new BN(2_000_000) }, [
          { address: payer.address, signer: payer, writable: true },
          { address: wallet, writable: true },
          { address: pdaVaultAddr, writable: true },
          { address: SYSTEM_PROGRAM },
          { address: VAULT_ID },
        ]),
      ]),
    );
    const owner = Buffer.from((d.svm.getAccount(pdaVaultAddr) as { data: Uint8Array }).data).subarray(8, 40);
    expect(Buffer.from(owner).equals(Buffer.from(getAddressEncoder().encode(wallet)))).toBe(true);
  });

  it("maps TypeSol IDLs too: structs with fixed layouts become interfaces, unsupported shapes are reported", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-cpigen-ts-"));
    const out = build(fileURLToPath(new URL("./fixtures/structargs.ts", import.meta.url)), dir, "11111111111111111111111111111112");
    const res = generateCpi(out.idl as unknown as Idl, { prefix: "book" });
    expect(res.generated).toEqual(expect.arrayContaining(["bookPlace", "bookPlaceMany", "bookSetIds", "bookForward"]));
    expect(res.source).toContain("export interface Order {");
    expect(res.source).toContain("export enum Side {");
    // The generated file compiles as part of a program.
    writeFileSync(path.join(dir, "book_cpi.ts"), res.source);
    writeFileSync(
      path.join(dir, "main.ts"),
      `import { type AccountInfo, type Mut, type Program, signer } from "typesol";\nimport { type Order, bookPlace } from "./book_cpi";\nexport function go(book: Mut<AccountInfo>, p: Program<"11111111111111111111111111111112">, order: Order): void { bookPlace(p, book, order, signer([])); }\n`,
    );
    expect(() => generate(path.join(dir, "main.ts"))).not.toThrow();
    // Strings inside structs have no fixed TypeSol layout: such instructions are left out with a reason.
    const odd = generateCpi({
      address: "11111111111111111111111111111112",
      metadata: { name: "odd" },
      instructions: [{ name: "named", discriminator: [1, 2, 3, 4, 5, 6, 7, 8], accounts: [], args: [{ name: "who", type: { defined: { name: "Person" } } }] }],
      types: [{ name: "Person", type: { kind: "struct", fields: [{ name: "name", type: "string" }] } }],
    });
    expect(odd.skipped).toEqual([{ instruction: "named", reason: "a string inside a struct, Vec or array" }]);
  });
});
