// Port of the oracles/pyth Anchor program of solana-developers/program-examples: runs the original's flow against the
// TypeSOL rewrite in test/ports/oracles/pyth.ts. Status and reasons: test/ports/README.md.
import { type Address, address, generateKeyPairSigner, lamports } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { customError, expectOk, fundedSigner, ix, send } from "../harness.js";
import { deployPort } from "../ports-helpers.js";

const PYTH_RECEIVER = address("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

/** A PriceUpdateV2 account as the Pyth receiver writes it (Borsh): discriminator, write authority, verification, message. */
function priceUpdate(price: bigint, expo: number, publish: bigint): Buffer {
  const msg = Buffer.alloc(84);
  Buffer.alloc(32, 0xef).copy(msg, 0);
  msg.writeBigInt64LE(price, 32);
  msg.writeBigUInt64LE(12_345n, 40);
  msg.writeInt32LE(expo, 48);
  msg.writeBigInt64LE(publish, 52);
  msg.writeBigInt64LE(publish - 1n, 60);
  const data = Buffer.concat([Buffer.from([34, 241, 35, 99, 157, 126, 244, 205]), Buffer.alloc(32, 7), Buffer.from([1]), msg, Buffer.alloc(8)]);
  return Buffer.concat([data, Buffer.alloc(134 - data.length)]);
}

describe("port: oracles/pyth", () => {
  it("reads a PriceUpdateV2 account, rejects one the Pyth receiver does not own and one with another discriminator", async () => {
    const d = await deployPort("oracles/pyth.ts", "GUkjQmrLPFXXNK1bFLKt8XQi6g3TjxcHVspbjDoHvMG2");
    const payer = await fundedSigner(d.svm);
    const plant = async (owner: Address, data = priceUpdate(15_012_345_678n, -8, 1_800_000_000n)) => {
      const a = (await generateKeyPairSigner()).address;
      d.svm.setAccount({
        address: a,
        data: new Uint8Array(data),
        executable: false,
        lamports: lamports(10_000_000n),
        programAddress: owner,
        space: BigInt(data.length),
      });
      return a;
    };
    const logs = expectOk(await send(d.svm, payer, [ix(d, "read_price", {}, [{ address: await plant(PYTH_RECEIVER) }])])).logs();
    expect(logs).toContain("Program log: Price: 15012345678");
    expect(logs).toContain("Program log: Exponent: -8");
    expect(logs).toContain("Program log: Publish Time: 1800000000");
    expect(customError(await send(d.svm, payer, [ix(d, "read_price", {}, [{ address: await plant(payer.address) }])]))).toBe(3007);
    expect(customError(await send(d.svm, payer, [ix(d, "read_price", {}, [{ address: payer.address }])]))).toBe(3007);
    // Owned by the receiver but not a PriceUpdateV2: another discriminator (Anchor's AccountDiscriminatorMismatch).
    const other = priceUpdate(15_012_345_678n, -8, 1_800_000_000n);
    other[0] ^= 0xff;
    expect(customError(await send(d.svm, payer, [ix(d, "read_price", {}, [{ address: await plant(PYTH_RECEIVER, other) }])]))).toBe(3002);
  });
});
