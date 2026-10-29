// Token-2022 extension initializers, checked against the official token-2022 decoder on real mints in LiteSVM.
import * as t22 from "@solana-program/token-2022";
import { type Address, generateKeyPairSigner } from "@solana/kit";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { CompileError, generate } from "../../src/compiler/index.js";
import { BN, SYSTEM_PROGRAM, deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "../harness.js";
import { pk } from "../ports-helpers.js";

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
type Ext = { __kind: string } & Record<string, unknown>;
// The decoder returns Option-wrapped or plain addresses depending on the extension.
const opt = (v: unknown) =>
  typeof v === "string" || v === null ? v : (v as { __option: string; value?: unknown }).__option === "Some" ? (v as { value: unknown }).value : null;

describe("Token-2022 extension initializers", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/t22init.ts", import.meta.url)));
  });

  const decodeMint = (a: Address) => {
    const acct = d.svm.getAccount(a);
    if (!acct.exists) throw new Error("no mint");
    return t22.getMintDecoder().decode(acct.data);
  };

  it("sets up a mint with transfer fee, close authority, permanent delegate, default state, pointers, hook and interest", async () => {
    const payer = await fundedSigner(d.svm);
    const mint = await generateKeyPairSigner();
    const admin = (await generateKeyPairSigner()).address;
    const hook = (await generateKeyPairSigner()).address;
    const space = t22.getMintSize([
      t22.extension("TransferFeeConfig", {
        transferFeeConfigAuthority: admin,
        withdrawWithheldAuthority: admin,
        withheldAmount: 0n,
        olderTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 },
        newerTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 },
      }),
      t22.extension("MintCloseAuthority", { closeAuthority: admin }),
      t22.extension("PermanentDelegate", { delegate: admin }),
      t22.extension("DefaultAccountState", { state: t22.AccountState.Frozen }),
      t22.extension("MetadataPointer", { authority: admin, metadataAddress: admin }),
      t22.extension("GroupPointer", { authority: admin, groupAddress: admin }),
      t22.extension("GroupMemberPointer", { authority: admin, memberAddress: admin }),
      t22.extension("TransferHook", { authority: admin, programId: hook }),
      t22.extension("InterestBearingConfig", {
        rateAuthority: admin,
        initializationTimestamp: 0n,
        preUpdateAverageRate: 0,
        lastUpdateTimestamp: 0n,
        currentRate: 0,
      }),
    ]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "rich", { space: new BN(space), admin: pk(admin), hook: pk(hook), bps: 250, max_fee: new BN(5000), rate: -120 }, [
          { address: payer.address, signer: payer, writable: true },
          { address: mint.address, signer: mint, writable: true },
          { address: TOKEN_2022 },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const m = decodeMint(mint.address);
    expect([m.decimals, opt(m.mintAuthority), opt(m.freezeAuthority)]).toEqual([6, admin, admin]);
    const ext = new Map((opt(m.extensions) as Ext[]).map((e) => [e.__kind, e]));
    const fee = ext.get("TransferFeeConfig")!;
    expect([fee.transferFeeConfigAuthority, fee.withdrawWithheldAuthority]).toEqual([admin, "11111111111111111111111111111111"]);
    expect(fee.newerTransferFee as { transferFeeBasisPoints: number; maximumFee: bigint }).toMatchObject({ transferFeeBasisPoints: 250, maximumFee: 5000n });
    expect(ext.get("MintCloseAuthority")!.closeAuthority).toBe(admin);
    expect(ext.get("PermanentDelegate")!.delegate).toBe(admin);
    expect(ext.get("DefaultAccountState")!.state).toBe(t22.AccountState.Frozen);
    expect([opt(ext.get("MetadataPointer")!.authority), opt(ext.get("MetadataPointer")!.metadataAddress)]).toEqual([admin, mint.address]);
    expect([opt(ext.get("GroupPointer")!.authority), opt(ext.get("GroupPointer")!.groupAddress)]).toEqual([null, mint.address]);
    expect([opt(ext.get("GroupMemberPointer")!.authority), opt(ext.get("GroupMemberPointer")!.memberAddress)]).toEqual([admin, null]);
    expect([opt(ext.get("TransferHook")!.authority), opt(ext.get("TransferHook")!.programId)]).toEqual([admin, hook]);
    expect([opt(ext.get("InterestBearingConfig")!.rateAuthority), ext.get("InterestBearingConfig")!.currentRate]).toEqual([admin, -120]);
  });

  it("sets up a non-transferable mint and an immutable-owner account", async () => {
    const payer = await fundedSigner(d.svm);
    const mint = await generateKeyPairSigner();
    const account = await generateKeyPairSigner();
    const owner = (await generateKeyPairSigner()).address;
    const mintSpace = t22.getMintSize([t22.extension("NonTransferable", {})]);
    const accountSpace = t22.getTokenSize([t22.extension("ImmutableOwner", {}), t22.extension("NonTransferableAccount", {})]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "soulbound", { mint_space: new BN(mintSpace), account_space: new BN(accountSpace), owner: pk(owner) }, [
          { address: payer.address, signer: payer, writable: true },
          { address: mint.address, signer: mint, writable: true },
          { address: account.address, signer: account, writable: true },
          { address: TOKEN_2022 },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    expect((opt(decodeMint(mint.address).extensions) as Ext[]).map((e) => e.__kind)).toEqual(["NonTransferable"]);
    const acct = d.svm.getAccount(account.address);
    if (!acct.exists) throw new Error("no account");
    const tok = t22.getTokenDecoder().decode(acct.data);
    expect(tok.owner).toBe(owner);
    expect((opt(tok.extensions) as Ext[]).map((e) => e.__kind).sort()).toEqual(["ImmutableOwner", "NonTransferableAccount"]);
  });

  it("refuses the extensions on the classic token program", () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "typesol-t22init-")), "p.ts");
    writeFileSync(
      file,
      `import { type Mut, type Signer, type TokenProgram } from "typesol";\nexport function f(mint: Mut<Signer>, token: TokenProgram): void { token.initializeNonTransferableMint(mint); }\n`,
    );
    expect(() => generate(file)).toThrow(CompileError);
    try {
      generate(file);
    } catch (e) {
      // TypeScript already refuses it: the classic program's type has no extension methods.
      expect((e as CompileError).diagnostics[0].message).toMatch(/initializeNonTransferableMint' does not exist on type 'TokenProgram'/);
    }
  });
});
