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
import { PROGRAM_METADATA_ID, fetchIdl, metadataAddress, publishIdl } from "../src/idlpublish.js";
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
});
