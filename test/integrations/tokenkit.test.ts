import { getAddressDecoder } from "@solana/kit";
import { pk } from "../ports-helpers.js";
import { existsSync } from "node:fs";
import { getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import * as spl from "@solana-program/token";
import * as t22 from "@solana-program/token-2022";
import { type Address, type KeyPairSigner, address, generateKeyPairSigner, lamports, some } from "@solana/kit";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  BN,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  customError,
  deployFile,
  expectOk,
  fundedSigner,
  ix,
  pda,
  send,
  type Deployed,
  TOKEN_2022,
  ATA_PROGRAM,
} from "../harness.js";

const MPL = address("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

// Metaplex programs are not redistributed with TypeSOL (Metaplex NFT license): `pnpm fetch:programs` downloads them.
const MPL_SO = fileURLToPath(new URL("../programs/mpl_token_metadata.so", import.meta.url));
const HAVE_MPL = existsSync(MPL_SO);

describe("ATA, token metadata (test/fixtures/tokenkit.ts)", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/tokenkit.ts", import.meta.url)));
    if (HAVE_MPL) d.svm.addProgramFromFile(MPL, MPL_SO);
  });

  /** A mint whose authority is the program's issuer PDA, plus the issuer account. */
  async function issuerWith(program: Address, extensions: "none" | "metadataPointer" = "none") {
    const admin = await fundedSigner(d.svm, 20n);
    const mint = await generateKeyPairSigner();
    const [issuer] = await pda(d.programId, ["issuer", mint.address]);
    const ext =
      extensions === "metadataPointer" ? [{ __kind: "MetadataPointer" as const, authority: some(admin.address), metadataAddress: some(mint.address) }] : [];
    const space = program === TOKEN_2022 && ext.length ? t22.getMintSize(ext) : spl.getMintSize();
    const ixs = [
      getCreateAccountInstruction({
        payer: admin,
        newAccount: mint,
        lamports: lamports(d.svm.minimumBalanceForRentExemption(BigInt(space))),
        space,
        programAddress: program,
      }),
      ...(extensions === "metadataPointer"
        ? [t22.getInitializeMetadataPointerInstruction({ mint: mint.address, authority: admin.address, metadataAddress: mint.address })]
        : []),
      program === TOKEN_2022
        ? t22.getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: issuer })
        : spl.getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: issuer }),
    ];
    expectOk(await send(d.svm, admin, ixs));
    expectOk(
      await send(d.svm, admin, [
        ix(d, "setup", {}, [
          { address: admin.address, signer: admin, writable: true },
          { address: issuer, writable: true },
          { address: mint.address },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    return { admin, mint: mint.address, issuer };
  }

  async function ataOf(owner: Address, mint: Address, program: Address) {
    return (await t22.findAssociatedTokenPda({ owner, mint, tokenProgram: program }))[0];
  }

  it("refuses a Token-2022 multisig (355 bytes) passed as a Mint, and mints owned by other programs", async () => {
    const admin = await fundedSigner(d.svm, 20n);
    const fake = (await generateKeyPairSigner()).address;
    const plant = (owner: Address, len: number) => {
      const data = new Uint8Array(len).fill(1); // byte 45 (is_initialized) = 1, byte 108 nonzero
      d.svm.setAccount({ address: fake, data, executable: false, lamports: lamports(10_000_000n), programAddress: owner, space: BigInt(len) } as never);
    };
    const setup = async () => {
      const [issuer] = await pda(d.programId, ["issuer", fake]);
      return send(d.svm, admin, [
        ix(d, "setup", {}, [
          { address: admin.address, signer: admin, writable: true },
          { address: issuer, writable: true },
          { address: fake },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    };
    plant(TOKEN_2022, 355);
    expect(customError(await setup())).toBe(3003);
    plant(SYSTEM_PROGRAM, 82);
    expect(customError(await setup())).toBe(3007);
  });

  for (const [label, program] of [
    ["SPL Token", TOKEN_PROGRAM],
    ["Token-2022", TOKEN_2022],
  ] as const) {
    it(`creates associated token accounts through a CPI (${label}), idempotently, and checks the address`, async () => {
      const { admin, mint } = await issuerWith(program);
      const user = await generateKeyPairSigner();
      const ata = await ataOf(user.address, mint, program);
      const open = (target: Address) =>
        ix(d, "open_account", {}, [
          { address: admin.address, signer: admin, writable: true },
          { address: user.address },
          { address: target, writable: true },
          { address: mint },
          { address: SYSTEM_PROGRAM },
          { address: program },
          { address: ATA_PROGRAM },
        ]);
      expectOk(await send(d.svm, admin, [open(ata)]));
      const acct = d.svm.getAccount(ata) as { exists: boolean; data: Uint8Array; programAddress: Address };
      expect(acct.exists && acct.programAddress).toBe(program);
      expect(Buffer.from(acct.data.subarray(32, 64))).toEqual(
        Buffer.from(new Uint8Array((await import("@solana/kit")).getAddressEncoder().encode(user.address))),
      );
      expectOk(await send(d.svm, admin, [open(ata)])); // idempotent
      expect(customError(await send(d.svm, admin, [open((await generateKeyPairSigner()).address)]))).toBe(6000);
    });
  }

  it("names a Token-2022 mint with the metadata extension, signed by the PDA mint authority", async () => {
    const { admin, mint, issuer } = await issuerWith(TOKEN_2022, "metadataPointer");
    // The metadata TLV grows the mint: top up lamports first (as clients do).
    expectOk(await send(d.svm, admin, [getTransferSolInstruction({ source: admin, destination: mint, amount: lamports(10_000_000n) })]));
    expectOk(
      await send(d.svm, admin, [
        ix(d, "name_token2022", { name: "TypeSOL Coin", symbol: "DEMO", uri: "https://example.com/coin.json" }, [
          { address: admin.address, signer: admin },
          { address: issuer },
          { address: mint, writable: true },
          { address: TOKEN_2022 },
        ]),
      ]),
    );
    const data = Buffer.from((d.svm.getAccount(mint) as { data: Uint8Array }).data);
    expect(data.includes(Buffer.from("TypeSOL Coin"))).toBe(true);
    expect(data.includes(Buffer.from("DEMO"))).toBe(true);
    expect(data.includes(Buffer.from("https://example.com/coin.json"))).toBe(true);
  });

  it.skipIf(!HAVE_MPL)("creates Metaplex metadata through the real Token Metadata program", async () => {
    const { admin, mint, issuer } = await issuerWith(TOKEN_PROGRAM);
    const [metadata] = await pda(MPL, ["metadata", MPL, mint]);
    const name = (target: Address, who: KeyPairSigner = admin) =>
      ix(d, "name_metaplex", { name: "TypeSOL", symbol: "DEMO", uri: "https://example.com/m.json" }, [
        { address: who.address, signer: who, writable: true },
        { address: issuer },
        { address: mint },
        { address: target, writable: true },
        { address: SYSTEM_PROGRAM },
        { address: MPL },
      ]);
    expect(customError(await send(d.svm, admin, [name((await generateKeyPairSigner()).address)]))).toBe(6002); // not the metadata PDA
    expectOk(await send(d.svm, admin, [name(metadata)]));
    const acct = d.svm.getAccount(metadata) as { exists: boolean; data: Uint8Array; programAddress: Address };
    expect(acct.exists && acct.programAddress).toBe(MPL);
    const data = Buffer.from(acct.data);
    expect(data[0]).toBe(4); // Key::MetadataV1
    expect(data.includes(Buffer.from("TypeSOL"))).toBe(true);
    expect(data.includes(Buffer.from("https://example.com/m.json"))).toBe(true);
  });

  it.skipIf(!HAVE_MPL)("writes creators and an unverified collection into Metaplex metadata", async () => {
    const { admin, mint, issuer } = await issuerWith(TOKEN_PROGRAM);
    const [metadata] = await pda(MPL, ["metadata", MPL, mint]);
    const artist = (await generateKeyPairSigner()).address;
    const collectionMint = (await generateKeyPairSigner()).address;
    expectOk(
      await send(d.svm, admin, [
        ix(d, "name_with_creators", { artist: pk(artist), collection_mint: pk(collectionMint) }, [
          { address: admin.address, signer: admin, writable: true },
          { address: issuer },
          { address: mint },
          { address: metadata, writable: true },
          { address: SYSTEM_PROGRAM },
          { address: MPL },
        ]),
      ]),
    );
    // Metadata: key, update authority, mint, name, symbol, uri, fee, creators, primary sale, mutable, edition nonce,
    // token standard, collection.
    const acct = d.svm.getAccount(metadata) as { exists: boolean; data: Uint8Array };
    const b = Buffer.from(acct.data);
    let at = 1 + 32 + 32;
    const str = () => {
      const n = b.readUInt32LE(at);
      const v = b
        .subarray(at + 4, at + 4 + n)
        .toString()
        .replace(/\0+$/, "");
      at += 4 + n;
      return v;
    };
    const key = () => {
      const v = getAddressDecoder().decode(b.subarray(at, at + 32));
      at += 32;
      return v;
    };
    expect([str(), str(), str()]).toEqual(["TypeSOL #1", "TSOL", "https://example.com/1.json"]);
    expect(b.readUInt16LE(at)).toBe(250);
    at += 2;
    expect(b[at++]).toBe(1); // creators: Some
    const n = b.readUInt32LE(at);
    at += 4;
    const creators = Array.from({ length: n }, () => ({ address: key(), verified: b[at++] === 1, share: b[at++] }));
    expect(creators).toEqual([
      { address: artist, verified: false, share: 70 },
      { address: admin.address, verified: false, share: 30 },
    ]);
    at += 1; // primary sale happened
    expect(b[at++]).toBe(0); // is_mutable: false
    at += b[at] ? 2 : 1; // edition nonce
    at += b[at] ? 2 : 1; // token standard
    expect(b[at++]).toBe(1); // collection: Some
    expect(b[at++]).toBe(0); // unverified
    expect(key()).toBe(collectionMint);
  });

  it.skipIf(!HAVE_MPL)("reads createV3's arguments in source order", async () => {
    const { admin, mint, issuer } = await issuerWith(TOKEN_PROGRAM);
    const [metadata] = await pda(MPL, ["metadata", MPL, mint]);
    const [note] = await pda(d.programId, ["note", admin.address]);
    expectOk(
      await send(d.svm, admin, [
        ix(d, "note_setup", {}, [{ address: admin.address, signer: admin, writable: true }, { address: note, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    expectOk(
      await send(d.svm, admin, [
        ix(d, "name_in_order", {}, [
          { address: admin.address, signer: admin, writable: true },
          { address: issuer },
          { address: mint },
          { address: metadata, writable: true },
          { address: SYSTEM_PROGRAM },
          { address: MPL },
          { address: note, writable: true },
        ]),
      ]),
    );
    const b = Buffer.from((d.svm.getAccount(metadata) as { data: Uint8Array }).data);
    let at = 1 + 32 + 32;
    const n = b.readUInt32LE(at);
    expect(
      b
        .subarray(at + 4, at + 4 + n)
        .toString()
        .replace(/\0+$/, ""),
    ).toBe("before");
    at += 4 + n;
    for (let i = 0; i < 2; i++) at += 4 + b.readUInt32LE(at); // symbol, uri
    expect(b.readUInt16LE(at)).toBe(111);
  });
});
