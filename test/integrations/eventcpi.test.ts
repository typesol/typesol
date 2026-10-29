import { generateKeyPairSigner, getProgramDerivedAddress } from "@solana/kit";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, customError, deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "../harness.js";

const TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

describe("emitCpi (test/fixtures/eventcpi.ts)", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/eventcpi.ts", import.meta.url)));
  });

  it("puts the event in a self-CPI that Anchor clients decode, with the IDL accounts Anchor expects", async () => {
    const payer = await fundedSigner(d.svm);
    const [authority] = await getProgramDerivedAddress({ programAddress: d.programId, seeds: ["__event_authority"] });
    const r = expectOk(
      await send(d.svm, payer, [
        ix(d, "pay", { amount: new BN(42), memo: "rent" }, [{ address: payer.address, signer: payer }, { address: authority }, { address: d.programId }]),
      ]),
    );
    const inner = r.innerInstructions().flat();
    expect(inner.length).toBe(1);
    const data = Buffer.from(inner[0].instruction().data());
    expect(data.subarray(0, 8).equals(TAG)).toBe(true);
    const ev = d.coder.events.decode(data.subarray(8).toString("base64"))!;
    expect([ev.name, (ev.data.amount as BN).toString(), ev.data.memo]).toEqual(["Paid", "42", "rent"]);
    expect(r.logs().some((l) => l.startsWith("Program data:"))).toBe(false);
    const accts = d.idl.instructions[0].accounts as { name: string; pda?: unknown; address?: string }[];
    expect(accts[1]).toEqual({ name: "event_authority", pda: { seeds: [{ kind: "const", value: [...Buffer.from("__event_authority")] }] } });
    expect(accts[2]).toEqual({ name: "self", address: d.programId });
  });

  it("rejects a forged event instruction (unsigned 2002, wrong authority 2006) and a wrong authority account", async () => {
    const payer = await fundedSigner(d.svm);
    const [authority] = await getProgramDerivedAddress({ programAddress: d.programId, seeds: ["__event_authority"] });
    const forged = (address: typeof authority, signer?: typeof payer) =>
      send(d.svm, payer, [
        {
          programAddress: d.programId,
          accounts: [{ address, role: signer ? 2 : 0, ...(signer ? { signer } : {}) }],
          data: new Uint8Array(Buffer.concat([TAG, Buffer.alloc(16)])),
        } as never,
      ]);
    expect(customError(await forged(authority))).toBe(2002);
    expect(customError(await forged(payer.address, payer))).toBe(2006);
    const wrong = (await generateKeyPairSigner()).address;
    expect(
      customError(
        await send(d.svm, payer, [
          ix(d, "pay", { amount: new BN(1), memo: "" }, [{ address: payer.address, signer: payer }, { address: wrong }, { address: d.programId }]),
        ]),
      ),
    ).toBe(2006);
  });
});
