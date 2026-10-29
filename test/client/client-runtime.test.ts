// The generated client's runtime helpers against a real program: sendInstructions, simulate and views, fetchAll /
// fetchMultiple, account and event subscriptions, emitCpi events and remaining accounts. LiteSVM runs the program
// behind a small stand-in for the kit RPC and subscription objects (only the methods the helpers call).
import {
  type Address,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
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
import { writeClient } from "../../src/tools/clientgen.js";
import { build } from "../../src/compiler/index.js";
import { svmConnection } from "../../src/tools/svmrpc.js";
import { fundedSigner } from "../harness.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
mkdirSync(path.join(ROOT, "target"), { recursive: true });
const OUT = mkdtempSync(path.join(ROOT, "target", "client-runtime-"));
afterAll(() => rmSync(OUT, { recursive: true, force: true }));

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/** typesol/testing's LiteSVM connection; `known` are extra accounts for getProgramAccounts to scan. */
function chain(svm: LiteSVM, known: Address[]) {
  const conn = svmConnection(svm);
  conn.track(...known);
  return { rpc: conn.rpc as Any, rpcSubscriptions: conn.rpcSubscriptions as Any, results: conn.transactions };
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

    // watch yields the account after a transaction changes it (no snapshot of it as it is).
    const abort = new AbortController();
    const watching = c.accounts.Tally.watch(rpcSubscriptions, aliceTally, { abortSignal: abort.signal });
    const next = watching.next();
    expect(await Promise.race([next.then(() => "yielded"), new Promise((r) => setTimeout(() => r("waiting"), 50))])).toBe("waiting");
    await c.sendInstructions(connection, alice, [await c.add({ owner: alice, tally: aliceTally }, { by: 1n })]);
    expect((await next).value).toEqual({ owner: alice.address, count: 6n });
    abort.abort();
    expect((await watching.next()).done).toBe(true);
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
    // The shape getTransaction returns (json encoding): account keys, logs, and inner instructions (program index,
    // base58 data).
    const tx = await rpc.getTransaction(results.at(-1)!.signature).send();
    expect(tx.meta.innerInstructions.flatMap((g: Any) => g.instructions.map((i: Any) => i.data))).toEqual(
      meta
        .innerInstructions()
        .flat()
        .map((i) => getBase58Decoder().decode(i.instruction().data())),
    );
    const three = { name: "Added", data: { by: 3n, count: 3n } };
    const four = { name: "Added", data: { by: 4n, count: 7n } };
    expect(c.eventsOf(tx)).toEqual([three, four]);
    // Without the account keys an inner instruction cannot be tied to a program: log events only.
    expect(c.eventsOf({ meta: tx.meta })).toEqual([three]);
    // Event data in an inner instruction of another program is not this program's event.
    const keys: string[] = tx.transaction.message.accountKeys;
    const elsewhere = {
      ...tx,
      meta: {
        ...tx.meta,
        innerInstructions: tx.meta.innerInstructions.map((g: Any) => ({
          ...g,
          instructions: g.instructions.map((i: Any) => ({ ...i, programIdIndex: keys.indexOf(alice.address) })),
        })),
      },
    };
    expect(c.eventsOf(elsewhere)).toEqual([three]);
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
    // With an RPC, emitCpi events too: the transaction is fetched and its inner instructions read.
    const abort2 = new AbortController();
    const all = await take(c.watchEvents(rpcSubscriptions, { abortSignal: abort2.signal, rpc }), 2, abort2);
    expect(all.map((e: Any) => e.event.data.by)).toEqual([3n, 4n]);
  });

  it("reads only the log lines this program wrote, following invokes", async () => {
    const alice = await fundedSigner(svm);
    const [tally] = await c.pdas.tally({ owner: alice });
    const { rpc, rpcSubscriptions, results } = chain(svm, [tally]);
    await c.sendInstructions({ rpc, rpcSubscriptions }, alice, [await c.open({ owner: alice }), await c.add({ owner: alice, tally }, { by: 3n })]);
    const logs = results.at(-1)!.meta.logs();
    const line = logs.find((l) => l.startsWith("Program data: "))!;
    const event = { name: "Added", data: { by: 3n, count: 3n } };
    expect(c.parseEvents(logs)).toEqual([event]);
    const other = (await generateKeyPairSigner()).address;
    // Another program writing a line that decodes as this program's event: ignored, as is a line outside any invoke.
    expect(c.parseEvents([`Program ${other} invoke [1]`, line, `Program ${other} success`])).toEqual([]);
    expect(c.parseEvents([line])).toEqual([]);
    // Nested invokes: only lines while this program is the innermost one running (a `msg!` copy is a log line).
    expect(
      c.parseEvents([
        `Program ${programId} invoke [1]`,
        `Program log: ${line}`,
        `Program ${other} invoke [2]`,
        line,
        `Program ${other} failed: custom program error: 0x1`,
        line,
        `Program ${programId} invoke [2]`,
        line,
        `Program ${programId} consumed 100 of 200000 compute units`,
        `Program ${programId} success`,
        `Program ${programId} success`,
        line,
      ]),
    ).toEqual([event, event]);
  });

  it("skips failed transactions in watchEvents, and reports errors in the RPC's JSON shape", async () => {
    const alice = await fundedSigner(svm);
    const [tally] = await c.pdas.tally({ owner: alice });
    const { rpc, rpcSubscriptions } = chain(svm, [tally]);
    const connection = { rpc, rpcSubscriptions };
    await c.sendInstructions(connection, alice, [await c.open({ owner: alice }), await c.add({ owner: alice, tally }, { by: 1n })]);
    // Emits Added { by: 2 }, then overflows: the transaction fails, so its event did not happen.
    const overflow = await c.add({ owner: alice, tally }, { by: 2n ** 64n - 1n });
    await expect(c.sendInstructions(connection, alice, [await c.add({ owner: alice, tally }, { by: 2n }), overflow])).rejects.toThrow(/5100/);
    await c.sendInstructions(connection, alice, [await c.add({ owner: alice, tally }, { by: 5n })]);

    const abort = new AbortController();
    const notes = await take(await rpcSubscriptions.logsNotifications({ mentions: [programId] }).subscribe({ abortSignal: abort.signal }), 3, abort);
    expect(notes.map((n: Any) => n.value.err)).toEqual([null, { InstructionError: [1, { Custom: 5100 }] }, null]);
    const abort2 = new AbortController();
    const events = await take(c.watchEvents(rpcSubscriptions, { abortSignal: abort2.signal }), 2, abort2);
    expect(events.map((e: Any) => e.event.data.by)).toEqual([1n, 5n]);
    // `mentions` filters: a fresh address no transaction named gets nothing; alice's own transactions are there.
    const abort3 = new AbortController();
    const mine = await take(await rpcSubscriptions.logsNotifications({ mentions: [alice.address] }).subscribe({ abortSignal: abort3.signal }), 3, abort3);
    expect(mine.length).toBe(3);
    const abort4 = new AbortController();
    const nobody = (
      await rpcSubscriptions.logsNotifications({ mentions: [(await generateKeyPairSigner()).address] }).subscribe({ abortSignal: abort4.signal })
    )[Symbol.asyncIterator]();
    const first = nobody.next();
    expect(await Promise.race([first.then(() => "yielded"), new Promise((r) => setTimeout(() => r("waiting"), 50))])).toBe("waiting");
    abort4.abort();
    expect((await first).done).toBe(true);

    // A simulation's error: { InstructionError: [index, { Custom: code }] }, which errorCode and isError read.
    const sim = await c.simulate(rpc, alice, [overflow]);
    expect(sim.err).toEqual({ InstructionError: [0, { Custom: 5100 }] });
    expect(c.isError(sim.err, "ArithmeticOverflow")).toBe(true);
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
    // A signer named by has_one is not read from the chain: it is the default signer passed in, or given.
    expect(await c.resolve.add(rpc, { tally }, { signer: alice })).toEqual({ tally, owner: alice });
    expect(await c.resolve.add(rpc, { tally, owner: other })).toEqual({ tally, owner: other });
  });

  it("fills signers with the default signer, and derives a PDA seeded from its own fields from their values", async () => {
    const alice = await fundedSigner(svm);
    const { rpc, rpcSubscriptions } = chain(svm, []);
    const accounts = await c.resolve.openSlot(rpc, {}, { signer: alice });
    expect(accounts).toEqual({ owner: alice });
    await c.sendInstructions({ rpc, rpcSubscriptions }, alice, [await c.openSlot(accounts, { id: 42n })]);
    const [slot] = await c.pdas.slotIdSlot({ owner: alice.address, id: 42n });
    expect((await c.accounts.Slot.fetch(rpc, slot)).id).toBe(42n);
    // The program agrees: its Seeds<…> check on the slot's own fields passes.
    expect(await c.views.slotId(rpc, alice, { slot })).toBe(42n);
  });

  it("derives a PDA seeded from another account's fields (resolve)", async () => {
    const alice = await fundedSigner(svm);
    const [tally] = await c.pdas.tally({ owner: alice });
    const { rpc, rpcSubscriptions } = chain(svm, [tally]);
    await c.sendInstructions({ rpc, rpcSubscriptions }, alice, [await c.open({ owner: alice }), await c.add({ owner: alice, tally }, { by: 9n })]);
    const accounts = await c.resolve.stash(rpc, { tally });
    const count = new Uint8Array(8);
    count[0] = 9;
    const [expected] = await getProgramDerivedAddress({
      programAddress: programId,
      seeds: [new TextEncoder().encode("stash"), getAddressEncoder().encode(alice.address), count],
    });
    expect(accounts).toEqual({ tally, stash: expected });
    // The program agrees: its Seeds<…> check passes with the resolved address.
    expect(await c.views.stash(rpc, alice, accounts)).toBe(9n);
  });

  it("names every Anchor error code a program can raise", async () => {
    expect(c.errors[2502]?.name).toBe("RequireKeysEqViolated");
    expect(c.errors[2032]?.name).toBe("ConstraintMintMetadataPointerExtensionMetadataAddress");
    expect(c.errors[5110]?.name).toBe("HeapExhausted");
  });
});
