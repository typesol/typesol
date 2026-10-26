import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, customError, deployFile, expectOk, fundedSigner, ix, pda, send, acct } from "./harness.js";

describe("realloc (test/fixtures/realloc.ts)", () => {
  it("grows (payer funds rent), shrinks (lamports stay), and enforces the limits", async () => {
    const d = await deployFile(fileURLToPath(new URL("./fixtures/realloc.ts", import.meta.url)));
    const payer = await fundedSigner(d.svm);
    const [doc] = await pda(d.programId, ["doc", payer.address]);
    const metas = [{ address: payer.address, signer: payer, writable: true }, { address: doc, writable: true }, { address: SYSTEM_PROGRAM }];
    expectOk(await send(d.svm, payer, [ix(d, "make", {}, metas)]));
    const resize = (size: number) => send(d.svm, payer, [ix(d, "resize", { size: new BN(size) }, metas)]);
    const rent = (n: number) => d.svm.minimumBalanceForRentExemption(BigInt(n));

    expectOk(await resize(4000));
    expect(acct(d.svm, doc).data.length).toBe(4000);
    expect(d.svm.getBalance(doc)).toBe(rent(4000));
    const before = d.svm.getBalance(payer.address)!;
    expectOk(await resize(100));
    // Shrinking keeps the lamports in the account (only the program may move them out).
    expect(d.svm.getBalance(doc)).toBe(rent(4000));
    expect(before - d.svm.getBalance(payer.address)!).toBe(5000n);
    expect(customError(await resize(100 + 10 * 1024 + 1))).toBe(3016);
    expect(customError(await resize(15))).toBe(3016); // below 8 + sizeof(Doc)
  });
});
