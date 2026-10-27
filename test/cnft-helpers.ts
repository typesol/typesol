// Compressed NFTs for the compression ports: a Bubblegum tree (depth 3) made and minted with Bubblegum instructions, and
// the leaf hashes, root and proofs Bubblegum checks, computed the way mpl-bubblegum and spl-concurrent-merkle-tree do.
import { getCreateAccountInstruction } from "@solana-program/system";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  AccountRole,
  type Address,
  type KeyPairSigner,
  address,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
} from "@solana/kit";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type LiteSVM } from "litesvm";
import { SYSTEM_PROGRAM, expectOk, send } from "./harness.js";

export const BUBBLEGUM = address("BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY");
export const COMPRESSION = address("cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK");
export const NOOP = address("noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV");
const programs = (f: string) => fileURLToPath(new URL(`./programs/${f}`, import.meta.url));
export const HAVE_BUBBLEGUM = ["mpl_bubblegum.so", "spl_account_compression.so", "spl_noop.so"].every((f) => existsSync(programs(f)));

const DEPTH = 3;
const enc = getAddressEncoder();
const keccak = (...parts: ArrayLike<number>[]) => keccak_256(Buffer.concat(parts.map((p) => Buffer.from(Uint8Array.from(p)))));
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
/** The leaves `mint` makes: name "cNFT", symbol "CN", 500 bps, no creators. */
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

const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

/** A Bubblegum tree (depth 3, buffer 8) whose creator is `payer`, minting with MintV1 directly; tracks its leaves. */
export async function makeTree(svm: LiteSVM, payer: KeyPairSigner, opts: { isPublic?: boolean } = {}) {
  const tree = await generateKeyPairSigner();
  const space = 56 + 24 + 8 * (40 + 32 * DEPTH) + (40 + 32 * DEPTH);
  const [treeConfig] = await getProgramDerivedAddress({ programAddress: BUBBLEGUM, seeds: [enc.encode(tree.address)] });
  const tail = [
    { address: NOOP, role: AccountRole.READONLY },
    { address: COMPRESSION, role: AccountRole.READONLY },
    { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
  ];
  const u32le = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  expectOk(
    await send(svm, payer, [
      getCreateAccountInstruction({ payer, newAccount: tree, lamports: svm.minimumBalanceForRentExemption(BigInt(space)), space, programAddress: COMPRESSION }),
      {
        programAddress: BUBBLEGUM,
        accounts: [
          { address: treeConfig, role: AccountRole.WRITABLE },
          { address: tree.address, role: AccountRole.WRITABLE },
          { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payer },
          { address: payer.address, role: AccountRole.READONLY_SIGNER, signer: payer },
          ...tail,
        ],
        data: Buffer.concat([disc("create_tree"), u32le(DEPTH), u32le(8), Buffer.from(opts.isPublic ? [1, 1] : [0])]),
      } as never,
    ]),
  );
  const leaves = new Map<number, Uint8Array>();
  let minted = 0n;
  const fee = Buffer.alloc(2);
  fee.writeUInt16LE(FEE);
  return {
    tree: tree.address,
    treeConfig,
    leaves,
    /** Account that a leaf was minted into, by others (e.g. MintToCollectionV1): track its nonce. */
    track(leaf: Leaf & { index: number }, hash: Uint8Array) {
      minted = leaf.nonce + 1n;
      leaves.set(leaf.index, hash);
    },
    nextNonce: () => minted,
    /** MintV1 a cNFT to `owner` (also its delegate); returns its leaf. */
    async mint(owner: Address): Promise<Leaf & { index: number }> {
      expectOk(
        await send(svm, payer, [
          {
            programAddress: BUBBLEGUM,
            accounts: [
              { address: treeConfig, role: AccountRole.WRITABLE },
              { address: owner, role: AccountRole.READONLY },
              { address: owner, role: AccountRole.READONLY },
              { address: tree.address, role: AccountRole.WRITABLE },
              { address: payer.address, role: AccountRole.READONLY_SIGNER, signer: payer },
              { address: payer.address, role: AccountRole.READONLY_SIGNER, signer: payer },
              ...tail,
            ],
            data: Buffer.concat([disc("mint_v1"), str(NAME), str(SYMBOL), str(URI), fee, Buffer.from([0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0])]),
          } as never,
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
