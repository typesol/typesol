// Bubblegum V2 through a program-owned PDA: tree, mints (plain and into a Core collection), transfer and burn with the
// leaf hashes and proofs mpl-bubblegum checks (LeafSchema::V2), on the real Bubblegum, mpl-account-compression,
// mpl-noop and Core programs.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { getCreateAccountInstruction } from "@solana-program/system";
import { type Address, type KeyPairSigner, address, generateKeyPairSigner, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { nodeAddress, rootAndProof } from "./cnft-helpers.js";
import { BN, SYSTEM_PROGRAM, acct, customError, deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "./harness.js";

const BUBBLEGUM = address("BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY");
const COMPRESSION = address("mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW");
const NOOP = address("mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3");
const CORE = address("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const programs = (f: string) => fileURLToPath(new URL(`./programs/${f}`, import.meta.url));
const HAVE = ["mpl_bubblegum.so", "mpl_account_compression.so", "mpl_noop.so", "mpl_core.so"].every((f) => existsSync(programs(f)));

const enc = getAddressEncoder();
const keccak = (...parts: ArrayLike<number>[]) => keccak_256(Buffer.concat(parts.map((p) => Buffer.from(Uint8Array.from(p)))));
const str = (s: string) => {
  const b = Buffer.from(s);
  const l = Buffer.alloc(4);
  l.writeUInt32LE(b.length);
  return Buffer.concat([l, b]);
};
const u64le = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const bytes = (h: Uint8Array) => [...h];

/** mpl-bubblegum's hashes of a MetadataArgsV2 leaf (non-fungible, primary sale false, mutable). */
function hashes(m: { name: string; uri: string; fee: number; creators: Address[]; collection: Address | null }) {
  const fee = Buffer.alloc(2);
  fee.writeUInt16LE(m.fee);
  const creators = m.creators.map((a) => Buffer.concat([Buffer.from(enc.encode(a)), Buffer.from([0, 100])]));
  const count = Buffer.alloc(4);
  count.writeUInt32LE(creators.length);
  const args = Buffer.concat([
    str(m.name),
    str("CN"),
    str(m.uri),
    fee,
    Buffer.from([0, 1, 1, 0]),
    count,
    ...creators,
    m.collection ? Buffer.concat([Buffer.from([1]), Buffer.from(enc.encode(m.collection))]) : Buffer.from([0]),
  ]);
  return {
    dataHash: keccak(keccak(args), fee),
    creatorHash: keccak(...creators),
    collectionHash: keccak(m.collection ? enc.encode(m.collection) : new Uint8Array(32)),
    assetDataHash: keccak(),
  };
}

describe.skipIf(!HAVE)("Bubblegum V2 (test/fixtures/bubblegum-v2.ts)", () => {
  let d: Deployed;
  let studio: Address;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/bubblegum-v2.ts", import.meta.url)));
    d.svm.addProgramFromFile(BUBBLEGUM, programs("mpl_bubblegum.so"));
    d.svm.addProgramFromFile(COMPRESSION, programs("mpl_account_compression.so"));
    d.svm.addProgramFromFile(NOOP, programs("mpl_noop.so"));
    d.svm.addProgramFromFile(CORE, programs("mpl_core.so"));
    const payer = await fundedSigner(d.svm);
    [studio] = await getProgramDerivedAddress({ programAddress: d.programId, seeds: ["studio"] });
    expectOk(
      await send(d.svm, payer, [
        ix(d, "setup", {}, [{ address: payer.address, signer: payer, writable: true }, { address: studio, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
  });

  async function makeTree(payer: KeyPairSigner) {
    const tree = await generateKeyPairSigner();
    const space = 56 + 24 + 8 * (40 + 32 * 3) + (40 + 32 * 3);
    const [treeConfig] = await getProgramDerivedAddress({ programAddress: BUBBLEGUM, seeds: [enc.encode(tree.address)] });
    expectOk(
      await send(d.svm, payer, [
        getCreateAccountInstruction({
          payer,
          newAccount: tree,
          lamports: d.svm.minimumBalanceForRentExemption(BigInt(space)),
          space,
          programAddress: COMPRESSION,
        }),
        ix(d, "make_tree", {}, [
          { address: treeConfig, writable: true },
          { address: tree.address, writable: true },
          { address: payer.address, signer: payer, writable: true },
          { address: studio },
          { address: NOOP },
          { address: COMPRESSION },
          { address: BUBBLEGUM },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    return { tree: tree.address, treeConfig };
  }

  const leafOf = async (tree: Address, owner: Address, nonce: bigint, h: ReturnType<typeof hashes>) => {
    const [id] = await getProgramDerivedAddress({ programAddress: BUBBLEGUM, seeds: ["asset", enc.encode(tree), u64le(nonce)] });
    return keccak(
      Uint8Array.of(2),
      enc.encode(id),
      enc.encode(owner),
      enc.encode(owner),
      u64le(nonce),
      h.dataHash,
      h.creatorHash,
      h.collectionHash,
      h.assetDataHash,
      [0],
    );
  };

  it("mints into a tree, transfers with the proof and burns", async () => {
    const payer = await fundedSigner(d.svm, 50n);
    const { tree, treeConfig } = await makeTree(payer);
    expect(getAddressDecoder().decode(Buffer.from(acct(d.svm, treeConfig).data).subarray(8, 40))).toBe(studio); // tree creator
    const owner = await fundedSigner(d.svm);
    const leaves = new Map<number, Uint8Array>();
    const plain = (name: string) => hashes({ name, uri: "https://example.com/n.json", fee: 500, creators: [studio], collection: null });
    for (const [i, name] of ["one", "two"].entries()) {
      expectOk(
        await send(d.svm, payer, [
          ix(d, "mint", { name }, [
            { address: treeConfig, writable: true },
            { address: payer.address, signer: payer, writable: true },
            { address: studio },
            { address: owner.address },
            { address: tree, writable: true },
            { address: NOOP },
            { address: COMPRESSION },
            { address: CORE },
            { address: BUBBLEGUM },
            { address: SYSTEM_PROGRAM },
          ]),
        ]),
      );
      leaves.set(i, await leafOf(tree, owner.address, BigInt(i), plain(name)));
    }

    // Transfer leaf 1 to `next`: the root and proof cover both leaves, as an indexer would report them.
    const next = await fundedSigner(d.svm);
    const h = plain("two");
    const give = (who: KeyPairSigner, assetDataHash: Uint8Array | null) => {
      const { root, proof } = rootAndProof(leaves, 1);
      return send(d.svm, who, [
        ix(
          d,
          "give",
          {
            root: bytes(root),
            data_hash: bytes(h.dataHash),
            creator_hash: bytes(h.creatorHash),
            asset_data_hash: assetDataHash && bytes(assetDataHash),
            nonce: new BN(1),
            index: 1,
          },
          [
            { address: treeConfig, writable: true },
            { address: who.address, signer: who, writable: true },
            { address: next.address },
            { address: tree, writable: true },
            { address: BUBBLEGUM }, // no collection
            { address: NOOP },
            { address: COMPRESSION },
            { address: BUBBLEGUM },
            { address: SYSTEM_PROGRAM },
            ...proof.map((n) => ({ address: nodeAddress(n) })),
          ],
        ),
      ]);
    };
    expect(customError(await give(next, null))).toBeGreaterThan(0); // not the owner: the leaf does not match
    expectOk(await give(owner, h.assetDataHash));
    leaves.set(1, await leafOf(tree, next.address, 1n, h));

    // The new owner burns it.
    const { root, proof } = rootAndProof(leaves, 1);
    expectOk(
      await send(d.svm, next, [
        ix(d, "burn", { root: bytes(root), data_hash: bytes(h.dataHash), creator_hash: bytes(h.creatorHash), nonce: new BN(1), index: 1 }, [
          { address: treeConfig, writable: true },
          { address: next.address, signer: next, writable: true },
          { address: tree, writable: true },
          { address: NOOP },
          { address: COMPRESSION },
          { address: CORE },
          { address: BUBBLEGUM },
          { address: SYSTEM_PROGRAM },
          ...proof.map((n) => ({ address: nodeAddress(n) })),
        ]),
      ]),
    );
    leaves.set(1, new Uint8Array(32));
    // Burned: the same leaf no longer verifies.
    expect(customError(await give(next, null))).toBeGreaterThan(0);
  });

  it("mints into a Core collection with the BubblegumV2 plugin", async () => {
    const payer = await fundedSigner(d.svm, 50n);
    const { tree, treeConfig } = await makeTree(payer);
    const collection = await generateKeyPairSigner();
    expectOk(
      await send(d.svm, payer, [
        ix(d, "make_collection", {}, [
          { address: collection.address, signer: collection, writable: true },
          { address: studio, writable: true },
          { address: payer.address, signer: payer, writable: true },
          { address: CORE },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const [cpiSigner] = await getProgramDerivedAddress({ programAddress: BUBBLEGUM, seeds: ["mpl_core_cpi_signer"] });
    const owner = (await generateKeyPairSigner()).address;
    const sizeBefore = acct(d.svm, collection.address).data.length;
    expectOk(
      await send(d.svm, payer, [
        ix(d, "mint_into_collection", {}, [
          { address: treeConfig, writable: true },
          { address: payer.address, signer: payer, writable: true },
          { address: studio },
          { address: owner },
          { address: tree, writable: true },
          { address: collection.address, writable: true },
          { address: cpiSigner },
          { address: NOOP },
          { address: COMPRESSION },
          { address: CORE },
          { address: BUBBLEGUM },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    // Core counts the member: the collection's current size (after the update authority, name and uri) went up.
    const data = Buffer.from(acct(d.svm, collection.address).data);
    expect(data.length).toBe(sizeBefore);
    const at = 1 + 32 + 4 + "cNFTs".length + 4 + "https://example.com/c.json".length;
    expect(data.readUInt32LE(at + 4)).toBe(1); // current_size
  });
});
