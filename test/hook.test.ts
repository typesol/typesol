import { getCreateAccountInstruction } from "@solana-program/system";
import * as t22 from "@solana-program/token-2022";
import { type Address, AccountRole, generateKeyPairSigner, lamports } from "@solana/kit";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_PROGRAM, customError, deployFile, expectOk, fundedSigner, pda, send, type Deployed, TOKEN_2022 } from "./harness.js";

describe("Token-2022 transfer hook written in TypeSOL (test/fixtures/hook.ts)", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/hook.ts", import.meta.url)));
  });

  it("Token-2022 calls the hook on every transfer; the hook blocks large ones", async () => {
    const { svm } = d;
    const admin = await fundedSigner(svm, 20n);
    const mint = await generateKeyPairSigner();
    const space = t22.getMintSize([{ __kind: "TransferHook", authority: admin.address, programId: d.programId }]);
    expectOk(
      await send(svm, admin, [
        getCreateAccountInstruction({
          payer: admin,
          newAccount: mint,
          lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(space))),
          space,
          programAddress: TOKEN_2022,
        }),
        t22.getInitializeTransferHookInstruction({ mint: mint.address, authority: admin.address, programId: d.programId }),
        t22.getInitializeMint2Instruction({ mint: mint.address, decimals: 0, mintAuthority: admin.address }),
      ]),
    );
    // The validation account, created by the hook program itself.
    const [extraMetas] = await pda(d.programId, ["extra-account-metas", mint.address]);
    const initData = Uint8Array.from([43, 34, 13, 49, 167, 88, 235, 235, 0, 0, 0, 0]); // discriminator + empty Vec
    expectOk(
      await send(svm, admin, [
        {
          programAddress: d.programId,
          accounts: [
            { address: admin.address, role: AccountRole.WRITABLE_SIGNER, signer: admin },
            { address: extraMetas, role: AccountRole.WRITABLE },
            { address: mint.address, role: AccountRole.READONLY },
            { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
          ],
          data: initData,
        } as never,
      ]),
    );
    expect(Buffer.from((svm.getAccount(extraMetas) as { data: Uint8Array }).data)).toEqual(
      Buffer.from([105, 37, 101, 197, 75, 251, 102, 26, 4, 0, 0, 0, 0, 0, 0, 0]),
    );

    const alice = await fundedSigner(svm);
    const bob = await generateKeyPairSigner();
    const ata = async (owner: Address) => {
      const c = await t22.getCreateAssociatedTokenIdempotentInstructionAsync({ payer: admin, owner, mint: mint.address, tokenProgram: TOKEN_2022 });
      expectOk(await send(svm, admin, [c]));
      return c.accounts[1].address as Address;
    };
    const [from, to] = [await ata(alice.address), await ata(bob.address)];
    expectOk(await send(svm, admin, [t22.getMintToInstruction({ mint: mint.address, token: from, mintAuthority: admin, amount: 5000n })]));

    const transfer = (amount: bigint) => {
      const base = t22.getTransferCheckedInstruction({ source: from, mint: mint.address, destination: to, authority: alice, amount, decimals: 0 });
      // Token-2022 needs the hook program and its validation account appended.
      return {
        ...base,
        accounts: [...base.accounts, { address: d.programId, role: AccountRole.READONLY }, { address: extraMetas, role: AccountRole.READONLY }],
      };
    };
    expectOk(await send(svm, alice, [transfer(700n) as never]));
    expect(customError(await send(svm, alice, [transfer(1500n) as never]))).toBe(6000);
    const bal = (a: Address) => Buffer.from((svm.getAccount(a) as { data: Uint8Array }).data).readBigUInt64LE(64);
    expect([bal(from), bal(to)]).toEqual([4300n, 700n]);
  });
});
