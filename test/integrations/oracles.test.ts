import { getAddressEncoder } from "@solana/kit";
import { type Address, address, generateKeyPairSigner, lamports } from "@solana/kit";
import { Clock, type TransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, customError, deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "../harness.js";

const PYTH_RECEIVER = address("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
const SB_MAINNET = address("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");
const SB_DEVNET = address("Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2");
const PRICE_UPDATE_DISC = [34, 241, 35, 99, 157, 126, 244, 205];
const SB_DISC = [196, 27, 108, 196, 10, 215, 219, 40];
const FEED = Buffer.alloc(32, 0xef);
const NOW = 1_800_000_000n;
const SLOT = 400_000_000n;
const i64 = (r: TransactionMetadata) => Buffer.from(r.returnData().data()).readBigInt64LE();

/** PriceUpdateV2 bytes exactly as the Pyth receiver writes them (Borsh). */
function priceUpdate(o: { price: bigint; expo: number; publish: bigint; full?: boolean; feed?: Buffer }) {
  const level = o.full === false ? Buffer.from([0, 5]) : Buffer.from([1]);
  const msg = Buffer.alloc(84);
  (o.feed ?? FEED).copy(msg, 0);
  msg.writeBigInt64LE(o.price, 32);
  msg.writeBigUInt64LE(12_345n, 40);
  msg.writeInt32LE(o.expo, 48);
  msg.writeBigInt64LE(o.publish, 52);
  msg.writeBigInt64LE(o.publish - 1n, 60);
  const data = Buffer.concat([Buffer.from(PRICE_UPDATE_DISC), Buffer.alloc(32, 7), level, msg, Buffer.alloc(8)]);
  return Buffer.concat([data, Buffer.alloc(134 - data.length)]);
}

/** PullFeedAccountData with only the fields TypeSOL reads filled in (result.value / num_samples / slot). */
function pullFeed(o: { value: bigint; samples: number; slot: bigint }) {
  const data = Buffer.alloc(8 + 3200);
  Buffer.from(SB_DISC).copy(data, 0);
  const base = 8 + 2256;
  data.writeBigInt64LE(BigInt.asIntN(64, o.value), base);
  data.writeBigInt64LE(o.value < 0n ? -1n : BigInt.asIntN(64, o.value >> 64n), base + 8);
  data[base + 96] = o.samples;
  data.writeBigUInt64LE(o.slot, base + 104);
  return data;
}

describe("oracles (test/fixtures/oracles.ts)", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/oracles.ts", import.meta.url)));
    d.svm.setClock(new Clock(SLOT, NOW - 1000n, 900n, 901n, NOW));
  });

  const plant = async (data: Buffer, owner: Address) => {
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
  const feedArg = [...FEED];

  it("reads a fresh, fully verified Pyth price and enforces feed, age and verification", async () => {
    const payer = await fundedSigner(d.svm);
    const read = async (acct: Address, maxAge = 60) =>
      send(d.svm, payer, [ix(d, "pyth_usd", { feed_id: feedArg, max_age: new BN(maxAge) }, [{ address: acct }])]);
    const fresh = await plant(priceUpdate({ price: 15_012_345_678n, expo: -8, publish: NOW - 10n }), PYTH_RECEIVER);
    expect(i64(expectOk(await read(fresh)))).toBe(15_012_345_678n);
    expect(customError(await read(fresh, 5))).toBe(5111); // too old for a 5 s window
    const stale = await plant(priceUpdate({ price: 1n, expo: -8, publish: NOW - 3600n }), PYTH_RECEIVER);
    expect(customError(await read(stale))).toBe(5111);
    const other = await plant(priceUpdate({ price: 1n, expo: -8, publish: NOW, feed: Buffer.alloc(32, 1) }), PYTH_RECEIVER);
    expect(customError(await read(other))).toBe(5111);
    const partial = await plant(priceUpdate({ price: 1n, expo: -8, publish: NOW, full: false }), PYTH_RECEIVER);
    expect(customError(await read(partial))).toBe(5111);
    const forged = await plant(priceUpdate({ price: 1n, expo: -8, publish: NOW }), d.programId);
    expect(customError(await read(forged))).toBe(3007);
    // With the expected exponent: the same feed at another scale is refused.
    const e8 = async (acct: Address) => send(d.svm, payer, [ix(d, "pyth_usd_e8", { feed_id: feedArg, max_age: new BN(60) }, [{ address: acct }])]);
    expect(i64(expectOk(await e8(fresh)))).toBe(15_012_345_678n);
    const e6 = await plant(priceUpdate({ price: 150_123_456n, expo: -6, publish: NOW - 10n }), PYTH_RECEIVER);
    expect(customError(await e8(e6))).toBe(5111);
    expect(i64(expectOk(await read(e6)))).toBe(150_123_456n); // without it, read at whatever scale the feed has
    // Raw fields parse at the right offsets for both verification-level encodings.
    const raw = async (acct: Address) => i64(expectOk(await send(d.svm, payer, [ix(d, "pyth_raw", {}, [{ address: acct }])])));
    expect(await raw(fresh)).toBe(15_012_345_678n);
    expect(await raw(partial)).toBe(1n);
  });

  it("reads Switchboard results scaled from 18 decimals, rejecting stale, empty and foreign feeds", async () => {
    const payer = await fundedSigner(d.svm);
    const key = (a: string) => ({ toBuffer: () => Buffer.from(getAddressEncoder().encode(a as never)) });
    const read = async (acct: Address, stale: number | bigint = 100, expected: Address = acct) =>
      send(d.svm, payer, [ix(d, "sb_value", { expected: key(expected), max_stale_slots: new BN(stale.toString()) }, [{ address: acct }])]);
    // 1234.567891234567891234 with 18 decimals -> 1234.567891 at 6 decimals
    const good = await plant(pullFeed({ value: 1_234_567_891_234_567_891_234n, samples: 3, slot: SLOT - 10n }), SB_MAINNET);
    expect(i64(expectOk(await read(good)))).toBe(1_234_567_891n);
    const negative = await plant(pullFeed({ value: -2_500_000_000_000_000_000n, samples: 1, slot: SLOT }), SB_MAINNET);
    expect(i64(expectOk(await read(negative)))).toBe(-2_500_000n);
    expect(customError(await read(good, 5))).toBe(5111);
    // another (valid, fresh) feed than the one the program expects is refused.
    expect(customError(await read(negative, 100, good))).toBe(5111);
    // "Never stale": slot + u64::MAX must not wrap around into "stale".
    expect(i64(expectOk(await read(good, 2n ** 64n - 1n)))).toBe(1_234_567_891n);
    expect(customError(await read(await plant(pullFeed({ value: 1n, samples: 0, slot: SLOT }), SB_MAINNET)))).toBe(5111);
    // minSamples: a result resting on fewer oracle samples is refused.
    const read3 = async (acct: Address) => send(d.svm, payer, [ix(d, "sb_value3", { expected: key(acct), max_stale_slots: new BN(100) }, [{ address: acct }])]);
    expect(i64(expectOk(await read3(good)))).toBe(1_234_567_891n); // 3 samples
    expect(customError(await read3(negative))).toBe(5111); // 1 sample
    expect(customError(await read(await plant(pullFeed({ value: 1n, samples: 1, slot: SLOT }), SB_DEVNET)))).toBe(3007); // devnet feed on a mainnet program
  });
});
