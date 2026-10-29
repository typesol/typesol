import { fileURLToPath } from "node:url";
import type { TransactionMetadata } from "litesvm";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, customError, decodeAccount, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

const ret = (r: TransactionMetadata) => Buffer.from(r.returnData().data());

describe("Anchor-style conveniences (test/fixtures/conveniences.ts)", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/conveniences.ts", import.meta.url)));
  });

  async function opened() {
    const owner = await fundedSigner(d.svm);
    const [stash] = await pda(d.programId, ["stash", owner.address]);
    const deposit = (amount: number, who = owner, target = stash) =>
      ix(d, "deposit", { amount: new BN(amount) }, [
        { address: who.address, signer: who, writable: true },
        { address: target, writable: true },
        { address: SYSTEM_PROGRAM },
      ]);
    return { owner, stash, deposit };
  }

  it("init_if_needed: creates on the first call, reuses afterwards, re-derives the PDA", async () => {
    const { owner, stash, deposit } = await opened();
    expect(ret(expectOk(await send(d.svm, owner, [deposit(10)])))[0]).toBe(1);
    expect(ret(expectOk(await send(d.svm, owner, [deposit(5)])))[0]).toBe(0);
    const s = decodeAccount<{ amount: BN; visits: BN }>(d, d.svm, "Stash", stash);
    expect([s.amount.toString(), s.visits.toString()]).toEqual(["15", "2"]);
    // Someone else's existing stash cannot be passed as yours.
    const { stash: other, deposit: otherDeposit, owner: otherOwner } = await opened();
    expectOk(await send(d.svm, otherOwner, [otherDeposit(1)]));
    expect(customError(await send(d.svm, owner, [deposit(1, owner, other)]))).toBe(2006);
  });

  it("has_one + seeds/bump constraints run before the body; switch with fallthrough", async () => {
    const { owner, stash, deposit } = await opened();
    expectOk(await send(d.svm, owner, [deposit(10)]));
    const op = (name: string, n: number, who = owner, target = stash) =>
      ix(d, "apply", { op: { [name]: {} }, n: new BN(n) }, [
        { address: who.address, signer: who },
        { address: target, writable: true },
      ]);
    const amount = async (name: string, n: number) => ret(expectOk(await send(d.svm, owner, [op(name, n)]))).readBigUInt64LE();
    expect(await amount("Add", 5)).toBe(15n);
    expect(await amount("Sub", 3)).toBe(12n);
    expect(await amount("Double", 0)).toBe(24n); // Double falls through into the visit counting
    expect(await amount("Reset", 0)).toBe(0n);
    expect(decodeAccount<{ visits: BN }>(d, d.svm, "Stash", stash).visits.toString()).toBe("3");

    const mallory = await fundedSigner(d.svm);
    // Mallory signs as "owner" for alice's stash: the seeds (checked first, as in Anchor) refuse; has_one would too.
    expect(customError(await send(d.svm, mallory, [op("Add", 1, mallory)]))).toBe(2006);
  });

  it("has_one rejects a mismatched owner even when the seeds match", async () => {
    const { owner, stash, deposit } = await opened();
    expectOk(await send(d.svm, owner, [deposit(1)]));
    // Forge the stored owner so seeds(owner) still match but owner field differs.
    const acct = d.svm.getAccount(stash) as { data: Uint8Array; lamports: bigint; programAddress: string };
    const data = Uint8Array.from(acct.data);
    data.fill(9, 8, 40);
    d.svm.setAccount({
      address: stash,
      data,
      executable: false,
      lamports: acct.lamports as never,
      programAddress: acct.programAddress as never,
      space: BigInt(data.length),
    });
    const r = await send(d.svm, owner, [
      ix(d, "apply", { op: { Add: {} }, n: new BN(1) }, [
        { address: owner.address, signer: owner },
        { address: stash, writable: true },
      ]),
    ]);
    expect(customError(r)).toBe(2001);
  });

  it("close-on-success returns the rent to the owner after the body ran", async () => {
    const { owner, stash, deposit } = await opened();
    expectOk(await send(d.svm, owner, [deposit(42)]));
    const before = d.svm.getBalance(owner.address)!;
    const rent = d.svm.getBalance(stash)!;
    const r = expectOk(
      await send(d.svm, owner, [
        ix(d, "withdraw_all", {}, [
          { address: owner.address, signer: owner, writable: true },
          { address: stash, writable: true },
        ]),
      ]),
    );
    expect(ret(r).readBigUInt64LE()).toBe(42n);
    expect(d.svm.getAccount(stash).exists).toBe(false);
    expect(d.svm.getBalance(owner.address)! - before).toBe(rent - 5000n);
  });

  it("puts relations and seeds in the IDL", () => {
    const apply = d.idl.instructions.find((i) => i.name === "apply")!.accounts as { name: string; relations?: string[]; pda?: { seeds: unknown[] } }[];
    // Anchor's direction: `owner` lists the account whose has_one names it, so clients read stash.owner.
    expect(apply[0].relations).toEqual(["stash"]);
    expect(apply[1].relations).toBeUndefined();
    expect(apply[1].pda?.seeds).toEqual([
      { kind: "const", value: [...Buffer.from("stash")] },
      { kind: "account", path: "owner" },
    ]);
  });
});
