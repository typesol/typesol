// Ports of the tokens/ Anchor programs of solana-developers/program-examples that call Metaplex Token Metadata: each
// describe runs the flows of the original's TypeScript tests against the TypeSOL rewrite under test/ports/tokens/.
// Status and reasons per program: test/ports/README.md.
import { getMintDecoder } from "@solana-program/token";
import { type Address, address, generateKeyPairSigner, getAddressDecoder, getProgramDerivedAddress, some } from "@solana/kit";
import type { LiteSVM } from "litesvm";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ATA_PROGRAM, BN, SYSTEM_PROGRAM, TOKEN_PROGRAM, acct, customError, expectOk, fundedSigner, ix, pda, send } from "./harness.js";
import { METADATA_PROGRAM, addrBytes, ataOf, deployPort, tokenBalance } from "./ports-helpers.js";

// Metaplex Token Metadata is not redistributed with TypeSOL (Metaplex NFT license): `pnpm fetch:programs` downloads it.
const MPL_METADATA_SO = fileURLToPath(new URL("./programs/mpl_token_metadata.so", import.meta.url));
const HAVE_METADATA = existsSync(MPL_METADATA_SO);
const SYSVAR_RENT = address("SysvarRent111111111111111111111111111111111");
const META = {
  name: "Solana Gold",
  symbol: "GOLDSOL",
  uri: "https://raw.githubusercontent.com/solana-developers/program-examples/new-examples/tokens/tokens/.assets/spl-token.json",
};

async function metadataPda(mint: Address): Promise<Address> {
  const [a] = await getProgramDerivedAddress({ programAddress: METADATA_PROGRAM, seeds: ["metadata", addrBytes(METADATA_PROGRAM), addrBytes(mint)] });
  return a;
}

/** The update authority, mint and name recorded in a Metaplex metadata account. */
function readMetadata(svm: LiteSVM, a: Address) {
  const data = Buffer.from(acct(svm, a).data);
  const dec = getAddressDecoder();
  const nameLen = data.readUInt32LE(65);
  return {
    updateAuthority: dec.decode(data.subarray(1, 33)),
    mint: dec.decode(data.subarray(33, 65)),
    name: data
      .subarray(69, 69 + nameLen)
      .toString("utf8")
      .replace(/\0+$/, ""),
  };
}

describe.skipIf(!HAVE_METADATA)("port: tokens/create-token", () => {
  it("creates an SPL token and an NFT mint with Metaplex metadata", async () => {
    const d = await deployPort("tokens/create-token.ts", "GwvQ53QTu1xz3XXYfG5m5jEqwhMBvVBudPS8TUuFYnhT");
    d.svm.addProgramFromFile(METADATA_PROGRAM, MPL_METADATA_SO);
    const payer = await fundedSigner(d.svm);
    for (const decimals of [9, 0]) {
      const mint = await generateKeyPairSigner();
      const metadata = await metadataPda(mint.address);
      expectOk(
        await send(d.svm, payer, [
          ix(d, "create_token_mint", { token_decimals: decimals, token_name: META.name, token_symbol: META.symbol, token_uri: META.uri }, [
            { address: payer.address, signer: payer, writable: true },
            { address: metadata, writable: true },
            { address: mint.address, signer: mint, writable: true },
            { address: METADATA_PROGRAM },
            { address: TOKEN_PROGRAM },
            { address: SYSTEM_PROGRAM },
            { address: SYSVAR_RENT },
          ]),
        ]),
      );
      const m = getMintDecoder().decode(acct(d.svm, mint.address).data);
      expect(m.decimals).toBe(decimals);
      expect(m.mintAuthority).toEqual(some(payer.address));
      expect(readMetadata(d.svm, metadata)).toEqual({ updateAuthority: payer.address, mint: mint.address, name: META.name });
    }
    // A metadata account that is not the mint's PDA under Token Metadata is refused.
    const mint = await generateKeyPairSigner();
    const wrong = await metadataPda((await generateKeyPairSigner()).address);
    const res = await send(d.svm, payer, [
      ix(d, "create_token_mint", { token_decimals: 9, token_name: META.name, token_symbol: META.symbol, token_uri: META.uri }, [
        { address: payer.address, signer: payer, writable: true },
        { address: wrong, writable: true },
        { address: mint.address, signer: mint, writable: true },
        { address: METADATA_PROGRAM },
        { address: TOKEN_PROGRAM },
        { address: SYSTEM_PROGRAM },
        { address: SYSVAR_RENT },
      ]),
    ]);
    expect(customError(res)).toBe(2006);
  });
});

describe.skipIf(!HAVE_METADATA)("port: tokens/transfer-tokens", () => {
  it("creates a token, mints to a new ATA and transfers to another new ATA", async () => {
    const d = await deployPort("tokens/transfer-tokens.ts", "nHi9DdNjuupjQ3c8AJU9sChB5gLbZvTLsJQouY4hU67");
    d.svm.addProgramFromFile(METADATA_PROGRAM, MPL_METADATA_SO);
    const payer = await fundedSigner(d.svm);
    const recipient = await fundedSigner(d.svm, 1n);
    const mint = await generateKeyPairSigner();
    const metadata = await metadataPda(mint.address);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "create_token", { token_title: META.name, token_symbol: META.symbol, token_uri: META.uri }, [
          { address: payer.address, signer: payer, writable: true },
          { address: mint.address, signer: mint, writable: true },
          { address: metadata, writable: true },
          { address: TOKEN_PROGRAM },
          { address: METADATA_PROGRAM },
          { address: SYSTEM_PROGRAM },
          { address: SYSVAR_RENT },
        ]),
      ]),
    );
    expect(readMetadata(d.svm, metadata).name).toBe(META.name);
    const payerAta = await ataOf(payer.address, mint.address);
    const recipientAta = await ataOf(recipient.address, mint.address);
    const mintTo = (to: Address, toAta: Address) =>
      send(d.svm, payer, [
        ix(d, "mint_token", { amount: new BN(100) }, [
          { address: payer.address, signer: payer, writable: true },
          { address: to },
          { address: mint.address, writable: true },
          { address: toAta, writable: true },
          { address: TOKEN_PROGRAM },
          { address: ATA_PROGRAM },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    const minted = expectOk(await mintTo(payer.address, payerAta)).logs();
    expect(minted).toContain(`Program log: Mint: ${mint.address}`);
    expect(minted).toContain(`Program log: Token Address: ${payerAta}`);
    expect(tokenBalance(d.svm, payerAta)).toBe(100n * 10n ** 9n);
    // The ATA must belong to the recipient passed.
    expect(customError(await mintTo(recipient.address, payerAta))).toBe(2009);
    const transfer = (amount: number) =>
      send(d.svm, payer, [
        ix(d, "transfer_tokens", { amount: new BN(amount) }, [
          { address: payer.address, signer: payer, writable: true },
          { address: recipient.address },
          { address: mint.address, writable: true },
          { address: payerAta, writable: true },
          { address: recipientAta, writable: true },
          { address: TOKEN_PROGRAM },
          { address: ATA_PROGRAM },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    const sent = expectOk(await transfer(50)).logs();
    expect(sent).toContain(`Program log: From Token Address: ${payerAta}`);
    expect(sent).toContain(`Program log: To Token Address: ${recipientAta}`);
    expect(tokenBalance(d.svm, recipientAta)).toBe(50n * 10n ** 9n);
    expect(tokenBalance(d.svm, payerAta)).toBe(50n * 10n ** 9n);
    // More than the sender holds: SPL Token refuses (InsufficientFunds = 1).
    expect(customError(await transfer(51))).toBe(1);
  });
});

describe.skipIf(!HAVE_METADATA)("port: tokens/pda-mint-authority", () => {
  it("creates a token whose mint authority is a PDA, mints for the admin only", async () => {
    const d = await deployPort("tokens/pda-mint-authority.ts", "3LFrPHqwk5jMrmiz48BFj6NV2k4NjobgTe1jChzx3JGD");
    d.svm.addProgramFromFile(METADATA_PROGRAM, MPL_METADATA_SO);
    const payer = await fundedSigner(d.svm);
    const [mint] = await pda(d.programId, ["mint"]);
    const [mintConfig] = await pda(d.programId, ["mint_config"]);
    const metadata = await metadataPda(mint);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "create_token", { token_name: META.name, token_symbol: META.symbol, token_uri: META.uri }, [
          { address: payer.address, signer: payer, writable: true },
          { address: mint, writable: true },
          { address: metadata, writable: true },
          { address: mintConfig, writable: true },
          { address: TOKEN_PROGRAM },
          { address: METADATA_PROGRAM },
          { address: SYSTEM_PROGRAM },
          { address: SYSVAR_RENT },
        ]),
      ]),
    );
    const m = getMintDecoder().decode(acct(d.svm, mint).data);
    expect(m.mintAuthority).toEqual(some(mint));
    expect(m.freezeAuthority).toEqual(some(mint));
    expect(readMetadata(d.svm, metadata).updateAuthority).toBe(mint);
    const mintFor = (who: typeof payer) =>
      send(d.svm, who, [
        ix(d, "mint_token", { amount: new BN(100) }, [
          { address: who.address, signer: who, writable: true },
          { address: mint, writable: true },
          { address: mintConfig },
          { address: atas.get(who.address)!, writable: true },
          { address: TOKEN_PROGRAM },
          { address: ATA_PROGRAM },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    const atas = new Map<string, Address>();
    atas.set(payer.address, await ataOf(payer.address, mint));
    expectOk(await mintFor(payer));
    expect(tokenBalance(d.svm, atas.get(payer.address)!)).toBe(100n * 10n ** 9n);
    // Someone who did not create the token cannot mint.
    const stranger = await fundedSigner(d.svm);
    atas.set(stranger.address, await ataOf(stranger.address, mint));
    expect(customError(await mintFor(stranger))).toBe(6000);
  });
});

describe.skipIf(!HAVE_METADATA)("port: tokens/nft-operations", () => {
  /** Creators and collection of a Metaplex metadata account (Borsh after the fixed header). */
  function parseMetadata(svm: LiteSVM, a: Address) {
    const data = Buffer.from(acct(svm, a).data);
    const dec = getAddressDecoder();
    let at = 65;
    const str = () => {
      const n = data.readUInt32LE(at);
      const s = data
        .subarray(at + 4, at + 4 + n)
        .toString("utf8")
        .replace(/\0+$/, "");
      at += 4 + n;
      return s;
    };
    const name = str();
    str();
    str();
    at += 2;
    const creators: { address: Address; verified: boolean; share: number }[] = [];
    if (data[at++] === 1) {
      const n = data.readUInt32LE(at);
      at += 4;
      for (let i = 0; i < n; i++, at += 34)
        creators.push({ address: dec.decode(data.subarray(at, at + 32)), verified: data[at + 32] === 1, share: data[at + 33] });
    }
    at += 2; // primary_sale_happened, is_mutable
    if (data[at++] === 1) at += 1; // edition_nonce
    if (data[at++] === 1) at += 1; // token_standard
    const collection = data[at++] === 1 ? { verified: data[at] === 1, key: dec.decode(data.subarray(at + 1, at + 33)) } : null;
    return { name, creators, collection };
  }

  it("creates a collection NFT, mints an NFT into it and verifies it", async () => {
    const d = await deployPort("tokens/nft-operations.ts", "3EMcczaGi9ivdLxvvFwRbGYeEUEHpGwabXegARw4jLxa");
    const { svm } = d;
    svm.addProgramFromFile(METADATA_PROGRAM, MPL_METADATA_SO);
    const user = await fundedSigner(svm);
    const [authority] = await pda(d.programId, ["authority"]);
    const edition = async (mint: Address) =>
      (await getProgramDerivedAddress({ programAddress: METADATA_PROGRAM, seeds: ["metadata", addrBytes(METADATA_PROGRAM), addrBytes(mint), "edition"] }))[0];

    const collection = await generateKeyPairSigner();
    const collectionMetadata = await metadataPda(collection.address);
    const collectionEdition = await edition(collection.address);
    expectOk(
      await send(svm, user, [
        ix(d, "create_collection", {}, [
          { address: user.address, signer: user, writable: true },
          { address: collection.address, signer: collection, writable: true },
          { address: authority },
          { address: collectionMetadata, writable: true },
          { address: collectionEdition, writable: true },
          { address: await ataOf(user.address, collection.address), writable: true },
          { address: SYSTEM_PROGRAM },
          { address: TOKEN_PROGRAM },
          { address: ATA_PROGRAM },
          { address: METADATA_PROGRAM },
        ]),
      ]),
    );
    expect(parseMetadata(svm, collectionMetadata)).toEqual({
      name: "DummyCollection",
      creators: [{ address: authority, verified: true, share: 100 }],
      collection: null,
    });
    expect(acct(svm, collectionEdition).data[0]).toBe(6); // MasterEditionV2

    const nft = await generateKeyPairSigner();
    const nftMetadata = await metadataPda(nft.address);
    const mintNft = async () =>
      send(svm, user, [
        ix(d, "mint_nft", {}, [
          { address: user.address, signer: user, writable: true },
          { address: nft.address, signer: nft, writable: true },
          { address: await ataOf(user.address, nft.address), writable: true },
          { address: nftMetadata, writable: true },
          { address: await edition(nft.address), writable: true },
          { address: authority },
          { address: collection.address, writable: true },
          { address: SYSTEM_PROGRAM },
          { address: TOKEN_PROGRAM },
          { address: ATA_PROGRAM },
          { address: METADATA_PROGRAM },
        ]),
      ]);
    expectOk(await mintNft());
    expect(tokenBalance(svm, await ataOf(user.address, nft.address))).toBe(1n);
    expect(parseMetadata(svm, nftMetadata).collection).toEqual({ verified: false, key: collection.address });

    const verify = (metadata: Address) =>
      send(svm, user, [
        ix(d, "verify_collection", {}, [
          { address: user.address, signer: user },
          { address: metadata, writable: true },
          { address: nft.address },
          { address: authority },
          { address: collection.address },
          { address: collectionMetadata, writable: true },
          { address: collectionEdition },
          { address: SYSTEM_PROGRAM },
          { address: address("Sysvar1nstructions1111111111111111111111111") },
          { address: METADATA_PROGRAM },
        ]),
      ]);
    // The collection's master edition passed as the item's metadata is not a Metadata account: AccountDidNotDeserialize (3003), as in Anchor.
    // Anchor's Account<MetadataAccount> fails deserializing it instead, with AccountDidNotDeserialize (3003).
    expect(customError(await verify(collectionEdition))).toBe(3003);
    expectOk(await verify(nftMetadata));
    expect(parseMetadata(svm, nftMetadata).collection).toEqual({ verified: true, key: collection.address });
  });
});
