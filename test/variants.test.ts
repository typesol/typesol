import { getAddressEncoder, type KeyPairSigner } from "@solana/kit";
import type { TransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, customError, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "./harness.js";

const pk = (a: string) => ({ toBuffer: () => Buffer.from(getAddressEncoder().encode(a as never)) });
const u64 = (r: TransactionMetadata) => Buffer.from(r.returnData().data()).readBigUInt64LE();
const i64 = (r: TransactionMetadata) => Buffer.from(r.returnData().data()).readBigInt64LE();

describe("data enums and Option<struct> (test/fixtures/variants.ts)", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/variants.ts", import.meta.url)));
  });

  async function queue() {
    const owner = await fundedSigner(d.svm);
    const [q] = await pda(d.programId, ["queue", owner.address]);
    expectOk(
      await send(d.svm, owner, [
        ix(d, "init", {}, [{ address: owner.address, signer: owner, writable: true }, { address: q, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    const submit = (action: object, who: KeyPairSigner = owner) =>
      ix(d, "submit", { action }, [
        { address: who.address, signer: who },
        { address: q, writable: true },
      ]);
    return { owner, q, submit };
  }
  const raw = (q: string) => Buffer.from((d.svm.getAccount(q as never) as { data: Uint8Array }).data);

  it("describes Borsh enums for arguments/events and fixed layouts for account data", () => {
    const types = Object.fromEntries((d.idl.types ?? []).map((t) => [t.name, t.type])) as Record<
      string,
      { kind: string; variants?: unknown[]; fields?: { name: string; type: unknown }[] }
    >;
    expect(types.Action.variants).toEqual([
      { name: "Deposit", fields: [{ name: "amount", type: "u64" }] },
      {
        name: "Withdraw",
        fields: [
          { name: "amount", type: "u64" },
          { name: "to", type: "pubkey" },
        ],
      },
      {
        name: "Move",
        fields: [
          { name: "x", type: "i64" },
          { name: "y", type: "i64" },
        ],
      },
      { name: "Pause" },
    ]);
    expect(types.FixedEnum_Action.fields).toEqual([
      { name: "tag", type: "u8" },
      { name: "payload", type: { array: ["u8", 40] } },
    ]);
    expect(types.Queue.fields!.find((f) => f.name === "last")!.type).toEqual({ defined: { name: "FixedEnum_Action" } });
    expect(types.Queue.fields!.find((f) => f.name === "pending")!.type).toEqual({ defined: { name: "FixedOption_s_Point" } });
    expect(d.idl.instructions.find((i) => i.name === "submit")!.args[0].type).toEqual({ defined: { name: "Action" } });
    expect(types.Applied.fields!.find((f) => f.name === "action")!.type).toEqual({ defined: { name: "Action" } });
  });

  it("switches on argument variants, stores them, and emits them as Borsh enums", async () => {
    const { owner, q, submit } = await queue();
    const r1 = expectOk(await send(d.svm, owner, [submit({ Deposit: { amount: new BN(100) } })]));
    expect(u64(r1)).toBe(100n);
    const r2 = expectOk(await send(d.svm, owner, [submit({ Withdraw: { amount: new BN(30), to: pk(owner.address) } })]));
    expect(u64(r2)).toBe(70n);
    const ev = r2
      .logs()
      .filter((l) => l.startsWith("Program data: "))
      .map((l) => d.coder.events.decode(l.slice(14))!);
    expect(ev[0].name).toBe("Applied");
    expect(Object.keys(ev[0].data.action)).toEqual(["Withdraw"]);
    expect(ev[0].data.action.Withdraw.amount.toString()).toBe("30");

    // `last` holds the Withdraw: tag 1, amount, to.
    const data = raw(q);
    const lastAt = 8 + 32;
    expect(data[lastAt]).toBe(1);
    expect(data.readBigUInt64LE(lastAt + 1)).toBe(30n);

    expect(u64(expectOk(await send(d.svm, owner, [ix(d, "last_amount", {}, [{ address: q }])])))).toBe(30n);
    expect(customError(await send(d.svm, owner, [submit({ Withdraw: { amount: new BN(1), to: pk(q) } })]))).toBe(6002); // not to yourself
    expectOk(await send(d.svm, owner, [submit({ Pause: {} })]));
    expect(u64(expectOk(await send(d.svm, owner, [ix(d, "last_amount", {}, [{ address: q }])])))).toBe(0n);
    expect(customError(await send(d.svm, owner, [submit({ Withdraw: { amount: new BN(1), to: pk(owner.address) } })]))).toBe(6001); // paused
  });

  it("sets, reads and clears Option<struct>", async () => {
    const { owner, q, submit } = await queue();
    const sum = async () => i64(expectOk(await send(d.svm, owner, [ix(d, "pending_sum", {}, [{ address: q }])])));
    expect(await sum()).toBe(-1n);
    expectOk(await send(d.svm, owner, [submit({ Move: { x: new BN(3), y: new BN(-10) } })]));
    expect(await sum()).toBe(-7n);
    expectOk(
      await send(d.svm, owner, [
        ix(d, "clear_pending", {}, [
          { address: owner.address, signer: owner },
          { address: q, writable: true },
        ]),
      ]),
    );
    expect(await sum()).toBe(-1n);
  });

  it("rewrites a variant from its own old fields, and local enum values", async () => {
    const { owner, q } = await queue();
    const reshape = () =>
      ix(d, "reshape", { label: "home" }, [
        { address: owner.address, signer: owner },
        { address: q, writable: true },
      ]);
    expect(u64(expectOk(await send(d.svm, owner, [reshape()])))).toBe(1n); // was Circle(radius 1)
    expect(u64(expectOk(await send(d.svm, owner, [reshape()])))).toBe(0n); // now Labeled: at.x += 1
    const data = raw(q);
    // Queue: owner 32, last 41, pending 17, shape (1 + 28)
    const shapeAt = 8 + 32 + 41 + 17;
    expect(data[shapeAt]).toBe(1); // Labeled
    expect(data.readBigInt64LE(shapeAt + 1)).toBe(1n); // at.x carried over (0) then +1
    expect(data.subarray(shapeAt + 1 + 16 + 4, shapeAt + 1 + 16 + 8).toString()).toBe("home");
  });

  it("rejects malformed enum arguments", async () => {
    const { owner, submit } = await queue();
    const good = submit({ Pause: {} });
    const bad = { ...good, data: Uint8Array.from([...good.data!.slice(0, 8), 9]) };
    expect(customError(await send(d.svm, owner, [bad]))).toBe(102);
  });
});
