// `typesol verify --address`: reading a deployed program's ELF and authority from each loader's account layout, and
// comparing the IDL published on chain with the built one.
import { type Address, generateKeyPairSigner, getAddressEncoder, lamports } from "@solana/kit";
import { LiteSVM } from "litesvm";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { build, verifyBinary, type BuildResult } from "../src/compiler/index.js";
import { PROGRAM_METADATA_ID, fetchIdl, publishIdl } from "../src/idlpublish.js";
import { LOADER_V2, LOADER_V4, canonicalJson, fetchDeployed } from "../src/onchain.js";
import { rawProgram, svmChain, upgradeable } from "./chain-helpers.js";
import { fundedSigner } from "./harness.js";

const COUNTER = fileURLToPath(new URL("../examples/counter.ts", import.meta.url));
const VAULT = fileURLToPath(new URL("../examples/vault.ts", import.meta.url));
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "typesol-onchain-"));
const newAddress = async () => (await generateKeyPairSigner()).address;

describe("reading deployed programs (typesol verify --address)", () => {
  let built: BuildResult;
  let elf: Buffer;
  beforeAll(() => {
    built = build(COUNTER, tmp(), "11111111111111111111111111111112");
    elf = readFileSync(built.soPath);
  });

  it("loader v3: the ELF from ProgramData, its upgrade authority and deploy slot; frozen programs have none", async () => {
    const svm = new LiteSVM();
    const authority = await newAddress();
    const live = await newAddress();
    const frozen = await newAddress();
    await upgradeable(svm, live, built.soPath, authority);
    await upgradeable(svm, frozen, built.soPath, null);
    const rpc = svmChain(svm).rpc;

    const a = await fetchDeployed(rpc, live);
    expect([a.loader, a.authority, a.slot]).toEqual(["v3", authority, 123n]);
    expect(a.dataAccount).not.toBe(live);
    expect(verifyBinary(a.elf, elf)).toBe(true);
    expect((await fetchDeployed(rpc, frozen)).authority).toBeNull();

    // A different program does not verify against these bytes.
    const other = readFileSync(build(VAULT, tmp(), "11111111111111111111111111111112").soPath);
    expect(verifyBinary(a.elf, other)).toBe(false);
  });

  it("loader v2 (the account is the ELF) and loader v4 (header, then the ELF; finalized means immutable)", async () => {
    const svm = new LiteSVM();
    const v2 = await newAddress();
    rawProgram(svm, v2, LOADER_V2 as Address, elf);
    const rpc = svmChain(svm).rpc;
    const a = await fetchDeployed(rpc, v2);
    expect([a.loader, a.authority, verifyBinary(a.elf, elf)]).toEqual(["v2", null, true]);

    const authority = await newAddress();
    const v4 = (status: bigint) => {
      const header = Buffer.alloc(48);
      header.writeBigUInt64LE(77n, 0);
      Buffer.from(getAddressEncoder().encode(authority)).copy(header, 8);
      header.writeBigUInt64LE(status, 40);
      return Buffer.concat([header, elf]);
    };
    const deployed = await newAddress();
    const finalized = await newAddress();
    const retracted = await newAddress();
    rawProgram(svm, deployed, LOADER_V4 as Address, v4(1n));
    rawProgram(svm, finalized, LOADER_V4 as Address, v4(2n));
    rawProgram(svm, retracted, LOADER_V4 as Address, v4(0n));
    const d = await fetchDeployed(rpc, deployed);
    expect([d.loader, d.authority, d.slot, verifyBinary(d.elf, elf)]).toEqual(["v4", authority, 77n, true]);
    expect((await fetchDeployed(rpc, finalized)).authority).toBeNull();
    await expect(fetchDeployed(rpc, retracted)).rejects.toThrow(/retracted/);
  });

  it("says why there is nothing to verify", async () => {
    const svm = new LiteSVM();
    const rpc = svmChain(svm).rpc;
    await expect(fetchDeployed(rpc, await newAddress())).rejects.toThrow(/no account/);
    const wallet = await fundedSigner(svm);
    await expect(fetchDeployed(rpc, wallet.address)).rejects.toThrow(/is not a program \(owner 1111/);
    // A loader-v3 program whose ProgramData was closed.
    const closed = await newAddress();
    await upgradeable(svm, closed, built.soPath, await newAddress());
    const { dataAccount } = await fetchDeployed(rpc, closed);
    svm.setAccount({
      address: dataAccount as Address,
      data: new Uint8Array(0),
      executable: false,
      lamports: lamports(0n),
      programAddress: "11111111111111111111111111111111" as Address,
      space: 0n,
    });
    await expect(fetchDeployed(rpc, closed)).rejects.toThrow(/no program data/);
  });

  it("compares the IDL published on chain with the built one, whatever the key order", async () => {
    const svm = new LiteSVM();
    svm.addProgramFromFile(PROGRAM_METADATA_ID, fileURLToPath(new URL("./programs/program_metadata.so", import.meta.url)));
    const admin = await fundedSigner(svm);
    const program = await newAddress();
    const out = build(COUNTER, tmp(), program);
    await upgradeable(svm, program, out.soPath, admin.address);
    const chain = svmChain(svm);
    await publishIdl(chain, { program, idl: out.idl, payer: admin, canonical: true });
    const published = await fetchIdl(chain.rpc, program);
    expect(canonicalJson(published)).toBe(canonicalJson(out.idl));
    const reordered = Object.fromEntries(Object.entries(out.idl).reverse());
    expect(canonicalJson(reordered)).toBe(canonicalJson(out.idl));
    expect(canonicalJson(build(VAULT, tmp(), program).idl)).not.toBe(canonicalJson(published));
  });
});
