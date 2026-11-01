// A Hash (sha256 / keccak256 output) as a PDA seed: its 32 bytes, as Rust's `&hash.to_bytes()` (Marginfi's order PDA).
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { acct, customError, deployFile, expectOk, fundedSigner, ix, pda, send, SYSTEM_PROGRAM, type Deployed } from "../harness.js";
import { pk } from "../ports-helpers.js";

const SOURCE = `import { findProgramAddress, programId, sha256, type Init, type Mut, type Pubkey, type Signer, type SystemProgram, type u64 } from "typesol";
export interface Note { derived: Pubkey }
export function open(payer: Mut<Signer>, note: Init<Note>, system_program: SystemProgram, label: string): void {
  note.create(payer, ["note", sha256(payer.key, label)]);
  note.derived = findProgramAddress(["note", sha256(payer.key, label)], programId());
}
`;

describe("Hash seeds", () => {
  let d: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-hashseed-"));
    writeFileSync(path.join(dir, "hs.ts"), SOURCE);
    d = await deployFile(path.join(dir, "hs.ts"));
  });

  it("derives the PDA from the hash's bytes", async () => {
    const payer = await fundedSigner(d.svm);
    const hash = (label: string) =>
      new Uint8Array(
        createHash("sha256")
          .update(Buffer.concat([pk(payer.address).toBuffer(), Buffer.from(label)]))
          .digest(),
      );
    const [note] = await pda(d.programId, ["note", hash("a")]);
    const open = (label: string, at: typeof note) =>
      send(d.svm, payer, [
        ix(d, "open", { label }, [{ address: payer.address, signer: payer, writable: true }, { address: at, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]);
    expectOk(await open("a", note));
    expect(Buffer.from(acct(d.svm, note).data).subarray(8, 40).equals(pk(note).toBuffer())).toBe(true);
    const [other] = await pda(d.programId, ["note", hash("b")]);
    expect(customError(await open("c", other))).toBe(2006);
  });
});
