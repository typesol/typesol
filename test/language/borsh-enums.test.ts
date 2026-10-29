// Data enums and strings inside @layout borsh structs: argument structs as Anchor declares them, returned and emitted
// in Anchor's bytes, and a data enum in a Borsh account; checked with Anchor's coder.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { CompileError, generate } from "../../src/compiler/index.js";
import { BN, SYSTEM_PROGRAM, acct, customError, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

describe("data enums and strings in @layout borsh structs", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/borsh-enums.ts", import.meta.url)));
  });

  it("takes, returns and emits an argument struct holding an enum with a String and a String", async () => {
    const payer = await fundedSigner(d.svm);
    const run = (args: object) => send(d.svm, payer, [ix(d, "update", { args }, [])]);
    const r = expectOk(await run({ field: { Key: { key: "color" } }, value: "réd", weight: 4 }));
    expect(r.logs()).toContain("Program log: key color = réd");
    const back = d.coder.types.decode("UpdateArgs", Buffer.from(r.returnData().data()));
    expect(back).toEqual({ field: { Key: { key: "color" } }, value: "réd", weight: 4 });
    const ev = r
      .logs()
      .filter((l) => l.startsWith("Program data: "))
      .map((l) => d.coder.events.decode(l.slice("Program data: ".length)));
    expect(ev.map((e) => e && [e.name, e.data])).toEqual([["UpdateArgs", { field: { Key: { key: "color" } }, value: "réd", weight: 5 }]]);
    expect(expectOk(await run({ field: { Symbol: {} }, value: "TS", weight: 0 })).logs()).toContain("Program log: symbol = TS");
  });

  it("refuses bad bytes: an unknown variant, invalid UTF-8, a short string", async () => {
    const payer = await fundedSigner(d.svm);
    const good = ix(d, "update", { args: { field: { Key: { key: "ab" } }, value: "cd", weight: 1 } }, []);
    const run = (data: Buffer) => send(d.svm, payer, [{ ...good, data: new Uint8Array(data) }]);
    const tag = Buffer.from(good.data!);
    tag[8] = 3;
    expect(customError(await run(tag))).toBe(102);
    const utf8 = Buffer.from(good.data!);
    utf8[8 + 1 + 4] = 0xff; // first byte of the key
    expect(customError(await run(utf8))).toBe(102);
    expect(customError(await run(Buffer.from(good.data!).subarray(0, good.data!.length - 2)))).toBe(102);
    expectOk(await run(Buffer.from(good.data!)));
  });

  it("stores a data enum without strings in a Borsh account, as Anchor does", async () => {
    const payer = await fundedSigner(d.svm);
    const [sketch] = await pda(d.programId, ["sketch", payer.address]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "draw", { shape: { Box: { w: new BN(3), h: new BN(4) } } }, [
          { address: payer.address, signer: payer, writable: true },
          { address: sketch, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const data = Buffer.from(acct(d.svm, sketch).data);
    const s = d.coder.accounts.decode("Sketch", data);
    expect(s.title).toBe("first");
    expect([s.shape.Box.w.toNumber(), s.shape.Box.h.toNumber(), s.count.toNumber()]).toEqual([3, 4, 1]);
    const enc = Buffer.from(await d.coder.accounts.encode("Sketch", s));
    expect(data.subarray(0, enc.length).equals(enc)).toBe(true);
  });

  it("keeps strings out of account data", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-borsh-enums-"));
    const file = path.join(dir, "p.ts");
    writeFileSync(
      file,
      `import { type Mut, type u64 } from "typesol";\n/** @layout borsh */\nexport interface S { name: string; n: u64 }\nexport function f(s: Mut<S>): void {}\n`,
    );
    let msg = "";
    try {
      generate(file);
    } catch (e) {
      if (e instanceof CompileError) msg = e.diagnostics.map((x) => x.message).join(" | ");
      else throw e;
    }
    expect(msg).toMatch(/holds a string .* account data uses FixedString<N>/);
  });
});
