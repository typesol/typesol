// The generated client against a real Anchor program (test/anchor-twins/programs/zerocopy, built by `pnpm build:twins`):
// a zero-copy account read and written at rustc's #[repr(C)] offsets (padding included), and generic argument types
// instantiated from the IDL. Driven through typesol/testing's LiteSVM connection.
import { LiteSVM } from "litesvm";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { type ClientIdl, generateClient } from "../../src/tools/clientgen.js";
import { svmConnection } from "../../src/tools/svmrpc.js";
import { fundedSigner } from "../harness.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SO = path.join(ROOT, "test/anchor-twins/target/deploy/anchor_zerocopy.so");
const IDL = JSON.parse(readFileSync(path.join(ROOT, "test/fixtures/anchor_zerocopy.idl.json"), "utf8")) as ClientIdl;
mkdirSync(path.join(ROOT, "target"), { recursive: true });
const OUT = mkdtempSync(path.join(ROOT, "target", "client-anchor-"));
afterAll(() => rmSync(OUT, { recursive: true, force: true }));

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

describe.skipIf(!existsSync(SO))("generated client: an Anchor program's zero-copy account and generic types", () => {
  it("reads and writes the zero-copy account at the program's offsets, and passes generic arguments", async () => {
    const { source, notes } = generateClient(IDL);
    // The generic definitions themselves have no client type; their instantiations do.
    expect(notes.filter((n) => !/type (Pair|Wrap) is generic/.test(n))).toEqual([]);
    const file = path.join(OUT, "anchor_zerocopy.client.ts");
    writeFileSync(file, source);
    const mod = (await import(pathToFileURL(file).href)) as Any;
    const c = mod.anchorZerocopy;

    const svm = new LiteSVM();
    svm.addProgramFromFile(IDL.address as never, SO);
    const { rpc, rpcSubscriptions } = svmConnection(svm);
    const alice = await fundedSigner(svm);
    await c.sendInstructions({ rpc, rpcSubscriptions }, alice, [await c.create({ owner: alice })]);
    const [board] = await c.pdas.board({ owner: alice });

    const values = { flag: 7, big: (1n << 100n) + 5n, small: 0xbeef, cells: [1, 2, 3], x: 0xaabbccdd, y: 9, last: 0xee };
    const accounts = await c.resolve.set(rpc, { board }, { signer: alice });
    await c.sendInstructions({ rpc, rpcSubscriptions }, alice, [await c.set(accounts, values)]);

    const got = await c.accounts.Board.fetch(rpc, board);
    expect(got).toEqual({
      flag: 7,
      big: values.big,
      small: 0xbeef,
      owner: alice.address,
      cells: [1, 2, 3],
      inner: { x: 0xaabbccdd, y: 9 },
      last: 0xee,
    });
    // Encoding the decoded value gives the account's bytes back exactly: same size, offsets and (zero) padding.
    const raw = svm.getAccount(board);
    expect(raw.exists && raw.data.length).toBe(8 + mod.getBoardCodec().fixedSize);
    expect([...c.accounts.Board.encode(got)]).toEqual([...(raw.exists ? raw.data : [])]);

    // Pair<u64, 2>, Wrap<Pair<u64, 2>> and Pair<u8, 3>, instantiated from the generic definitions.
    const total = await c.views.pairs(
      rpc,
      alice,
      {},
      { p: { a: 1n, items: [2n, 3n] }, w: { v: { a: 4n, items: [0n, 0n] }, n: 7 }, q: { a: 8, items: [0, 0, 9] } },
    );
    expect(total).toBe(1n + 2n + 3n + 4n + 7n + 8n + 9n);
  });
});
