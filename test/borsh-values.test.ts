// @layout borsh structs as instruction arguments, return values and events: Anchor's Borsh bytes, checked with
// Anchor's own coder.
import { fileURLToPath } from "node:url";
import { web3 } from "@anchor-lang/core";
import { describe, expect, it, beforeAll } from "vitest";
import { BN, SYSTEM_PROGRAM, acct, customError, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "./harness.js";

const fixture = fileURLToPath(new URL("./fixtures/borsh-values.ts", import.meta.url));

describe("@layout borsh values", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fixture);
  });
  const card = {
    owner: web3.PublicKey.default,
    bump: 0,
    name: "ünïcode",
    tags: [new BN(1), new BN(2), new BN(3)],
    labels: ["a", "bc"],
    badge: new BN(9),
    score: new BN(40),
  };

  it("takes one as an argument and returns an account as one", async () => {
    const payer = await fundedSigner(d.svm);
    const [c] = await pda(d.programId, ["card", payer.address]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "create", { init: card }, [
          { address: payer.address, signer: payer, writable: true },
          { address: c, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const stored = d.coder.accounts.decode("Card", Buffer.from(acct(d.svm, c).data));
    expect(stored.name).toBe("ünïcode");
    expect(stored.tags.map((x: BN) => x.toNumber())).toEqual([1, 2, 3]);
    expect(stored.labels).toEqual(["a", "bc"]);
    expect(stored.badge.toNumber()).toBe(9);
    const r = expectOk(await send(d.svm, payer, [ix(d, "read", {}, [{ address: c }])]));
    const ret = Buffer.from(r.returnData().data());
    // Return data is the Borsh value: the account's bytes after its discriminator.
    const data = Buffer.from(acct(d.svm, c).data);
    expect(ret.equals(data.subarray(8, 8 + ret.length))).toBe(true);
    const back = d.coder.types.decode("Card", ret);
    expect(back.owner.toBase58()).toBe(payer.address);
    expect(back.score.toNumber()).toBe(40);
  });

  it("refuses an argument that is not a valid Borsh value or not UTF-8", async () => {
    const payer = await fundedSigner(d.svm);
    const [c] = await pda(d.programId, ["card", payer.address]);
    const accounts = [{ address: payer.address, signer: payer, writable: true }, { address: c, writable: true }, { address: SYSTEM_PROGRAM }];
    const good = ix(d, "create", { init: card }, accounts);
    const at = 8 + 32 + 1; // discriminator, owner, bump: then name's length
    const run = (data: Buffer) => send(d.svm, payer, [{ ...good, data: new Uint8Array(data) }]);
    const tooLong = Buffer.from(good.data!);
    tooLong.writeUInt32LE(17, at); // FixedString<16>
    expect(customError(await run(tooLong))).toBe(102);
    const badUtf8 = Buffer.from(good.data!);
    badUtf8[at + 4] = 0xff;
    expect(customError(await run(badUtf8))).toBe(102);
    expect(customError(await run(Buffer.from(good.data!).subarray(0, good.data!.length - 3)))).toBe(102);
    expectOk(await run(Buffer.from(good.data!)));
  });

  it("emits one as an event and echoes one back", async () => {
    const payer = await fundedSigner(d.svm);
    const r = expectOk(await send(d.svm, payer, [ix(d, "note", { title: "hello", amount: null }, [{ address: payer.address, signer: payer }])]));
    const ev = r
      .logs()
      .filter((l) => l.startsWith("Program data: "))
      .map((l) => d.coder.events.decode(l.slice("Program data: ".length)));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.name).toBe("Note");
    expect(ev[0]!.data.title).toBe("hello");
    expect(ev[0]!.data.amount).toBeNull();
    expect((ev[0]!.data.at as BN).toNumber()).toBe(7);
    // Exactly the Borsh bytes: 8 + (4 + 5) + 1 + 8.
    const raw = Buffer.from(
      r
        .logs()
        .find((l) => l.startsWith("Program data: "))!
        .slice(14),
      "base64",
    );
    expect(raw.length).toBe(8 + 9 + 1 + 8);

    const e = expectOk(await send(d.svm, payer, [ix(d, "echo", { n: { title: "x", amount: new BN(5), at: new BN(1) }, k: new BN(2) }, [])]));
    const out = d.coder.types.decode("Note", Buffer.from(e.returnData().data()));
    expect(out.title).toBe("x");
    expect(out.amount.toNumber()).toBe(5);
    expect(out.at.toNumber()).toBe(3);
  });

  it("takes data enum variants that carry structs", async () => {
    const payer = await fundedSigner(d.svm);
    const run = (m: unknown) => send(d.svm, payer, [ix(d, "move", { m }, [])]);
    const u64 = (r: Awaited<ReturnType<typeof run>>) => Buffer.from(expectOk(r).returnData().data()).readBigUInt64LE(0);
    expect(u64(await run({ To: { to: { x: new BN(3), y: new BN(4), ok: true }, tag: 2 } }))).toBe(2034n);
    expect(u64(await run({ Stay: {} }))).toBe(0n);
    // A bool that is not 0 or 1 inside the struct is not a valid Borsh value.
    const good = ix(d, "move", { m: { To: { to: { x: new BN(3), y: new BN(4), ok: true }, tag: 2 } } }, []);
    const bad = Buffer.from(good.data!);
    bad[8 + 1 + 16] = 2;
    expect(customError(await send(d.svm, payer, [{ ...good, data: new Uint8Array(bad) }]))).toBe(102);
  });
});
