import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { generateKeyPairSigner } from "@solana/kit";
import { LiteSVM } from "litesvm";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "../src/compiler/index.js";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAX_IDL_BYTES,
  PROGRAM_METADATA_ID,
  anchorIdlAddress,
  fetchAnchorIdl,
  fetchIdl,
  fetchProgramIdl,
  metadataAddress,
  publishIdl,
} from "../src/idlpublish.js";
import { Compression, DataSource, Encoding, Format, getMetadataEncoder } from "@solana-program/program-metadata";
import { createHash } from "node:crypto";
import { deflateSync, gzipSync } from "node:zlib";
import { generateClient } from "../src/clientgen.js";
import { deployFile, fundedSigner, acct } from "./harness.js";
import { svmChain, upgradeable } from "./chain-helpers.js";

describe("on-chain IDL (Program Metadata program)", () => {
  it("writes the canonical IDL when the upgrade authority signs, and refuses anyone else", async () => {
    const out = build(
      fileURLToPath(new URL("../examples/counter.ts", import.meta.url)),
      mkdtempSync(path.join(os.tmpdir(), "typesol-idl-")),
      "11111111111111111111111111111112",
    );
    const svm = new LiteSVM();
    svm.addProgramFromFile(PROGRAM_METADATA_ID, fileURLToPath(new URL("./programs/program_metadata.so", import.meta.url)));
    const admin = await fundedSigner(svm);
    const program = (await generateKeyPairSigner()).address;
    await upgradeable(svm, program, out.soPath, admin.address);
    const chain = svmChain(svm);
    const stranger = await fundedSigner(svm);
    const refused = await publishIdl(chain, { program, idl: out.idl, payer: stranger, canonical: true }).then(
      () => "",
      (e: Error) => e.message,
    );
    // Only the upgrade authority derives the canonical address; the error names the failed transaction's reason.
    expect(refused).toMatch(/^IDL write failed: .*InvalidSeeds/s);
    const at = await publishIdl(chain, { program, idl: out.idl, payer: admin, canonical: true });
    expect(at).toBe(await metadataAddress(program, null));
    expect(await fetchIdl(chain.rpc, program)).toEqual(out.idl);
  });

  it("reads a program's IDL for a client: Program Metadata first, else Anchor's IDL account", async () => {
    const out = build(
      fileURLToPath(new URL("../examples/counter.ts", import.meta.url)),
      mkdtempSync(path.join(os.tmpdir(), "typesol-idl-")),
      "11111111111111111111111111111112",
    );
    const svm = new LiteSVM();
    svm.addProgramFromFile(PROGRAM_METADATA_ID, fileURLToPath(new URL("./programs/program_metadata.so", import.meta.url)));
    const admin = await fundedSigner(svm);
    const chain = svmChain(svm);

    // An Anchor program: its IDL in the account `anchor idl init` writes (discriminator, authority, length, zlib JSON).
    const anchorProgram = (await generateKeyPairSigner()).address;
    const json = Buffer.from(JSON.stringify(out.idl));
    const zipped = deflateSync(json);
    const data = Buffer.alloc(44 + zipped.length);
    createHash("sha256").update("account:IdlAccount").digest().subarray(0, 8).copy(data);
    data.writeUInt32LE(zipped.length, 40);
    zipped.copy(data, 44);
    const at = await anchorIdlAddress(anchorProgram);
    svm.setAccount({
      address: at,
      data: new Uint8Array(data),
      executable: false,
      lamports: 10n ** 9n,
      programAddress: anchorProgram,
      space: BigInt(data.length),
    } as never);
    const fromAnchor = await fetchProgramIdl(chain.rpc, anchorProgram);
    expect(fromAnchor.source).toBe("anchor");
    expect(fromAnchor.idl).toEqual(out.idl);
    expect(generateClient(fromAnchor.idl as never, { address: anchorProgram }).source).toContain("export const counter = {");

    // A program with published metadata: that one, even when an Anchor account exists too.
    const program = (await generateKeyPairSigner()).address;
    await upgradeable(svm, program, out.soPath, admin.address);
    await publishIdl(chain, { program, idl: out.idl, payer: admin, canonical: true });
    expect((await fetchProgramIdl(chain.rpc, program)).source).toBe("program-metadata");

    // Neither: a clear error naming both places.
    const none = (await generateKeyPairSigner()).address;
    await expect(fetchProgramIdl(chain.rpc, none)).rejects.toThrow(/no IDL on chain .* Program Metadata .* Anchor IDL account/s);
  });

  it("writes, reads back and updates a program's IDL as non-canonical metadata", async () => {
    const d = await deployFile(fileURLToPath(new URL("../examples/counter.ts", import.meta.url)));
    d.svm.addProgramFromFile(PROGRAM_METADATA_ID, fileURLToPath(new URL("./programs/program_metadata.so", import.meta.url)));
    const author = await fundedSigner(d.svm);
    const chain = svmChain(d.svm);
    const at = await publishIdl(chain, { program: d.programId, idl: d.idl, payer: author, canonical: false });
    expect(at).toBe(await metadataAddress(d.programId, author.address));
    expect(acct(d.svm, at).programAddress).toBe(PROGRAM_METADATA_ID);
    expect(await fetchIdl(chain.rpc, d.programId, author.address)).toEqual(d.idl);
    // A larger IDL goes through a buffer; writing again updates in place.
    const bigger = { ...d.idl, docs: [require("node:crypto").randomBytes(2500).toString("base64")] }; // incompressible: needs a buffer
    expect(await publishIdl(chain, { program: d.programId, idl: bigger, payer: author, canonical: false })).toBe(at);
    expect(await fetchIdl(chain.rpc, d.programId, author.address)).toEqual(bigger);
    // Someone else cannot overwrite it; their write lands at their own non-canonical address.
    const other = await fundedSigner(d.svm);
    const theirs = await publishIdl(chain, { program: d.programId, idl: { fake: true }, payer: other, canonical: false });
    expect(theirs).not.toBe(at);
    expect(await fetchIdl(chain.rpc, d.programId, author.address)).toEqual(bigger);
    void generateKeyPairSigner;
  });

  it("refuses IDLs that inflate past the cap, linked IDLs and accounts that are not Anchor's IdlAccount", async () => {
    const svm = new LiteSVM();
    const chain = svmChain(svm);
    const put = (address: string, owner: string, data: Uint8Array) =>
      svm.setAccount({ address, data, executable: false, lamports: 10n ** 9n, programAddress: owner, space: BigInt(data.length) } as never);
    const bomb = deflateSync(Buffer.alloc(MAX_IDL_BYTES + 1024 * 1024, 0x20)); // a few KiB that inflate to 17 MiB
    expect(bomb.length).toBeLessThan(64 * 1024);

    // Anchor's IDL account: the discriminator is checked, and inflation is capped.
    const anchorAccount = (discriminator: Buffer, zipped: Buffer) => {
      const data = Buffer.alloc(44 + zipped.length);
      discriminator.copy(data);
      data.writeUInt32LE(zipped.length, 40);
      zipped.copy(data, 44);
      return new Uint8Array(data);
    };
    const IDL_ACCOUNT = createHash("sha256").update("account:IdlAccount").digest().subarray(0, 8);
    const anchorProgram = (await generateKeyPairSigner()).address;
    put(await anchorIdlAddress(anchorProgram), anchorProgram, anchorAccount(IDL_ACCOUNT, bomb));
    await expect(fetchAnchorIdl(chain.rpc, anchorProgram)).rejects.toThrow(/inflates to more than 16 MiB/);
    put(await anchorIdlAddress(anchorProgram), anchorProgram, anchorAccount(Buffer.alloc(8, 7), deflateSync(Buffer.from("{}"))));
    await expect(fetchAnchorIdl(chain.rpc, anchorProgram)).rejects.toThrow(/not an IdlAccount/);
    put(await anchorIdlAddress(anchorProgram), anchorProgram, anchorAccount(IDL_ACCOUNT, deflateSync(Buffer.from('{"ok":1}'))));
    expect(await fetchAnchorIdl(chain.rpc, anchorProgram)).toEqual({ ok: 1 });

    // Program Metadata: the same cap; a linked IDL (a URL) is refused, not fetched.
    const program = (await generateKeyPairSigner()).address;
    const metadata = (dataSource: DataSource, compression: Compression, data: Uint8Array) =>
      new Uint8Array(
        getMetadataEncoder().encode({
          program,
          authority: null,
          mutable: true,
          canonical: true,
          seed: "idl",
          encoding: Encoding.Utf8,
          compression,
          format: Format.Json,
          dataSource,
          dataLength: data.length,
          data,
        }),
      );
    const at = await metadataAddress(program, null);
    put(at, PROGRAM_METADATA_ID, metadata(DataSource.Direct, Compression.Zlib, bomb));
    await expect(fetchIdl(chain.rpc, program)).rejects.toThrow(/inflates to more than 16 MiB/);
    put(at, PROGRAM_METADATA_ID, metadata(DataSource.Url, Compression.None, new TextEncoder().encode("https://example.com/idl.json")));
    await expect(fetchIdl(chain.rpc, program)).rejects.toThrow(/linked: "https:\/\/example.com\/idl.json". Fetch it yourself/);
    put(at, PROGRAM_METADATA_ID, metadata(DataSource.Direct, Compression.Gzip, new Uint8Array(gzipSync(Buffer.from('{"ok":2}')))));
    expect(await fetchIdl(chain.rpc, program)).toEqual({ ok: 2 });
  });
});
