// Template literals and += build exactly the strings JS would, through the joined / in-place paths.
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { generateKeyPairSigner } from "@solana/kit";
import { web3 } from "@anchor-lang/core";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, acct, deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "./harness.js";

describe("string building", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/string-build.ts", import.meta.url)));
  });

  it("matches JS for templates, += and views taken before a string grows", async () => {
    const payer = await fundedSigner(d.svm);
    const key = (await generateKeyPairSigner()).address;
    const logs = expectOk(await send(d.svm, payer, [ix(d, "build", { n: new BN(42), word: "hé", key: new web3.PublicKey(key) }, [])])).logs();
    // The same program in JS.
    let s = "a";
    const before = s;
    s += "b";
    s += `${42}-${"hé"}`;
    const mid = s;
    for (let i = 0; i < 3; i++) s += `[${i}]`;
    let other = mid;
    other += "x";
    s += "y";
    expect(logs).toContain(`Program log: ${before}|${mid}|${s}|${other}`);
    expect(logs).toContain(`Program log: ww9C83noARSQVBnqmCUmaVdbJjmiwcV9j2LkXYMoUCV|${key}|true|7`);
  });

  it("reads account text in each piece's turn", async () => {
    const payer = await fundedSigner(d.svm);
    const note = (await generateKeyPairSigner()).address;
    const data = Buffer.alloc(8 + 4 + 16);
    createHash("sha256").update("account:Note").digest().subarray(0, 8).copy(data);
    data.writeUInt32LE(3, 8);
    data.write("old", 12);
    d.svm.setAccount({
      address: note,
      data: new Uint8Array(data),
      executable: false,
      lamports: 10n ** 9n,
      programAddress: d.programId,
      space: BigInt(data.length),
    } as never);
    const logs = expectOk(await send(d.svm, payer, [ix(d, "reread", { to: "new" }, [{ address: note, writable: true }])])).logs();
    expect(logs).toContain("Program log: old!new");
    expect(logs).toContain("Program log: new!z");
    expect(Buffer.from(acct(d.svm, note).data).subarray(12, 13).toString()).toBe("z");
  });
});
