// Ata<Init<TokenAccount>, …> / Ata<InitIfNeeded<TokenAccount>, …>: Anchor's `init` / `init_if_needed` with
// `associated_token::mint` and `associated_token::authority` (test/fixtures/ata-init.ts), on SPL Token and Token-2022.
import { getCreateAccountInstruction } from "@solana-program/system";
import * as spl from "@solana-program/token";
import * as t22 from "@solana-program/token-2022";
import { type Address, generateKeyPairSigner, getAddressEncoder, getProgramDerivedAddress, lamports } from "@solana/kit";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { CompileError, generate } from "../src/compiler/index.js";
import {
  ATA_PROGRAM,
  BN,
  SYSTEM_PROGRAM,
  TOKEN_2022,
  TOKEN_PROGRAM,
  customError,
  deployFile,
  expectOk,
  fundedSigner,
  ix,
  send,
  type Deployed,
} from "./harness.js";

const ata = async (owner: Address, mint: Address, program: Address) =>
  (
    await getProgramDerivedAddress({
      programAddress: ATA_PROGRAM,
      seeds: [getAddressEncoder().encode(owner), getAddressEncoder().encode(program), getAddressEncoder().encode(mint)],
    })
  )[0];

for (const [label, program] of [
  ["SPL Token", TOKEN_PROGRAM],
  ["Token-2022", TOKEN_2022],
] as const) {
  describe(`Ata<Init|InitIfNeeded<TokenAccount>> on ${label}`, () => {
    let d: Deployed;
    beforeAll(async () => {
      d = await deployFile(fileURLToPath(new URL("./fixtures/ata-init.ts", import.meta.url)));
    });

    /** A mint whose authority is `payer`. */
    async function mintOf(payer: Awaited<ReturnType<typeof fundedSigner>>) {
      const mint = await generateKeyPairSigner();
      const space = spl.getMintSize();
      expectOk(
        await send(d.svm, payer, [
          getCreateAccountInstruction({
            payer,
            newAccount: mint,
            lamports: lamports(d.svm.minimumBalanceForRentExemption(BigInt(space))),
            space,
            programAddress: program,
          }),
          program === TOKEN_2022
            ? t22.getInitializeMint2Instruction({ mint: mint.address, decimals: 0, mintAuthority: payer.address })
            : spl.getInitializeMint2Instruction({ mint: mint.address, decimals: 0, mintAuthority: payer.address }),
        ]),
      );
      return mint.address;
    }
    const accounts = (payer: Awaited<ReturnType<typeof fundedSigner>>, owner: Address, mint: Address, account: Address) => [
      { address: payer.address, signer: payer, writable: true },
      { address: owner },
      { address: mint, writable: true },
      { address: account, writable: true },
      { address: program },
      { address: ATA_PROGRAM },
      { address: SYSTEM_PROGRAM },
    ];
    const amountOf = (a: Address) => {
      const acct = d.svm.getAccount(a);
      if (!acct.exists) throw new Error("missing");
      return Buffer.from(acct.data).readBigUInt64LE(64);
    };

    it("create makes the ATA and mints into it; a second create fails", async () => {
      const payer = await fundedSigner(d.svm);
      const owner = (await generateKeyPairSigner()).address;
      const mint = await mintOf(payer);
      const a = await ata(owner, mint, program);
      expectOk(await send(d.svm, payer, [ix(d, "open", { amount: new BN(5) }, accounts(payer, owner, mint, a))]));
      expect(amountOf(a)).toBe(5n);
      const created = d.svm.getAccount(a);
      expect(created.exists && created.programAddress).toBe(program);
      const again = await send(d.svm, payer, [ix(d, "open", { amount: new BN(1) }, accounts(payer, owner, mint, a))]);
      expect(String((again as { err(): unknown }).err())).toMatch(/InstructionError/);
    });

    it("createIfNeeded creates once, then reuses the account (no second create)", async () => {
      const payer = await fundedSigner(d.svm);
      const owner = (await generateKeyPairSigner()).address;
      const mint = await mintOf(payer);
      const a = await ata(owner, mint, program);
      const first = expectOk(await send(d.svm, payer, [ix(d, "fund", { amount: new BN(3) }, accounts(payer, owner, mint, a))]));
      expect([...first.returnData().data()]).toEqual([1]);
      const second = expectOk(await send(d.svm, payer, [ix(d, "fund", { amount: new BN(4) }, accounts(payer, owner, mint, a))]));
      expect([...second.returnData().data()]).toEqual([0]);
      expect(second.logs().some((l) => l.includes(ATA_PROGRAM))).toBe(false);
      expect(amountOf(a)).toBe(7n);
      const bal = expectOk(
        await send(d.svm, payer, [
          ix(
            d,
            "balance",
            {},
            accounts(payer, owner, mint, a).map((x, i) => (i === 2 ? { address: mint } : x)),
          ),
        ]),
      );
      expect(Buffer.from(bal.returnData().data()).readBigUInt64LE(0)).toBe(7n);
    });

    it("an account that is not the owner's ATA is refused (2009), as is another mint's existing ATA (2014 or 2009)", async () => {
      const payer = await fundedSigner(d.svm);
      const owner = (await generateKeyPairSigner()).address;
      const mint = await mintOf(payer);
      const other = await mintOf(payer);
      // An existing token account at a non-ATA address.
      const stray = await generateKeyPairSigner();
      const size = spl.getTokenSize();
      expectOk(
        await send(d.svm, payer, [
          getCreateAccountInstruction({
            payer,
            newAccount: stray,
            lamports: lamports(d.svm.minimumBalanceForRentExemption(BigInt(size))),
            space: size,
            programAddress: program,
          }),
          program === TOKEN_2022
            ? t22.getInitializeAccount3Instruction({ account: stray.address, mint, owner })
            : spl.getInitializeAccount3Instruction({ account: stray.address, mint, owner }),
        ]),
      );
      expect(customError(await send(d.svm, payer, [ix(d, "fund", { amount: new BN(1) }, accounts(payer, owner, mint, stray.address))]))).toBe(2009);
      // The ATA of another mint, passed for this mint: its address does not match.
      const otherAta = await ata(owner, other, program);
      expectOk(await send(d.svm, payer, [ix(d, "fund", { amount: new BN(1) }, accounts(payer, owner, other, otherAta))]));
      expect(customError(await send(d.svm, payer, [ix(d, "fund", { amount: new BN(1) }, accounts(payer, owner, mint, otherAta))]))).toBe(2009);
    });
  });
}

describe("Ata<Init|InitIfNeeded<TokenAccount>> diagnostics", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-ata-"));
  const HEAD = `import { type AccountInfo, type AssociatedTokenProgram, type Ata, type Init, type InitIfNeeded, type Mut, type Mint, type Owner, type Signer, type SystemProgram, type TokenAccount, type TokenProgram, type u64 } from "typesol";\n`;
  const errorsFor = (body: string) => {
    const f = path.join(dir, `p${Math.random().toString(36).slice(2)}.ts`);
    writeFileSync(f, HEAD + body);
    try {
      generate(f);
    } catch (e) {
      if (e instanceof CompileError) return e.diagnostics.map((x) => x.message).join("\n");
      throw e;
    }
    return "";
  };
  const params = `payer: Mut<Signer>, owner: AccountInfo, mint: Mint, tokenProgram: TokenProgram, associatedTokenProgram: AssociatedTokenProgram, systemProgram: SystemProgram`;
  it("needs Ata<…>, must be created before use and exactly once, and needs the programs", () => {
    expect(errorsFor(`export function f(${params}, a: Init<TokenAccount>): void { a.create(payer); }`)).toMatch(/wrap it in Ata/);
    expect(errorsFor(`export function f(${params}, a: Ata<InitIfNeeded<TokenAccount>, "owner", "mint">): u64 { return a.amount; }`)).toMatch(
      /used before a\.createIfNeeded/,
    );
    expect(errorsFor(`export function f(${params}, a: Ata<Init<TokenAccount>, "owner", "mint">): void {}`)).toMatch(/never created; call a\.create\(payer\)/);
    expect(
      errorsFor(
        `export function f(payer: Mut<Signer>, owner: AccountInfo, mint: Mint, tokenProgram: TokenProgram, a: Ata<Init<TokenAccount>, "owner", "mint">): void { a.create(payer); }`,
      ),
    ).toMatch(/needs an AssociatedTokenProgram/);
    // The programs the CPI needs cannot be optional, and Owner<…> cannot hold on an account that does not exist yet.
    expect(
      errorsFor(
        `export function f(payer: Mut<Signer>, owner: AccountInfo, mint: Mint, tokenProgram: TokenProgram | null, associatedTokenProgram: AssociatedTokenProgram, systemProgram: SystemProgram, a: Ata<Init<TokenAccount>, "owner", "mint">): void { a.create(payer); }`,
      ),
    ).toMatch(/cannot be optional/);
    expect(
      errorsFor(
        `export function f(${params}, a: Owner<Ata<Init<TokenAccount>, "owner", "mint">, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">): void { a.create(payer); }`,
      ),
    ).toMatch(/drop HasOne\/Seeds\/Address\/Owner\/Executable/);
    expect(errorsFor(`export function f(${params}, a: Ata<Init<TokenAccount>, "owner", "mint">, go: boolean): void { if (go) { a.create(payer); } }`)).toMatch(
      /top-level statement/,
    );
  });
});
