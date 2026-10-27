// Compressed NFTs for the compression ports: a Bubblegum tree (depth 3) minted through test/fixtures/metaplex.ts, and
// the leaf hashes, root and proofs Bubblegum checks, computed the way mpl-bubblegum and spl-concurrent-merkle-tree do.
import { getCreateAccountInstruction } from "@solana-program/system";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { type Address, type KeyPairSigner, address, generateKeyPairSigner, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type LiteSVM } from "litesvm";
import { SYSTEM_PROGRAM, deployFile, expectOk, ix, send } from "./harness.js";

export const BUBBLEGUM = address("BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY");
export const COMPRESSION = address("cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK");
export const NOOP = address("noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV");
const programs = (f: string) => fileURLToPath(new URL(`./programs/${f}`, import.meta.url));
export const HAVE_BUBBLEGUM = ["mpl_bubblegum.so", "spl_account_compression.so", "spl_noop.so"].every((f) => existsSync(programs(f)));

const DEPTH = 3;
const enc = getAddressEncoder();
const keccak = (...parts: Uint8Array[]) => keccak_256(Buffer.concat(parts.map((p) => Buffer.from(p))));
const u64le = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const str = (s: string) => {
  const b = Buffer.from(s, "utf8");
  const l = Buffer.alloc(4);
  l.writeUInt32LE(b.length);
  return Buffer.concat([l, b]);
};
/** The leaves of `mintCompressed` in the metaplex fixture: name "cNFT", symbol "CN", 500 bps, no creators. */
const NAME = "cNFT";
const SYMBOL = "CN";
const URI = "https://example.com/n.json";
const FEE = 500;

/** mpl-bubblegum hash_metadata and the creator hash of no creators. */
export function metadataHashes(): { dataHash: Uint8Array; creatorHash: Uint8Array } {
  const fee = Buffer.alloc(2);
  fee.writeUInt16LE(FEE);
  const args = Buffer.concat([str(NAME), str(SYMBOL), str(URI), fee, Buffer.from([0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0])]);
  return { dataHash: keccak(keccak(args), fee), creatorHash: keccak() };
}

export interface Leaf {
  owner: Address;
  delegate: Address;
  nonce: bigint;
  assetId: Address;
}

/** LeafSchema::V1 hash. */
export function leafHash(l: Leaf): Uint8Array {
  const { dataHash, creatorHash } = metadataHashes();
  return keccak(Uint8Array.of(1), enc.encode(l.assetId), enc.encode(l.owner), enc.encode(l.delegate), u64le(l.nonce), dataHash, creatorHash);
}

const EMPTY: Uint8Array[] = [new Uint8Array(32)];
for (let i = 1; i <= DEPTH; i++) EMPTY.push(keccak(EMPTY[i - 1]!, EMPTY[i - 1]!));

/** The root over `leaves` (index → hash; missing ones are empty) and the proof of `index`. */
export function rootAndProof(leaves: Map<number, Uint8Array>, index: number): { root: Uint8Array; proof: Uint8Array[] } {
  let level: Uint8Array[] = Array.from({ length: 2 ** DEPTH }, (_, i) => leaves.get(i) ?? EMPTY[0]!);
  const proof: Uint8Array[] = [];
  let i = index;
  while (level.length > 1) {
    proof.push(level[i ^ 1]!);
    const next: Uint8Array[] = [];
    for (let k = 0; k < level.length; k += 2) next.push(keccak(level[k]!, level[k + 1]!));
    level = next;
    i >>= 1;
  }
  return { root: level[0]!, proof };
}

/** A proof node as an account address (the cNFT programs take the proof as remaining accounts). */
export const nodeAddress = (n: Uint8Array): Address => getAddressDecoder().decode(n);

/** A tree made and minted by the metaplex fixture's studio PDA, tracking its leaves. */
export async function makeTree(svm: LiteSVM, payer: KeyPairSigner) {
  const m = await deployFile(fileURLToPath(new URL("./fixtures/metaplex.ts", import.meta.url)), { svm });
  const [studio] = await getProgramDerivedAddress({ programAddress: m.programId, seeds: ["studio"] });
  expectOk(
    await send(svm, payer, [
      ix(m, "setup", {}, [{ address: payer.address, signer: payer, writable: true }, { address: studio, writable: true }, { address: SYSTEM_PROGRAM }]),
    ]),
  );
  const tree = await generateKeyPairSigner();
  const space = 56 + 24 + 8 * (40 + 32 * DEPTH) + (40 + 32 * DEPTH);
  const [treeConfig] = await getProgramDerivedAddress({ programAddress: BUBBLEGUM, seeds: [enc.encode(tree.address)] });
  const common = [{ address: NOOP }, { address: COMPRESSION }, { address: BUBBLEGUM }, { address: SYSTEM_PROGRAM }];
  expectOk(
    await send(svm, payer, [
      getCreateAccountInstruction({ payer, newAccount: tree, lamports: svm.minimumBalanceForRentExemption(BigInt(space)), space, programAddress: COMPRESSION }),
      ix(m, "make_tree", {}, [
        { address: treeConfig, writable: true },
        { address: tree.address, writable: true },
        { address: payer.address, signer: payer, writable: true },
        { address: studio },
        ...common,
      ]),
    ]),
  );
  const leaves = new Map<number, Uint8Array>();
  let minted = 0n;
  return {
    tree: tree.address,
    treeConfig,
    leaves,
    /** Mint a cNFT to `owner` (also its delegate); returns its leaf. */
    async mint(owner: Address): Promise<Leaf & { index: number }> {
      expectOk(
        await send(svm, payer, [
          ix(m, "mint_compressed", {}, [
            { address: treeConfig, writable: true },
            { address: owner },
            { address: tree.address, writable: true },
            { address: payer.address, signer: payer, writable: true },
            { address: studio },
            ...common,
          ]),
        ]),
      );
      const nonce = minted++;
      const [assetId] = await getProgramDerivedAddress({ programAddress: BUBBLEGUM, seeds: ["asset", enc.encode(tree.address), u64le(nonce)] });
      const leaf = { owner, delegate: owner, nonce, assetId, index: Number(nonce) };
      leaves.set(leaf.index, leafHash(leaf));
      return leaf;
    },
  };
}
