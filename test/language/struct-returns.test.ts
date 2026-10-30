// Structs another program returns: `const q = returnData<Quote>(program)` after a CPI, as Anchor's get_return_data and
// deserialize. A fixed layout of integers, booleans, Pubkeys, unit enums and arrays is read as its bytes; a
// `@layout borsh` struct (Options, strings, Vecs) is Borsh-decoded.
import { type Address, type KeyPairSigner } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, compileErrors, customError, deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "../harness.js";

const CALLEE = `import { type FixedString, type Option, type Pubkey, type Signer, type u64, type u8, pubkey } from "typesol";
export enum Side { Bid, Ask }
export interface Level { price: u64; size: u64; side: Side; live: boolean; maker: Pubkey }
/** Borsh, as an Anchor program returns it: the Option and the string take only the bytes they need. */
/** @layout borsh */
export interface Quote { price: u64; limit: Option<u64>; label: FixedString<8> }

export function level(price: u64, live: boolean): Level {
  return { price, size: price * 2n, side: Side.Ask, live, maker: pubkey("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T") };
}
export function quote(price: u64, limit: Option<u64>): Quote {
  return { price, limit, label: "quote" };
}
export function raw(n: u64): u64 {
  return n;
}
`;

const CALLER = `import { type FixedString, type Option, type Pubkey, type UncheckedProgram, type u64, invoke, pubkey, require, returnData, sighash } from "typesol";
export enum Side { Bid, Ask }
export interface Level { price: u64; size: u64; side: Side; live: boolean; maker: Pubkey }
/** @layout borsh */
export interface Quote { price: u64; limit: Option<u64>; label: FixedString<8> }

/** price + size, after checking the fields the callee set. */
export function readLevel(prices: UncheckedProgram, price: u64, live: boolean): u64 {
  invoke(prices, [], [sighash("level"), price, live]);
  const l = returnData<Level>(prices);
  require(l.side === Side.Ask, "side");
  require(l.maker === pubkey("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T"), "maker");
  return l.live ? l.price + l.size : 0n;
}
/** price + limit (0 when none), when the label came through. */
export function readQuote(prices: UncheckedProgram, price: u64, limit: Option<u64>): u64 {
  invoke(prices, [], [sighash("quote"), price, limit]);
  const q = returnData<Quote>(prices);
  require(q.label === "quote", "label");
  return q.price + (q.limit ?? 0n);
}
/** A u64 read as a Level: the size does not match. */
export function misread(prices: UncheckedProgram, n: u64): u64 {
  invoke(prices, [], [sighash("raw"), n]);
  const l = returnData<Level>(prices);
  return l.price;
}
/** A Quote read as a Level (its Borsh bytes are shorter). */
export function misquote(prices: UncheckedProgram, price: u64): u64 {
  const none: u64 | null = null;
  invoke(prices, [], [sighash("quote"), price, none]);
  const l = returnData<Level>(prices);
  return l.price;
}
`;

describe("struct return data", () => {
  let caller: Deployed;
  let callee: Deployed;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-struct-returns-"));
    writeFileSync(path.join(dir, "prices.ts"), CALLEE);
    writeFileSync(path.join(dir, "reader.ts"), CALLER);
    caller = await deployFile(path.join(dir, "reader.ts"));
    callee = await deployFile(path.join(dir, "prices.ts"), { svm: caller.svm });
    payer = await fundedSigner(caller.svm);
  });
  const call = (name: string, args: Record<string, unknown>) => send(caller.svm, payer, [ix(caller, name, args, [{ address: callee.programId }])]);
  const u64 = (res: Awaited<ReturnType<typeof call>>) => Buffer.from(expectOk(res).returnData().data()).readBigUInt64LE();

  it("reads a fixed-layout struct and checks its fields", async () => {
    expect(u64(await call("read_level", { price: new BN(40), live: true }))).toBe(120n);
    expect(u64(await call("read_level", { price: new BN(41), live: false }))).toBe(0n);
  });

  it("Borsh-decodes a @layout borsh struct, Options and strings included", async () => {
    expect(u64(await call("read_quote", { price: new BN(5), limit: new BN(7) }))).toBe(12n);
    expect(u64(await call("read_quote", { price: new BN(6), limit: null }))).toBe(6n);
  });

  it("refuses return data of another size (5106)", async () => {
    expect(customError(await call("misread", { n: new BN(3) }))).toBe(5106);
    expect(customError(await call("misquote", { price: new BN(3) }))).toBe(5106);
    // Return data from another program than the one named.
    const other = await fundedSigner(caller.svm);
    const res = await send(caller.svm, payer, [ix(caller, "read_level", { price: new BN(1), live: true }, [{ address: other.address as Address }])]);
    expect(res).toBeInstanceOf(FailedTransactionMetadata);
  });

  it("asks for @layout borsh when the fixed layout is not Borsh, and for a local", () => {
    const head = `import { type Option, type UncheckedProgram, type u64, returnData } from "typesol";\nexport interface Q { price: u64; limit: Option<u64> }\nexport interface P { price: u64 }\n`;
    expect(compileErrors(head + `export function f(p: UncheckedProgram): void { const q = returnData<Q>(p); }`)).toMatch(
      /declare it \/\*\* @layout borsh \*\//,
    );
    expect(compileErrors(head + `export function f(p: UncheckedProgram): u64 { return returnData<P>(p).price; }`)).toMatch(/bind a returned struct to a local/);
  });
});
