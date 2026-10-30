// Switchboard On-Demand randomness (test/fixtures/coinflip.ts): RandomnessAccountData written into the VM as the
// oracle leaves it after commit and after reveal.
import { type Address, type KeyPairSigner, generateKeyPairSigner } from "@solana/kit";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, customError, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

const SB_MAINNET = "SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv" as Address;
const DISC = [10, 66, 229, 135, 220, 239, 217, 114];

describe("Switchboard randomness (test/fixtures/coinflip.ts)", () => {
  let d: Deployed;
  let player: KeyPairSigner;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/coinflip.ts", import.meta.url)));
    player = await fundedSigner(d.svm);
  });
  const setSlot = (slot: bigint) => {
    const c = d.svm.getClock();
    c.slot = slot;
    d.svm.setClock(c);
  };
  const writeRandomness = (at: Address, seedSlot: bigint, revealSlot: bigint, value: number[], owner: Address = SB_MAINNET) => {
    const data = Buffer.alloc(384);
    Buffer.from(DISC).copy(data, 0);
    data.writeBigUInt64LE(seedSlot, 104);
    data.writeBigUInt64LE(revealSlot, 144);
    Buffer.from(value).copy(data, 152);
    d.svm.setAccount({ address: at, data: new Uint8Array(data), executable: false, lamports: 3_000_000n as never, programAddress: owner, space: 384n });
  };
  const bet = async (who: KeyPairSigner) => (await pda(d.programId, ["bet", who.address]))[0];
  const commit = async (who: KeyPairSigner, randomness: Address, guess: bigint) =>
    send(d.svm, who, [
      ix(d, "commit", { guess: new BN(guess.toString()) }, [
        { address: who.address, signer: who, writable: true },
        { address: await bet(who), writable: true },
        { address: randomness },
        { address: SYSTEM_PROGRAM },
      ]),
    ]);
  const settle = async (who: KeyPairSigner, randomness: Address) =>
    send(d.svm, who, [ix(d, "settle", {}, [{ address: who.address, signer: who }, { address: await bet(who), writable: true }, { address: randomness }])]);
  const outcome = async (who: KeyPairSigner) => {
    const data = Buffer.from((d.svm.getAccount(await bet(who)) as { data: Uint8Array }).data);
    return { settled: data[8 + 48] === 1, won: data[8 + 49] === 1 };
  };

  it("commits to an unrevealed value, then settles on the value revealed in this slot", async () => {
    const r = (await generateKeyPairSigner()).address;
    setSlot(1000n);
    writeRandomness(r, 999n, 0n, []);
    expectOk(await commit(player, r, 1n));
    // Revealed in slot 1003: value 7 (odd), so a guess of 1 wins.
    setSlot(1003n);
    writeRandomness(r, 999n, 1003n, [7, 0, 0, 0, 0, 0, 0, 0]);
    expectOk(await settle(player, r));
    expect(await outcome(player)).toEqual({ settled: true, won: true });
    expect(customError(await settle(player, r))).toBe(6002); // Settled
  });

  it("refuses stale commits, values read outside their reveal slot, and other accounts", async () => {
    const p = await fundedSigner(d.svm);
    const r = (await generateKeyPairSigner()).address;
    setSlot(2000n);
    writeRandomness(r, 1990n, 0n, []);
    expect(customError(await commit(p, r, 0n))).toBe(6000); // not committed in the previous slot
    writeRandomness(r, 1999n, 0n, []);
    expectOk(await commit(p, r, 0n));
    setSlot(2005n);
    writeRandomness(r, 1999n, 2004n, [2]);
    expect(customError(await settle(p, r))).toBe(5111); // revealed in another slot
    const other = (await generateKeyPairSigner()).address;
    writeRandomness(other, 1999n, 2005n, [2]);
    expect(customError(await settle(p, other))).toBe(6001); // not the committed account
    const fake = (await generateKeyPairSigner()).address;
    writeRandomness(fake, 1999n, 2005n, [2], SYSTEM_PROGRAM);
    expect(customError(await settle(p, fake))).toBe(3007); // owned by another program
    writeRandomness(r, 1999n, 2005n, [2]);
    expectOk(await settle(p, r));
    expect(await outcome(p)).toEqual({ settled: true, won: true }); // 2 is even, the guess was 0
  });
});
