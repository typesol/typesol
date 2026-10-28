// Security and correctness hardening: attacks and edge cases the compiler and runtime must handle.
import { getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import * as spl from "@solana-program/token";
import * as t22 from "@solana-program/token-2022";
import { type Address, address, generateKeyPairSigner, getAddressDecoder, getAddressEncoder } from "@solana/kit";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { build } from "../src/compiler/index.js";
import { generateCpi, type Idl } from "../src/cpigen.js";
import { BN, SYSTEM_PROGRAM, TOKEN_PROGRAM, customError, decodeAccount, deployFile, expectOk, fundedSigner, ix, pda, send, acct } from "./harness.js";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/hardening/${name}.ts`, import.meta.url));
const T22 = address(t22.TOKEN_2022_PROGRAM_ADDRESS);
const enc = getAddressEncoder();
const dec = getAddressDecoder();
const pk = (a: string) => ({ toBuffer: () => Buffer.from(enc.encode(a as never)) });
const u64 = (r: ReturnType<typeof expectOk>) => Buffer.from(r.returnData().data()).readBigUInt64LE();

describe("hardening: runtime", () => {
  it("data written after a variable-size field is bounds-checked (event too large, no stack overflow)", async () => {
    const d = await deployFile(fixture("overflow"));
    const user = await fundedSigner(d.svm);
    const vault = await fundedSigner(d.svm);
    const shout = (reps: number) =>
      send(d.svm, user, [
        ix(d, "shout", { piece: "x".repeat(100), reps: new BN(reps), amount: new BN(1), k: pk(user.address) }, [
          { address: user.address, signer: user },
          { address: vault.address, signer: vault, writable: true },
        ]),
      ]);
    expectOk(await shout(7)); // 8 + 4 + 700 + 8 * 32 + 8 = 976 bytes: fits
    // 1000 bytes of text + 8 Pubkeys + u64 > 1024: refused before anything is written past the buffer.
    expect(customError(await shout(10))).toBe(5107);
  });

  it("CPI data after a string is bounds-checked too (102)", async () => {
    const d = await deployFile(fixture("cpidata"));
    const payer = await fundedSigner(d.svm);
    const target = await fundedSigner(d.svm);
    // 8 (sighash) + 4 + 1010 + 8 > 1024. The Anchor coder caps at 1000 bytes, so encode by hand.
    const base = ix(d, "relay", { memo: "", amount: new BN(1) }, [{ address: target.address, signer: target, writable: true }, { address: SYSTEM_PROGRAM }]);
    const memo = Buffer.alloc(1010, 0x6d);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(memo.length);
    const data = Buffer.concat([Buffer.from(base.data!).subarray(0, 8), len, memo, Buffer.alloc(8, 1)]);
    expect(customError(await send(d.svm, payer, [{ ...base, data: new Uint8Array(data) }]))).toBe(102);
  });

  it("realloc never moves deposits to the caller: growth is paid by the payer, shrinking pays nothing back", async () => {
    const d = await deployFile(fixture("realloc_pool"));
    const admin = await fundedSigner(d.svm, 100n);
    const [pool] = await pda(d.programId, ["pool"]);
    expectOk(
      await send(d.svm, admin, [
        ix(d, "open", {}, [{ address: admin.address, signer: admin, writable: true }, { address: pool, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    const victim = await fundedSigner(d.svm, 100n);
    expectOk(
      await send(d.svm, victim, [
        ix(d, "deposit", { amount: new BN("50000000000") }, [
          { address: victim.address, signer: victim, writable: true },
          { address: pool, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const attacker = await fundedSigner(d.svm);
    const size = acct(d.svm, pool).data.length;
    const expand = (n: number) =>
      send(d.svm, attacker, [
        ix(d, "expand", { size: new BN(n) }, [
          { address: attacker.address, signer: attacker, writable: true },
          { address: pool, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    const rent = (n: number) => d.svm.minimumBalanceForRentExemption(BigInt(n));
    const pool0 = d.svm.getBalance(pool)!;
    const a0 = d.svm.getBalance(attacker.address)!;
    // Grow: the payer funds the extra rent although the pool could have covered it.
    expectOk(await expand(size + 8));
    expect(d.svm.getBalance(pool)! - pool0).toBe(rent(size + 8) - rent(size));
    // Same size: nothing moves.
    expectOk(await expand(size + 8));
    // Shrink: nothing comes back to the caller.
    expectOk(await expand(size));
    expect(d.svm.getBalance(pool)! - pool0).toBe(rent(size + 8) - rent(size));
    expect(a0 - d.svm.getBalance(attacker.address)!).toBe(rent(size + 8) - rent(size) + 3n * 5000n);
    // Growing by 10 KiB, shrinking back and repeating only costs the attacker.
    for (let i = 0; i < 5; i++) {
      expectOk(await expand(size + 10_240));
      expectOk(await expand(size));
    }
    expect(d.svm.getBalance(attacker.address)!).toBeLessThan(a0);
    expect(d.svm.getBalance(pool)!).toBeGreaterThanOrEqual(pool0);
  });

  it("Token-2022 extension readers refuse a multisig (or any non-mint layout)", async () => {
    const d = await deployFile(fixture("t22forge"));
    const attacker = await fundedSigner(d.svm);
    const ms = await generateKeyPairSigner();
    const signers = await Promise.all(Array.from({ length: 11 }, async () => (await generateKeyPairSigner()).address));
    expectOk(
      await send(d.svm, attacker, [
        getCreateAccountInstruction({ payer: attacker, newAccount: ms, lamports: d.svm.minimumBalanceForRentExemption(355n), space: 355, programAddress: T22 }),
        t22.getInitializeMultisig2Instruction({ multisig: ms.address, m: 1, signers }) as never,
      ]),
    );
    for (const [name, args] of [
      ["quote", { amount: new BN(1000) }],
      ["delegate_of", {}],
      ["has_pd", {}],
    ] as const)
      expect(customError(await send(d.svm, attacker, [ix(d, name, args, [{ address: ms.address }])]))).toBe(3003);
    // Not a token-program account at all.
    expect(customError(await send(d.svm, attacker, [ix(d, "quote", { amount: new BN(1) }, [{ address: attacker.address }])]))).toBe(3007);
  });

  it("Ata<> also checks the token account's owner and mint fields (owner reassigned -> 2015)", async () => {
    const d = await deployFile(fixture("t22forge"));
    const alice = await fundedSigner(d.svm);
    const mallory = (await generateKeyPairSigner()).address;
    const mint = await generateKeyPairSigner();
    expectOk(
      await send(d.svm, alice, [
        getCreateAccountInstruction({
          payer: alice,
          newAccount: mint,
          lamports: d.svm.minimumBalanceForRentExemption(82n),
          space: 82,
          programAddress: TOKEN_PROGRAM,
        }),
        spl.getInitializeMint2Instruction({ mint: mint.address, decimals: 0, mintAuthority: alice.address }),
      ]),
    );
    const [ata] = await spl.findAssociatedTokenPda({ owner: alice.address, mint: mint.address, tokenProgram: TOKEN_PROGRAM });
    expectOk(await send(d.svm, alice, [await spl.getCreateAssociatedTokenInstructionAsync({ payer: alice, owner: alice.address, mint: mint.address })]));
    const call = () => send(d.svm, alice, [ix(d, "ata_owner", {}, [{ address: ata }, { address: alice.address }, { address: mint.address }])]);
    expect(
      dec.decode(
        Buffer.from(
          expectOk(await call())
            .returnData()
            .data(),
        ),
      ),
    ).toBe(alice.address);
    expectOk(
      await send(d.svm, alice, [
        spl.getSetAuthorityInstruction({ owned: ata, owner: alice, authorityType: spl.AuthorityType.AccountOwner, newAuthority: mallory }),
      ]),
    );
    expect(customError(await call())).toBe(2015);
  });

  it("rentExempt overflows abort instead of wrapping", async () => {
    const d = await deployFile(fixture("rentx"));
    const payer = await fundedSigner(d.svm);
    expect(customError(await send(d.svm, payer, [ix(d, "rent", { space: new BN((2n ** 64n - 128n).toString()) }, [])]))).toBe(5100);
    expect(u64(expectOk(await send(d.svm, payer, [ix(d, "rent", { space: new BN(0) }, [])])))).toBe(d.svm.minimumBalanceForRentExemption(0n));
  });
});

describe("hardening: strings", () => {
  it("keeps non-ASCII bytes followed by hex-digit letters intact in literals", async () => {
    const d = await deployFile(fixture("strings"));
    const payer = await fundedSigner(d.svm);
    const text = "éa café\u0001b ?? ";
    expect(u64(expectOk(await send(d.svm, payer, [ix(d, "check", { s: text }, [])])))).toBe(BigInt(Buffer.byteLength(text)));
  });

  it("string arguments must be valid UTF-8 (102), as Borsh String requires", async () => {
    const d = await deployFile(fixture("strings"));
    const payer = await fundedSigner(d.svm);
    const good = ix(d, "check", { s: "ab" }, []);
    for (const bad of [[0xc3], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80]]) {
      const len = Buffer.alloc(4);
      len.writeUInt32LE(bad.length);
      const data = Buffer.concat([Buffer.from(good.data!).subarray(0, 8), len, Buffer.from(bad)]);
      expect(customError(await send(d.svm, payer, [{ ...good, data: new Uint8Array(data) }]))).toBe(102);
    }
  });

  it("checks UTF-8 after ASCII runs of every length (the 8-byte ASCII fast path)", async () => {
    const d = await deployFile(fixture("strings"));
    const payer = await fundedSigner(d.svm);
    const good = ix(d, "check", { s: "ab" }, []);
    const call = (bytes: number[]) => {
      const len = Buffer.alloc(4);
      len.writeUInt32LE(bytes.length);
      return send(d.svm, payer, [{ ...good, data: new Uint8Array(Buffer.concat([Buffer.from(good.data!).subarray(0, 8), len, Buffer.from(bytes)])) }]);
    };
    for (let run = 0; run <= 17; run++) {
      const ascii = Array.from({ length: run }, (_, i) => 0x61 + (i % 26));
      // Valid: a 2-, 3- and 4-byte sequence after the run, then more ASCII.
      for (const ok of [
        [0xc3, 0xa9],
        [0xe2, 0x82, 0xac],
        [0xf0, 0x9f, 0x98, 0x80],
      ])
        expectOk(await call([...ascii, ...ok, 0x7a, 0x7a]));
      // Invalid: a lone continuation, an overlong, a surrogate, a truncated sequence at the end.
      for (const bad of [[0x80], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xe2, 0x82]]) expect(customError(await call([...ascii, ...bad]))).toBe(102);
    }
  });
});

describe("hardening: evaluation order", () => {
  async function holder(file = "order") {
    const d = await deployFile(fixture(file));
    const payer = await fundedSigner(d.svm);
    const [h] = await pda(d.programId, ["h"]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "init", {}, [{ address: payer.address, signer: payer, writable: true }, { address: h, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    return { d, payer, h };
  }

  it("push evaluates its value before the Vec grows", async () => {
    const { d, payer, h } = await holder();
    for (let i = 0; i < 2; i++)
      expectOk(
        await send(d.svm, payer, [
          ix(d, "push_len", {}, [{ address: payer.address, signer: payer, writable: true }, { address: h, writable: true }, { address: SYSTEM_PROGRAM }]),
        ]),
      );
    expect(decodeAccount<{ items: BN[] }>(d, d.svm, "Holder", h).items.map(String)).toEqual(["0", "1"]);
  });

  it("object literals evaluate in source order (struct values and events)", async () => {
    const { d, payer, h } = await holder();
    expectOk(await send(d.svm, payer, [ix(d, "lit_order", {}, [{ address: h, writable: true }])]));
    const q = decodeAccount<{ q: { x: BN; y: BN } }>(d, d.svm, "Holder", h).q;
    expect([q.x.toString(), q.y.toString()]).toEqual(["1", "1"]);
    const r = expectOk(await send(d.svm, payer, [ix(d, "ev_order", {}, [{ address: h, writable: true }])]));
    const ev = d.coder.events.decode(
      r
        .logs()
        .find((l) => l.startsWith("Program data: "))!
        .slice(14),
    )!;
    expect([(ev.data.a as BN).toString(), (ev.data.b as BN).toString()]).toEqual(["2", "2"]);
  });

  it("Pubkey and struct helper arguments are values, read at the call", async () => {
    const { d, payer, h } = await holder();
    const next = (await generateKeyPairSigner()).address;
    const old = expectOk(await send(d.svm, payer, [ix(d, "swap_owner", { next: pk(next) }, [{ address: h, writable: true }])]));
    expect(dec.decode(Buffer.from(old.returnData().data()))).toBe(payer.address);
    expect(u64(expectOk(await send(d.svm, payer, [ix(d, "struct_param", {}, [{ address: h, writable: true }])])))).toBe(1n);
  });

  it("builtin arguments are read left to right (mulDiv, associatedTokenAddress)", async () => {
    const { d, payer, h } = await holder();
    expect(u64(expectOk(await send(d.svm, payer, [ix(d, "md", {}, [{ address: h, writable: true }])])))).toBe(5n);
    const o = await holder("order2");
    const next = (await generateKeyPairSigner()).address;
    const mint = (await generateKeyPairSigner()).address;
    const got = expectOk(
      await send(o.d.svm, o.payer, [ix(o.d, "ata", { next: pk(next), mint: pk(mint), tp: pk(TOKEN_PROGRAM) }, [{ address: o.h, writable: true }])]),
    );
    const [want] = await spl.findAssociatedTokenPda({ owner: o.payer.address, mint: next, tokenProgram: TOKEN_PROGRAM });
    expect(dec.decode(Buffer.from(got.returnData().data()))).toBe(want);
  });

  it("set(i, pop()) checks the index against the length after pop", async () => {
    const { d, payer, h } = await holder("order2");
    const push = (v: number) =>
      send(d.svm, payer, [
        ix(d, "push", { v: new BN(v) }, [
          { address: payer.address, signer: payer, writable: true },
          { address: h, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    for (const v of [10, 20, 30]) expectOk(await push(v));
    const swap = (i: number) => send(d.svm, payer, [ix(d, "swap_remove", { i: new BN(i) }, [{ address: h, writable: true }])]);
    expect(customError(await swap(2))).toBe(5104);
    expect(u64(expectOk(await swap(0)))).toBe(2n);
    expect(decodeAccount<{ items: BN[] }>(d, d.svm, "Holder", h).items.map(String)).toEqual(["30", "20"]);
  });
});

describe("hardening: evaluation order, heap reuse and seeds", () => {
  async function r2() {
    const d = await deployFile(fixture("order3"));
    const payer = await fundedSigner(d.svm);
    const [h] = await pda(d.programId, ["h"]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "init", {}, [{ address: payer.address, signer: payer, writable: true }, { address: h, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    return { d, payer, h };
  }

  it("a.equals(f()) reads a before f() runs; event fields read before later ones run", async () => {
    const { d, payer, h } = await r2();
    const next = (await generateKeyPairSigner()).address;
    const eq = (n: string) => send(d.svm, payer, [ix(d, "eq", { next: pk(n) }, [{ address: h, writable: true }])]);
    expect(u64(expectOk(await eq(next)))).toBe(0n); // old owner (payer) !== next
    expect(u64(expectOk(await eq(next)))).toBe(1n); // now it was already next
    const r = expectOk(await send(d.svm, payer, [ix(d, "ev", {}, [{ address: h, writable: true }])]));
    const ev = d.coder.events.decode(
      r
        .logs()
        .find((l) => l.startsWith("Program data: "))!
        .slice(14),
    )!;
    expect(Object.keys(ev.data.act as object)).toEqual(["Deposit"]);
  });

  it("the assignment target is chosen before the right side runs", async () => {
    const { d, payer, h } = await r2();
    expect(u64(expectOk(await send(d.svm, payer, [ix(d, "idx", {}, [{ address: h, writable: true }])])))).toBe(9n);
    const pts = decodeAccount<{ pts: { x: BN }[]; i: BN }>(d, d.svm, "Holder", h);
    expect([pts.i.toString(), pts.pts[1].x.toString()]).toEqual(["1", "0"]);
  });

  it("a struct helper argument in a loop does not exhaust the heap", async () => {
    const { d, payer, h } = await r2();
    // 40 copies of a 1 KB struct would need 40 KB of a 32 KB heap if each call allocated.
    const data = Buffer.alloc(5);
    data[0] = 2; // ComputeBudget SetComputeUnitLimit
    data.writeUInt32LE(1_400_000, 1);
    const cuLimit = { programAddress: address("ComputeBudget111111111111111111111111111111"), accounts: [], data: new Uint8Array(data) };
    const r = expectOk(await send(d.svm, payer, [cuLimit as never, ix(d, "spin", { n: new BN(40) }, [{ address: h, writable: true }])]));
    expect(u64(r)).toBe(40n);
  });

  it("a u128 constant seed is 16 bytes, in the program and in the IDL", async () => {
    const { d, payer } = await r2();
    const big = new Uint8Array(16);
    big[0] = 5;
    const [b] = await pda(d.programId, ["box", big]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "boxed", {}, [{ address: payer.address, signer: payer, writable: true }, { address: b, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    const seeds = (d.idl as unknown as { instructions: { name: string; accounts: { pda?: { seeds: { value?: number[] }[] } }[] }[] }).instructions
      .find((i) => i.name === "boxed")!
      .accounts.find((a) => a.pda)!.pda!.seeds;
    expect(seeds[1].value).toEqual([...big]);
  });
});

describe("hardening: builds", () => {
  const tmp = () => mkdtempSync(path.join(os.tmpdir(), "typesol-hardening-"));
  const compile = (name: string, body: string) => {
    const dir = tmp();
    const file = path.join(dir, name);
    writeFileSync(file, body);
    return build(file, path.join(dir, "out"), "11111111111111111111111111111112");
  };

  it("self-comparisons and 256-variant enums compile", () => {
    const variants = Array.from({ length: 256 }, (_, i) => `V${i}`).join(", ");
    expect(() =>
      compile(
        "edge.ts",
        `import { type u64 } from "typesol";\nexport enum Big { ${variants} }\nexport function f(a: u64, e: Big): u64 { if (a === a) return 1n; return 0n; }\n`,
      ),
    ).not.toThrow();
  });

  it("a source file name with a quote does not break the generated C", () => {
    expect(() => compile('we"ird.ts', `import { type u64 } from "typesol";\nexport function f(a: u64): u64 { return a + 1n; }\n`)).not.toThrow();
  });

  it("generated CPI bindings with enum arguments typecheck in the caller", () => {
    const dir = tmp();
    writeFileSync(
      path.join(dir, "colors.ts"),
      `import { type Signer } from "typesol";\nexport enum Color { Red, Green, Blue }\nexport function setc(user: Signer, c: Color, o: Color | null): void {}\n`,
    );
    const idl = build(path.join(dir, "colors.ts"), path.join(dir, "out1"), "11111111111111111111111111111112").idl;
    const gen = generateCpi(idl as unknown as Idl);
    expect(gen.skipped).toEqual([]);
    writeFileSync(path.join(dir, "colors_cpi.ts"), gen.source);
    const fn = gen.generated[0];
    writeFileSync(
      path.join(dir, "caller.ts"),
      `import { type Signer, type Program, signer } from "typesol";\nimport { ${fn}, Color } from "./colors_cpi";\nexport function go(user: Signer, p: Program<"11111111111111111111111111111112">): void { ${fn}(p, user, Color.Blue, null, signer([])); }\n`,
    );
    expect(() => build(path.join(dir, "caller.ts"), path.join(dir, "out2"), "11111111111111111111111111111113")).not.toThrow();
  });
});
void getTransferSolInstruction;
