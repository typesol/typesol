// TypeSOL derives PDAs with the sha256 and curve-validation syscalls instead of the PDA syscalls
// (runtime/typesol_rt.h ts_find_pda / ts_create_pda_address). These cases compare it with @solana/kit's derivation,
// which follows the runtime's: random seeds, canonical bumps below 255, on-curve bumps and over-long seeds.
import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, isOffCurveAddress } from "@solana/kit";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, customError, deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "./harness.js";
import { pk } from "./ports-helpers.js";

const enc = getAddressEncoder();
// create_program_address: sha256(seeds ‖ program ‖ "ProgramDerivedAddress"), valid only off the curve.
const createPda = (program: Address, seeds: Uint8Array[]): Address | undefined => {
  const h = createHash("sha256");
  for (const s of seeds) h.update(s);
  h.update(enc.encode(program));
  h.update("ProgramDerivedAddress");
  const address = getAddressDecoder().decode(h.digest());
  return isOffCurveAddress(address) ? address : undefined;
};
const u64le = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};

describe("PDA derivation (sha256 + curve check) matches the runtime's", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/pda-derivation.ts", import.meta.url)));
  });

  it("finds the same canonical address for random seeds and programs", async () => {
    const payer = await fundedSigner(d.svm);
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
    let belowMax = 0;
    for (let i = 0; i < 160; i++) {
      const len = i % 33;
      const seedA = Array.from({ length: len }, (_, k) => alphabet[(i * 7 + k * 13) % alphabet.length]).join("");
      const seedB = (await generateKeyPairSigner()).address;
      const seedN = (BigInt(i) * 0x9e3779b97f4a7c15n) % (1n << 64n);
      const program = (await generateKeyPairSigner()).address;
      const [expected, bump] = await getProgramDerivedAddress({ programAddress: program, seeds: [seedA, enc.encode(seedB), u64le(seedN)] });
      if (bump < 255) belowMax++;
      const r = expectOk(
        await send(d.svm, payer, [ix(d, "derive", { seed_a: seedA, seed_b: pk(seedB), seed_n: new BN(seedN.toString()), program: pk(program) }, [])]),
      );
      expect(getAddressDecoder().decode(r.returnData().data())).toBe(expected);
    }
    // The canonical bump is below 255 about half the time: those cases walk past on-curve candidates.
    expect(belowMax).toBeGreaterThan(40);
  });

  it("accepts exactly the bumps create_program_address accepts", async () => {
    const payer = await fundedSigner(d.svm);
    let onCurve = 0;
    let offCurve = 0;
    for (let i = 0; i < 40; i++) {
      const seedA = `seed-${i}`;
      for (const bump of [255, 254, 253]) {
        // undefined: the hash is on the curve, so there is no PDA for this bump
        const address = createPda(d.programId, [new TextEncoder().encode(seedA), Uint8Array.of(bump)]);
        // The target: the PDA when there is one, else any address (the check must fail either way).
        const target = address ?? (await generateKeyPairSigner()).address;
        const r = await send(d.svm, payer, [ix(d, "check", { seed_a: seedA, bump }, [{ address: target }])]);
        if (address) {
          offCurve++;
          expectOk(r);
        } else {
          onCurve++;
          expect(customError(r)).toBe(2006);
        }
      }
    }
    expect(onCurve).toBeGreaterThan(10);
    expect(offCurve).toBeGreaterThan(10);
  });

  it("refuses seeds over 32 bytes, as the syscall does", async () => {
    const payer = await fundedSigner(d.svm);
    const program = (await generateKeyPairSigner()).address;
    const r = await send(d.svm, payer, [ix(d, "derive", { seed_a: "x".repeat(33), seed_b: pk(payer.address), seed_n: new BN(1), program: pk(program) }, [])]);
    expect(customError(r)).toBe(2006);
  });

  it("searches with 15 seeds, the most the syscall takes (16 is a compile error)", async () => {
    const payer = await fundedSigner(d.svm);
    const program = (await generateKeyPairSigner()).address;
    const seeds = "abcdefghijklmno".split("");
    const [expected] = await getProgramDerivedAddress({ programAddress: program, seeds });
    const ok = expectOk(await send(d.svm, payer, [ix(d, "most_seeds", { program: pk(program) }, [])]));
    expect(getAddressDecoder().decode(ok.returnData().data())).toBe(expected);
  });
});
