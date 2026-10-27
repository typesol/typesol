// Ports of the compression examples (Bubblegum compressed NFTs; skipped without `pnpm fetch:programs`).
import { fileURLToPath } from "node:url";
import { FailedTransactionMetadata } from "litesvm";
import { describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, TOKEN_PROGRAM, expectOk, fundedSigner, ix, send } from "./harness.js";
import { BUBBLEGUM, COMPRESSION, HAVE_BUBBLEGUM, NOOP, leafHash, makeTree, metadataHashes, nodeAddress, rootAndProof } from "./cnft-helpers.js";
import { AccountRole, type Address, generateKeyPairSigner, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { existsSync } from "node:fs";
import { METADATA_PROGRAM, createMint, deployPort, fundAta } from "./ports-helpers.js";

const programs = (f: string) => fileURLToPath(new URL(`./programs/${f}`, import.meta.url));
const bytes = (b: Uint8Array) => Array.from(b);

describe.skipIf(!HAVE_BUBBLEGUM)("port: compression/cnft-burn", () => {
  it("burns a compressed NFT, passing the proof on as remaining accounts", async () => {
    const d = await deployPort("compression/cnft-burn.ts", "C6qxH8n6mZxrrbtMtYWYSp8JR8vkQ55X1o4EBg7twnMv");
    const { svm } = d;
    svm.addProgramFromFile(BUBBLEGUM, programs("mpl_bubblegum.so"));
    svm.addProgramFromFile(COMPRESSION, programs("spl_account_compression.so"));
    svm.addProgramFromFile(NOOP, programs("spl_noop.so"));
    const payer = await fundedSigner(svm, 50n);
    const t = await makeTree(svm, payer);
    const owner = await fundedSigner(svm);
    const leaf = await t.mint(owner.address);
    await t.mint((await fundedSigner(svm)).address); // a second leaf, so the proof is not all empty nodes
    const { dataHash, creatorHash } = metadataHashes();
    const burn = (signer: typeof owner) => {
      const { root, proof } = rootAndProof(t.leaves, leaf.index);
      return send(svm, signer, [
        ix(
          d,
          "burn_cnft",
          { root: bytes(root), data_hash: bytes(dataHash), creator_hash: bytes(creatorHash), nonce: new BN(leaf.nonce.toString()), index: leaf.index },
          [
            { address: signer.address, signer, writable: true },
            { address: t.treeConfig, writable: true },
            { address: t.tree, writable: true },
            { address: NOOP },
            { address: COMPRESSION },
            { address: BUBBLEGUM },
            { address: SYSTEM_PROGRAM },
            ...proof.map((n) => ({ address: nodeAddress(n) })),
          ],
        ),
      ]);
    };
    // Only the owner can burn it.
    expect(await burn(await fundedSigner(svm))).toBeInstanceOf(FailedTransactionMetadata);
    expectOk(await burn(owner));
    t.leaves.set(leaf.index, new Uint8Array(32));
    // Gone: burning it again fails (its leaf no longer matches).
    expect(await burn(owner)).toBeInstanceOf(FailedTransactionMetadata);
  });
});

describe.skipIf(!HAVE_BUBBLEGUM)("port: compression/cnft-vault", () => {
  it("withdraws one cNFT, then two from two trees, signed by the vault PDA", async () => {
    const d = await deployPort("compression/cnft-vault.ts", "Fd4iwpPWaCU8BNwGQGtvvrcvG4Tfizq3RgLm8YLBJX6D");
    const { svm } = d;
    svm.addProgramFromFile(BUBBLEGUM, programs("mpl_bubblegum.so"));
    svm.addProgramFromFile(COMPRESSION, programs("spl_account_compression.so"));
    svm.addProgramFromFile(NOOP, programs("spl_noop.so"));
    const payer = await fundedSigner(svm, 50n);
    const [vault] = await getProgramDerivedAddress({ programAddress: d.programId, seeds: ["cNFT-vault"] });
    const t1 = await makeTree(svm, payer);
    const t2 = await makeTree(svm, payer);
    const a = await t1.mint(vault);
    const b = await t1.mint(vault);
    const c = await t2.mint(vault);
    const { dataHash, creatorHash } = metadataHashes();
    const args = (t: typeof t1, l: typeof a, suffix = "") => {
      const { root, proof } = rootAndProof(t.leaves, l.index);
      return {
        proof,
        args: {
          [`root${suffix}`]: bytes(root),
          [`data_hash${suffix}`]: bytes(dataHash),
          [`creator_hash${suffix}`]: bytes(creatorHash),
          [`nonce${suffix}`]: new BN(l.nonce.toString()),
          [`index${suffix}`]: l.index,
        },
      };
    };
    const moved = (t: typeof t1, l: typeof a, to: Address) => t.leaves.set(l.index, leafHash({ ...l, owner: to, delegate: to }));
    const common = [{ address: NOOP }, { address: COMPRESSION }, { address: BUBBLEGUM }, { address: SYSTEM_PROGRAM }];
    const alice = (await generateKeyPairSigner()).address;
    const one = args(t1, a);
    expectOk(
      await send(svm, payer, [
        ix(d, "withdraw_cnft", one.args, [
          { address: t1.treeConfig, writable: true },
          { address: vault },
          { address: alice },
          { address: t1.tree, writable: true },
          ...common,
          ...one.proof.map((n) => ({ address: nodeAddress(n) })),
        ]),
      ]),
    );
    moved(t1, a, alice);
    // Withdrawing it again fails: the vault no longer owns it.
    const again = args(t1, { ...a, owner: vault, delegate: vault } as typeof a);
    expect(
      await send(svm, payer, [
        ix(d, "withdraw_cnft", again.args, [
          { address: t1.treeConfig, writable: true },
          { address: vault },
          { address: alice },
          { address: t1.tree, writable: true },
          ...common,
          ...again.proof.map((n) => ({ address: nodeAddress(n) })),
        ]),
      ]),
    ).toBeInstanceOf(FailedTransactionMetadata);
    const bob = (await generateKeyPairSigner()).address;
    const carol = (await generateKeyPairSigner()).address;
    const p1 = args(t1, b, "1");
    const p2 = args(t2, c, "2");
    expectOk(
      await send(svm, payer, [
        ix(d, "withdraw_two_cnfts", { ...p1.args, proof1_length: p1.proof.length, ...p2.args, proof2_length: p2.proof.length }, [
          { address: t1.treeConfig, writable: true },
          { address: vault },
          { address: bob },
          { address: t1.tree, writable: true },
          { address: t2.treeConfig, writable: true },
          { address: carol },
          { address: t2.tree, writable: true },
          ...common,
          ...[...p1.proof, ...p2.proof].map((n) => ({ address: nodeAddress(n) })),
        ]),
      ]),
    );
    moved(t1, b, bob);
    moved(t2, c, carol);
    // The vault holds none of them now.
    expect([...t1.leaves.values(), ...t2.leaves.values()].length).toBe(3);
  });
});

describe.skipIf(!HAVE_BUBBLEGUM || !existsSync(programs("mpl_token_metadata.so")))("port: compression/cutils", () => {
  it("mints a cNFT into a sized collection, then verifies leaves against the tree", async () => {
    const d = await deployPort("compression/cutils.ts", "BuFyrgRYzg2nPhqYrxZ7d9uYUs4VXtxH71U8EcoAfTQZ");
    const { svm } = d;
    svm.addProgramFromFile(BUBBLEGUM, programs("mpl_bubblegum.so"));
    svm.addProgramFromFile(COMPRESSION, programs("spl_account_compression.so"));
    svm.addProgramFromFile(NOOP, programs("spl_noop.so"));
    svm.addProgramFromFile(METADATA_PROGRAM, programs("mpl_token_metadata.so"));
    const payer = await fundedSigner(svm, 50n);
    const t = await makeTree(svm, payer);
    const enc = getAddressEncoder();

    // A sized collection NFT whose update authority is the payer (Token Metadata CreateMetadataAccountV3 + CreateMasterEditionV3).
    const collectionMint = await createMint(svm, payer, { decimals: 0, freeze: payer.address });
    await fundAta(svm, payer, payer.address, collectionMint, 1n);
    const [metadata] = await getProgramDerivedAddress({
      programAddress: METADATA_PROGRAM,
      seeds: ["metadata", enc.encode(METADATA_PROGRAM), enc.encode(collectionMint)],
    });
    const [edition] = await getProgramDerivedAddress({
      programAddress: METADATA_PROGRAM,
      seeds: ["metadata", enc.encode(METADATA_PROGRAM), enc.encode(collectionMint), "edition"],
    });
    const s = (x: string) => Buffer.concat([Buffer.from(Uint32Array.of(x.length).buffer), Buffer.from(x)]);
    const P = (address: Address, role: AccountRole, signer?: typeof payer) => ({ address, role, ...(signer ? { signer } : {}) });
    expectOk(
      await send(svm, payer, [
        {
          programAddress: METADATA_PROGRAM,
          accounts: [
            P(metadata, AccountRole.WRITABLE),
            P(collectionMint, AccountRole.READONLY),
            P(payer.address, AccountRole.READONLY_SIGNER, payer),
            P(payer.address, AccountRole.WRITABLE_SIGNER, payer),
            P(payer.address, AccountRole.READONLY_SIGNER, payer),
            P(SYSTEM_PROGRAM, AccountRole.READONLY),
          ],
          data: Buffer.concat([Buffer.from([33]), s("Burgers"), s("BURG"), s(""), Buffer.from([0, 0, 0, 0, 0, 1, 1, 0]), Buffer.alloc(8)]),
        } as never,
        {
          programAddress: METADATA_PROGRAM,
          accounts: [
            P(edition, AccountRole.WRITABLE),
            P(collectionMint, AccountRole.WRITABLE),
            P(payer.address, AccountRole.READONLY_SIGNER, payer),
            P(payer.address, AccountRole.READONLY_SIGNER, payer),
            P(payer.address, AccountRole.WRITABLE_SIGNER, payer),
            P(metadata, AccountRole.WRITABLE),
            P(TOKEN_PROGRAM, AccountRole.READONLY),
            P(SYSTEM_PROGRAM, AccountRole.READONLY),
          ],
          data: Buffer.concat([Buffer.from([17, 1]), Buffer.alloc(8)]),
        } as never,
      ]),
    );

    // mint: into the collection.
    const owner = await fundedSigner(svm);
    const [bubblegumSigner] = await getProgramDerivedAddress({ programAddress: BUBBLEGUM, seeds: ["collection_cpi"] });
    const uri = "https://example.com/burger.json";
    expectOk(
      await send(svm, payer, [
        ix(d, "mint", { uri }, [
          { address: payer.address, signer: payer },
          { address: t.treeConfig, writable: true },
          { address: owner.address },
          { address: owner.address },
          { address: t.tree, writable: true },
          { address: payer.address, signer: payer },
          { address: payer.address, signer: payer },
          { address: BUBBLEGUM },
          { address: collectionMint },
          { address: metadata, writable: true },
          { address: edition },
          { address: bubblegumSigner },
          { address: NOOP },
          { address: COMPRESSION },
          { address: METADATA_PROGRAM },
          { address: BUBBLEGUM },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    // The leaf Bubblegum stored: the original's MetadataArgs with the collection verified by the mint.
    const k = (...p: ArrayLike<number>[]) => keccak_256(Buffer.concat(p.map((x) => Buffer.from(Uint8Array.from(x)))));
    const args = Buffer.concat([
      s("BURGER"),
      s("BURG"),
      s(uri),
      Buffer.from([0, 0, 0, 0, 1, 0, 1, 0, 1, 1]),
      Buffer.from(enc.encode(collectionMint)),
      Buffer.from([0, 0, 1, 0, 0, 0]),
      Buffer.from(enc.encode(payer.address)),
      Buffer.from([0, 100]),
    ]);
    const dataHash = k(k(args), Buffer.from([0, 0]));
    const creatorHash = k(Buffer.from(enc.encode(payer.address)), Buffer.from([0, 100]));
    const nonce = t.nextNonce();
    const [assetId] = await getProgramDerivedAddress({
      programAddress: BUBBLEGUM,
      seeds: ["asset", enc.encode(t.tree), Buffer.from(new BigUint64Array([nonce]).buffer)],
    });
    const leaf = { owner: owner.address, delegate: owner.address, nonce, assetId, index: Number(nonce) };
    t.track(
      leaf,
      k(
        Uint8Array.of(1),
        enc.encode(assetId),
        enc.encode(owner.address),
        enc.encode(owner.address),
        Buffer.from(new BigUint64Array([nonce]).buffer),
        dataHash,
        creatorHash,
      ),
    );

    // verify: the leaf is in the tree for its owner, and not for anyone else.
    const verify = (signer: typeof owner, hashes = { dataHash, creatorHash }) => {
      const { root, proof } = rootAndProof(t.leaves, leaf.index);
      return send(svm, signer, [
        ix(
          d,
          "verify",
          {
            params: {
              root: bytes(root),
              data_hash: bytes(hashes.dataHash),
              creator_hash: bytes(hashes.creatorHash),
              nonce: new BN(nonce.toString()),
              index: leaf.index,
            },
          },
          [
            { address: signer.address, signer },
            { address: signer.address },
            { address: t.tree },
            { address: COMPRESSION },
            ...proof.map((n) => ({ address: nodeAddress(n) })),
          ],
        ),
      ]);
    };
    expectOk(await verify(owner));
    expect(await verify(await fundedSigner(svm))).toBeInstanceOf(FailedTransactionMetadata);
    expect(await verify(owner, { dataHash: creatorHash, creatorHash })).toBeInstanceOf(FailedTransactionMetadata);
    // A leaf minted with MintV1 next to it verifies too.
    const other = await fundedSigner(svm);
    const plain = await t.mint(other.address);
    const { root, proof } = rootAndProof(t.leaves, plain.index);
    const h = metadataHashes();
    expectOk(
      await send(svm, other, [
        ix(
          d,
          "verify",
          {
            params: {
              root: bytes(root),
              data_hash: bytes(h.dataHash),
              creator_hash: bytes(h.creatorHash),
              nonce: new BN(plain.nonce.toString()),
              index: plain.index,
            },
          },
          [
            { address: other.address, signer: other },
            { address: other.address },
            { address: t.tree },
            { address: COMPRESSION },
            ...proof.map((n) => ({ address: nodeAddress(n) })),
          ],
        ),
      ]),
    );
  });
});
