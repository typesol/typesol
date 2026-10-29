import * as spl from "@solana-program/token";
import { getCreateAccountInstruction } from "@solana-program/system";
import { type Address, generateKeyPairSigner } from "@solana/kit";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, TOKEN_PROGRAM, customError, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

describe("helpers that take accounts and signer seeds (test/fixtures/helpers.ts)", () => {
  let d: Deployed;
  let tally: Address;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/helpers.ts", import.meta.url)));
    const payer = await fundedSigner(d.svm);
    [tally] = await pda(d.programId, ["tally"]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "init", {}, [{ address: payer.address, signer: payer, writable: true }, { address: tally, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
  });

  it("updates a struct account in a helper; string arguments keep their value", async () => {
    const payer = await fundedSigner(d.svm);
    const r = expectOk(await send(d.svm, payer, [ix(d, "bump", { by: new BN(5) }, [{ address: tally, writable: true }])]));
    expect(Buffer.from(r.returnData().data()).readBigUInt64LE()).toBe(5n);
    // The label is now "changed", so the helper's own check fails the second time: the copy was taken at the call.
    expect(customError(await send(d.svm, payer, [ix(d, "bump", { by: new BN(1) }, [{ address: tally, writable: true }])]))).toBe(6000);
  });

  it("signs a token transfer in a helper with seeds passed by the instruction", async () => {
    const payer = await fundedSigner(d.svm);
    const mint = await generateKeyPairSigner();
    expectOk(
      await send(d.svm, payer, [
        getCreateAccountInstruction({ payer, newAccount: mint, lamports: d.svm.minimumBalanceForRentExemption(82n), space: 82, programAddress: TOKEN_PROGRAM }),
        spl.getInitializeMint2Instruction({ mint: mint.address, decimals: 0, mintAuthority: payer.address }),
      ]),
    );
    const vault = await generateKeyPairSigner();
    const ata = (await spl.findAssociatedTokenPda({ owner: payer.address, mint: mint.address, tokenProgram: TOKEN_PROGRAM }))[0];
    expectOk(
      await send(d.svm, payer, [
        getCreateAccountInstruction({
          payer,
          newAccount: vault,
          lamports: d.svm.minimumBalanceForRentExemption(165n),
          space: 165,
          programAddress: TOKEN_PROGRAM,
        }),
        spl.getInitializeAccount3Instruction({ account: vault.address, mint: mint.address, owner: tally }),
        await spl.getCreateAssociatedTokenInstructionAsync({ payer, owner: payer.address, mint: mint.address }),
        spl.getMintToInstruction({ mint: mint.address, token: vault.address, mintAuthority: payer, amount: 50n }),
      ]),
    );
    expectOk(
      await send(d.svm, payer, [
        ix(d, "pay", { amount: new BN(20) }, [
          { address: tally },
          { address: TOKEN_PROGRAM },
          { address: vault.address, writable: true },
          { address: ata, writable: true },
        ]),
      ]),
    );
    const amount = (a: Address) => spl.getTokenDecoder().decode(new Uint8Array((d.svm.getAccount(a) as { data: Uint8Array }).data)).amount;
    expect([amount(vault.address), amount(ata)]).toEqual([30n, 20n]);
  });
});
