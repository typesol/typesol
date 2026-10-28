// Core plugin values added after #48, against the real Core program.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { address, generateKeyPairSigner, getAddressEncoder } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_PROGRAM, acct, deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "./harness.js";

const CORE = address("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const CORE_SO = fileURLToPath(new URL("./programs/mpl_core.so", import.meta.url));

describe.skipIf(!existsSync(CORE_SO))("Metaplex Core: rule sets, MasterEdition, VerifiedCreators, Autograph, execute freezes", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/core-more.ts", import.meta.url)));
    d.svm.addProgramFromFile(CORE, CORE_SO);
  });
  const create = async (name: string) => {
    const payer = await fundedSigner(d.svm);
    const target = await generateKeyPairSigner();
    const res = await send(d.svm, payer, [
      ix(d, name, {}, [
        { address: target.address, signer: target, writable: true },
        { address: payer.address, signer: payer, writable: true },
        { address: CORE },
        { address: SYSTEM_PROGRAM },
      ]),
    ]);
    return { res, data: () => Buffer.from(acct(d.svm, target.address).data), payer };
  };

  it("writes a royalty deny list, verified creators and an autograph", async () => {
    const { res, data, payer } = await create("ruled");
    expectOk(res);
    const b = data();
    // RuleSet::ProgramDenyList (2), one program: Core.
    expect(b.includes(Buffer.concat([Buffer.from([2, 1, 0, 0, 0]), Buffer.from(getAddressEncoder().encode(CORE))]))).toBe(true);
    // VerifiedCreators: one signature (payer, verified).
    expect(b.includes(Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.from(getAddressEncoder().encode(payer.address)), Buffer.from([1])]))).toBe(true);
    expect(b.includes(Buffer.from("first!"))).toBe(true);
  });

  it("writes a collection's MasterEdition", async () => {
    const { res, data } = await create("edition");
    expectOk(res);
    // max_supply Some(10), name Some("Genesis"), uri None.
    const name = Buffer.from("Genesis");
    expect(data().includes(Buffer.concat([Buffer.from([1, 10, 0, 0, 0, 1, name.length, 0, 0, 0]), name, Buffer.from([0])]))).toBe(true);
  });

  it("writes an execute freeze", async () => {
    expectOk((await create("exec_frozen")).res);
  });
});
