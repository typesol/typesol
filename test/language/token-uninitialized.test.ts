// A token account or mint parameter that was never created (an empty system account) fails with AccountNotInitialized
// (3012), as Anchor's Account / InterfaceAccount checks it before the owner; any other wrong owner is 3007.
import { generateKeyPairSigner } from "@solana/kit";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { customError, deployFile, fundedSigner, ix, send, type Deployed } from "../harness.js";

const SOURCE = `import { type Mint, type TokenAccount } from "typesol";
export function holds(account: TokenAccount): void {}
export function mints(mint: Mint): void {}
`;

describe("token accounts and mints never created", () => {
  let d: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-tokuninit-"));
    writeFileSync(path.join(dir, "tok.ts"), SOURCE);
    d = await deployFile(path.join(dir, "tok.ts"));
  });

  it("refuses them with 3012, and a wallet (system-owned, funded) with 3007", async () => {
    const payer = await fundedSigner(d.svm);
    const nothing = (await generateKeyPairSigner()).address;
    const wallet = (await fundedSigner(d.svm)).address;
    for (const name of ["holds", "mints"]) {
      expect(customError(await send(d.svm, payer, [ix(d, name, {}, [{ address: nothing }])])), name).toBe(3012);
      expect(customError(await send(d.svm, payer, [ix(d, name, {}, [{ address: wallet }])])), name).toBe(3007);
    }
  });
});
