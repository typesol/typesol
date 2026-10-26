import type { Address, KeyPairSigner } from "@solana/kit";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, customError, decodeAccount, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "./harness.js";

type Order = { side: object; price: BN; qty: BN; tag: { len: number; bytes: number[] }; flags: boolean[]; note: { is_some: boolean; value: BN } };
const order = (price: number, qty: number, tag = "hi", note?: number): Order => ({
  side: { Ask: {} },
  price: new BN(price),
  qty: new BN(qty),
  tag: { len: Buffer.byteLength(tag), bytes: [...Buffer.from(tag.padEnd(8, "\0"))].slice(0, 8) },
  flags: [true, false],
  note: { is_some: note !== undefined, value: new BN(note ?? 0) },
});

describe("struct, array and Vec<struct> arguments (test/fixtures/structargs.ts)", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  let book: Address;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/structargs.ts", import.meta.url)));
    payer = await fundedSigner(d.svm);
    [book] = await pda(d.programId, ["book", payer.address]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "init", {}, [{ address: payer.address, signer: payer, writable: true }, { address: book, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
  });
  const state = () => decodeAccount<{ count: BN; total: BN; last: Order; ids: number[] }>(d, d.svm, "Book", book);
  const ret = (r: ReturnType<typeof expectOk>) => Buffer.from(r.returnData().data()).readBigUInt64LE();

  it("describes the arguments with the struct's fixed layout in the IDL", () => {
    const place = d.idl.instructions.find((i) => i.name === "place")!;
    expect(place.args).toEqual([{ name: "order", type: { defined: { name: "Order" } } }]);
    expect(d.idl.instructions.find((i) => i.name === "place_many")!.args[0].type).toEqual({ vec: { defined: { name: "Order" } } });
    expect(d.idl.instructions.find((i) => i.name === "set_ids")!.args[0].type).toEqual({ array: ["u8", 4] });
  });

  it("takes a struct argument and stores it", async () => {
    expectOk(await send(d.svm, payer, [ix(d, "place", { order: order(7, 3, "abc", 42) }, [{ address: book, writable: true }])]));
    const s = state();
    expect([s.count.toString(), s.total.toString(), s.last.price.toString(), s.last.tag.len, s.last.note.is_some, s.last.note.value.toString()]).toEqual([
      "1",
      "21",
      "7",
      3,
      true,
      "42",
    ]);
  });

  it("rejects malformed struct arguments: bools, enums, option tags, string lengths", async () => {
    const good = ix(d, "place", { order: order(1, 1) }, [{ address: book, writable: true }]);
    const at = (offset: number, value: number) => {
      const data = Uint8Array.from(good.data!);
      data[8 + offset] = value;
      return send(d.svm, payer, [{ ...good, data }]);
    };
    // Order layout: side u8 @0, price @1, qty @9, tag { len u32 @17, bytes[8] @21 }, flags @29, note { some @31, value @32 }
    expect(customError(await at(0, 2))).toBe(102);
    expect(customError(await at(17, 9))).toBe(102);
    expect(customError(await at(30, 2))).toBe(102);
    expect(customError(await at(31, 2))).toBe(102);
    expectOk(await at(31, 0));
    // An empty Option must carry a zero value (the fixed layout the IDL describes).
    const noneWithValue = Uint8Array.from(good.data!);
    noneWithValue[8 + 31] = 0;
    noneWithValue[8 + 32] = 5;
    expect(customError(await send(d.svm, payer, [{ ...good, data: noneWithValue }]))).toBe(102);
  });

  it("reads Vec<struct> arguments in place and validates every element", async () => {
    const before = state();
    const r = expectOk(await send(d.svm, payer, [ix(d, "place_many", { orders: [order(1, 4), order(1, 6)] }, [{ address: book, writable: true }])]));
    expect(ret(r)).toBe(2n);
    expect(state().total.sub(before.total).toString()).toBe("10");
    const bad = ix(d, "place_many", { orders: [order(1, 1), order(1, 1)] }, [{ address: book, writable: true }]);
    const data = Uint8Array.from(bad.data!);
    data[8 + 4 + 40 + 29] = 7; // second element's first flag
    expect(customError(await send(d.svm, payer, [{ ...bad, data }]))).toBe(102);
  });

  it("takes FixedArray arguments and builds struct locals", async () => {
    expect(ret(expectOk(await send(d.svm, payer, [ix(d, "set_ids", { ids: [1, 2, 3, 250] }, [{ address: book, writable: true }])])))).toBe(250n);
    expect(state().ids).toEqual([1, 2, 3, 250]);
    expect(ret(expectOk(await send(d.svm, payer, [ix(d, "local", {}, [{ address: book, writable: true }])])))).toBe(3n);
    expect(state().last.tag.len).toBe(3);
  });

  it("sends structs and Vec<struct> as CPI data", async () => {
    const before = state();
    expectOk(
      await send(d.svm, payer, [
        ix(d, "forward", { order: order(10, 10), orders: [order(1, 5)] }, [{ address: book, writable: true }, { address: d.programId }]),
      ]),
    );
    const after = state();
    expect(after.count.sub(before.count).toString()).toBe("2");
    expect(after.total.sub(before.total).toString()).toBe("105");
  });
});
