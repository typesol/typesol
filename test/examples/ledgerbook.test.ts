import { lamports } from "@solana/kit";
import { generateKeyPairSigner, getAddressEncoder, type Address, type KeyPairSigner } from "@solana/kit";
import type { TransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, customError, decodeAccount, deployExample, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

type FStr = { len: number; bytes: number[] };
type Entry = { who: { toBase58(): string }; amount: BN; status: Record<string, object>; note: FStr };
type Book = {
  title: FStr;
  approver: { is_some?: boolean; isSome?: boolean; value: { toBase58(): string } };
  last_amount?: { is_some: boolean; value: BN };
  lastAmount?: { isSome: boolean; value: BN };
  entries: Entry[];
};
const text = (s: FStr) => Buffer.from(s.bytes.slice(0, s.len)).toString("utf8");
const pk = (a: Address) => ({ toBuffer: () => Buffer.from(getAddressEncoder().encode(a)) });
const ENTRY = 32 + 8 + 1 + 4 + 16;
const FIXED = 32 + (4 + 24) + 33 + 9 + 4;

describe("examples/ledgerbook.ts (enums, Option, Vec, realloc)", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployExample("ledgerbook");
  });

  async function book(title: string, approver: Address | null) {
    const admin = await fundedSigner(d.svm);
    const [addr] = await pda(d.programId, ["book", admin.address, new TextEncoder().encode(title)]);
    expectOk(
      await send(d.svm, admin, [
        ix(d, "create", { title, approver: approver ? pk(approver) : null }, [
          { address: admin.address, signer: admin, writable: true },
          { address: addr, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const file = (who: KeyPairSigner, amount: number, note: string, memo: number | null) =>
      ix(d, "file", { amount: new BN(amount), note, memo: memo === null ? null : new BN(memo) }, [
        { address: who.address, signer: who, writable: true },
        { address: addr, writable: true },
        { address: SYSTEM_PROGRAM },
      ]);
    return { admin, addr, file };
  }

  it("describes Option/Vec/enum types in the IDL", () => {
    const types = Object.fromEntries((d.idl.types ?? []).map((t) => [t.name, t.type])) as Record<
      string,
      { kind: string; fields?: { name: string; type: unknown }[]; variants?: unknown[] }
    >;
    expect(types.Status).toEqual({ kind: "enum", variants: [{ name: "Pending" }, { name: "Approved" }, { name: "Rejected" }] });
    expect(types.Book.fields!.find((f) => f.name === "entries")!.type).toEqual({ vec: { defined: { name: "Entry" } } });
    expect(types.Book.fields!.find((f) => f.name === "approver")!.type).toEqual({ defined: { name: "FixedOption_pubkey" } });
    expect(types.Filed.fields!.find((f) => f.name === "memo")!.type).toEqual({ option: "u64" });
    const create = d.idl.instructions.find((i) => i.name === "create")!;
    expect(create.args.find((a) => a.name === "approver")!.type).toEqual({ option: "pubkey" });
  });

  it("grows the account per push, tops up rent, emits Option events", async () => {
    const approver = await fundedSigner(d.svm);
    const { admin, addr, file } = await book("grants", approver.address);
    const [alice, bob] = [await fundedSigner(d.svm), await fundedSigner(d.svm)];
    const len = () => d.svm.getAccount(addr).exists && (d.svm.getAccount(addr) as { data: Uint8Array }).data.length;
    expect(len()).toBe(8 + FIXED);

    const res = expectOk(await send(d.svm, alice, [file(alice, 100, "rent", 7), file(alice, 250, "travel", null)]));
    expectOk(await send(d.svm, bob, [file(bob, 40, "food", null)]));
    expect(len()).toBe(8 + FIXED + 3 * ENTRY);
    expect(d.svm.getBalance(addr)).toBe(d.svm.minimumBalanceForRentExemption(BigInt(8 + FIXED + 3 * ENTRY)));

    const b = decodeAccount<Book>(d, d.svm, "Book", addr);
    expect(text(b.title)).toBe("grants");
    expect(b.entries.map((e) => [e.who.toBase58(), e.amount.toString(), Object.keys(e.status)[0], text(e.note)])).toEqual([
      [alice.address, "100", "Pending", "rent"],
      [alice.address, "250", "Pending", "travel"],
      [bob.address, "40", "Pending", "food"],
    ]);
    const ev = (res as TransactionMetadata)
      .logs()
      .filter((l) => l.startsWith("Program data: "))
      .map((l) => d.coder.events.decode(l.slice(14))!);
    expect(ev.map((e) => [e.data.index.toString(), e.data.memo === null ? null : e.data.memo.toString()])).toEqual([
      ["0", "7"],
      ["1", null],
    ]);
    void admin;
  });

  it("decides entries with enum state, Option approver and Vec<u64> arguments", async () => {
    const approver = await fundedSigner(d.svm);
    const { addr, file } = await book("votes", approver.address);
    const alice = await fundedSigner(d.svm);
    expectOk(await send(d.svm, alice, [file(alice, 1, "a", null), file(alice, 2, "b", null), file(alice, 3, "c", null), file(alice, 4, "d", null)]));
    const decide = (index: number, approve: boolean, who = approver) =>
      ix(d, "decide", { index: new BN(index), approve }, [
        { address: who.address, signer: who },
        { address: addr, writable: true },
      ]);
    expectOk(await send(d.svm, approver, [decide(1, false)]));
    expect(customError(await send(d.svm, approver, [decide(1, true)]))).toBe(6003);
    expect(customError(await send(d.svm, alice, [decide(0, true, alice)]))).toBe(6002);
    expect(customError(await send(d.svm, approver, [decide(9, true)]))).toBe(5104);

    const many = (idx: number[]) =>
      ix(d, "approve_many", { indices: idx.map((i) => new BN(i)) }, [
        { address: approver.address, signer: approver },
        { address: addr, writable: true },
      ]);
    expectOk(await send(d.svm, approver, [many([0, 2, 1])]));
    expect(customError(await send(d.svm, approver, [many([3, 7])]))).toBe(5104);
    const statuses = decodeAccount<Book>(d, d.svm, "Book", addr).entries.map((e) => Object.keys(e.status)[0]);
    expect(statuses).toEqual(["Approved", "Rejected", "Approved", "Pending"]);

    const total = async (status: number) => {
      const r = expectOk(await send(d.svm, alice, [ix(d, "total", { status: { [["Pending", "Approved", "Rejected"][status]]: {} } }, [{ address: addr }])]));
      return Buffer.from(r.returnData().data()).readBigUInt64LE();
    };
    expect([await total(0), await total(1), await total(2)]).toEqual([4n, 4n, 2n]);
  });

  it("handles a book without an approver, clearing the approver, and reset shrinking the account", async () => {
    const { admin, addr, file } = await book("solo", null);
    const alice = await fundedSigner(d.svm);
    expectOk(await send(d.svm, alice, [file(alice, 5, "x", null)]));
    const decide = (who: KeyPairSigner) =>
      ix(d, "decide", { index: new BN(0), approve: true }, [
        { address: who.address, signer: who },
        { address: addr, writable: true },
      ]);
    expect(customError(await send(d.svm, alice, [decide(alice)]))).toBe(6001);

    const setApprover = (a: Address | null) =>
      ix(d, "set_approver", { approver: a ? pk(a) : null }, [
        { address: admin.address, signer: admin },
        { address: addr, writable: true },
      ]);
    expectOk(await send(d.svm, admin, [setApprover(alice.address)]));
    expectOk(await send(d.svm, alice, [decide(alice)]));
    expectOk(await send(d.svm, admin, [setApprover(null)]));
    const b = decodeAccount<Book>(d, d.svm, "Book", addr) as Book & Record<string, unknown>;
    expect(JSON.stringify(b.approver)).toContain("false");

    expectOk(
      await send(d.svm, admin, [
        ix(d, "reset", {}, [
          { address: admin.address, signer: admin },
          { address: addr, writable: true },
        ]),
      ]),
    );
    expect((d.svm.getAccount(addr) as { data: Uint8Array }).data.length).toBe(8 + FIXED);
    expect(decodeAccount<Book>(d, d.svm, "Book", addr).entries).toEqual([]);
  });

  it("rejects malformed Option arguments and accounts whose size disagrees with the Vec length", async () => {
    const { addr, file } = await book("strict", null);
    const alice = await fundedSigner(d.svm);
    const good = file(alice, 1, "n", null);
    const bad = { ...good, data: Uint8Array.from([...good.data!.slice(0, good.data!.length - 1), 2]) };
    expect(customError(await send(d.svm, alice, [bad]))).toBe(102);

    expectOk(await send(d.svm, alice, [file(alice, 1, "n", null)]));
    const acct = d.svm.getAccount(addr) as { data: Uint8Array; lamports: bigint; programAddress: Address; executable: boolean };
    const forged = Uint8Array.from(acct.data);
    forged[8 + FIXED - 4] = 5; // claim 5 entries while only one is stored
    d.svm.setAccount({
      address: addr,
      data: forged,
      executable: false,
      lamports: lamports(acct.lamports),
      programAddress: acct.programAddress,
      space: BigInt(forged.length),
    });
    expect(customError(await send(d.svm, alice, [file(alice, 2, "m", null)]))).toBe(3003);
  });
});

describe("Vec edge cases (test/fixtures/stack.ts)", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/stack.ts", import.meta.url)));
  });

  it("pops values in LIFO order, shrinking the account, and refuses popping empty", async () => {
    const payer = await fundedSigner(d.svm);
    const [stack] = await pda(d.programId, ["stack", payer.address]);
    const p = { address: payer.address, signer: payer, writable: true };
    expectOk(await send(d.svm, payer, [ix(d, "make_stack", {}, [p, { address: stack, writable: true }, { address: SYSTEM_PROGRAM }])]));
    expectOk(
      await send(d.svm, payer, [
        ix(d, "push_many", { from: new BN(10), count: new BN(3) }, [p, { address: stack, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    const pop = async () => {
      const r = await send(d.svm, payer, [ix(d, "pop_one", {}, [{ address: stack, writable: true }])]);
      return "returnData" in r ? Buffer.from((r as TransactionMetadata).returnData().data()).readBigUInt64LE() : customError(r);
    };
    expect([await pop(), await pop(), await pop()]).toEqual([12n, 11n, 10n]);
    expect((d.svm.getAccount(stack) as { data: Uint8Array }).data.length).toBe(8 + 8 + 4);
    expect(await pop()).toBe(5104);
  });

  it("enforces the 10 KiB per-instruction growth limit", async () => {
    const payer = await fundedSigner(d.svm, 100n);
    const [blobs] = await pda(d.programId, ["blobs", payer.address]);
    const make = (count: number) =>
      ix(d, "make_blobs", { count: new BN(count) }, [
        { address: payer.address, signer: payer, writable: true },
        { address: blobs, writable: true },
        { address: SYSTEM_PROGRAM },
      ]);
    // 8 + 12 fixed + 11 * 1004 > 10240
    expect(customError(await send(d.svm, payer, [make(11)]))).toBe(3016);
    expectOk(await send(d.svm, payer, [make(10)]));
    expect((d.svm.getAccount(blobs) as { data: Uint8Array }).data.length).toBe(8 + 12 + 10 * 1004);
  });
});
