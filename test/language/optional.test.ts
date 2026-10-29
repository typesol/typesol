import { type Address, getAddressDecoder } from "@solana/kit";
import { web3 } from "@anchor-lang/core";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, customError, decodeAccount, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

describe("optional accounts (test/fixtures/optional.ts)", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/optional.ts", import.meta.url)));
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

  it("`bank!` uses a passed account and fails when it was left out; Pubkeys go into template strings as base58", async () => {
    const alice = await fundedSigner(d.svm);
    const aBank = await bankOf(alice);
    const must = (bank: Address) =>
      send(d.svm, alice, [
        ix(d, "must_add", { amount: new BN(5) }, [
          { address: alice.address, signer: alice },
          { address: bank, writable: bank !== d.programId },
        ]),
      ]);
    const ok = expectOk(await must(aBank));
    expect(Buffer.from(ok.returnData().data()).readBigUInt64LE()).toBe(5n);
    expect(ok.logs()).toContain(`Program log: bank of ${alice.address} holds 5`);
    expect(customError(await must(d.programId))).toBe(5115);
  });

  it("prints Pubkeys in templates as base58, leading zero bytes and all", async () => {
    const payer = await fundedSigner(d.svm);
    const dec = getAddressDecoder();
    const keys: Uint8Array[] = [new Uint8Array(32), new Uint8Array(32).fill(255), Uint8Array.from({ length: 32 }, (_, i) => (i < 3 ? 0 : i))];
    const one = new Uint8Array(32);
    one[31] = 1;
    keys.push(one);
    for (let i = 0; i < 40; i++) keys.push(crypto.getRandomValues(new Uint8Array(32)));
    // Every count of leading zero bytes, with random bytes after them.
    for (let z = 1; z < 32; z++) {
      const k = crypto.getRandomValues(new Uint8Array(32));
      k.fill(0, 0, z);
      if (k[z] === 0) k[z] = 1;
      keys.push(k);
    }
    for (const k of keys) {
      const text = dec.decode(k);
      const r = expectOk(await send(d.svm, payer, [ix(d, "show", { k: new web3.PublicKey(k) }, [])]));
      expect(r.logs()).toContain(`Program log: key ${text}`);
    }
  });
});
