import type { Address } from "@solana/kit";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, customError, decodeAccount, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "./harness.js";

describe("optional accounts (test/fixtures/optional.ts)", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/optional.ts", import.meta.url)));
  });
  const bankOf = async (owner: Awaited<ReturnType<typeof fundedSigner>>) => {
    const [bank] = await pda(d.programId, ["bank", owner.address]);
    expectOk(
      await send(d.svm, owner, [
        ix(d, "open", {}, [{ address: owner.address, signer: owner, writable: true }, { address: bank, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    return bank;
  };
  const total = (bank: Address) => decodeAccount<{ total: BN }>(d, d.svm, "Bank", bank).total.toString();

  it("marks them optional in the IDL", () => {
    const accts = d.idl.instructions.find((i) => i.name === "maybe_add")!.accounts as { name: string; optional?: boolean }[];
    expect(accts.map((a) => [a.name, !!a.optional])).toEqual([
      ["owner", false],
      ["bank", true],
      ["referrer", true],
    ]);
  });

  it("runs with and without them, checking constraints only when present", async () => {
    const alice = await fundedSigner(d.svm);
    const bob = await fundedSigner(d.svm);
    const aBank = await bankOf(alice);
    const bBank = await bankOf(bob);
    const NONE = d.programId;
    const add = (who: typeof alice, bank: Address, referrer: Address) =>
      send(d.svm, who, [
        ix(d, "maybe_add", { amount: new BN(7) }, [
          { address: who.address, signer: who },
          { address: bank, writable: bank !== NONE },
          { address: referrer, writable: referrer !== NONE },
        ]),
      ]);
    const ret = (r: ReturnType<typeof expectOk>) => Buffer.from(r.returnData().data()).readBigUInt64LE();
    expect(ret(expectOk(await add(alice, NONE, NONE)))).toBe(0n);
    expect(ret(expectOk(await add(alice, aBank, NONE)))).toBe(1n);
    expect(total(aBank)).toBe("7");
    expectOk(await add(alice, NONE, aBank));
    expect(total(aBank)).toBe("8");
    // Present accounts are still checked: the referrer must belong to the signer, and both slots must differ.
    expect(customError(await add(alice, NONE, bBank))).toBe(2001);
    expect(customError(await add(alice, aBank, aBank))).toBe(2040);
    // Something that is neither this program's id nor a Bank fails the owner check.
    expect(customError(await add(alice, alice.address, NONE))).toBe(3007);
  });
});
