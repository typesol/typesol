// Token Metadata BurnV1 through the real program (test/fixtures/mpl-burn.ts): an NFT a PDA holds, burned by the program.
import { type Address, generateKeyPairSigner, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SYSTEM_PROGRAM, TOKEN_PROGRAM, deployFile, expectOk, fundedSigner, ix, pda, send } from "../harness.js";

const MPL = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s" as Address;
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;
const IXS = "Sysvar1nstructions1111111111111111111111111" as Address;
const MPL_SO = fileURLToPath(new URL("../programs/mpl_token_metadata.so", import.meta.url));
const enc = getAddressEncoder();

describe.skipIf(!existsSync(MPL_SO))("Token Metadata burnV1", () => {
  it("burns an NFT its PDA holds: token account and edition closed, metadata cleared, rent to the PDA", async () => {
    const d = await deployFile(fileURLToPath(new URL("../fixtures/mpl-burn.ts", import.meta.url)));
    d.svm.addProgramFromFile(MPL, MPL_SO);
    const user = await fundedSigner(d.svm, 10n);
    const [authority] = await pda(d.programId, ["authority"]);
    const [vault] = await pda(d.programId, ["vault"]);
    const mint = await generateKeyPairSigner();
    const [token] = await getProgramDerivedAddress({ programAddress: ATA, seeds: [enc.encode(vault), enc.encode(TOKEN_PROGRAM), enc.encode(mint.address)] });
    const [metadata] = await getProgramDerivedAddress({ programAddress: MPL, seeds: ["metadata", enc.encode(MPL), enc.encode(mint.address)] });
    const [edition] = await getProgramDerivedAddress({ programAddress: MPL, seeds: ["metadata", enc.encode(MPL), enc.encode(mint.address), "edition"] });
    expectOk(
      await send(d.svm, user, [
        ix(d, "mint_to_vault", {}, [
          { address: user.address, signer: user, writable: true },
          { address: mint.address, signer: mint, writable: true },
          { address: authority },
          { address: vault },
          { address: token, writable: true },
          { address: metadata, writable: true },
          { address: edition, writable: true },
          { address: SYSTEM_PROGRAM },
          { address: TOKEN_PROGRAM },
          { address: ATA },
          { address: MPL },
        ]),
      ]),
    );
    expect(d.svm.getAccount(metadata).exists).toBe(true);
    const burn = (holder: Address) =>
      send(d.svm, user, [
        ix(d, "burn_from_vault", {}, [
          { address: holder, writable: true },
          { address: metadata, writable: true },
          { address: edition, writable: true },
          { address: mint.address, writable: true },
          { address: token, writable: true },
          { address: SYSTEM_PROGRAM },
          { address: IXS },
          { address: TOKEN_PROGRAM },
          { address: MPL },
        ]),
      ]);
    // Another address in the vault's slot is not the PDA (2006).
    expect(await burn(user.address)).toBeInstanceOf(FailedTransactionMetadata);
    expectOk(await burn(vault));
    for (const a of [token, edition]) expect(d.svm.getAccount(a).exists).toBe(false);
    // Token Metadata keeps the metadata account as one cleared byte (holding its protocol fee).
    const md = d.svm.getAccount(metadata);
    expect(md.exists && [md.data.length, md.data[0]]).toEqual([1, 0]);
    expect(d.svm.getBalance(vault) ?? 0n).toBeGreaterThan(0n);
  });
});
