// do … while, **=, switch on 128-bit integers, ?. and an explicit token program in mint.create.
import * as t22 from "@solana-program/token-2022";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  BN,
  SYSTEM_PROGRAM,
  TOKEN_2022,
  TOKEN_PROGRAM,
  acct,
  customError,
  deployFile,
  expectOk,
  fundedSigner,
  ix,
  pda,
  send,
  type Deployed,
} from "./harness.js";

describe("do … while, **=, 128-bit switch, ?., explicit token program", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/closers.ts", import.meta.url)));
  });
  const u64 = (r: Awaited<ReturnType<typeof send>>) => Buffer.from(expectOk(r).returnData().data()).readBigUInt64LE(0);
  const call = async (name: string, args: Record<string, unknown>, accounts: Parameters<typeof ix>[3] = []) => {
    const payer = await fundedSigner(d.svm);
    return send(d.svm, payer, [ix(d, name, args, accounts)]);
  };

  it("do … while runs the body first, and continue goes to the test", async () => {
    for (const [n, want] of [
      [0, 1n],
      [9, 1n],
      [55, 2n],
      [1234567, 7n],
    ] as const)
      expect(u64(await call("digits", { n: new BN(n) }))).toBe(want);
  });

  it("**= raises in place and checks overflow", async () => {
    expect(u64(await call("cube", { x: new BN(7) }))).toBe(343n);
    expect(customError(await call("cube", { x: new BN("3000000") }))).toBe(5100);
  });

  it("switches on u128 values, with fallthrough and default", async () => {
    const g = (s: string) => call("grade", { score: new BN(s) });
    expect(u64(await g("0"))).toBe(0n);
    expect(u64(await g("340282366920938463463374607431768211455"))).toBe(9n);
    expect(u64(await g("100000000000000000000000"))).toBe(7n);
    expect(u64(await g("7"))).toBe(7n);
    expect(u64(await g("8"))).toBe(1n);
  });

  it("?. gives null for a left-out account or an empty Option<struct>", async () => {
    const payer = await fundedSigner(d.svm);
    const make = async (who: typeof payer, n: number, withHome: boolean) => {
      const [box] = await pda(d.programId, ["box", who.address]);
      expectOk(
        await send(d.svm, who, [
          ix(d, "setup", { n: new BN(n), with_home: withHome }, [
            { address: who.address, signer: who, writable: true },
            { address: box, writable: true },
            { address: SYSTEM_PROGRAM },
          ]),
        ]),
      );
      return box;
    };
    const withHome = await make(payer, 5, true);
    const other = await fundedSigner(d.svm);
    const noHome = await make(other, 6, false);
    const peek = (box: string, home: string) =>
      send(d.svm, payer, [ix(d, "peek", {}, [{ address: payer.address, signer: payer }, { address: box as never }, { address: home as never }])]);
    expect(u64(await peek(withHome, withHome))).toBe(5n * 1000n + 3n);
    expect(u64(await peek(noHome, noHome))).toBe(6n * 1000n + 50n);
    expect(u64(await peek(d.programId, withHome))).toBe(100n * 1000n + 3n); // the optional account left out
  });

  it("mint.create takes the token program when the instruction has two", async () => {
    const payer = await fundedSigner(d.svm);
    const [mint] = await pda(d.programId, ["m22", payer.address]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "make_mint22", {}, [
          { address: payer.address, signer: payer, writable: true },
          { address: mint, writable: true },
          { address: TOKEN_PROGRAM },
          { address: TOKEN_2022 },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    expect(acct(d.svm, mint).programAddress).toBe(TOKEN_2022);
    expect(t22.getMintDecoder().decode(acct(d.svm, mint).data).decimals).toBe(2);
  });
});
