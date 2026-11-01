// An Option argument with a default as a seed (`tag ?? 7n`): the account is the PDA of the value or the default, the
// IDL records the seed as Anchor does for `tag.unwrap_or(7)` (Marginfi's account PDAs), and the generated client
// derives it from such an IDL.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type ClientIdl, generateClient } from "../../src/tools/clientgen.js";
import { svmConnection } from "../../src/tools/svmrpc.js";
import { programHarness } from "../../src/testing.js";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_PROGRAM, customError, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

const SOURCE = `import { type Init, type Mut, type Option, type Signer, type SystemProgram, type u16 } from "typesol";

export interface Note { index: u16 }

export function make(payer: Mut<Signer>, note: Init<Note>, system_program: SystemProgram, index: u16, tag: Option<u16>): void {
  note.create(payer, ["note", payer.key, tag ?? 7n]);
  note.index = index;
}
`;

describe("Option arguments with a default, as seeds", () => {
  let d: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-optseed-"));
    writeFileSync(path.join(dir, "notes.ts"), SOURCE);
    d = await deployFile(path.join(dir, "notes.ts"));
  });

  it("derives the PDA from the value or the default, and records `tag.unwrap_or(7)` in the IDL", async () => {
    const payer = await fundedSigner(d.svm);
    const u16 = (n: number) => Uint8Array.of(n & 0xff, n >> 8);
    const make = (note: string, tag: number | null) =>
      ix(d, "make", { index: 1, tag }, [
        { address: payer.address, signer: payer, writable: true },
        { address: note as never, writable: true },
        { address: SYSTEM_PROGRAM },
      ]);
    const [withDefault] = await pda(d.programId, ["note", payer.address, u16(7)]);
    expectOk(await send(d.svm, payer, [make(withDefault, null)]));
    const [tagged] = await pda(d.programId, ["note", payer.address, u16(300)]);
    expectOk(await send(d.svm, payer, [make(tagged, 300)]));
    // The default's address with another tag: not the PDA.
    const [other] = await pda(d.programId, ["note", payer.address, u16(8)]);
    expect(customError(await send(d.svm, payer, [make(other, 9)]))).toBe(2006);
    const seeds = (d.idl.instructions[0]!.accounts[1] as { pda: { seeds: unknown[] } }).pda.seeds;
    expect(seeds[2]).toEqual({ kind: "arg", path: "tag.unwrap_or(7)" });
  });

  it("generates a client that derives such a PDA, with and without the value", async () => {
    const { source } = generateClient(d.idl as unknown as ClientIdl);
    const dir = mkdtempSync(path.join(fileURLToPath(new URL("../../target/", import.meta.url)), "optseed-"));
    const file = path.join(dir, "notes.client.ts");
    writeFileSync(file, source);
    const c = ((await import(pathToFileURL(file).href)) as Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>>).notes!;
    const { rpc, rpcSubscriptions } = svmConnection(d.svm);
    const payer = await fundedSigner(d.svm);
    for (const tag of [null, 41]) {
      await c.sendInstructions!({ rpc, rpcSubscriptions }, payer, [await c.make!({ payer }, { index: 2, tag })]);
      const [note] = await pda(d.programId, ["note", payer.address, Uint8Array.of(tag ?? 7, 0)]);
      expect(d.svm.getAccount(note).exists, `tag ${tag}`).toBe(true);
    }
  });

  it("lets typesol/testing derive it too", async () => {
    const t = programHarness(d.svm, d.programId, d.idl as never);
    const payer = await t.wallet();
    for (const tag of [null, 512]) {
      t.ok(await t.send(payer, t.ix("make", { index: 3n, tag: tag === null ? null : BigInt(tag) }, { payer })));
      const [note] = await pda(d.programId, ["note", payer.address, Uint8Array.of((tag ?? 7) & 0xff, (tag ?? 7) >> 8)]);
      expect(d.svm.getAccount(note).exists, `tag ${tag}`).toBe(true);
    }
  });

  it("generates a client from Marginfi's on-chain IDL, its account PDAs included", () => {
    const idl = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../showcase/test/fixtures/marginfi/marginfi.idl.json", import.meta.url)), "utf8"),
    ) as ClientIdl;
    const { source, notes } = generateClient(idl);
    expect(notes.filter((n) => /marginfi_account is not filled in/.test(n))).toEqual([]);
    expect(source).toContain("getU16Codec().encode(args.thirdPartyId ?? 0)");
  });
});
