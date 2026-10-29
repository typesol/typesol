import { getU64Encoder } from "@solana/kit";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, customError, decodeAccount, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

type Ledger = { a: BN; b: BN; small: number; mid: number; wide: number; delta: BN; stamp: BN; flag: boolean };

describe("language semantics (test/fixtures/ledger.ts)", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/ledger.ts", import.meta.url)));
  });

  async function makeLedger(id: number) {
    const payer = await fundedSigner(d.svm);
    const [ledger] = await pda(d.programId, ["ledger", payer.address, new Uint8Array(getU64Encoder().encode(BigInt(id)))]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "make", { id: new BN(id) }, [
          { address: payer.address, signer: payer, writable: true },
          { address: ledger, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    return { payer, ledger };
  }

  it("derives PDAs from integer seeds and reads the clock", async () => {
    const { ledger } = await makeLedger(7);
    const s = decodeAccount<Ledger>(d, d.svm, "Ledger", ledger);
    expect(s.a.toString()).toBe("100");
    expect(s.stamp.toString()).toBe(String(d.svm.getClock().unixTimestamp));
  });

  it("refuses the same account in two writable slots", async () => {
    const { payer, ledger } = await makeLedger(1);
    const { ledger: other } = await makeLedger(2);
    const move = (a: typeof ledger, b: typeof ledger, amount: number) =>
      ix(d, "move", { amount: new BN(amount) }, [
        { address: a, writable: true },
        { address: b, writable: true },
      ]);
    expect(customError(await send(d.svm, payer, [move(ledger, ledger, 10)]))).toBe(2040);
    expectOk(await send(d.svm, payer, [move(ledger, other, 30)]));
    expect(decodeAccount<Ledger>(d, d.svm, "Ledger", ledger).a.toString()).toBe("70");
    expect(decodeAccount<Ledger>(d, d.svm, "Ledger", other).a.toString()).toBe("130");
    // u64 underflow aborts.
    expect(customError(await send(d.svm, payer, [move(ledger, other, 71)]))).toBe(5100);
  });

  it("checks narrowing casts", async () => {
    const { payer, ledger } = await makeLedger(3);
    const narrow = (v: bigint) => ix(d, "narrow", { value: new BN(v.toString()) }, [{ address: ledger, writable: true }]);
    expectOk(await send(d.svm, payer, [narrow(255n)]));
    const s = decodeAccount<Ledger>(d, d.svm, "Ledger", ledger);
    expect([s.small, s.mid, s.wide]).toEqual([255, 255, 255]);
    expect(customError(await send(d.svm, payer, [narrow(256n)]))).toBe(4102);
  });

  it("does signed arithmetic, branches and short-circuit logic", async () => {
    const { payer, ledger } = await makeLedger(4);
    const signed = (x: number, y: number, flag: boolean) => ix(d, "signed", { x: new BN(x), y: new BN(y), flag }, [{ address: ledger, writable: true }]);
    expectOk(await send(d.svm, payer, [signed(3, 10, true)]));
    let s = decodeAccount<Ledger>(d, d.svm, "Ledger", ledger);
    expect([s.delta.toString(), s.flag]).toEqual(["7", true]);
    expectOk(await send(d.svm, payer, [signed(3, 10, false)]));
    s = decodeAccount<Ledger>(d, d.svm, "Ledger", ledger);
    expect([s.delta.toString(), s.flag]).toEqual(["-14", false]);
    // 100 + (-1000 * 2) < 0 -> require fails with the auto-registered string error.
    expect(customError(await send(d.svm, payer, [signed(0, 1000, false)]))).toBe(6000);
    expect(d.idl.errors?.[0]).toMatchObject({ code: 6000, msg: "balance would go negative" });
  });

  it("guards division by zero", async () => {
    const { payer, ledger } = await makeLedger(5);
    const divide = (by: number) => ix(d, "divide", { by: new BN(by) }, [{ address: ledger, writable: true }]);
    expectOk(await send(d.svm, payer, [divide(7)]));
    const s = decodeAccount<Ledger>(d, d.svm, "Ledger", ledger);
    expect([s.b.toString(), s.a.toString()]).toEqual(["14", "2"]);
    expect(customError(await send(d.svm, payer, [divide(0)]))).toBe(5101);
  });

  it("rejects malformed bool arguments and unknown instructions", async () => {
    const { payer, ledger } = await makeLedger(6);
    const good = ix(d, "signed", { x: new BN(1), y: new BN(0), flag: true }, [{ address: ledger, writable: true }]);
    const bad = { ...good, data: Uint8Array.from([...good.data!.slice(0, 24), 2]) };
    expect(customError(await send(d.svm, payer, [bad]))).toBe(102);
    const unknown = { ...good, data: new Uint8Array(8).fill(1) };
    expect(customError(await send(d.svm, payer, [unknown]))).toBe(101);
  });
});
