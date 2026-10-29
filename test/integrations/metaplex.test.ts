import { existsSync } from "node:fs";
import { getCreateAccountInstruction } from "@solana-program/system";
import { type Address, address, generateKeyPairSigner, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_PROGRAM, customError, deployFile, expectOk, fundedSigner, ix, send, type Deployed, acct } from "../harness.js";

const CORE = address("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const BUBBLEGUM = address("BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY");
const COMPRESSION = address("cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK");
const NOOP = address("noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV");
const programs = (f: string) => fileURLToPath(new URL(`../programs/${f}`, import.meta.url));

// Metaplex programs are not redistributed with TypeSOL (Metaplex NFT license): `pnpm fetch:programs` downloads them.
const HAVE_MPL = ["mpl_core.so", "mpl_bubblegum.so"].every((f) => existsSync(programs(f)));

describe.skipIf(!HAVE_MPL)("Metaplex Core and Bubblegum (test/fixtures/metaplex.ts)", () => {
  let d: Deployed;
  let studio: Address;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/metaplex.ts", import.meta.url)));
    d.svm.addProgramFromFile(CORE, programs("mpl_core.so"));
    d.svm.addProgramFromFile(BUBBLEGUM, programs("mpl_bubblegum.so"));
    d.svm.addProgramFromFile(COMPRESSION, programs("spl_account_compression.so"));
    d.svm.addProgramFromFile(NOOP, programs("spl_noop.so"));
    const payer = await fundedSigner(d.svm);
    [studio] = await getProgramDerivedAddress({ programAddress: d.programId, seeds: ["studio"] });
    expectOk(
      await send(d.svm, payer, [
        ix(d, "setup", {}, [{ address: payer.address, signer: payer, writable: true }, { address: studio, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
  });

  it("creates a collection and an asset in it with a PDA authority, transfers and burns it", async () => {
    const payer = await fundedSigner(d.svm);
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
    expect(acct(d.svm, collection.address).programAddress).toBe(CORE);
    const owner = await fundedSigner(d.svm);
    const asset = await generateKeyPairSigner();
    expectOk(
      await send(d.svm, payer, [
        ix(d, "mint_asset", {}, [
          { address: asset.address, signer: asset, writable: true },
          { address: collection.address, writable: true },
          { address: studio },
          { address: payer.address, signer: payer, writable: true },
          { address: owner.address },
          { address: CORE },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const data = Buffer.from(acct(d.svm, asset.address).data);
    expect(getAddressDecoder().decode(data.subarray(1, 33))).toBe(owner.address);
    const next = await fundedSigner(d.svm);
    const give = (who: typeof owner) =>
      send(d.svm, who, [
        ix(d, "give", {}, [
          { address: asset.address, writable: true },
          { address: collection.address },
          { address: who.address, signer: who, writable: true },
          { address: next.address },
          { address: CORE },
        ]),
      ]);
    expect(customError(await give(payer))).toBeGreaterThan(0); // not the owner: Core refuses
    expectOk(await give(owner));
    const burn = (who: typeof owner) =>
      send(d.svm, who, [
        ix(d, "burn", {}, [
          { address: asset.address, writable: true },
          { address: collection.address, writable: true },
          { address: who.address, signer: who, writable: true },
          { address: CORE },
        ]),
      ]);
    expect(customError(await burn(owner))).toBeGreaterThan(0); // no longer the owner
    expectOk(await burn(next));
    expect(d.svm.getAccount(asset.address).exists ? acct(d.svm, asset.address).data.length : 0).toBeLessThanOrEqual(1); // burned (Core leaves a 1-byte tombstone)
  });

  it("creates assets and collections with plugins, and adds, updates and removes plugins", async () => {
    const payer = await fundedSigner(d.svm);
    const owner = await fundedSigner(d.svm);
    const asset = await generateKeyPairSigner();
    const has = (a: Address, text: string) => Buffer.from(acct(d.svm, a).data).includes(Buffer.from(text));
    expectOk(
      await send(d.svm, payer, [
        ix(d, "mint_with_plugins", { level: "seven" }, [
          { address: asset.address, signer: asset, writable: true },
          { address: studio },
          { address: payer.address, signer: payer, writable: true },
          { address: owner.address },
          { address: CORE },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const data = Buffer.from(acct(d.svm, asset.address).data);
    expect(getAddressDecoder().decode(data.subarray(1, 33))).toBe(owner.address);
    expect(has(asset.address, "level") && has(asset.address, "seven")).toBe(true);
    // Royalties: Plugin::Royalties (0), 500 bps, one creator (the studio) at 100%.
    const royalties = Buffer.concat([Buffer.from([0, 0xf4, 0x01, 1, 0, 0, 0]), Buffer.from(getAddressEncoder().encode(studio)), Buffer.from([100, 0])]);
    expect(data.includes(royalties)).toBe(true);

    const next = await fundedSigner(d.svm);
    const transfer = async () => {
      // A plain Core TransferV1 from the owner (data: discriminator 14, compression proof None).
      const { getTransferV1Instruction } = await import("../mpl-core-ix.js");
      return send(d.svm, owner, [getTransferV1Instruction(asset.address, owner.address, next.address)]);
    };
    const studioFreeze = (frozen: boolean) =>
      send(d.svm, payer, [
        ix(d, "studio_freeze", { frozen }, [
          { address: asset.address, writable: true },
          { address: payer.address, signer: payer, writable: true },
          { address: studio },
          { address: CORE },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    expectOk(await studioFreeze(true));
    expect(customError(await transfer())).toBeGreaterThan(0); // permanently frozen by the studio
    expectOk(await studioFreeze(false));

    const ownerFreeze = (cycle: boolean) =>
      send(d.svm, owner, [
        ix(d, "owner_freeze", { cycle }, [
          { address: asset.address, writable: true },
          { address: owner.address, signer: owner, writable: true },
          { address: CORE },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    expectOk(await ownerFreeze(true)); // added, thawed and removed
    expectOk(await ownerFreeze(false)); // added again (so the remove above worked), frozen
    expect(customError(await transfer())).toBeGreaterThan(0);
    expectOk(
      await send(d.svm, owner, [
        ix(d, "owner_thaw", {}, [
          { address: asset.address, writable: true },
          { address: owner.address, signer: owner, writable: true },
          { address: CORE },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    expectOk(await transfer()); // thawed: the same transfer goes through
    expect(getAddressDecoder().decode(Buffer.from(acct(d.svm, asset.address).data).subarray(1, 33))).toBe(next.address);

    const collection = await generateKeyPairSigner();
    expectOk(
      await send(d.svm, payer, [
        ix(d, "plugin_collection", {}, [
          { address: collection.address, signer: collection, writable: true },
          { address: payer.address, signer: payer, writable: true },
          { address: CORE },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    expect(has(collection.address, "season")).toBe(true);
    const season = Buffer.from(acct(d.svm, collection.address).data);
    expect(season[season.indexOf(Buffer.from("season")) + 6 + 4]).toBe("2".charCodeAt(0)); // updated from "1"
    expectOk(
      await send(d.svm, payer, [
        ix(d, "drop_collection_attributes", {}, [
          { address: collection.address, writable: true },
          { address: payer.address, signer: payer, writable: true },
          { address: CORE },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    expect(has(collection.address, "season")).toBe(false);
  });

  it("creates a Bubblegum tree owned by the PDA and mints a compressed NFT", async () => {
    const payer = await fundedSigner(d.svm, 50n);
    const tree = await generateKeyPairSigner();
    const depth = 3;
    const buffer = 8;
    const space = 56 + 24 + buffer * (40 + 32 * depth) + (40 + 32 * depth);
    const [treeConfig] = await getProgramDerivedAddress({ programAddress: BUBBLEGUM, seeds: [getAddressEncoder().encode(tree.address)] });
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
    const config = () => Buffer.from(acct(d.svm, treeConfig).data);
    expect(getAddressDecoder().decode(config().subarray(8, 40))).toBe(studio); // tree creator
    expect(config().readBigUInt64LE(80)).toBe(0n); // num minted
    const owner = (await generateKeyPairSigner()).address;
    for (let i = 0; i < 2; i++)
      expectOk(
        await send(d.svm, payer, [
          ix(d, "mint_compressed", {}, [
            { address: treeConfig, writable: true },
            { address: owner },
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
    expect(config().readBigUInt64LE(80)).toBe(2n);
  });
});
