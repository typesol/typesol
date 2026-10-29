// Instructions returning a struct: the fixed layout as return data, described in the IDL so Anchor clients decode it.
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

type Quote = {
  owner: { toBase58(): string };
  price: BN;
  fee: number;
  open: boolean;
  limit: { is_some: boolean; value: BN };
  label: { len: number; bytes: number[] };
};
const plain = (q: Quote) => ({
  owner: q.owner.toBase58(),
  price: q.price.toNumber(),
  fee: q.fee,
  open: q.open,
  limit: q.limit.is_some ? q.limit.value.toNumber() : null,
  label: Buffer.from(q.label.bytes.slice(0, q.label.len)).toString(),
});

describe("instructions returning structs", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/retdata.ts", import.meta.url)));
  });

  it("describes the return type in the IDL", () => {
    const ixs = d.idl.instructions as { name: string; returns?: unknown }[];
    expect(ixs.find((i) => i.name === "preview")?.returns).toEqual({ defined: { name: "Quote" } });
    expect((d.idl.types as { name: string }[]).some((t) => t.name === "Quote")).toBe(true);
  });

  it("returns literals, stored structs and helper results, decodable with the IDL", async () => {
    const admin = await fundedSigner(d.svm);
    const [market] = await pda(d.programId, ["market", admin.address]);
    const me = { address: admin.address, signer: admin };
    expectOk(
      await send(d.svm, admin, [
        ix(d, "setup", { price: new BN(70) }, [{ ...me, writable: true }, { address: market, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    const decode = (r: Awaited<ReturnType<typeof send>>) => plain(d.coder.types.decode("Quote", Buffer.from(expectOk(r).returnData().data())) as Quote);

    expect(decode(await send(d.svm, admin, [ix(d, "preview", { price: new BN(21), limit: new BN(4) }, [me])]))).toEqual({
      owner: admin.address,
      price: 42,
      fee: 5,
      open: false,
      limit: 4,
      label: "preview",
    });
    expect(decode(await send(d.svm, admin, [ix(d, "last", {}, [{ address: market }])]))).toEqual({
      owner: admin.address,
      price: 70,
      fee: 30,
      open: true,
      limit: null,
      label: "spot",
    });
    expect(decode(await send(d.svm, admin, [ix(d, "fresh", { price: new BN(1) }, [me])])).limit).toBe(9);
  });
});
