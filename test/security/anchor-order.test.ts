// Which error a transaction that breaks several checks gets: each account's constraints in the order of Anchor's
// generated try_accounts (anchor-syn's linearize), and Anchor's codes (docs/errors.md, "Which error a transaction gets").
import { getU64Encoder } from "@solana/kit";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, customError, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

const SOURCE = `import { type HasOne, type Init, type Mut, type Pubkey, type Seeds, type Signer, type SystemProgram, type u8, type u64 } from "typesol";
export interface Box { owner: Pubkey; id: u64; bump: u8; }
export function open(owner: Mut<Signer>, box: Init<Box>, systemProgram: SystemProgram, id: u64): void {
  box.bump = box.create(owner, ["box", owner.key, id]);
  box.owner = owner.key;
  box.id = id;
}
export function bump(owner: Signer, box: Seeds<HasOne<Mut<Box>, "owner">, ["box", "@owner", "@box.id"], "bump">, by: u64): void {
  box.id = box.id + by - by;
}
`;

describe("check order (Anchor's)", () => {
  let d: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-order-"));
    writeFileSync(path.join(dir, "order.ts"), SOURCE);
    d = await deployFile(path.join(dir, "order.ts"));
  });

  it("a read-only Mut (2000, ConstraintMut), seeds before has_one (2006)", async () => {
    const owner = await fundedSigner(d.svm);
    const [box] = await pda(d.programId, ["box", owner.address, new Uint8Array(getU64Encoder().encode(1n))]);
    const O = { address: owner.address, signer: owner, writable: true };
    expectOk(await send(d.svm, owner, [ix(d, "open", { id: new BN(1) }, [O, { address: box, writable: true }, { address: SYSTEM_PROGRAM }])]));
    const call = (accounts: Parameters<typeof ix>[3], data?: Uint8Array) => {
      const i = ix(d, "bump", { by: new BN(1) }, accounts);
      return send(d.svm, owner, [data ? { ...i, data: data.slice() } : i]);
    };
    expectOk(await call([O, { address: box, writable: true }]));
    // The box passed read-only: ConstraintMut, as Anchor's #[account(mut)].
    expect(customError(await call([O, { address: box }]))).toBe(2000);
    // Another signer: the seeds (derived from the signer) fail before has_one.
    const mallory = await fundedSigner(d.svm);
    const M = { address: mallory.address, signer: mallory };
    expect(customError(await send(d.svm, mallory, [ix(d, "bump", { by: new BN(1) }, [M, { address: box, writable: true }])]))).toBe(2006);
  });
});
