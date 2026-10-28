// Callback methods on lists, expanded into loops: forEach / some / every / find / findIndex / reduce / includes / indexOf.
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, decodeAccount, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "./harness.js";
import { pk } from "./ports-helpers.js";

describe("list methods", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/listmethods.ts", import.meta.url)));
  });

  it("run callbacks over Vec, FixedArray, FixedVec and Vec arguments", async () => {
    const payer = await fundedSigner(d.svm);
    const [book] = await pda(d.programId, ["book", payer.address]);
    const B = { address: book, writable: true };
    expectOk(await send(d.svm, payer, [ix(d, "setup", {}, [{ address: payer.address, signer: payer, writable: true }, B, { address: SYSTEM_PROGRAM }])]));
    const r = expectOk(await send(d.svm, payer, [ix(d, "sweep", { limit: new BN(6) }, [{ address: payer.address, signer: payer }, B])]));
    // 1 closed, some open, every < 10, first empty at 1 (+1), total 12.
    expect(Buffer.from(r.returnData().data()).readBigUInt64LE(0)).toBe(1_000_000n + 100_000n + 10_000n + 2_000n + 12n);
    const b = decodeAccount<{ orders: { len: number; items: { open: boolean }[] } }>(d, d.svm, "Book", book);
    expect(b.orders.items.slice(0, 3).map((o) => o.open)).toEqual([true, false, false]); // the struct reference wrote through

    const scan = (who: string) =>
      send(d.svm, payer, [
        ix(d, "scan", { xs: [new BN(3), new BN(15), new BN(20)], who: pk(who as never) }, [{ address: payer.address, signer: payer }, { address: book }]),
      ]);
    const s = expectOk(await scan(payer.address));
    expect(Buffer.from(s.returnData().data()).readBigInt64LE(0)).toBe(15n * 1000n + 3n * 100n + 10n + 7n);
    const other = await fundedSigner(d.svm);
    expect(
      Buffer.from(
        expectOk(await scan(other.address))
          .returnData()
          .data(),
      ).readBigInt64LE(0),
    ).toBe(15n * 1000n + 3n * 100n + 7n);
  });
});
