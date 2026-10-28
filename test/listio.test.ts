// FixedVec arguments and list fields in events, through Anchor's coder (the IDL describes them).
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "./harness.js";

describe("lists in arguments and events", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/listio.ts", import.meta.url)));
  });

  it("takes FixedVec arguments up to their capacity, and emits FixedVec and Vec fields", async () => {
    const payer = await fundedSigner(d.svm);
    const [holder] = await pda(d.programId, ["holder", payer.address]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "setup", {}, [{ address: payer.address, signer: payer, writable: true }, { address: holder, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    const fire = (ids: number[]) =>
      send(d.svm, payer, [
        ix(d, "fire", { ids: ids.map((x) => new BN(x)), tags: [new BN(7), new BN(8)] }, [{ address: payer.address, signer: payer }, { address: holder }]),
      ]);
    const r = expectOk(await fire([1, 2, 3]));
    expect(Buffer.from(r.returnData().data()).readBigUInt64LE(0)).toBe(6n);
    const events = r
      .logs()
      .filter((l) => l.startsWith("Program data: "))
      .map((l) => d.coder.events.decode(l.slice("Program data: ".length)) as { name: string; data: { n: BN; xs: { len: number; items: BN[] }; tags: BN[] } });
    const plain = events.map((e) => ({ n: e.data.n.toNumber(), xs: e.data.xs.items.slice(0, e.data.xs.len).map(Number), tags: e.data.tags.map(Number) }));
    expect(plain).toEqual([
      { n: 3, xs: [5, 6], tags: [7, 8] },
      { n: 0, xs: [9], tags: [7, 8] },
    ]);
    // One element more than the FixedVec holds does not deserialize (Anchor's InstructionDidNotDeserialize).
    const over = await fire([1, 2, 3, 4]);
    expect(String((over as { err?: () => unknown }).err?.())).toMatch(/Custom\D*102/);
  });
});
