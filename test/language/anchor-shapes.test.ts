// Shapes Anchor programs use that ports need (from the Jito MEV programs): a Seeds bump stored in a struct field of
// another account ("@cfg.bumps.vault", Anchor `bump = cfg.bumps.vault`), Hash.compare, an argument named like an
// account with a trailing underscore (Anchor's IDL drops it), and error members without a message.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { web3 } from "@anchor-lang/core";
import { SYSTEM_PROGRAM, compileErrors, customError, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

const SOURCE = `import { type Account, type Hash, type Init, type Mut, type Pubkey, type Seeds, type Signer, type SystemProgram, type i64, type u8, require } from "typesol";

export enum E {
  Plain = "",
  Said = "said",
}
export interface Bumps {
  main: u8;
  vault: u8;
}
export interface Cfg {
  owner: Pubkey;
  bumps: Bumps;
}
export interface Vault {
  n: u8;
}

export function setup(cfg: Init<Cfg>, vault: Init<Vault>, payer: Mut<Signer>, system_program: SystemProgram): void {
  cfg.bumps.main = cfg.create(payer, ["cfg"], 42n);
  cfg.bumps.vault = vault.create(payer, ["vault"], 9n);
  cfg.owner = payer.key;
}
export function touch(cfg: Account<Cfg>, vault: Seeds<Mut<Vault>, ["vault"], "@cfg.bumps.vault">): void {
  vault.n += 1n;
}
export function order(a: Hash, b: Hash): i64 {
  return a.compare(b);
}
export function named(owner: Signer, owner_: Pubkey, other_: Pubkey): void {
  require(owner.key === owner_, E.Plain);
  require(owner.key !== other_, E.Said);
}
`;

describe("Anchor shapes from the Jito ports", () => {
  let dir: string;
  let d: Deployed;
  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "typesol-shapes-"));
    writeFileSync(path.join(dir, "shapes.ts"), SOURCE);
    d = await deployFile(path.join(dir, "shapes.ts"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("checks a Seeds account against a bump stored in a nested struct field", async () => {
    const payer = await fundedSigner(d.svm);
    const [cfg] = await pda(d.programId, ["cfg"]);
    const [vault] = await pda(d.programId, ["vault"]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "setup", {}, [
          { address: cfg, writable: true },
          { address: vault, writable: true },
          { address: payer.address, signer: payer, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    expectOk(await send(d.svm, payer, [ix(d, "touch", {}, [{ address: cfg }, { address: vault, writable: true }])]));
    // A wrong bump stored in the config (byte 41: after the discriminator, owner and bumps.main): the check fails.
    const a = d.svm.getAccount(cfg);
    if (!a.exists) throw new Error("cfg");
    const data = Uint8Array.from(a.data);
    data[41] = (data[41]! + 1) % 256;
    d.svm.setAccount({ ...a, address: cfg, data });
    expect(customError(await send(d.svm, payer, [ix(d, "touch", {}, [{ address: cfg }, { address: vault, writable: true }])]))).toBe(2006);
  });

  it("refuses a stored bump path that is not a u8 at the end of struct fields", () => {
    const at = (bump: string) => compileErrors(SOURCE.replace('"@cfg.bumps.vault"', `"${bump}"`));
    expect(at("@cfg.bumps.vault")).toBe("");
    expect(at("@cfg.bumps")).toMatch(/needs a u8 field "bumps"/);
    expect(at("@cfg.owner.x")).toMatch(/Cfg\.owner must be a struct field/);
    expect(at("@cfg.bumps.nope")).toMatch(/Bumps needs a u8 field "nope"/);
    expect(at("@cfg")).toMatch(/must name a u8 field of a struct account parameter/);
  });

  it("orders hashes as Rust orders [u8; 32]", async () => {
    const payer = await fundedSigner(d.svm);
    const h = (...bytes: number[]) => [...bytes, ...new Array(32 - bytes.length).fill(0)];
    const order = async (a: number[], b: number[]) => {
      const r = expectOk(await send(d.svm, payer, [ix(d, "order", { a, b }, [])]));
      return Buffer.from(r.returnData().data()).readBigInt64LE();
    };
    expect(await order(h(1), h(1))).toBe(0n);
    expect(await order(h(1, 2), h(1, 3))).toBe(-1n);
    expect(await order(h(2), h(1, 255))).toBe(1n);
    expect(await order(h(0, 0, 0, 0, 0, 0, 0, 0, 1), h(0, 0, 0, 0, 0, 0, 0, 0, 0, 9))).toBe(1n);
  });

  it("names an account-like argument without its trailing underscore, and leaves out empty error messages", async () => {
    const named = d.idl.instructions.find((i) => i.name === "named")!;
    expect(named.args.map((a) => a.name)).toEqual(["owner", "other_"]);
    expect(d.idl.errors).toEqual([
      { code: 6000, name: "Plain" },
      { code: 6001, name: "Said", msg: "said" },
    ]);
    const payer = await fundedSigner(d.svm);
    const call = (owner: string, other: string) =>
      send(d.svm, payer, [
        ix(d, "named", { owner: new web3.PublicKey(owner), other_: new web3.PublicKey(other) }, [{ address: payer.address, signer: payer }]),
      ]);
    expectOk(await call(payer.address, SYSTEM_PROGRAM));
    expect(customError(await call(SYSTEM_PROGRAM, SYSTEM_PROGRAM))).toBe(6000);
    expect(customError(await call(payer.address, payer.address))).toBe(6001);
  });
});
