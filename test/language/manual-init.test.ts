// Creating an account by hand, as Raydium's initialize does: programId(), findProgramAddressBump, system allocate /
// assign, initAccount<T> (Anchor's load_init) and its refusals, Pubkey.compare, and an ATA created under a chosen token
// program.
import { type Address, generateKeyPairSigner, lamports } from "@solana/kit";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, acct, compileErrors, customError, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

const SOURCE = `import { type AccountInfo, type Mut, type Pubkey, type Signer, type SystemProgram, type u64, findProgramAddress, findProgramAddressBump, initAccount, programId, rentExempt, require } from "typesol";

export interface Note { owner: Pubkey; n: u64 }

/** At the PDA ["note", owner]: created with CreateAccount, or allocated and assigned when someone pre-funded it. */
export function open(payer: Mut<Signer>, note: Mut<AccountInfo>, system: SystemProgram, n: u64): void {
  const bump = findProgramAddressBump(["note", payer.key], programId());
  require(note.key === findProgramAddress(["note", payer.key], programId()), "not the note PDA");
  if (note.lamports === 0n) system.createAccount(payer, note, rentExempt(48n), 48n, programId(), ["note", payer.key, bump]);
  else {
    if (note.lamports < rentExempt(48n)) system.transfer(payer, note, rentExempt(48n) - note.lamports);
    system.allocate(note, 48n, ["note", payer.key, bump]);
    system.assign(note, programId(), ["note", payer.key, bump]);
  }
  const data = initAccount<Note>(note);
  data.owner = payer.key;
  data.n = n;
}
/** initAccount on an account as given (its checks). */
export function load(note: Mut<AccountInfo>): void {
  const data = initAccount<Note>(note);
  data.n = 1n;
}
export function order(a: Pubkey, b: Pubkey): u64 {
  return a.compare(b) < 0n ? 1n : a.compare(b) === 0n ? 2n : 3n;
}
`;

describe("creating accounts by hand", () => {
  let d: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-manual-init-"));
    writeFileSync(path.join(dir, "notes.ts"), SOURCE);
    d = await deployFile(path.join(dir, "notes.ts"));
  });
  const open = (payer: Awaited<ReturnType<typeof fundedSigner>>, note: Address) =>
    ix(d, "open", { n: new BN(7) }, [
      { address: payer.address, signer: payer, writable: true },
      { address: note, writable: true },
      { address: SYSTEM_PROGRAM },
    ]);

  it("creates at a PDA, or allocates and assigns a pre-funded one, then initAccount writes the struct", async () => {
    const payer = await fundedSigner(d.svm);
    const [note] = await pda(d.programId, ["note", payer.address]);
    expectOk(await send(d.svm, payer, [open(payer, note)]));
    const a = acct(d.svm, note);
    expect([a.programAddress, a.data.length, Buffer.from(a.data).readBigUInt64LE(40)]).toEqual([d.programId, 48, 7n]);
    expect(customError(await send(d.svm, payer, [open(payer, note)]))).toBe(0); // in use: the System Program refuses it
    const other = await fundedSigner(d.svm);
    const [pre] = await pda(d.programId, ["note", other.address]);
    d.svm.airdrop(pre, lamports(5_000n));
    expectOk(await send(d.svm, other, [open(other, pre)]));
    expect(acct(d.svm, pre).data.length).toBe(48);
  });

  it("initAccount refuses an account of another program, a small one and an initialized one", async () => {
    const payer = await fundedSigner(d.svm);
    const make = async (owner: Address, data: Uint8Array) => {
      const k = (await generateKeyPairSigner()).address;
      d.svm.setAccount({ address: k, data, executable: false, lamports: lamports(10_000_000n), programAddress: owner, space: BigInt(data.length) });
      return k;
    };
    const load = (k: Address, writable = true) => ix(d, "load", {}, [{ address: k, writable }]);
    expect(customError(await send(d.svm, payer, [load(await make(SYSTEM_PROGRAM, new Uint8Array(48)))]))).toBe(3007);
    // A Mut<AccountInfo> parameter passed read-only stops at its type check (2000); a remaining account at initAccount (3006).
    expect(customError(await send(d.svm, payer, [load(await make(d.programId, new Uint8Array(48)), false)]))).toBe(2000);
    expect(customError(await send(d.svm, payer, [load(await make(d.programId, new Uint8Array(20)))]))).toBe(3003);
    expect(customError(await send(d.svm, payer, [load(await make(d.programId, new Uint8Array(48).fill(1)))]))).toBe(3000);
    expectOk(await send(d.svm, payer, [load(await make(d.programId, new Uint8Array(48)))]));
  });

  it("orders Pubkeys as Rust does (bytes, lexicographic)", async () => {
    const payer = await fundedSigner(d.svm);
    const order = async (a: string, b: string) => {
      const { web3 } = await import("@anchor-lang/core");
      const r = expectOk(await send(d.svm, payer, [ix(d, "order", { a: new web3.PublicKey(a), b: new web3.PublicKey(b) }, [])]));
      return Buffer.from(r.returnData().data())[0];
    };
    expect(await order("11111111111111111111111111111111", "11111111111111111111111111111112")).toBe(1);
    expect(await order("So11111111111111111111111111111111111111112", "So11111111111111111111111111111111111111112")).toBe(2);
    expect(await order("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "So11111111111111111111111111111111111111112")).toBe(3);
  });

  it("an ATA under one of several token programs: pass it to create", () => {
    const head = `import { type AssociatedTokenProgram, type Ata, type Init, type Mint, type Mut, type Signer, type SystemProgram, type Token2022Program, type TokenAccount, type TokenProgram } from "typesol";\n`;
    const body = (call: string) =>
      `${head}export function go(payer: Mut<Signer>, mint: Mint, vault: Ata<Init<TokenAccount>, "payer", "mint">, ata: AssociatedTokenProgram, tokenProgram: TokenProgram, token2022Program: Token2022Program, systemProgram: SystemProgram): void {\n  ${call};\n}\n`;
    expect(compileErrors(body("vault.create(payer, token2022Program)"))).toBe("");
    expect(compileErrors(body("vault.create(payer)"))).toMatch(/pass it, vault\.create\(payer, tokenProgram\)/);
  });
});
