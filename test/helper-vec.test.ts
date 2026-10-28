// Growable Vec<T> push / pop inside helpers, nested two deep, with rent paid and returned as in an instruction.
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, acct, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "./harness.js";

describe("Vec<T> growth in helpers", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/helper-vec.ts", import.meta.url)));
  });

  it("grows and shrinks the account from helpers", async () => {
    const payer = await fundedSigner(d.svm);
    const [log] = await pda(d.programId, ["log", payer.address]);
    const P = { address: payer.address, signer: payer, writable: true };
    const L = { address: log, writable: true };
    expectOk(await send(d.svm, payer, [ix(d, "create", {}, [P, L, { address: SYSTEM_PROGRAM }])]));
    const base = acct(d.svm, log).data.length;
    expectOk(await send(d.svm, payer, [ix(d, "push", { x: new BN(10) }, [P, L, { address: SYSTEM_PROGRAM }])]));
    expectOk(await send(d.svm, payer, [ix(d, "push", { x: new BN(20) }, [P, L, { address: SYSTEM_PROGRAM }])]));
    const read = () => d.coder.accounts.decode("Log", Buffer.from(acct(d.svm, log).data));
    let l = read();
    expect(l.n.toNumber()).toBe(4);
    expect(l.items.map((x: BN) => x.toNumber())).toEqual([10, 11, 20, 21]);
    expect(acct(d.svm, log).data.length).toBe(base + 4 * 8);
    expectOk(await send(d.svm, payer, [ix(d, "drop", {}, [L])]));
    l = read();
    expect(l.items.map((x: BN) => x.toNumber())).toEqual([10, 11, 20]);
    expect(acct(d.svm, log).data.length).toBe(base + 3 * 8);
  });
});
