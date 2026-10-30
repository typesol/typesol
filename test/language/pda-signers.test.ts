// PDAs of this program signing CPIs: systemProgram.transfer out of a SOL vault PDA, and two PDAs signing one invoke.
import { type Address, type KeyPairSigner, getAddressEncoder, lamports } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, acct, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

const pk = (a: string) => ({ toBuffer: () => Buffer.from(getAddressEncoder().encode(a as never)), toBase58: () => a });

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
  it("signs an invokeInstruction for two PDAs, and only for the PDAs the seeds derive", async () => {
    const [crate, crateBump] = await pda(d.programId, ["crate", owner.address]);
    const data = Buffer.alloc(52);
    data.writeUInt32LE(0, 0); // CreateAccount
    data.writeBigUInt64LE(5_000_000n, 4);
    data.writeBigUInt64LE(16n, 12);
    Buffer.from(getAddressEncoder().encode(d.programId)).copy(data, 20);
    const run = (bump: number) =>
      send(d.svm, owner, [
        ix(
          d,
          "run_signed",
          {
            metas: [
              { pubkey: pk(vault), is_signer: true, is_writable: true },
              { pubkey: pk(crate), is_signer: true, is_writable: true },
            ],
            data: [...data],
            vault_bump: vaultBump,
            crate_bump: bump,
          },
          [
            { address: owner.address, signer: owner },
            // remainingAccounts(): the accounts the stored instruction names, and the program it calls.
            { address: vault, writable: true },
            { address: crate, writable: true },
            { address: SYSTEM_PROGRAM },
          ],
        ),
      ]);
    expect(await run(crateBump === 255 ? 254 : crateBump + 1)).toBeInstanceOf(FailedTransactionMetadata);
    expectOk(await run(crateBump));
    const c = acct(d.svm, crate);
    expect([c.lamports, c.data.length, c.programAddress]).toEqual([5_000_000n, 16, d.programId]);
  });
});
