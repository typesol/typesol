// `a ?? b` and `x!` on Options: JS results, b evaluated only when needed, an empty `x!` aborts with 5108.
import { generateKeyPairSigner, getAddressDecoder } from "@solana/kit";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, customError, decodeAccount, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "./harness.js";

describe("?? and ! on Options", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/nullish.ts", import.meta.url)));
  });
  const ret = (r: Awaited<ReturnType<typeof send>>) => Buffer.from(expectOk(r).returnData().data());
  const opt = (v: number | null) => (v === null ? null : new BN(v));

  it("takes the first value that is present, running the fallback only when needed", async () => {
    for (const stored of [7, null]) {
      const admin = await fundedSigner(d.svm);
      const [prefs] = await pda(d.programId, ["prefs", admin.address]);
      const p = { address: prefs, writable: true };
      expectOk(
        await send(d.svm, admin, [
          ix(d, "setup", { limit: opt(stored) }, [{ address: admin.address, signer: admin, writable: true }, p, { address: SYSTEM_PROGRAM }]),
        ]),
      );
      for (const fallback of [3, null]) {
        const v = ret(await send(d.svm, admin, [ix(d, "limit_or", { fallback: opt(fallback) }, [p])])).readBigUInt64LE(0);
        expect(v).toBe(BigInt(stored ?? fallback ?? 100));
      }
      // countHit() ran only when both were empty.
      expect(decodeAccount<{ hits: BN }>(d, d.svm, "Prefs", prefs).hits.toNumber()).toBe(stored === null ? 1 : 0);

      const who = await fundedSigner(d.svm);
      const owner = getAddressDecoder().decode(ret(await send(d.svm, who, [ix(d, "owner_or", {}, [p, { address: who.address, signer: who }])])));
      expect(owner).toBe(who.address); // owner is empty in this account
    }
  });

  it("keeps an Option result empty when both sides are", async () => {
    const payer = await fundedSigner(d.svm);
    const either = async (a: number | null, b: number | null) =>
      ret(await send(d.svm, payer, [ix(d, "either", { a: opt(a), b: opt(b) }, [])])).readBigUInt64LE(0);
    expect([await either(4, 9), await either(null, 9), await either(null, null)]).toEqual([5n, 10n, 0n]);
  });

  it("x! gives the value and aborts with 5108 when empty", async () => {
    const payer = await fundedSigner(d.svm);
    expect(ret(await send(d.svm, payer, [ix(d, "must", { a: new BN(21) }, [])])).readBigUInt64LE(0)).toBe(42n);
    expect(customError(await send(d.svm, payer, [ix(d, "must", { a: null }, [])]))).toBe(5108);
    void generateKeyPairSigner;
  });
});
