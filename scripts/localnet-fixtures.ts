/**
 * Writes solana-test-validator `--account` fixtures: a Pyth PriceUpdateV2 and a Switchboard pull feed
 * laid out exactly as the TypeSol runtime reads them, stamped with the current time.
 *   node scripts/localnet-fixtures.ts <outDir>
 * Prints `<pythAddress> <switchboardAddress>`.
 */
import { generateKeyPairSigner } from "@solana/kit";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const out = process.argv[2] ?? ".";
mkdirSync(out, { recursive: true });
const now = BigInt(Math.floor(Date.now() / 1000));
const FEED = Buffer.alloc(32, 0xef);

const msg = Buffer.alloc(84);
FEED.copy(msg, 0);
msg.writeBigInt64LE(15_012_345_678n, 32);
msg.writeBigUInt64LE(12_345n, 40);
msg.writeInt32LE(-8, 48);
msg.writeBigInt64LE(now + 600n, 52); // fresh for the next 10 minutes of validator time
msg.writeBigInt64LE(now, 60);
const pyth = Buffer.concat([Buffer.from([34, 241, 35, 99, 157, 126, 244, 205]), Buffer.alloc(32, 7), Buffer.from([1]), msg, Buffer.alloc(8), Buffer.alloc(1)]);

const sb = Buffer.alloc(8 + 3200);
Buffer.from([196, 27, 108, 196, 10, 215, 219, 40]).copy(sb, 0);
const value = 1_234_567_891_234_567_891_234n; // 1234.567891234567891234 as an 18-decimal i128
sb.writeBigUInt64LE(value & 0xffff_ffff_ffff_ffffn, 8 + 2256);
sb.writeBigInt64LE(value >> 64n, 8 + 2256 + 8);
sb[8 + 2256 + 96] = 3;
sb.writeBigUInt64LE(0n, 8 + 2256 + 104);

const write = (name: string, address: string, data: Buffer, owner: string) =>
  writeFileSync(
    path.join(out, `${name}.json`),
    JSON.stringify({
      pubkey: address,
      account: { lamports: 10_000_000, data: [data.toString("base64"), "base64"], owner, executable: false, rentEpoch: 0, space: data.length },
    }),
  );
const pythAddr = (await generateKeyPairSigner()).address;
const sbAddr = (await generateKeyPairSigner()).address;
write("pyth", pythAddr, pyth, "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
write("switchboard", sbAddr, sb, "SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");
console.log(pythAddr, sbAddr);
