// PDAs of this program signing CPIs: systemProgram.transfer out of a SOL vault PDA, and two PDAs signing one invoke.
import { type Address, type KeyPairSigner, lamports } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, acct, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

describe("PDA signers (test/fixtures/pda-signers.ts)", () => {
  let d: Deployed;
  let owner: KeyPairSigner;
  let vault: Address;
  let vaultBump: number;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/pda-signers.ts", import.meta.url)));
    owner = await fundedSigner(d.svm, 5n);
    [vault, vaultBump] = await pda(d.programId, ["sol", owner.address]);
    d.svm.airdrop(vault, lamports(2_000_000_000n));
  });

  it("pays out of a system-owned vault PDA with systemProgram.transfer", async () => {
    const to = (await fundedSigner(d.svm, 1n)).address;
    const before = acct(d.svm, to).lamports;
    const withdraw = (bump: number, amount: bigint) =>
      send(d.svm, owner, [
        ix(d, "withdraw", { bump, amount: new BN(amount.toString()) }, [
          { address: owner.address, signer: owner },
          { address: vault, writable: true },
          { address: to, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    expectOk(await withdraw(vaultBump, 300_000_000n));
    expect(acct(d.svm, to).lamports - before).toBe(300_000_000n);
    expect(acct(d.svm, vault).lamports).toBe(1_700_000_000n);
    // A wrong bump derives another address, which cannot sign for the vault.
    const bad = await withdraw(vaultBump === 255 ? 254 : vaultBump + 1, 1n);
    expect(bad).toBeInstanceOf(FailedTransactionMetadata);
    expect(acct(d.svm, vault).lamports).toBe(1_700_000_000n);
  });

  it("signs one CPI for two PDAs", async () => {
    const [box, boxBump] = await pda(d.programId, ["box", owner.address]);
    expectOk(
      await send(d.svm, owner, [
        ix(d, "box_up", { vault_bump: vaultBump, box_bump: boxBump, lamports: new BN(10_000_000) }, [
          { address: owner.address, signer: owner },
          { address: vault, writable: true },
          { address: box, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const b = acct(d.svm, box);
    expect([b.lamports, b.data.length, b.programAddress]).toEqual([10_000_000n, 8, d.programId]);
  });
});
