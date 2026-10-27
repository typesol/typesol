// Helpers that return structs: literals, places, other helpers' results; the caller gets its own copy.
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CompileError, generate } from "../src/compiler/index.js";
import { BN, SYSTEM_PROGRAM, decodeAccount, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "./harness.js";

type P = { x: BN; y: BN };
const xy = (p: P) => [p.x.toNumber(), p.y.toNumber()];

describe("helpers returning structs", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/structret.ts", import.meta.url)));
  });

  it("builds, copies and chains struct results", async () => {
    const admin = await fundedSigner(d.svm);
    const [board] = await pda(d.programId, ["board", admin.address]);
    const b = { address: board, writable: true };
    expectOk(await send(d.svm, admin, [ix(d, "setup", {}, [{ address: admin.address, signer: admin, writable: true }, b, { address: SYSTEM_PROGRAM }])]));
    let s = decodeAccount<{ home: P; path: P[] }>(d, d.svm, "Board", board);
    expect(xy(s.home)).toEqual([3, 4]);
    expect(s.path.map(xy)).toEqual([
      [13, 15],
      [0, 5],
      [0, 0],
    ]);

    const r = expectOk(await send(d.svm, admin, [ix(d, "check", {}, [b])]));
    expect(Buffer.from(r.returnData().data()).readBigUInt64LE(0)).toBe(9n + 4n);
    s = decodeAccount<{ home: P; path: P[] }>(d, d.svm, "Board", board);
    expect(xy(s.home)).toEqual([100, 200]);
    expect(xy(s.path[2])).toEqual([4, 5]);
  });

  it("refuses variable-size results and wrong return values", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-structret-"));
    const errors = (body: string) => {
      const file = path.join(dir, `p${Math.random().toString(36).slice(2)}.ts`);
      writeFileSync(
        file,
        `import { type Account, type Vec, type u64 } from "typesol";\nexport interface P { x: u64 }\nexport interface V { xs: Vec<u64> }\n${body}\nexport function f(): void {}\n`,
      );
      try {
        generate(file);
        return [];
      } catch (e) {
        if (e instanceof CompileError) return e.diagnostics.map((x) => x.message);
        throw e;
      }
    };
    expect(errors(`function g(v: Account<V>): V { return v; }`).join()).toMatch(/variable-size fields and cannot be returned/);
    expect(errors(`function g(): P { return 1n; }`).join()).toMatch(/not assignable|expected a P/);
  });
});
