import { getCreateAccountInstruction } from "@solana-program/system";
import { type Address, type KeyPairSigner, generateKeyPairSigner, lamports } from "@solana/kit";
import { FailedTransactionMetadata, type TransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, customError, decodeAccount, deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "../harness.js";

const BOOK_SIZE = 8 + 28_720;
const BID = { Bid: {} };
const ASK = { Ask: {} };

describe("examples/orderbook (multi-file program, 28 KiB Zeroed account)", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../../examples/orderbook/orderbook.ts", import.meta.url)));
  });

  /** The client allocates the big account (System CreateAccount allows up to 10 MiB), then init() claims it. */
  async function allocate(admin: KeyPairSigner, opts: { space?: number; owner?: Address; lamportsDelta?: bigint } = {}) {
    const book = await generateKeyPairSigner();
    const space = opts.space ?? BOOK_SIZE;
    const rent = d.svm.minimumBalanceForRentExemption(BigInt(space)) + (opts.lamportsDelta ?? 0n);
    expectOk(
      await send(d.svm, admin, [
        getCreateAccountInstruction({ payer: admin, newAccount: book, lamports: lamports(rent), space, programAddress: opts.owner ?? d.programId }),
      ]),
    );
    return book.address;
  }
  const init = (admin: KeyPairSigner, book: Address) =>
    ix(d, "init", {}, [
      { address: admin.address, signer: admin },
      { address: book, writable: true },
    ]);

  it("initializes a client-allocated 28 KiB account exactly once", async () => {
    const admin = await fundedSigner(d.svm, 10n);
    const book = await allocate(admin);
    expectOk(await send(d.svm, admin, [init(admin, book)]));
    expect((d.svm.getAccount(book) as { data: Uint8Array }).data.length).toBe(BOOK_SIZE);
    expect(customError(await send(d.svm, admin, [init(admin, book)]))).toBe(2013); // Anchor's ConstraintZero
  });

  it("refuses accounts that are not ours, too small, or not rent-exempt", async () => {
    const admin = await fundedSigner(d.svm, 10n);
    expect(customError(await send(d.svm, admin, [init(admin, await allocate(admin, { owner: "11111111111111111111111111111111" as Address }))]))).toBe(3007);
    expect(customError(await send(d.svm, admin, [init(admin, await allocate(admin, { space: BOOK_SIZE - 1 }))]))).toBe(3003);
    // Larger than needed is fine (zero-copy reads the prefix).
    const big = await allocate(admin, { space: BOOK_SIZE + 4096 });
    expectOk(await send(d.svm, admin, [init(admin, big)]));
    // The runtime refuses to create non-rent-exempt accounts, so plant one directly to exercise the check.
    const poor = (await generateKeyPairSigner()).address;
    d.svm.setAccount({
      address: poor,
      data: new Uint8Array(BOOK_SIZE),
      executable: false,
      lamports: lamports(1_000_000n),
      programAddress: d.programId,
      space: BigInt(BOOK_SIZE),
    });
    expect(customError(await send(d.svm, admin, [init(admin, poor)]))).toBe(2005);
  });

  it("matches crossing orders best-price-first across a 256-slot book, emits fills, cancels", async () => {
    const admin = await fundedSigner(d.svm, 10n);
    const book = await allocate(admin);
    expectOk(await send(d.svm, admin, [init(admin, book)]));
    const [alice, bob] = [await fundedSigner(d.svm), await fundedSigner(d.svm)];
    const place = (who: KeyPairSigner, side: object, price: number, qty: number) =>
      ix(d, "place", { side, price: new BN(price), qty: new BN(qty) }, [
        { address: who.address, signer: who },
        { address: book, writable: true },
      ]);
    const best = async (side: object) => {
      const r = expectOk(await send(d.svm, admin, [ix(d, "best", { side }, [{ address: book }])]));
      return Buffer.from(r.returnData().data()).readBigUInt64LE();
    };
    const id = (r: TransactionMetadata | FailedTransactionMetadata) => Buffer.from(expectOk(r).returnData().data()).readBigUInt64LE();

    expect(id(await send(d.svm, alice, [place(alice, ASK, 105, 10)]))).toBe(1n);
    expect(id(await send(d.svm, alice, [place(alice, ASK, 101, 5)]))).toBe(2n);
    expect(id(await send(d.svm, alice, [place(alice, ASK, 103, 5)]))).toBe(3n);
    expect([await best(ASK), await best(BID)]).toEqual([101n, 0n]);

    // Bob buys 8 up to 104: takes 5 @101 then 3 @103; nothing rests.
    const res = expectOk(await send(d.svm, bob, [place(bob, BID, 104, 8)]));
    const fills = res
      .logs()
      .filter((l) => l.startsWith("Program data: "))
      .map((l) => d.coder.events.decode(l.slice(14))!.data);
    expect(fills.map((f) => [f.maker.toString(), f.price.toString(), f.qty.toString()])).toEqual([
      ["2", "101", "5"],
      ["3", "103", "3"],
    ]);
    expect([await best(ASK), await best(BID)]).toEqual([103n, 0n]);

    // Bob bids 102 for 4: no cross, rests.
    expectOk(await send(d.svm, bob, [place(bob, BID, 102, 4)]));
    expect(await best(BID)).toBe(102n);
    const state = decodeAccount<{ fills: BN; next_id?: BN; nextId?: BN }>(d, d.svm, "Book", book);
    expect(state.fills.toString()).toBe("2");

    const cancel = (who: KeyPairSigner, side: object, oid: number) =>
      ix(d, "cancel", { side, id: new BN(oid) }, [
        { address: who.address, signer: who },
        { address: book, writable: true },
      ]);
    expect(customError(await send(d.svm, alice, [cancel(alice, BID, 5)]))).toBe(6003); // not alice's
    expectOk(await send(d.svm, bob, [cancel(bob, BID, 5)]));
    expect(await best(BID)).toBe(0n);
    expect(customError(await send(d.svm, alice, [place(alice, ASK, 0, 1)]))).toBe(6001);
  });

  it("fills a whole side and reports the book full", async () => {
    const admin = await fundedSigner(d.svm, 10n);
    const book = await allocate(admin);
    expectOk(await send(d.svm, admin, [init(admin, book)]));
    const trader = await fundedSigner(d.svm, 10n);
    for (let i = 0; i < 256; i += 8) {
      const batch = Array.from({ length: 8 }, (_, k) =>
        ix(d, "place", { side: ASK, price: new BN(1000 + i + k), qty: new BN(1) }, [
          { address: trader.address, signer: trader },
          { address: book, writable: true },
        ]),
      );
      expectOk(await send(d.svm, trader, batch));
    }
    const res = await send(d.svm, trader, [
      ix(d, "place", { side: ASK, price: new BN(5000), qty: new BN(1) }, [
        { address: trader.address, signer: trader },
        { address: book, writable: true },
      ]),
    ]);
    expect(customError(res)).toBe(6002);
    // A bid that crosses the 4 cheapest asks consumes exactly MAX_MATCHES orders and stays within the compute budget.
    const take = expectOk(
      await send(d.svm, trader, [
        ix(d, "place", { side: BID, price: new BN(1003), qty: new BN(10) }, [
          { address: trader.address, signer: trader },
          { address: book, writable: true },
        ]),
      ]),
    );
    expect(take.computeUnitsConsumed()).toBeLessThan(200_000n);
    if (process.env.FUZZ_VERBOSE) console.log("full-book match CU", take.computeUnitsConsumed());
  });
});
