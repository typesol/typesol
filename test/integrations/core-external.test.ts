// Metaplex Core external plugin adapters through the real Core program: added, written, removed.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { address, generateKeyPairSigner, getAddressEncoder } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_PROGRAM, acct, customError, deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "../harness.js";

const CORE = address("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const CORE_SO = fileURLToPath(new URL("../programs/mpl_core.so", import.meta.url));

describe.skipIf(!existsSync(CORE_SO))("Metaplex Core external plugin adapters", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/core-external.ts", import.meta.url)));
    d.svm.addProgramFromFile(CORE, CORE_SO);
  });
  const bytes = (a: string) => Buffer.from(acct(d.svm, a as never).data);
  const key = (a: string) => Buffer.from(getAddressEncoder().encode(a as never));

  it("adds AppData and writes it, from a string and from a Vec<u8> argument", async () => {
    const payer = await fundedSigner(d.svm);
    const asset = await generateKeyPairSigner();
    const P = { address: payer.address, signer: payer, writable: true };
    expectOk(
      await send(d.svm, payer, [
        ix(d, "with_app_data", {}, [{ address: asset.address, signer: asset, writable: true }, P, { address: CORE }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    expect(bytes(asset.address).includes(Buffer.from('{"score":7}'))).toBe(true);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "write_bytes", { data: Buffer.from([9, 8, 7, 6, 5]) }, [
          { address: asset.address, writable: true },
          P,
          { address: CORE },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const b = bytes(asset.address);
    expect(b.includes(Buffer.from([9, 8, 7, 6, 5]))).toBe(true);
    expect(b.includes(Buffer.from('{"score":7}'))).toBe(false);
  });

  it("adds an Oracle and removes it, and adds a LifecycleHook with extra accounts", async () => {
    const payer = await fundedSigner(d.svm);
    const asset = await generateKeyPairSigner();
    const oracle = (await generateKeyPairSigner()).address;
    const P = { address: payer.address, signer: payer, writable: true };
    expectOk(
      await send(d.svm, payer, [
        ix(d, "with_oracle", {}, [
          { address: asset.address, signer: asset, writable: true },
          P,
          { address: oracle },
          { address: CORE },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    expect(bytes(asset.address).includes(key(oracle))).toBe(true);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "drop_oracle", {}, [{ address: asset.address, writable: true }, P, { address: oracle }, { address: CORE }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    expect(bytes(asset.address).includes(key(oracle))).toBe(false);

    // Core has lifecycle hooks switched off for now: it reads the adapter, then answers NotAvailable (23).
    const hooked = await generateKeyPairSigner();
    const hook = (await generateKeyPairSigner()).address;
    const res = await send(d.svm, payer, [
      ix(d, "with_hook", {}, [
        { address: hooked.address, signer: hooked, writable: true },
        P,
        { address: hook },
        { address: CORE },
        { address: SYSTEM_PROGRAM },
      ]),
    ]);
    expect(customError(res)).toBe(23);
  });

  it("adds, writes and removes an external plugin on a collection", async () => {
    const payer = await fundedSigner(d.svm);
    const collection = await generateKeyPairSigner();
    const P = { address: payer.address, signer: payer, writable: true };
    expectOk(
      await send(d.svm, payer, [
        ix(d, "collection_data", {}, [{ address: collection.address, signer: collection, writable: true }, P, { address: CORE }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    expect(bytes(collection.address).includes(Buffer.from("collection-data"))).toBe(true);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "clear_collection_data", {}, [{ address: collection.address, writable: true }, P, { address: CORE }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    expect(bytes(collection.address).includes(Buffer.from("collection-data"))).toBe(false);
  });
});
