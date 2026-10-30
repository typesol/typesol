// Your errors on declarative constraints, as Anchor's `has_one = owner @ ErrorCode.NotOwner`: HasOne, Address, Owner,
// Signed and Mut take one of the program's errors as their last type argument.
import { type Address, type KeyPairSigner, getAddressEncoder } from "@solana/kit";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_PROGRAM, compileErrors, customError, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

const SOURCE = `import { type AccountInfo, type Address, type HasOne, type Init, type Mut, type Owner, type Pubkey, type Signed, type Signer, type SystemProgram, type u64 } from "typesol";

export enum VaultError {
  NotOwner = "not the vault's owner",
  NotAdmin = "not the vault's admin",
  WrongTreasury = "not the treasury",
  NotSystemOwned = "not a system account",
  MustSign = "the witness must sign",
  ReadOnly = "the vault must be writable",
}

export interface Vault { owner: Pubkey; admin: Pubkey; n: u64 }

export function open(owner: Mut<Signer>, vault: Init<Vault>, systemProgram: SystemProgram, admin: Pubkey): void {
  vault.create(owner, ["vault", owner.key]);
  vault.owner = owner.key;
  vault.admin = admin;
}

export function touch(
  vault: HasOne<HasOne<Mut<Vault, VaultError.ReadOnly>, "owner", VaultError.NotOwner>, "admin", VaultError.NotAdmin>,
  owner: Signer,
  admin: AccountInfo,
): void {
  vault.n += 1n;
}

export function pinned(
  treasury: Address<AccountInfo, "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T", VaultError.WrongTreasury>,
  wallet: Owner<AccountInfo, "11111111111111111111111111111111", VaultError.NotSystemOwned>,
  witness: Signed<AccountInfo, VaultError.MustSign>,
): void {}
`;

const pk = (a: string) => ({ toBuffer: () => Buffer.from(getAddressEncoder().encode(a as Address)), toBase58: () => a });
const TREASURY = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T" as Address;

describe("custom errors on declarative constraints", () => {
  let d: Deployed;
  let owner: KeyPairSigner;
  let admin: KeyPairSigner;
  let vault: Address;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-constraint-errors-"));
    writeFileSync(path.join(dir, "vaults.ts"), SOURCE);
    d = await deployFile(path.join(dir, "vaults.ts"));
    owner = await fundedSigner(d.svm);
    admin = await fundedSigner(d.svm);
    [vault] = await pda(d.programId, ["vault", owner.address]);
    expectOk(
      await send(d.svm, owner, [
        ix(d, "open", { admin: pk(admin.address) }, [
          { address: owner.address, signer: owner, writable: true },
          { address: vault, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
  });

  it("has_one and mut fail with the program's errors (6000 + member index)", async () => {
    const touch = (signer: KeyPairSigner, adminKey: Address, writable = true) =>
      send(d.svm, signer, [ix(d, "touch", {}, [{ address: vault, writable }, { address: signer.address, signer }, { address: adminKey }])]);
    expectOk(await touch(owner, admin.address));
    const stranger = await fundedSigner(d.svm);
    expect(customError(await touch(stranger, admin.address))).toBe(6000); // NotOwner
    expect(customError(await touch(owner, stranger.address))).toBe(6001); // NotAdmin
    expect(customError(await touch(owner, admin.address, false))).toBe(6005); // ReadOnly
  });

  it("address, owner and signer fail with the program's errors", async () => {
    const witness = await fundedSigner(d.svm);
    const pinned = (treasury: Address, wallet: Address) =>
      send(d.svm, witness, [ix(d, "pinned", {}, [{ address: treasury }, { address: wallet }, { address: witness.address, signer: witness }])]);
    expectOk(await pinned(TREASURY, owner.address));
    expect(customError(await pinned(admin.address, owner.address))).toBe(6002); // WrongTreasury
    expect(customError(await pinned(TREASURY, vault))).toBe(6003); // NotSystemOwned: the vault belongs to the program
    // A witness that does not sign (the fee payer is another wallet).
    const other = await fundedSigner(d.svm);
    const res = await send(d.svm, witness, [ix(d, "pinned", {}, [{ address: TREASURY }, { address: owner.address }, { address: other.address }])]);
    expect(customError(res)).toBe(6004); // MustSign
  });

  it("refuses an error that is not a member of an error enum", () => {
    const head = `import { type Account, type HasOne, type Mut, type Pubkey, type Signer } from "typesol";\nexport enum E { A = "a" }\nexport interface V { owner: Pubkey }\n`;
    expect(compileErrors(head + `export function f(v: HasOne<Mut<V>, "owner", Pubkey>, owner: Signer): void {}`)).toMatch(
      /the error is a member of one of your error enums/,
    );
    expect(compileErrors(head + `export enum Color { Red, Blue }\nexport function f(v: HasOne<Mut<V>, "owner", Color.Red>, owner: Signer): void {}`)).toMatch(
      /Color\.Red is not one of this program's errors/,
    );
  });
});
