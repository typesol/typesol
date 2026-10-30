// The Raydium CLMM port's account layouts (examples/raydium-clmm/state.ts) against mainnet: a pool's accounts cloned
// on 2026-10-30 (test/fixtures/clmm/mainnet, USDC/CC pool 774uZX… with both of its tick arrays, cloned together with
// `typesol clone`) are read by the port and compared,
// field by field, with the same bytes decoded by the program's on-chain IDL; and each struct's size is the accounts'.
import { BorshCoder, type Idl } from "@anchor-lang/core";
import { type Address, getAddressDecoder } from "@solana/kit";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadClonedAccounts } from "../../src/tools/clone.js";
import { build } from "../../src/compiler/index.js";
import { BN, deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "../harness.js";
import { mkdtempSync } from "node:fs";
import os from "node:os";

const RAYDIUM_CLMM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK" as Address;
const DIR = fileURLToPath(new URL("../fixtures/clmm/mainnet", import.meta.url));
const PROBE = fileURLToPath(new URL("../fixtures/clmm/state-probe.ts", import.meta.url));
const POOL = "774uZXEhCJGqDYrZLLh3EUV6QDsBkeDzGp2gVhpdd9RU" as Address;
const CONFIG = "9iFER3bpjf1PTTCQCfTRu17EJgvsxo9pVyA9QWwEuX4x" as Address;
const OBSERVATION = "4iZDPZsZC6HyxZLP5mbwoeL3i5ruf5cVTZQECC9XbmcG" as Address;
const EXTENSION = "2Qd5cDYWSDJayz6MpQbPL8GGReFJYBv2sAzbXKkgqdNa" as Address;
const TICK_ARRAY = "Ew3kDkV2BBsPQHWzZUB627fWJr8K5jNVKKD2PpPJAsYG" as Address;

const idl = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/clmm/raydium_clmm.idl.json", import.meta.url)), "utf8")) as Idl;
const raydium = new BorshCoder(idl);
const bytes = (a: string) => Buffer.from((JSON.parse(readFileSync(path.join(DIR, `${a}.json`), "utf8")) as { data: string }).data, "base64");
const decoded = (type: string, a: string) => raydium.accounts.decode(type, bytes(a)) as Record<string, unknown>;
const big = (v: unknown) => BigInt((v as { toString(): string }).toString());
const key = (v: unknown) => (v as { toBase58(): string }).toBase58();

describe("Raydium CLMM account layouts against mainnet", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(PROBE, { programId: RAYDIUM_CLMM });
    expect(readdirSync(DIR).length).toBeGreaterThan(5);
    loadClonedAccounts(d.svm as never, DIR);
  });
  const read = async (name: string, args: Record<string, unknown>, account: Address) => {
    const payer = await fundedSigner(d.svm);
    return Buffer.from(expectOk(await send(d.svm, payer, [ix(d, name, args, [{ address: account }])])).returnData().data());
  };
  const u128 = (b: Buffer, at: number) => b.readBigUInt64LE(at) | (b.readBigUInt64LE(at + 8) << 64n);
  const i128 = (b: Buffer, at: number) => BigInt.asIntN(128, u128(b, at));
  const pk = (b: Buffer, at: number) => getAddressDecoder().decode(b.subarray(at, at + 32));

  it("has the accounts' sizes", () => {
    const { model } = build(PROBE, mkdtempSync(path.join(os.tmpdir(), "clmm-state-")), RAYDIUM_CLMM);
    const size = (n: string) => model.structs.get(n)!.size! + 8;
    for (const [type, account] of [
      ["PoolState", POOL],
      ["AmmConfig", CONFIG],
      ["ObservationState", OBSERVATION],
      ["TickArrayBitmapExtension", EXTENSION],
      ["TickArrayState", TICK_ARRAY],
    ] as const)
      expect(size(type), type).toBe(bytes(account).length);
    // The original's LEN for the accounts not cloned here.
    expect(size("PersonalPositionState")).toBe(8 + 1 + 32 + 32 + 4 + 4 + 16 + 16 + 16 + 8 + 8 + 24 * 3 + 64);
    expect(size("ProtocolPositionState")).toBe(8 + 1 + 32 + 4 + 4 + 16 + 16 + 16 + 8 + 8 + 16 * 3 + 64);
  });

  it("reads a PoolState as the IDL decodes it", async () => {
    const want = decoded("PoolState", POOL);
    const bitmap = want.tick_array_bitmap as unknown[];
    const word = bitmap.findIndex((w) => big(w) !== 0n);
    const b = await read("pool", { word: new BN(Math.max(word, 0)) }, POOL);
    const rewards = want.reward_infos as Record<string, unknown>[];
    const dynamic = want.dynamic_fee_info as Record<string, unknown>;
    expect({
      observation: pk(b, 0),
      decimals1: b[32],
      spacing: b.readUInt16LE(33),
      liquidity: u128(b, 35),
      sqrt: u128(b, 51),
      tick: b.readInt32LE(67),
      feeGrowth1: u128(b, 71),
      protocolFees1: b.readBigUInt64LE(87),
      status: b[95],
      feeOn: b[96],
      rewardMint0: pk(b, 97),
      rewardGrowth2: u128(b, 129),
      bitmap: b.readBigUInt64LE(145),
      fundFees1: b.readBigUInt64LE(153),
      openTime: b.readBigUInt64LE(161),
      epoch: b.readBigUInt64LE(169),
      dynamicUpdate: b.readBigUInt64LE(177),
      dynamicMax: b.readUInt32LE(185),
    }).toEqual({
      observation: key(want.observation_key),
      decimals1: want.mint_decimals_1,
      spacing: want.tick_spacing,
      liquidity: big(want.liquidity),
      sqrt: big(want.sqrt_price_x64),
      tick: want.tick_current,
      feeGrowth1: big(want.fee_growth_global_1_x64),
      protocolFees1: big(want.protocol_fees_token_1),
      status: want.status,
      feeOn: want.fee_on,
      rewardMint0: key(rewards[0]!.token_mint),
      rewardGrowth2: big(rewards[2]!.reward_growth_global_x64),
      bitmap: big(bitmap[Math.max(word, 0)]),
      fundFees1: big(want.fund_fees_token_1),
      openTime: big(want.open_time),
      epoch: big(want.recent_epoch),
      dynamicUpdate: big(dynamic.last_update_timestamp),
      dynamicMax: dynamic.max_volatility_accumulator,
    });
    // A live pool: real numbers, not zeros. Its tick (about 92,600) is beyond the ±30,720 its own bitmap covers at
    // spacing 1, so its tick arrays are marked in the extension (checked below), and this bitmap is all zeros.
    expect(big(want.liquidity)).toBeGreaterThan(0n);
  });

  it("reads an AmmConfig, a TickArrayState, the bitmap extension and the ObservationState as the IDL does", async () => {
    const config = decoded("AmmConfig", CONFIG);
    const c = await read("config", {}, CONFIG);
    expect([c.readUInt16LE(0), pk(c, 2), c.readUInt32LE(34), c.readUInt32LE(38), c.readUInt16LE(42), c.readUInt32LE(44), pk(c, 48)]).toEqual([
      config.index,
      key(config.owner),
      config.protocol_fee_rate,
      config.trade_fee_rate,
      config.tick_spacing,
      config.fund_fee_rate,
      key(config.fund_owner),
    ]);

    const array = decoded("TickArrayState", TICK_ARRAY);
    const ticks = array.ticks as Record<string, unknown>[];
    const live = ticks.map((t, i) => [t, i] as const).filter(([t]) => big(t.liquidity_gross) !== 0n);
    expect(live.length).toBeGreaterThan(0);
    for (const [t, i] of [...live.slice(0, 3), [ticks[59]!, 59] as const]) {
      const b = await read("tick_array", { i: new BN(i) }, TICK_ARRAY);
      expect([
        b.readInt32LE(0),
        b[4],
        b.readBigUInt64LE(5),
        b.readInt32LE(13),
        i128(b, 17),
        u128(b, 33),
        u128(b, 49),
        u128(b, 65),
        b.readBigUInt64LE(81),
        u128(b, 89),
      ]).toEqual([
        array.start_tick_index,
        array.initialized_tick_count,
        big(array.recent_epoch),
        t.tick,
        big(t.liquidity_net),
        big(t.liquidity_gross),
        big(t.fee_growth_outside_0_x64),
        big((t.reward_growths_outside_x64 as unknown[])[1]),
        big(t.order_phase),
        big(t.unfilled_ratio_x64),
      ]);
    }

    const ext = decoded("TickArrayBitmapExtension", EXTENSION);
    const pos = ext.positive_tick_array_bitmap as unknown[][];
    const neg = ext.negative_tick_array_bitmap as unknown[][];
    const marked: [number, number][] = [];
    pos.forEach((row, i) => row.forEach((w, j) => big(w) !== 0n && marked.push([i, j])));
    expect(marked.length).toBeGreaterThan(0);
    for (const [i, j] of [...marked.slice(0, 3), [13, 7] as [number, number]]) {
      const b = await read("bitmap", { i: new BN(i), j: new BN(j) }, EXTENSION);
      expect(b.readBigUInt64LE(0)).toBe(big(pos[i]![j]) ^ big(neg[i]![j]));
    }

    const obs = decoded("ObservationState", OBSERVATION);
    const index = obs.observation_index as number;
    const o = (obs.observations as Record<string, unknown>[])[index]!;
    const b = await read("observation", { i: new BN(index) }, OBSERVATION);
    expect([b[0] === 1, b.readBigUInt64LE(1), b.readUInt16LE(9), pk(b, 11), b.readUInt32LE(43), b.readBigInt64LE(47)]).toEqual([
      obs.initialized,
      big(obs.recent_epoch),
      index,
      key(obs.pool_id),
      o.block_timestamp,
      big(o.tick_cumulative),
    ]);
  });
});
