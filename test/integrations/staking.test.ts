// Stake program CPIs signed by a PDA (test/fixtures/staking.ts): initialize, delegate to a vote account, deactivate,
// withdraw, and hand over the staker role.
import { getCreateAccountInstruction } from "@solana-program/system";
import { type Address, type KeyPairSigner, generateKeyPairSigner, getAddressEncoder } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

const STAKE = "Stake11111111111111111111111111111111111111" as Address;
const VOTE = "Vote111111111111111111111111111111111111111" as Address;
const CONFIG = "StakeConfig11111111111111111111111111111111" as Address;
const RENT = "SysvarRent111111111111111111111111111111111" as Address;
const CLOCK = "SysvarC1ock11111111111111111111111111111111" as Address;
const HISTORY = "SysvarStakeHistory1111111111111111111111111" as Address;
const enc = getAddressEncoder();
const pk = (a: string) => ({ toBuffer: () => Buffer.from(enc.encode(a as Address)), toBase58: () => a });

describe("Stake program CPIs (test/fixtures/staking.ts)", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  let authority: Address;
  let bump: number;
  let vote: Address;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/staking.ts", import.meta.url)));
    payer = await fundedSigner(d.svm, 100n);
    [authority, bump] = await pda(d.programId, ["authority"]);
    // A vote account: created, then VoteInstruction::InitializeAccount(VoteInit { node, voter, withdrawer, commission }).
    const v = await generateKeyPairSigner();
    const node = await fundedSigner(d.svm);
    const space = 3762n;
    const data = Buffer.alloc(4 + 32 * 3 + 1);
    [node.address, node.address, node.address].forEach((k, i) => Buffer.from(enc.encode(k)).copy(data, 4 + 32 * i));
    expectOk(
      await send(d.svm, payer, [
        getCreateAccountInstruction({ payer, newAccount: v, lamports: d.svm.minimumBalanceForRentExemption(space), space, programAddress: VOTE }),
        {
          programAddress: VOTE,
          accounts: [
            { address: v.address, role: 1 },
            { address: RENT, role: 0 },
            { address: CLOCK, role: 0 },
            { address: node.address, role: 2, signer: node },
          ],
          data: new Uint8Array(data),
        } as never,
      ]),
    );
    vote = v.address;
  });

  async function stakeAccount(sol: bigint) {
    const s = await generateKeyPairSigner();
    const lamports = d.svm.minimumBalanceForRentExemption(200n) + sol * 1_000_000_000n;
    expectOk(
      await send(d.svm, payer, [
        getCreateAccountInstruction({ payer, newAccount: s, lamports, space: 200n, programAddress: STAKE }),
        ix(d, "setup", {}, [{ address: s.address, writable: true }, { address: RENT }, { address: authority }, { address: STAKE }]),
      ]),
    );
    return s.address;
  }
  const state = (stake: Address) => Buffer.from((d.svm.getAccount(stake) as { data: Uint8Array }).data).readUInt32LE(0);
  const meta = (stake: Address) => {
    const b = Buffer.from((d.svm.getAccount(stake) as { data: Uint8Array }).data);
    return { staker: b.subarray(12, 44), withdrawer: b.subarray(44, 76) };
  };

  it("initializes with the PDA as both authorities, delegates, deactivates and withdraws", async () => {
    const stake = await stakeAccount(2n);
    expect(state(stake)).toBe(1); // Initialized
    expect([...meta(stake).staker]).toEqual([...enc.encode(authority)]);
    const delegate = (b = bump) =>
      send(d.svm, payer, [
        ix(d, "delegate", { bump: b }, [
          { address: stake, writable: true },
          { address: vote },
          { address: CLOCK },
          { address: HISTORY },
          { address: CONFIG },
          { address: authority },
          { address: STAKE },
        ]),
      ]);
    expect(await delegate(bump === 255 ? 254 : bump + 1)).toBeInstanceOf(FailedTransactionMetadata); // not the PDA's seeds
    expectOk(await delegate());
    expect(state(stake)).toBe(2); // Stake
    expectOk(
      await send(d.svm, payer, [
        ix(d, "deactivate", { bump }, [{ address: stake, writable: true }, { address: CLOCK }, { address: authority }, { address: STAKE }]),
      ]),
    );

    const to = (await generateKeyPairSigner()).address;
    const withdraw = (lamports: bigint) =>
      send(d.svm, payer, [
        ix(d, "withdraw", { bump, lamports: new BN(lamports.toString()) }, [
          { address: stake, writable: true },
          { address: to, writable: true },
          { address: CLOCK },
          { address: HISTORY },
          { address: authority },
          { address: STAKE },
        ]),
      ]);
    // Activated and deactivated in one epoch, the stake never took effect: withdrawable at once, but not beyond it.
    expect(await withdraw(10_000_000_000n)).toBeInstanceOf(FailedTransactionMetadata);
    expectOk(await withdraw(1_000_000_000n));
    expect(d.svm.getBalance(to)).toBe(1_000_000_000n);
  });

  it("hands the staker role to another key", async () => {
    const stake = await stakeAccount(1n);
    const next = (await generateKeyPairSigner()).address;
    expectOk(
      await send(d.svm, payer, [
        ix(d, "hand_over", { bump, next: pk(next) }, [{ address: stake, writable: true }, { address: CLOCK }, { address: authority }, { address: STAKE }]),
      ]),
    );
    expect([...meta(stake).staker]).toEqual([...enc.encode(next)]);
    expect([...meta(stake).withdrawer]).toEqual([...enc.encode(authority)]);
  });
  it("reads the StakeHistory sysvar by epoch", async () => {
    // Entries newest first: (epoch, effective, activating, deactivating).
    const entries = [
      [12n, 9n, 2n, 1n],
      [11n, 7n, 3n, 0n],
    ];
    const data = Buffer.alloc(8 + 32 * entries.length);
    data.writeBigUInt64LE(BigInt(entries.length), 0);
    entries.forEach((e, i) => e.forEach((v, j) => data.writeBigUInt64LE(v, 8 + 32 * i + 8 * j)));
    d.svm.setAccount({
      address: HISTORY,
      data: new Uint8Array(data),
      executable: false,
      lamports: 1_000_000n as never,
      programAddress: "Sysvar1111111111111111111111111111111111111" as Address,
      space: BigInt(data.length),
    });
    const read = async (epoch: bigint) =>
      Buffer.from(
        expectOk(await send(d.svm, payer, [ix(d, "history", { epoch: new BN(epoch.toString()) }, [{ address: HISTORY }])]))
          .returnData()
          .data(),
      ).readBigUInt64LE();
    expect(await read(11n)).toBe(100_000_000_000n + 70_000_000n + 300_000n + 0n + 200n + 12n);
    expect(await read(12n)).toBe(100_000_000_000n + 90_000_000n + 200_000n + 1000n + 200n + 12n);
    expect(await read(5n)).toBe(200n + 12n); // not listed
    // Another account in the sysvar's slot.
    expect(await send(d.svm, payer, [ix(d, "history", { epoch: new BN(1) }, [{ address: CLOCK }])])).toBeInstanceOf(FailedTransactionMetadata);
  });
});
