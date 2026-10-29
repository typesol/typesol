// Token Metadata collections: createV3's isCollection, createMasterEditionV3, verifyCollection (the end-to-end run is the
// tokens/nft-operations port) and masterEditionAddress.
import { fileURLToPath } from "node:url";
import { address, generateKeyPairSigner, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { deployFile, expectOk, fundedSigner, ix, send, compileErrors } from "../harness.js";

const MPL = address("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

describe("Token Metadata collections", () => {
  it("derives the master edition address", async () => {
    const d = await deployFile(fileURLToPath(new URL("../fixtures/mpl-edition.ts", import.meta.url)));
    const payer = await fundedSigner(d.svm);
    const mint = (await generateKeyPairSigner()).address;
    const res = expectOk(await send(d.svm, payer, [ix(d, "addresses", {}, [{ address: mint }])]));
    const enc = getAddressEncoder();
    const [want] = await getProgramDerivedAddress({ programAddress: MPL, seeds: ["metadata", enc.encode(MPL), enc.encode(mint), "edition"] });
    expect(getAddressDecoder().decode(new Uint8Array(res.returnData().data()))).toBe(want);
  });

  it("refuses misuse at compile time", () => {
    const errors = (body: string) =>
      compileErrors(
        `import { type AccountInfo, type Mut, type Signer, type SystemProgram, type TokenMetadataProgram, type TokenProgram } from "typesol";\n${body}\n`,
      );
    const params =
      "p: Mut<Signer>, e: Mut<AccountInfo>, m: Mut<AccountInfo>, md: Mut<AccountInfo>, ro: AccountInfo, tp: TokenProgram, sys: SystemProgram, mpl: TokenMetadataProgram";
    expect(errors(`export function f(${params}): void { mpl.createMasterEditionV3(e, m, p, p, p, md, tp, sys, 0n); }`)).toBe("");
    expect(errors(`export function f(${params}): void { mpl.createMasterEditionV3(e, m, p, p, p, md, tp, sys, null); }`)).toBe("");
    expect(errors(`export function f(${params}): void { mpl.createMasterEditionV3(ro, m, p, p, p, md, tp, sys, 0n); }`)).toMatch(
      /the edition must be writable/,
    );
    expect(errors(`export function f(${params}): void { mpl.verifyCollection(p, ro, m, md, ro, sys, ro); }`)).toMatch(/the metadata must be writable/);
    expect(
      errors(`export function f(${params}): void { mpl.createV3(md, m, p, p, p, sys, "n", "s", "u", 0n, true, { isCollection: true, sized: 1n }); }`),
    ).toMatch(/sized/);
  });
});
