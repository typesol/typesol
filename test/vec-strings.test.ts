// Vec<string> instruction arguments: Borsh Vec<String> as Anchor encodes it, UTF-8 checked, re-encoded through CPI.
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { generateKeyPairSigner } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, acct, customError, deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "./harness.js";

describe("Vec<string> arguments", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/vec-strings.ts", import.meta.url)));
  });
  const u64 = (r: Awaited<ReturnType<typeof send>>) => Buffer.from(expectOk(r).returnData().data()).readBigUInt64LE(0);

  it("reads, iterates and searches them; the IDL says vec<string>", async () => {
    const payer = await fundedSigner(d.svm);
    const words = (xs: string[]) => send(d.svm, payer, [ix(d, "words", { xs, tail: new BN(3) }, [])]);
    const r = await words(["héllo", "", "ab"]);
    expect(u64(r)).toBe(8n * 1000n + 3n);
    expect(expectOk(r).logs()).toContain("Program log: first héllo");
    expect(u64(await words([]))).toBe(3n);
    expect(customError(await words(["ok", "bad"]))).toBe(6000);
    const arg = (d.idl.instructions.find((i) => i.name === "words")!.args as { name: string; type: unknown }[])[0];
    expect(arg).toEqual({ name: "xs", type: { vec: "string" } });
  });

  it("refuses bad bytes: invalid UTF-8, a short string, a count larger than the data", async () => {
    const payer = await fundedSigner(d.svm);
    const good = ix(d, "words", { xs: ["ab", "cd"], tail: new BN(0) }, []);
    const run = (data: Buffer) => send(d.svm, payer, [{ ...good, data: new Uint8Array(data) }]);
    const bad = Buffer.from(good.data!);
    bad[8 + 4 + 4] = 0xff; // first byte of "ab"
    expect(customError(await run(bad))).toBe(102);
    const short = Buffer.from(good.data!);
    short.writeUInt32LE(50, 8 + 4); // "ab" claims 50 bytes
    expect(customError(await run(short))).toBe(102);
    const many = Buffer.from(good.data!);
    many.writeUInt32LE(0xffffffff, 8);
    expect(customError(await run(many))).toBe(102);
    expectOk(await run(Buffer.from(good.data!)));
  });

  it("sends them on through CPI as Borsh", async () => {
    const payer = await fundedSigner(d.svm);
    const r = expectOk(await send(d.svm, payer, [ix(d, "relay", { xs: ["zz", "yyy"] }, [{ address: d.programId }])]));
    expect(r.logs()).toContain("Program log: first zz");
    expect(Buffer.from(r.returnData().data()).readBigUInt64LE(0)).toBe(5n * 1000n + 7n);
  });

  it("stores them in a FixedVec<FixedString<N>, M> account field", async () => {
    const payer = await fundedSigner(d.svm);
    const shelf = (await generateKeyPairSigner()).address;
    const disc = createHash("sha256").update("account:Shelf").digest().subarray(0, 8);
    const data = Buffer.alloc(8 + 4 + 4 * 20);
    disc.copy(data);
    d.svm.setAccount({
      address: shelf,
      data: new Uint8Array(data),
      executable: false,
      lamports: 10n ** 9n,
      programAddress: d.programId,
      space: BigInt(data.length),
    } as never);
    expectOk(await send(d.svm, payer, [ix(d, "shelve", { xs: ["a", "bc"] }, [{ address: shelf, writable: true }])]));
    expect(d.coder.accounts.decode("Shelf", Buffer.from(acct(d.svm, shelf).data)).titles).toEqual(["a", "bc"]);
    // Longer than FixedString<16>: does not fit (5105).
    expect(customError(await send(d.svm, payer, [ix(d, "shelve", { xs: ["x".repeat(17)] }, [{ address: shelf, writable: true }])]))).toBe(5105);
  });
});
