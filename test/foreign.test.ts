import { type Address, generateKeyPairSigner, getAddressEncoder, getAddressDecoder } from "@solana/kit";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, customError, deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "./harness.js";

const enc = getAddressEncoder();
const pk = (a: string) => ({ toBuffer: () => Buffer.from(enc.encode(a as never)) });

describe("foreign account reads (test/fixtures/foreign.ts)", () => {
  let d: Deployed;
  let amm: Address;
  let authority: Address;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/foreign.ts", import.meta.url)));
    amm = (await generateKeyPairSigner()).address;
    authority = (await generateKeyPairSigner()).address;
  });

  async function plant(owner: Address, disc = "account:Pool", extra = 0) {
    const a = (await generateKeyPairSigner()).address;
    const data = Buffer.alloc(8 + 32 + 8 + 2 + extra);
    createHash("sha256").update(disc).digest().copy(data, 0, 0, 8);
    Buffer.from(enc.encode(authority)).copy(data, 8);
    data.writeBigUInt64LE(1_000_000n, 40);
    data.writeUInt16LE(30, 48);
    d.svm.setAccount({
      address: a,
      data: new Uint8Array(data),
      executable: false,
      lamports: 10_000_000n as never,
      programAddress: owner,
      space: BigInt(data.length),
    });
    return a;
  }
  const u64 = (r: ReturnType<typeof expectOk>) => Buffer.from(r.returnData().data()).readBigUInt64LE();

  it("views another program's Anchor account as a struct, checking owner, discriminator and size", async () => {
    const payer = await fundedSigner(d.svm);
    const value = (acct: Address, owner = amm) => send(d.svm, payer, [ix(d, "pool_value", { owner: pk(owner) }, [{ address: acct }])]);
    expect(u64(expectOk(await value(await plant(amm))))).toBe(1_000_030n);
    expect(customError(await value(await plant(amm), (await generateKeyPairSigner()).address))).toBe(3007);
    expect(customError(await value(await plant(amm, "account:Other")))).toBe(3002);
    const short = (await generateKeyPairSigner()).address;
    d.svm.setAccount({ address: short, data: new Uint8Array(20), executable: false, lamports: 10_000_000n as never, programAddress: amm, space: 20n });
    expect(customError(await value(short))).toBe(3003);
    const r = expectOk(await send(d.svm, payer, [ix(d, "pool_authority", { owner: pk(amm) }, [{ address: await plant(amm) }])]));
    expect(getAddressDecoder().decode(r.returnData().data())).toBe(authority);
  });

  it("validates foreign data like arguments (a bool byte of 2 is refused, 3003)", async () => {
    const payer = await fundedSigner(d.svm);
    const plantFlag = async (on: number) => {
      const a = (await generateKeyPairSigner()).address;
      const data = Buffer.alloc(8 + 1 + 8);
      createHash("sha256").update("account:Flagged").digest().copy(data, 0, 0, 8);
      data[8] = on;
      data.writeBigUInt64LE(7n, 9);
      d.svm.setAccount({
        address: a,
        data: new Uint8Array(data),
        executable: false,
        lamports: 10_000_000n as never,
        programAddress: amm,
        space: BigInt(data.length),
      });
      return a;
    };
    const read = async (a: Address) => send(d.svm, payer, [ix(d, "flagged", { owner: pk(amm) }, [{ address: a }])]);
    expect(u64(expectOk(await read(await plantFlag(1))))).toBe(7n);
    expect(customError(await read(await plantFlag(2)))).toBe(3003);
  });

  it("reads raw little-endian values with bounds checks", async () => {
    const payer = await fundedSigner(d.svm);
    const acct = await plant(amm);
    const raw = (off: number) => send(d.svm, payer, [ix(d, "raw_u64", { offset: new BN(off) }, [{ address: acct }])]);
    expect(u64(expectOk(await raw(40)))).toBe(1_000_000n);
    expect(u64(expectOk(await raw(42)))).toBe((30n << 48n) | (1_000_000n >> 16n));
    expect(customError(await raw(43))).toBe(3003);
    expect(customError(await raw(2 ** 40))).toBe(3003);
    const key = expectOk(await send(d.svm, payer, [ix(d, "raw_key", {}, [{ address: acct }])]));
    expect(getAddressDecoder().decode(key.returnData().data())).toBe(authority);
  });
});
