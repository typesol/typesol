import { type Address, address, generateKeyPairSigner, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { TOKEN_PROGRAM, customError, deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "./harness.js";

const MPL = address("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");
const enc = getAddressEncoder();

describe("docs, clock, Owner/Executable, Seeds program, ProgramData (test/fixtures/platform.ts)", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/platform.ts", import.meta.url)));
  });
  const u64 = (r: ReturnType<typeof expectOk>) => Buffer.from(r.returnData().data()).readBigUInt64LE();

  it("carries JSDoc into the IDL: instructions, @param, structs and fields", () => {
    const clock = d.idl.instructions.find((i) => i.name === "clock")!;
    expect(clock.docs).toEqual(["Packs the clock: slot * 1000 + epoch.", "Second line of docs."]);
    const owners = d.idl.instructions.find((i) => i.name === "owners")!;
    expect(owners.accounts.map((a) => (a as { docs?: string[] }).docs)).toEqual([["any account owned by SPL Token"], ["an executable account"]]);
    const note = d.idl.types!.find((t) => t.name === "Note")!;
    expect(note.docs).toEqual(["A record kept by the program."]);
    expect((note.type as { fields: { docs?: string[] }[] }).fields[0].docs).toEqual(["Who wrote it."]);
  });

  it("reads the clock's slot and epoch", async () => {
    const payer = await fundedSigner(d.svm);
    d.svm.warpToSlot(1234n);
    const c = d.svm.getClock();
    expect(u64(expectOk(await send(d.svm, payer, [ix(d, "clock", {}, [])])))).toBe(c.slot * 1000n + c.epoch);
  });

  it("checks Owner (2004) and Executable (2007)", async () => {
    const payer = await fundedSigner(d.svm);
    const tokenAcct = (await generateKeyPairSigner()).address;
    d.svm.setAccount({
      address: tokenAcct,
      data: new Uint8Array(165),
      executable: false,
      lamports: 3_000_000n as never,
      programAddress: TOKEN_PROGRAM,
      space: 165n,
    });
    const call = (a: Address, p: Address) => send(d.svm, payer, [ix(d, "owners", {}, [{ address: a }, { address: p }])]);
    expectOk(await call(tokenAcct, TOKEN_PROGRAM));
    expect(customError(await call(payer.address, TOKEN_PROGRAM))).toBe(2004);
    expect(customError(await call(tokenAcct, tokenAcct))).toBe(2007);
  });

  it("derives Seeds under another program, fixed or given as a parameter (2006), and describes it in the IDL", async () => {
    const payer = await fundedSigner(d.svm);
    const mint = (await generateKeyPairSigner()).address;
    const [md] = await getProgramDerivedAddress({ programAddress: MPL, seeds: ["metadata", enc.encode(MPL), enc.encode(mint)] });
    for (const name of ["metadata_of", "metadata_via"]) {
      const call = (m: Address) => send(d.svm, payer, [ix(d, name, {}, [{ address: m }, { address: MPL }, { address: mint }])]);
      expectOk(await call(md));
      expect(customError(await call(mint))).toBe(2006);
    }
    const acct = d.idl.instructions.find((i) => i.name === "metadata_of")!.accounts[0] as { pda: { program: unknown } };
    expect(acct.pda.program).toEqual({ kind: "const", value: [...enc.encode(MPL)] });
    const via = d.idl.instructions.find((i) => i.name === "metadata_via")!.accounts[0] as { pda: { program: unknown } };
    expect(via.pda.program).toEqual({ kind: "account", path: "metadata_program" });
  });

  it("checks this program's ProgramData account and reads the upgrade authority", async () => {
    const admin = await fundedSigner(d.svm);
    const [pdAddr] = await getProgramDerivedAddress({ programAddress: LOADER, seeds: [enc.encode(d.programId)] });
    const plant = (at: Address, authority: Address | null, slot = 77n) => {
      const data = Buffer.alloc(45);
      data.writeUInt32LE(3, 0);
      data.writeBigUInt64LE(slot, 4);
      if (authority) {
        data[12] = 1;
        Buffer.from(enc.encode(authority)).copy(data, 13);
      }
      d.svm.setAccount({ address: at, data: new Uint8Array(data), executable: false, lamports: 10_000_000n as never, programAddress: LOADER, space: 45n });
    };
    const call = (pd: Address, who = admin) => send(d.svm, who, [ix(d, "admin_only", {}, [{ address: pd }, { address: who.address, signer: who }])]);
    plant(pdAddr, admin.address);
    expect(u64(expectOk(await call(pdAddr)))).toBe(77n);
    expect(customError(await call(pdAddr, await fundedSigner(d.svm)))).toBe(6000);
    plant(pdAddr, null);
    expect(customError(await call(pdAddr))).toBe(6000);
    const fake = (await generateKeyPairSigner()).address;
    plant(fake, admin.address);
    expect(customError(await call(fake))).toBe(2012);
    const pdIdl = d.idl.instructions.find((i) => i.name === "admin_only")!.accounts[0] as { pda: { seeds: unknown; program: unknown } };
    expect(pdIdl.pda).toEqual({ seeds: [{ kind: "const", value: [...enc.encode(d.programId)] }], program: { kind: "const", value: [...enc.encode(LOADER)] } });
  });
});
