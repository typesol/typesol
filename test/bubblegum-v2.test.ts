// Bubblegum V2 through a program-owned PDA: tree, mints (plain and into a Core collection), transfer and burn with the
// leaf hashes and proofs mpl-bubblegum checks (LeafSchema::V2), on the real Bubblegum, mpl-account-compression,
// mpl-noop and Core programs.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { getCreateAccountInstruction } from "@solana-program/system";
import { type Address, type KeyPairSigner, address, generateKeyPairSigner, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  COMPRESSION as V1_COMPRESSION,
  NOOP as V1_NOOP,
  leafHash as v1LeafHash,
  makeTree as makeTreeV1,
  metadataHashes,
  nodeAddress,
  rootAndProof,
} from "./cnft-helpers.js";
import { BN, SYSTEM_PROGRAM, acct, deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "./harness.js";

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
function hashes(m: { name: string; uri: string; fee: number; creators: Address[]; collection: Address | null; verified?: boolean }) {
  const fee = Buffer.alloc(2);
  fee.writeUInt16LE(m.fee);
  const creators = m.creators.map((a) => Buffer.concat([Buffer.from(enc.encode(a)), Buffer.from([m.verified ? 1 : 0, 100])]));
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

  const leafOf = async (tree: Address, owner: Address, nonce: bigint, h: ReturnType<typeof hashes>, delegate = owner, flags = 0) => {
    const [id] = await getProgramDerivedAddress({ programAddress: BUBBLEGUM, seeds: ["asset", enc.encode(tree), u64le(nonce)] });
    return keccak(
      Uint8Array.of(2),
      enc.encode(id),
      enc.encode(owner),
      enc.encode(delegate),
      u64le(nonce),
      h.dataHash,
      h.creatorHash,
      h.collectionHash,
      h.assetDataHash,
      [flags],
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
    expect(await give(next, null)).toBeInstanceOf(FailedTransactionMetadata); // not the owner: the leaf does not match
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
    expect(await give(next, null)).toBeInstanceOf(FailedTransactionMetadata);
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
  it("verifies a creator, delegates, freezes, thaws and renames a leaf", async () => {
    const payer = await fundedSigner(d.svm, 50n);
    const { tree, treeConfig } = await makeTree(payer);
    const owner = await fundedSigner(d.svm);
    const delegate = await fundedSigner(d.svm);
    const P = { address: payer.address, signer: payer, writable: true };
    const tail = [{ address: NOOP }, { address: COMPRESSION }, { address: BUBBLEGUM }, { address: SYSTEM_PROGRAM }];
    expectOk(
      await send(d.svm, payer, [
        ix(d, "mint", { name: "solo" }, [
          { address: treeConfig, writable: true },
          P,
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
    const leaves = new Map<number, Uint8Array>();
    const meta = (name: string, verified: boolean) =>
      hashes({ name, uri: "https://example.com/n.json", fee: 500, creators: [studio], collection: null, verified });
    const set = async (h: ReturnType<typeof hashes>, del: Address, flags = 0) => leaves.set(0, await leafOf(tree, owner.address, 0n, h, del, flags));
    await set(meta("solo", false), owner.address);
    const proof = () => rootAndProof(leaves, 0);
    const nodes = () => proof().proof.map((n) => ({ address: nodeAddress(n) }));
    const leafArgs = (h: ReturnType<typeof hashes>) => ({
      root: bytes(proof().root),
      data_hash: bytes(h.dataHash),
      creator_hash: bytes(h.creatorHash),
      nonce: new BN(0),
      index: 0,
    });

    // The studio verifies itself as the creator (signing with its seeds): the creator and data hashes change.
    expectOk(
      await send(d.svm, payer, [
        ix(d, "verify_studio", { root: bytes(proof().root), nonce: new BN(0), index: 0, name: "solo" }, [
          { address: treeConfig, writable: true },
          P,
          { address: studio },
          { address: owner.address },
          { address: tree, writable: true },
          ...tail,
          ...nodes(),
        ]),
      ]),
    );
    await set(meta("solo", true), owner.address);

    // The owner delegates; the delegate freezes; a frozen leaf cannot move; the delegate thaws.
    expectOk(
      await send(d.svm, owner, [
        ix(d, "delegate_to", { ...leafArgs(meta("solo", true)), collection_hash: null }, [
          { address: treeConfig, writable: true },
          { address: owner.address, signer: owner, writable: true },
          { address: delegate.address },
          { address: tree, writable: true },
          ...tail,
          ...nodes(),
        ]),
      ]),
    );
    await set(meta("solo", true), delegate.address);
    const freeze = (frozen: boolean, flags: number) =>
      send(d.svm, delegate, [
        ix(d, "freeze", { ...leafArgs(meta("solo", true)), frozen, flags }, [
          { address: treeConfig, writable: true },
          { address: delegate.address, signer: delegate, writable: true },
          { address: owner.address },
          { address: tree, writable: true },
          ...tail,
          ...nodes(),
        ]),
      ]);
    expectOk(await freeze(true, 0));
    await set(meta("solo", true), delegate.address, 1);
    expect(await freeze(true, 0)).toBeInstanceOf(FailedTransactionMetadata); // the leaf now carries flags 1
    expectOk(await freeze(false, 1));
    await set(meta("solo", true), delegate.address, 0);

    // The tree creator renames it; the next instruction only succeeds if the new leaf is what we computed.
    expectOk(
      await send(d.svm, payer, [
        ix(d, "rename", { root: bytes(proof().root), nonce: new BN(0), index: 0, name: "solo", new_name: "duo" }, [
          { address: treeConfig, writable: true },
          P,
          { address: studio },
          { address: owner.address },
          { address: delegate.address },
          { address: tree, writable: true },
          ...tail,
          ...nodes(),
        ]),
      ]),
    );
    await set(meta("duo", true), delegate.address);
    expectOk(
      await send(d.svm, delegate, [
        ix(d, "freeze", { ...leafArgs(meta("duo", true)), frozen: true, flags: 0 }, [
          { address: treeConfig, writable: true },
          { address: delegate.address, signer: delegate, writable: true },
          { address: owner.address },
          { address: tree, writable: true },
          ...tail,
          ...nodes(),
        ]),
      ]),
    );
  });

  it("transfers (signed by a PDA owner), delegates and burns on V1 trees", async () => {
    d.svm.addProgramFromFile(V1_COMPRESSION, programs("spl_account_compression.so"));
    d.svm.addProgramFromFile(V1_NOOP, programs("spl_noop.so"));
    const payer = await fundedSigner(d.svm, 50n);
    const v1 = await makeTreeV1(d.svm, payer);
    const leaf = await v1.mint(studio);
    const { dataHash, creatorHash } = metadataHashes();
    const tail = [{ address: V1_NOOP }, { address: V1_COMPRESSION }, { address: BUBBLEGUM }, { address: SYSTEM_PROGRAM }];
    const args = (l: { nonce: bigint; index: number }) => ({
      root: bytes(rootAndProof(v1.leaves, l.index).root),
      data_hash: bytes(dataHash),
      creator_hash: bytes(creatorHash),
      nonce: new BN(l.nonce.toString()),
      index: l.index,
    });
    const nodes = (i: number) => rootAndProof(v1.leaves, i).proof.map((n) => ({ address: nodeAddress(n) }));
    const owner = await fundedSigner(d.svm);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "give_v1", args(leaf), [
          { address: v1.treeConfig },
          { address: studio },
          { address: owner.address },
          { address: v1.tree, writable: true },
          ...tail,
          ...nodes(0),
        ]),
      ]),
    );
    const moved = { ...leaf, owner: owner.address, delegate: owner.address };
    v1.leaves.set(0, v1LeafHash(moved));
    const delegate = await fundedSigner(d.svm);
    expectOk(
      await send(d.svm, owner, [
        ix(d, "delegate_v1", args(leaf), [
          { address: v1.treeConfig },
          { address: owner.address, signer: owner },
          { address: delegate.address },
          { address: v1.tree, writable: true },
          ...tail,
          ...nodes(0),
        ]),
      ]),
    );
    v1.leaves.set(0, v1LeafHash({ ...moved, delegate: delegate.address }));
    expectOk(
      await send(d.svm, delegate, [
        ix(d, "burn_v1", args(leaf), [
          { address: v1.treeConfig },
          { address: owner.address },
          { address: delegate.address, signer: delegate },
          { address: v1.tree, writable: true },
          ...tail,
          ...nodes(0),
        ]),
      ]),
    );
  });
  it("unverifies a creator, moves a leaf into a collection and makes a collection's leaf soulbound", async () => {
    const payer = await fundedSigner(d.svm, 50n);
    const P = { address: payer.address, signer: payer, writable: true };
    const tail = [{ address: NOOP }, { address: COMPRESSION }, { address: BUBBLEGUM }, { address: SYSTEM_PROGRAM }];
    const owner = await fundedSigner(d.svm);
    const [cpiSigner] = await getProgramDerivedAddress({ programAddress: BUBBLEGUM, seeds: ["mpl_core_cpi_signer"] });
    const collection = await generateKeyPairSigner();
    expectOk(
      await send(d.svm, payer, [
        ix(d, "make_collection", {}, [
          { address: collection.address, signer: collection, writable: true },
          { address: studio, writable: true },
          P,
          { address: CORE },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );

    const { tree, treeConfig } = await makeTree(payer);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "mint", { name: "solo" }, [
          { address: treeConfig, writable: true },
          P,
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
    const leaves = new Map<number, Uint8Array>();
    const meta = (verified: boolean, coll: Address | null) =>
      hashes({ name: "solo", uri: "https://example.com/n.json", fee: 500, creators: [studio], collection: coll, verified });
    const set = async (h: ReturnType<typeof hashes>) => leaves.set(0, await leafOf(tree, owner.address, 0n, h));
    await set(meta(false, null));
    const nodes = () => rootAndProof(leaves, 0).proof.map((n) => ({ address: nodeAddress(n) }));
    const ref = () => ({ root: bytes(rootAndProof(leaves, 0).root), nonce: new BN(0), index: 0, name: "solo" });
    const studioIx = (name: string) =>
      send(d.svm, payer, [
        ix(d, name, ref(), [
          { address: treeConfig, writable: true },
          P,
          { address: studio },
          { address: owner.address },
          { address: tree, writable: true },
          ...tail,
          ...nodes(),
        ]),
      ]);
    expectOk(await studioIx("verify_studio"));
    await set(meta(true, null));
    expectOk(await studioIx("unverify_studio"));
    await set(meta(false, null));

    expectOk(
      await send(d.svm, payer, [
        ix(d, "move_into", ref(), [
          { address: treeConfig, writable: true },
          P,
          { address: studio },
          { address: owner.address },
          { address: tree, writable: true },
          { address: collection.address, writable: true },
          { address: cpiSigner },
          { address: NOOP },
          { address: COMPRESSION },
          { address: CORE },
          { address: BUBBLEGUM },
          { address: SYSTEM_PROGRAM },
          ...nodes(),
        ]),
      ]),
    );
    await set(meta(false, collection.address));
    // The leaf is now in the collection: an owner instruction built from that state goes through.
    const h = meta(false, collection.address);
    expectOk(
      await send(d.svm, owner, [
        ix(
          d,
          "delegate_to",
          {
            root: bytes(rootAndProof(leaves, 0).root),
            data_hash: bytes(h.dataHash),
            creator_hash: bytes(h.creatorHash),
            collection_hash: bytes(h.collectionHash),
            nonce: new BN(0),
            index: 0,
          },
          [
            { address: treeConfig, writable: true },
            { address: owner.address, signer: owner, writable: true },
            { address: owner.address },
            { address: tree, writable: true },
            ...tail,
            ...nodes(),
          ],
        ),
      ]),
    );

    // A collection with a permanent freeze delegate (the studio), which makes its leaf soulbound.
    const souls = await generateKeyPairSigner();
    expectOk(
      await send(d.svm, payer, [
        ix(d, "make_soul_collection", {}, [
          { address: souls.address, signer: souls, writable: true },
          { address: studio, writable: true },
          P,
          { address: CORE },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const second = await makeTree(payer);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "mint_into_collection", {}, [
          { address: second.treeConfig, writable: true },
          P,
          { address: studio },
          { address: owner.address },
          { address: second.tree, writable: true },
          { address: souls.address, writable: true },
          { address: cpiSigner },
          { address: NOOP },
          { address: COMPRESSION },
          { address: CORE },
          { address: BUBBLEGUM },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const m = hashes({ name: "Member", uri: "https://example.com/m.json", fee: 0, creators: [], collection: souls.address });
    const memberLeaves = new Map([[0, await leafOf(second.tree, owner.address, 0n, m)]]);
    const { root, proof } = rootAndProof(memberLeaves, 0);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "soulbind", { root: bytes(root), data_hash: bytes(m.dataHash), creator_hash: bytes(m.creatorHash), nonce: new BN(0), index: 0 }, [
          { address: second.treeConfig, writable: true },
          P,
          { address: studio },
          { address: owner.address },
          { address: second.tree, writable: true },
          { address: souls.address },
          ...tail,
          ...proof.map((n) => ({ address: nodeAddress(n) })),
        ]),
      ]),
    );
  });
});
