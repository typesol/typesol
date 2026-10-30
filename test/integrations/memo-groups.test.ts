// SPL Memo CPIs, the SlotHashes sysvar and Token-2022 token groups (test/fixtures/memo-groups.ts).
import * as t22 from "@solana-program/token-2022";
import { type Address, type KeyPairSigner, generateKeyPairSigner, getAddressEncoder } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, TOKEN_2022, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as Address;
const pk = (a: string) => ({ toBuffer: () => Buffer.from(getAddressEncoder().encode(a as Address)), toBase58: () => a });
const SLOT_HASHES = "SysvarS1otHashes111111111111111111111111111" as Address;

describe("memo, SlotHashes and token groups", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/memo-groups.ts", import.meta.url)));
    payer = await fundedSigner(d.svm, 20n);
  });
  const logs = (r: Awaited<ReturnType<typeof send>>) => expectOk(r).logs().join("\n");

  it("sends memos signed by a wallet, by the program's PDA, and by no one", async () => {
    expect(logs(await send(d.svm, payer, [ix(d, "note", { text: "gm" }, [{ address: payer.address, signer: payer }, { address: MEMO }])]))).toMatch(
      new RegExp(`Signed by:\\n.*${payer.address}\\n.*Memo \\(len 2\\)\\n.*gm`),
    );
    const [desk, bump] = await pda(d.programId, ["desk"]);
    expect(logs(await send(d.svm, payer, [ix(d, "desk_note", { bump }, [{ address: desk }, { address: MEMO }])]))).toMatch(/from the desk/);
    // A wrong bump derives another address: the desk did not sign.
    const bad = await send(d.svm, payer, [ix(d, "desk_note", { bump: bump === 255 ? 254 : bump + 1 }, [{ address: desk }, { address: MEMO }])]);
    expect(bad).toBeInstanceOf(FailedTransactionMetadata);
    expect(logs(await send(d.svm, payer, [ix(d, "unsigned", {}, [{ address: MEMO }])]))).toMatch(/anyone/);
    // Another program in the memo slot: refused before the CPI.
    expect(await send(d.svm, payer, [ix(d, "unsigned", {}, [{ address: SYSTEM_PROGRAM }])])).toBeInstanceOf(FailedTransactionMetadata);
  });

  it("reads the newest SlotHashes entry", async () => {
    d.svm.warpToSlot(500n);
    const res = expectOk(await send(d.svm, payer, [ix(d, "recent", {}, [{ address: SLOT_HASHES }])]));
    const v = Buffer.from(res.returnData().data()).readBigUInt64LE();
    const data = Buffer.from((d.svm.getAccount(SLOT_HASHES) as { data: Uint8Array }).data);
    expect(v).toBe(data.readBigUInt64LE(8) * 1000n + data.readBigUInt64LE(0));
    const h = expectOk(await send(d.svm, payer, [ix(d, "recent_hash", {}, [{ address: SLOT_HASHES }])]));
    expect(Buffer.from(h.returnData().data())).toEqual(data.subarray(16, 48));
    expect(await send(d.svm, payer, [ix(d, "recent", {}, [{ address: payer.address }])])).toBeInstanceOf(FailedTransactionMetadata);
  });

  it("reads the EpochSchedule and LastRestartSlot sysvars", async () => {
    const res = expectOk(await send(d.svm, payer, [ix(d, "schedule", {}, [])]));
    const b = Buffer.from((d.svm.getAccount("SysvarEpochSchedu1e111111111111111111111111" as Address) as { data: Uint8Array }).data);
    const [per, warmup, epoch, slot] = [b.readBigUInt64LE(0), b[16] === 1, b.readBigUInt64LE(17), b.readBigUInt64LE(25)];
    expect(Buffer.from(res.returnData().data()).readBigUInt64LE()).toBe(per * 1_000_000n + (warmup ? 100_000n : 0n) + epoch * 1000n + (slot % 1000n));
    const r = expectOk(await send(d.svm, payer, [ix(d, "restart", {}, [])]));
    expect(Buffer.from(r.returnData().data()).readBigUInt64LE()).toBe(0n);
  });

  it("makes a collection mint, adds members up to its size, resizes and hands it over", async () => {
    const groupSpace = t22.getMintSize([t22.extension("GroupPointer", { authority: payer.address, groupAddress: payer.address } as never)]);
    const groupFull = t22.getMintSize([
      t22.extension("GroupPointer", { authority: payer.address, groupAddress: payer.address } as never),
      t22.extension("TokenGroup", { updateAuthority: payer.address, mint: payer.address, size: 0n, maxSize: 0n } as never),
    ]);
    const group = await generateKeyPairSigner();
    expectOk(
      await send(d.svm, payer, [
        ix(d, "collection", { space: new BN(groupSpace), full: new BN(groupFull), max_size: new BN(1) }, [
          { address: payer.address, signer: payer, writable: true },
          { address: group.address, signer: group, writable: true },
          { address: TOKEN_2022 },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const groupExt = () => {
      const m = t22.getMintDecoder().decode(new Uint8Array((d.svm.getAccount(group.address) as { data: Uint8Array }).data));
      const ext = (m.extensions as { __option: string; value?: { __kind: string }[] }).value!.find((e) => e.__kind === "TokenGroup") as unknown as {
        size: bigint;
        maxSize: bigint;
        updateAuthority: { __option: string; value?: string } | string;
      };
      return ext;
    };
    expect([groupExt().size, groupExt().maxSize]).toEqual([0n, 1n]);

    const memberSpace = t22.getMintSize([t22.extension("GroupMemberPointer", { authority: payer.address, memberAddress: payer.address } as never)]);
    const memberFull = t22.getMintSize([
      t22.extension("GroupMemberPointer", { authority: payer.address, memberAddress: payer.address } as never),
      t22.extension("TokenGroupMember", { mint: payer.address, group: payer.address, memberNumber: 0n } as never),
    ]);
    const addMember = async () => {
      const m = await generateKeyPairSigner();
      return send(d.svm, payer, [
        ix(d, "member", { space: new BN(memberSpace), full: new BN(memberFull) }, [
          { address: payer.address, signer: payer, writable: true },
          { address: m.address, signer: m, writable: true },
          { address: group.address, writable: true },
          { address: TOKEN_2022 },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    };
    expectOk(await addMember());
    expect(groupExt().size).toBe(1n);
    expect(await addMember()).toBeInstanceOf(FailedTransactionMetadata); // full at 1
    const groupAuth = [{ address: group.address, writable: true }, { address: payer.address, signer: payer }, { address: TOKEN_2022 }];
    expectOk(await send(d.svm, payer, [ix(d, "resize", { max_size: new BN(3) }, groupAuth)]));
    expectOk(await addMember());
    expect([groupExt().size, groupExt().maxSize]).toEqual([2n, 3n]);
    const next = (await fundedSigner(d.svm)).address;
    expectOk(await send(d.svm, payer, [ix(d, "hand_over", { next: pk(next) }, groupAuth)]));
    expect(JSON.stringify(groupExt().updateAuthority)).toContain(next);
    // The old authority can no longer resize it.
    expect(await send(d.svm, payer, [ix(d, "resize", { max_size: new BN(4) }, groupAuth)])).toBeInstanceOf(FailedTransactionMetadata);
  });
  it("runs the @fallback for data no instruction matches, short data included, and keeps it out of the IDL", async () => {
    const raw = (data: number[], accounts: Address[] = []) =>
      send(d.svm, payer, [{ programAddress: d.programId, accounts: accounts.map((address) => ({ address, role: 0 })), data: new Uint8Array(data) } as never]);
    const out = (r: Awaited<ReturnType<typeof raw>>) =>
      expectOk(r)
        .logs()
        .filter((l) => l.startsWith("Program log: "))
        .map((l) => l.slice(13));
    expect(out(await raw([9, 1, 2, 3, 4, 5, 6, 7, 8, 9], [MEMO, SLOT_HASHES]))).toEqual(["10", "9", "2"]);
    expect(out(await raw([7, 7]))).toEqual(["2", "7", "0"]);
    expect(await raw([])).toBeInstanceOf(FailedTransactionMetadata); // require(data.length > 0n)
    // A known instruction still runs as itself.
    expect(logs(await send(d.svm, payer, [ix(d, "unsigned", {}, [{ address: MEMO }])]))).toMatch(/anyone/);
    expect((d.idl as unknown as { instructions: { name: string }[] }).instructions.map((i) => i.name)).not.toContain("legacy");
  });
});
