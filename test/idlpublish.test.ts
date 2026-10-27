import { lamports } from "@solana/kit";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import {
  type Address,
  type Blockhash,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64Encoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
} from "@solana/kit";
import { LiteSVM } from "litesvm";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "../src/compiler/index.js";
import { FailedTransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type Chain, PROGRAM_METADATA_ID, fetchIdl, metadataAddress, publishIdl } from "../src/idlpublish.js";
import { deployFile, fundedSigner, acct } from "./harness.js";

/** A Chain over LiteSVM: RPC-shaped account reads, sends through the VM. */
function svmChain(svm: LiteSVM): Chain {
  const info = (a: Address) => {
    const acct = svm.getAccount(a);
    if (!acct?.exists) return null;
    return {
      data: [Buffer.from(acct.data).toString("base64"), "base64"],
      executable: acct.executable,
      lamports: acct.lamports,
      owner: acct.programAddress,
      space: BigInt(acct.data.length),
      rentEpoch: 0n,
    };
  };
  return {
    rpc: {
      getAccountInfo: (a: Address) => ({ send: async () => ({ context: { slot: 0n }, value: info(a) }) }),
      getMultipleAccounts: (as: Address[]) => ({ send: async () => ({ context: { slot: 0n }, value: as.map(info) }) }),
    } as never,
    minimumBalance: async (space) => svm.minimumBalanceForRentExemption(BigInt(space)),
    latestBlockhash: async () => ({ blockhash: svm.latestBlockhash() as Blockhash, lastValidBlockHeight: 1_000_000n }),
    sendAndConfirm: async (wire) => {
      const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
      // Writes of one plan run concurrently on the same blockhash: do not expire it between them.
      const res = svm.sendTransaction(tx as never);
      if (res instanceof FailedTransactionMetadata) throw new Error(`${String(res.err())}\n${res.meta().logs().join("\n")}`);
    },
  };
}

/** Install `so` as an upgradeable (loader v3) program whose upgrade authority is `authority`. */
async function upgradeable(svm: LiteSVM, program: Address, so: string, authority: Address) {
  const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111" as Address;
  const enc = getAddressEncoder();
  const [programData] = await getProgramDerivedAddress({ programAddress: LOADER, seeds: [enc.encode(program)] });
  const elf = readFileSync(so);
  const pd = Buffer.alloc(45 + elf.length);
  pd.writeUInt32LE(3, 0);
  pd[12] = 1;
  Buffer.from(enc.encode(authority)).copy(pd, 13);
  elf.copy(pd, 45);
  const prog = Buffer.alloc(36);
  prog.writeUInt32LE(2, 0);
  Buffer.from(enc.encode(programData)).copy(prog, 4);
  svm.setAccount({
    address: programData,
    data: new Uint8Array(pd),
    executable: false,
    lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(pd.length))),
    programAddress: LOADER,
    space: BigInt(pd.length),
  });
  svm.setAccount({
    address: program,
    data: new Uint8Array(prog),
    executable: true,
    lamports: lamports(svm.minimumBalanceForRentExemption(36n)),
    programAddress: LOADER,
    space: 36n,
  });
}

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
