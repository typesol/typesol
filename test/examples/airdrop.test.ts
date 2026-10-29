import { type Address, type KeyPairSigner, generateKeyPairSigner } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, customError, decodeAccount, deployExample, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

describe("examples/airdrop.ts (remaining accounts)", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployExample("airdrop");
  });

  async function pot(fund: bigint) {
    const admin = await fundedSigner(d.svm, 20n);
    const [addr] = await pda(d.programId, ["pot", admin.address]);
    expectOk(
      await send(d.svm, admin, [
        ix(d, "setup", {}, [{ address: admin.address, signer: admin, writable: true }, { address: addr, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    d.svm.airdrop(addr, fund as never);
    return { admin, addr };
  }

  const extra = (addrs: Address[], writable = true) => addrs.map((address) => ({ address, writable }));

  it("pays every remaining account from a program-owned pot", async () => {
    const { admin, addr } = await pot(1_000_000_000n);
    const people = await Promise.all([1, 2, 3, 4].map(() => generateKeyPairSigner()));
    const drop = (each: number, to: { address: Address; writable: boolean }[]) =>
      ix(d, "airdrop", { each: new BN(each) }, [{ address: admin.address, signer: admin }, { address: addr, writable: true }, ...to]);
    expectOk(await send(d.svm, admin, [drop(1_000_000, extra(people.map((p) => p.address)))]));
    for (const p of people) expect(d.svm.getBalance(p.address)).toBe(1_000_000n);
    expect(decodeAccount<{ paid_out?: BN; paidOut?: BN }>(d, d.svm, "Pot", addr)).toMatchObject({});
    const state = decodeAccount<Record<string, BN>>(d, d.svm, "Pot", addr);
    expect((state.paid_out ?? state.paidOut).toString()).toBe("4000000");

    // A read-only remaining account is refused when the program tries to credit it.
    expect(customError(await send(d.svm, admin, [drop(1, extra([people[0].address], false))]))).toBe(3006);
    // 996M lamports remain above rent: 4 x 249.2M would dip into the rent reserve (6001); asking for
    // more than the pot holds at all fails the checked subtraction first (5100).
    expect(customError(await send(d.svm, admin, [drop(249_200_000, extra(people.map((p) => p.address)))]))).toBe(6001);
    expect(customError(await send(d.svm, admin, [drop(400_000_000, extra(people.map((p) => p.address)))]))).toBe(5100);
    // No remaining accounts: nothing happens.
    expectOk(await send(d.svm, admin, [drop(5, [])]));
  });

  it("updates many Member accounts via loadAccountMut and rejects anything else", async () => {
    const { admin, addr } = await pot(100_000_000n);
    const members: Address[] = [];
    for (let i = 0; i < 3; i++) {
      const owner = await fundedSigner(d.svm);
      const [m] = await pda(d.programId, ["member", owner.address]);
      expectOk(
        await send(d.svm, owner, [
          ix(d, "join", {}, [{ address: owner.address, signer: owner, writable: true }, { address: m, writable: true }, { address: SYSTEM_PROGRAM }]),
        ]),
      );
      members.push(m);
    }
    const award = (points: number, to: { address: Address; writable: boolean }[], who: KeyPairSigner = admin) =>
      ix(d, "award", { points: new BN(points) }, [{ address: who.address, signer: who }, { address: addr }, ...to]);
    expectOk(await send(d.svm, admin, [award(10, extra(members)), award(5, extra(members.slice(1)))]));
    expect(members.map((m) => decodeAccount<{ points: BN }>(d, d.svm, "Member", m).points.toString())).toEqual(["10", "15", "15"]);

    expect(customError(await send(d.svm, admin, [award(1, extra([admin.address]))]))).toBe(3007); // a wallet is not a Member
    expect(customError(await send(d.svm, admin, [award(1, extra([addr]))]))).toBe(3002); // the Pot is ours but not a Member
    expect(customError(await send(d.svm, admin, [award(1, extra([members[0]], false))]))).toBe(3006);
    expect(customError(await send(d.svm, admin, [award(1, extra([members[0], members[0]]))]))).toBe(2040); // same member twice
    const stranger = await fundedSigner(d.svm);
    expect(customError(await send(d.svm, stranger, [award(1, extra(members), stranger)]))).toBe(6000);
  });

  it("forwards remaining accounts into CPIs", async () => {
    const payer = await fundedSigner(d.svm, 5n);
    const people = await Promise.all([1, 2, 3].map(() => generateKeyPairSigner()));
    const tip = (to: { address: Address; writable: boolean }[]) =>
      ix(d, "tip", { amount: new BN(2_000_000) }, [{ address: payer.address, signer: payer, writable: true }, { address: SYSTEM_PROGRAM }, ...to]);
    expectOk(await send(d.svm, payer, [tip(extra(people.map((p) => p.address)))]));
    for (const p of people) expect(d.svm.getBalance(p.address)).toBe(2_000_000n);
    expect(customError(await send(d.svm, payer, [tip(extra([people[0].address], false))]))).toBe(3006);
  });
});
