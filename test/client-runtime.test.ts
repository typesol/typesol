// The generated client's runtime helpers against a real program: sendInstructions, simulate and views, fetchAll /
// fetchMultiple, account and event subscriptions, emitCpi events and remaining accounts. LiteSVM runs the program
// behind a small stand-in for the kit RPC and subscription objects (only the methods the helpers call).
import {
  type Address,
  generateKeyPairSigner,
  getAddressDecoder,
  getBase58Decoder,
  getBase58Encoder,
  getBase64Decoder,
  getBase64Encoder,
  getTransactionDecoder,
} from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from "litesvm";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeClient } from "../src/clientgen.js";
import { build } from "../src/compiler/index.js";
import { fundedSigner } from "./harness.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
mkdirSync(path.join(ROOT, "target"), { recursive: true });
const OUT = mkdtempSync(path.join(ROOT, "target", "client-runtime-"));
afterAll(() => rmSync(OUT, { recursive: true, force: true }));

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const b64 = (bytes: Uint8Array) => getBase64Decoder().decode(bytes);
const wireTx = (wire: string) => getTransactionDecoder().decode(getBase64Encoder().encode(wire));
const reply = <T>(value: T) => ({ send: async () => value });

/** A kit-like RPC and subscriptions object answered by LiteSVM; `known` lists the addresses getProgramAccounts scans. */
function chain(svm: LiteSVM, known: Address[]) {
  const results: { signature: string; meta: TransactionMetadata }[] = [];
  const encoded = (a: Address) => {
    const acct = svm.getAccount(a);
    if (!acct.exists) return null;
    return {
      data: [b64(acct.data), "base64"],
      executable: false,
      lamports: acct.lamports,
      owner: acct.programAddress,
      space: BigInt(acct.data.length),
      rentEpoch: 0n,
    };
  };
  const rpc = {
    getLatestBlockhash: () => reply({ value: { blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1_000_000n } }),
    getEpochInfo: () => reply({ absoluteSlot: 0n, blockHeight: 0n, epoch: 0n, slotIndex: 0n, slotsInEpoch: 432_000n, transactionCount: null }),
    getSignatureStatuses: (sigs: string[]) =>
      reply({ value: sigs.map(() => ({ confirmationStatus: "confirmed", confirmations: null, err: null, slot: 0n, status: { Ok: null } })) }),
    sendTransaction: (wire: string) => ({
      send: async () => {
        const res = svm.sendTransaction(wireTx(wire) as never);
        svm.expireBlockhash();
        if (res instanceof FailedTransactionMetadata) throw new Error(`failed: ${String(res.err())}\n${res.meta().logs().join("\n")}`);
        const signature = getBase58Decoder().decode(res.signature());
        results.push({ signature, meta: res });
        return signature;
      },
    }),
    simulateTransaction: (wire: string) => ({
      send: async () => {
        const res = svm.simulateTransaction(wireTx(wire) as never);
        if (res instanceof FailedTransactionMetadata)
          return { value: { err: String(res.err()), logs: res.meta().logs(), unitsConsumed: res.meta().computeUnitsConsumed(), returnData: null } };
        const meta = res.meta();
        const ret = meta.returnData();
        return {
          value: {
            err: null,
            logs: meta.logs(),
            unitsConsumed: meta.computeUnitsConsumed(),
            returnData: ret.data().length ? { programId: getAddressDecoder().decode(ret.programId()), data: [b64(ret.data()), "base64"] } : null,
          },
        };
      },
    }),
    getMultipleAccounts: (addresses: Address[]) => reply({ context: { slot: 0n }, value: addresses.map(encoded) }),
    getAccountInfo: (a: Address) => reply({ context: { slot: 0n }, value: encoded(a) }),
    getProgramAccounts: (program: Address, config: { filters: { memcmp: { offset: bigint; bytes: string } }[] }) =>
      reply(
        known
          .map((a) => ({ pubkey: a, account: encoded(a) }))
          .filter(({ account }) => account && account.owner === program)
          .filter(({ account }) => {
            const data = getBase64Encoder().encode(account!.data[0] as string);
            return config.filters.every(({ memcmp }) => {
              const want = getBase58Encoder().encode(memcmp.bytes);
              return want.every((b, i) => data[Number(memcmp.offset) + i] === b);
            });
          }),
      ),
  };
  /** Notifications that end when the subscriber aborts. */
  const stream = <T>(items: () => T[]) => ({
    subscribe: async ({ abortSignal }: { abortSignal: AbortSignal }) =>
      (async function* () {
        for (const item of items()) yield item;
        await new Promise((resolve) => abortSignal.addEventListener("abort", resolve, { once: true }));
      })(),
  });
  const rpcSubscriptions = {
    signatureNotifications: () => stream(() => [{ context: { slot: 0n }, value: { err: null } }]),
    slotNotifications: () => stream(() => []),
    logsNotifications: () => stream(() => results.map((r) => ({ context: { slot: 0n }, value: { signature: r.signature, logs: r.meta.logs(), err: null } }))),
    accountNotifications: (a: Address) => stream(() => [{ context: { slot: 0n }, value: encoded(a) ?? { data: ["", "base64"], lamports: 0n } }]),
  };
  return { rpc: rpc as Any, rpcSubscriptions: rpcSubscriptions as Any, results };
}

async function take<T>(gen: AsyncGenerator<T>, n: number, abort: AbortController): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) {
    out.push(v);
    if (out.length === n) break;
  }
  abort.abort();
  return out;
}

describe("generated client: runtime helpers", () => {
  let svm: LiteSVM;
  let c: Any;
  let programId: Address;
  beforeAll(async () => {
    programId = (await generateKeyPairSigner()).address;
    const res = build(path.join(ROOT, "test/fixtures/sdk.ts"), path.join(OUT, "sdk"), programId);
    const file = writeClient(res.idl, path.join(OUT, "sdk", `${res.model.name}.client.ts`)).path;
    svm = new LiteSVM().withSigverify(false);
    svm.addProgramFromFile(programId, res.soPath);
    c = ((await import(pathToFileURL(file).href)) as Record<string, unknown>).sdk;
  });

  it("sends, lists, fetches, views and watches accounts", async () => {
    const alice = await fundedSigner(svm);
    const bob = await fundedSigner(svm);
    const [aliceTally] = await c.pdas.tally({ owner: alice });
    const [bobTally] = await c.pdas.tally({ owner: bob });
    // An account of the program that is not a Tally: fetchAll's discriminator filter leaves it out.
    const other = (await generateKeyPairSigner()).address;
    svm.setAccount({ address: other, data: new Uint8Array(48), executable: false, lamports: 10n ** 9n, programAddress: programId, space: 48n } as never);
    const { rpc, rpcSubscriptions } = chain(svm, [aliceTally, bobTally, other]);
    const connection = { rpc, rpcSubscriptions };

    const sig = await c.sendInstructions(connection, alice, [await c.open({ owner: alice }), await c.add({ owner: alice, tally: aliceTally }, { by: 5n })]);
    expect(typeof sig).toBe("string");
    await c.sendInstructions(connection, bob, [await c.open({ owner: bob }), await c.add({ owner: bob, tally: bobTally }, { by: 2n })]);

    const all = await c.accounts.Tally.fetchAll(rpc);
    expect(all.map((t: Any) => [t.address, t.data.count]).sort()).toEqual(
      [
        [aliceTally, 5n],
        [bobTally, 2n],
      ].sort(),
    );
    // Filtered by the owner field (after the 8-byte discriminator).
    const mine = await c.accounts.Tally.fetchAll(rpc, [{ offset: 8, bytes: getBase58Encoder().encode(alice.address) }]);
    expect(mine.map((t: Any) => t.address)).toEqual([aliceTally]);
    const many = await c.accounts.Tally.fetchMultiple(rpc, [bobTally, (await generateKeyPairSigner()).address, aliceTally]);
    expect(many.map((t: Any) => t && t.count)).toEqual([2n, null, 5n]);

    // A view: the return value by simulation; nothing changes.
    expect(await c.views.total(rpc, alice, { tally: aliceTally })).toBe(5n);
    const sim = await c.simulate(rpc, alice.address, [await c.add({ owner: alice, tally: aliceTally }, { by: 1n })]);
    expect(sim.err).toBeNull();
    expect(c.parseEvents(sim.logs)).toEqual([{ name: "Added", data: { by: 1n, count: 6n } }]);
    expect((await c.accounts.Tally.fetch(rpc, aliceTally)).count).toBe(5n);

    const abort = new AbortController();
    const seen = await take(c.accounts.Tally.watch(rpcSubscriptions, aliceTally, { abortSignal: abort.signal }), 1, abort);
    expect(seen).toEqual([{ owner: alice.address, count: 5n }]);
  });

  it("passes remaining accounts, and finds log and CPI events in a transaction", async () => {
    const alice = await fundedSigner(svm);
    const [tally] = await c.pdas.tally({ owner: alice });
    const { rpc, rpcSubscriptions, results } = chain(svm, [tally]);
    const extra = [(await generateKeyPairSigner()).address, (await generateKeyPairSigner()).address].map((address) => ({ address, role: 0 }));
    expect(await c.views.countRest(rpc, alice, {})).toBe(0n);
    const ix = await c.countRest({}, extra);
    expect(ix.accounts.length).toBe(2);
    expect((await c.simulate(rpc, alice, [ix])).returnData).toEqual(new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0]));

    await c.sendInstructions({ rpc, rpcSubscriptions }, alice, [
      await c.open({ owner: alice }),
      await c.add({ owner: alice, tally }, { by: 3n }),
      await c.addCpi({ owner: alice, tally }, { by: 4n }),
    ]);
    const meta = results.at(-1)!.meta;
    // The shape getTransaction returns (json encoding): logs, and inner instruction data in base58.
    const tx = {
      meta: {
        logMessages: meta.logs(),
        innerInstructions: meta
          .innerInstructions()
          .map((group, index) => ({ index, instructions: group.map((i) => ({ data: getBase58Decoder().decode(i.instruction().data()) })) })),
      },
    };
    expect(c.eventsOf(tx)).toEqual([
      { name: "Added", data: { by: 3n, count: 3n } },
      { name: "Added", data: { by: 4n, count: 7n } },
    ]);
    expect(
      c.parseCpiEvents(
        meta
          .innerInstructions()
          .flat()
          .map((i) => i.instruction().data()),
      ),
    ).toEqual([{ name: "Added", data: { by: 4n, count: 7n } }]);

    const abort = new AbortController();
    const events = await take(c.watchEvents(rpcSubscriptions, { abortSignal: abort.signal }), 1, abort);
    expect(events).toEqual([{ signature: results.at(-1)!.signature, event: { name: "Added", data: { by: 3n, count: 3n } } }]);
  });

  it("fills in has_one accounts from the chain (resolve)", async () => {
    const alice = await fundedSigner(svm);
    const [tally] = await c.pdas.tally({ owner: alice });
    const { rpc, rpcSubscriptions } = chain(svm, [tally]);
    await c.sendInstructions({ rpc, rpcSubscriptions }, alice, [await c.open({ owner: alice })]);
    const accounts = await c.resolve.poke(rpc, { tally });
    expect(accounts).toEqual({ tally, owner: alice.address });
    await c.sendInstructions({ rpc, rpcSubscriptions }, alice, [await c.poke(accounts)]);
    expect((await c.accounts.Tally.fetch(rpc, tally)).count).toBe(1n);
    // Given accounts are kept; an account that does not exist is a clear error.
    const other = (await generateKeyPairSigner()).address;
    expect(await c.resolve.poke(rpc, { tally, owner: other })).toEqual({ tally, owner: other });
    await expect(c.resolve.poke(rpc, { tally: other })).rejects.toThrow(/cannot fill in owner: account .* does not exist/);
    // A signer named by has_one is never filled in: it has to sign.
    expect(c.resolve.add).toBeUndefined();
  });

  it("names every Anchor error code a program can raise", async () => {
    expect(c.errors[2502]?.name).toBe("RequireKeysEqViolated");
    expect(c.errors[2032]?.name).toBe("ConstraintMintMetadataPointerExtensionMetadataAddress");
    expect(c.errors[5110]?.name).toBe("HeapExhausted");
  });
});
