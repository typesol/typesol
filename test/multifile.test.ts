import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CompileError, generate } from "../src/compiler/index.js";
import { buildIdl } from "../src/compiler/idl.js";

/** Write a small program of several files and compile its entry; returns diagnostics or the model. */
function program(files: Record<string, string>, entry = "main.ts") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-mf-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  try {
    return { ok: generate(path.join(dir, entry)), errors: [] as string[], dir };
  } catch (e) {
    if (e instanceof CompileError) return { ok: undefined, errors: e.diagnostics.map((d) => `${path.basename(d.file)}: ${d.message}`), dir };
    throw e;
  }
}

const T = `import { type Mut, type Signer, type u64, require } from "typesol";`;

describe("multi-file programs", () => {
  it("only the entry file's exported functions are instructions; imported ones are helpers", () => {
    const ok = generate(fileURLToPath(new URL("../examples/orderbook/orderbook.ts", import.meta.url)));
    const idl = buildIdl(ok.model, "11111111111111111111111111111111");
    expect(idl.instructions.map((i) => i.name)).toEqual(["init", "place", "cancel", "best"]);
    expect([...ok.model.helpers.keys()].sort()).toEqual(["crosses", "min"]);
    // Imported files are processed first, so their error enums take the first codes.
    expect(idl.errors.map((e) => [e.code, e.name])).toEqual([
      [6000, "NotAdmin"],
      [6001, "ZeroQty"],
      [6002, "Full"],
      [6003, "NotFound"],
    ]);
  });

  it("resolves typesol names through each file's own imports", () => {
    const { ok, errors } = program({
      "lib.ts": `import { type u64 as Amount } from "typesol";\nexport function double(x: Amount): Amount { return x * 2n; }`,
      "main.ts": `${T}\nimport { double } from "./lib";\nexport interface S { v: u64; }\nexport function f(s: Mut<S>): void { s.v = double(s.v); }`,
    });
    expect(errors).toEqual([]);
    expect(ok!.c).toContain("fn_double");
  });

  it("reports TypeScript errors in imported files with their own path", () => {
    const { errors } = program({
      "lib.ts": `import { type u64 } from "typesol";\nexport function bad(x: u64): u64 { return x + 1; }`,
      "main.ts": `${T}\nimport { bad } from "./lib";\nexport function f(x: u64): void { bad(x); }`,
    });
    expect(errors.join("\n")).toMatch(/lib\.ts: .*number.*bigint|lib\.ts: .*bigint/);
  });

  const cases: [string, Record<string, string>, RegExp][] = [
    [
      "renamed relative imports",
      {
        "lib.ts": `import { type u64 } from "typesol";\nexport function one(): u64 { return 1n; }`,
        "main.ts": `${T}\nimport { one as uno } from "./lib";\nexport function f(): void { uno(); }`,
      },
      /renaming imports from TypeSOL files/,
    ],
    ["missing files", { "main.ts": `${T}\nimport { x } from "./nope";\nexport function f(): void {}` }, /cannot find "\.\/nope"/],
    [
      "the same name in two files",
      {
        "a.ts": `import { type u64 } from "typesol";\nexport interface P { v: u64; }`,
        "b.ts": `import { type u64 } from "typesol";\nexport interface P { w: u64; }`,
        "main.ts": `${T}\nimport { type P } from "./a";\nimport { type P as Q } from "./b";\nexport function f(): void {}`,
      },
      /already declared|renaming/,
    ],
    [
      "a helper in another file named like an instruction",
      {
        "lib.ts": `import { type u64 } from "typesol";\nexport function pay(x: u64): u64 { return x; }`,
        "main.ts": `${T}\nimport { pay as _p } from "./lib";\nexport function pay(x: u64): void {}`,
      },
      /already declared|renaming/,
    ],
    [
      "an unused helper file shadowing an instruction name",
      {
        "lib.ts": `import { type u64 } from "typesol";\nexport function pay(x: u64): u64 { return x; }\nexport function one(): u64 { return 1n; }`,
        "main.ts": `${T}\nimport { one } from "./lib";\nexport function pay(x: u64): void { one(); }`,
      },
      /"pay" is already declared in lib\.ts/,
    ],
    ["package imports", { "main.ts": `${T}\nimport { x } from "lodash";\nexport function f(): void {}` }, /relative TypeSOL files/],
    [
      "instructions in library files are helpers and must follow helper rules",
      {
        "lib.ts": `import { type Signer, type Init, type u64 } from "typesol";\nexport interface Box { v: u64; }\nexport function ix(s: Signer, b: Init<Box>): void {}`,
        "main.ts": `${T}\nimport { ix } from "./lib";\nexport function f(): void {}`,
      },
      /helpers take accounts that exist/,
    ],
  ];
  for (const [what, files, expected] of cases) {
    it(`rejects ${what}`, () => {
      expect(program(files).errors.join("\n")).toMatch(expected);
    });
  }
});

describe("large accounts and constants", () => {
  const big = `${T}\nimport { type FixedArray, type Init, type SystemProgram, type Zeroed, type Vec } from "typesol";\nexport interface Big { xs: FixedArray<u64, 2000>; }\n`;
  const cases: [string, string, RegExp][] = [
    [
      "Init<T> over 10 KiB",
      `${big}export function f(p: Mut<Signer>, b: Init<Big>, s: SystemProgram): void { b.create(p, ["b"]); }`,
      /at most 10240 through Init<T>.*Zeroed<Big>/,
    ],
    ["Zeroed<T> with a Vec", `${big}export interface V { xs: Vec<u64>; }\nexport function f(v: Zeroed<V>): void {}`, /Zeroed<T> is for fixed-size/],
    [
      "structs over 10 MiB",
      `${T}\nimport { type FixedArray } from "typesol";\nexport interface Huge { xs: FixedArray<u64, 1000000>; ys: FixedArray<u64, 400000>; }\nexport function f(): void {}`,
      /Solana accounts are at most/,
    ],
    ["non-literal constants", `${T}\nconst X = 1n + 2n;\nexport function f(): void {}`, /must be bigint, boolean or string literals/],
    ["typed constants out of range", `${T}\nimport { type u8 } from "typesol";\nconst X: u8 = 300n;\nexport function f(): void {}`, /300 does not fit in u8/],
    ["let at the top level", `${T}\nlet X = 1n;\nexport function f(): void {}`, /must be const literals/],
    [
      "ternaries between structs as values",
      `${big}export interface P { a: u64; }\nexport interface H { x: P; y: P; v: u64; }\nexport function f(h: Mut<H>, c: boolean): void { h.v = (c ? h.x : h.y).a; }`,
      /bind a choice between structs|unsupported/,
    ],
  ];
  for (const [what, src, expected] of cases) {
    it(`rejects ${what}`, () => {
      expect(program({ "main.ts": src }).errors.join("\n")).toMatch(expected);
    });
  }

  it("uses typed and untyped constants, including as seeds", () => {
    const { ok, errors } = program({
      "main.ts": `${T}\nimport { type Init, type SystemProgram, type u16 } from "typesol";\nconst SEED = "vault";\nconst FEE: u16 = 30n;\nconst LIMIT = 1000n;\nexport interface S { fee: u16; cap: u64; }\nexport function f(p: Mut<Signer>, s: Init<S>, sys: SystemProgram): void { s.create(p, [SEED, p.key]); s.fee = FEE; s.cap = LIMIT * 2n; require(LIMIT > 0n, "x"); }`,
    });
    expect(errors).toEqual([]);
    expect(ok!.model.instructions[0].pdas.get("s")).toEqual([
      { kind: "const", value: [...Buffer.from("vault")] },
      { kind: "account", path: "p" },
    ]);
  });
});
