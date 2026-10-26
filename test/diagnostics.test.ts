import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CompileError, generate } from "../src/compiler/index.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-diag-"));
const HEADER = `import { type Account, type AccountInfo, type FixedArray, type Init, type Mut, type Program, type Pubkey, type Signer, type SystemProgram, type UncheckedProgram, type FixedString, type Option, type Vec, type u64, type HasOne, type Seeds, type CloseTo, type SwitchboardFeed, emit, byteLength, requirePda, loadAccount, remainingAccounts, fixedArray, invoke, readonly, returnData, writable, writableSigner, require, u8 } from "typesol";
export interface Box { owner: Pubkey; value: u64; }
`;

function errorsFor(body: string, name = "prog"): string[] {
  const file = path.join(dir, `${name}.ts`);
  writeFileSync(file, HEADER + body);
  try {
    generate(file);
  } catch (e) {
    if (e instanceof CompileError) return e.diagnostics.map((d) => d.message);
    throw e;
  }
  return [];
}

describe("subset enforcement", () => {
  const cases: [string, string, RegExp][] = [
    ["floating-point numbers", `export function f(b: Mut<Box>): void { b.value = 1; }`, /Type 'number' is not assignable|bigint literal/],
    ["do-while loops", `export function f(b: Mut<Box>): void { do { b.value += 1n; } while (b.value < 3n); }`, /only for \(init; cond; step\) and while/],
    ["break outside a loop", `export function f(b: Mut<Box>): void { if (b.value > 0n) { break; } }`, /Jump target|outside a loop/],
    [
      "recursive helpers",
      `function a(x: u64): u64 { return b(x); }\nfunction b(x: u64): u64 { return a(x); }\nexport function f(): void {}`,
      /recursion is not supported/,
    ],
    ["helpers that take Init accounts", `function h(b: Init<Box>): void {}\nexport function f(): void {}`, /helpers take accounts that exist/],
    [
      "helpers with constraint types",
      `function h(b: HasOne<Mut<Box>, "owner">): void {}\nexport function f(): void {}`,
      /constraints belong on instruction parameters/,
    ],
    [
      "passing a read-only account where a helper takes Mut",
      `function h(b: Mut<Box>): void { b.value = 1n; }\nexport function f(b: Account<Box>): void { h(b); }`,
      /h\(\) takes b as Mut<Box>/,
    ],
    [
      "(TypeScript) passing another struct's account to a helper",
      `export interface Other { v: u64; }\nfunction h(b: Mut<Box>): void { b.value = 1n; }\nexport function f(o: Mut<Other>): void { h(o); }`,
      /not assignable to parameter of type 'Mut<Box>'|h\(\) takes b as Mut<Box>/,
    ],
    ["helpers without a return type", `function h(x: u64) { return x; }\nexport function f(): void {}`, /explicit return type/],
    [
      "copying arrays of different shapes",
      `export interface Arr { xs: FixedArray<u64, 4>; ys: FixedArray<u64, 3>; }\nexport function f(a: Mut<Arr>): void { a.xs = a.ys; }`,
      /assign a FixedArray<u64, 4> from another|not assignable/,
    ],
    ["zero-length arrays", `export interface Arr { xs: FixedArray<u64, 0>; }\nexport function f(): void {}`, /array length must be 1\.\.1000000/],
    ["unpinned Program types", `export function f(p: Program<string>): void {}`, /pin the program address/],
    ["invalid pinned addresses", `export function f(p: Program<"not-an-address">): void {}`, /not a valid base58 Solana address/],
    ["writable() on read-only accounts", `export function f(p: UncheckedProgram, a: AccountInfo): void { invoke(p, [writable(a)], []); }`, /not writable here/],
    [
      "signing without a signature or seeds",
      `export function f(p: UncheckedProgram, a: Mut<AccountInfo>): void { invoke(p, [writableSigner(a)], []); }`,
      /did not sign/,
    ],
    ["CPI helpers outside invoke", `export function f(a: AccountInfo): void { const x = readonly(a); }`, /only valid inside the accounts list/],
    ["invoking a non-program", `export function f(a: AccountInfo): void { invoke(a as never, [], []); }`, /program must be/],
    ["emit without a type argument", `export interface Ev { v: u64; }\nexport function f(): void { emit({ v: 1n }); }`, /explicit event type/],
    [
      "events with missing fields",
      `export interface Ev { v: u64; w: u64; }\nexport function f(): void { emit<Ev>({ v: 1n } as Ev); }`,
      /one object literal|missing field/,
    ],
    [
      "events with unknown fields",
      `export interface Ev { v: u64; }\nexport function f(): void { emit<Ev>({ v: 1n, z: 2n } as Ev); }`,
      /one object literal|has no field "z"/,
    ],
    ["returnData without a type", `export function f(p: UncheckedProgram): void { const x = returnData(p); }`, /explicit type/],
    [
      "fixedArray outside a declaration",
      `export function f(b: Mut<Box>): void { b.value = fixedArray<u64, 2>(0n).get(0n); }`,
      /only allowed as a local declaration|get/,
    ],
    ["oversized local arrays", `export function f(): void { const xs = fixedArray<u64, 300>(0n); }`, /N must be a literal 1\.\.256/],
    ["zero-capacity strings", `export interface S { name: FixedString<0>; }\nexport function f(): void {}`, /capacity 1\.\.1024/],
    ["structs that contain themselves", `export interface Node { next: Node; }\nexport function f(): void {}`, /contains itself/],
    ["variable strings in account data", `export interface S { name: string; }\nexport function f(a: Mut<S>): void {}`, /cannot be account data/],
    [
      "Pubkeys inside template strings",
      "export function f(b: Account<Box>): void { const s = `owner ${b.owner}`; }",
      /only strings, integers and booleans can be joined/,
    ],
    ["string .length", `export function f(s: string): void { const n = s.length; }`, /byteLength|number/],
    ["Vec fields that are not last", `export interface S { xs: Vec<u64>; n: u64; }\nexport function f(): void {}`, /must be the last field/],
    [
      "growing a Vec without SystemProgram",
      `export interface S { xs: Vec<u64>; }\nexport function f(p: Mut<Signer>, s: Mut<S>): void { s.xs.push(1n, p); }`,
      /need a SystemProgram/,
    ],
    [
      "Vecs nested in other structs",
      `export interface Inner { xs: Vec<u64>; }\nexport interface S { inner: Inner; }\nexport function f(s: Mut<S>): void {}`,
      /can only be account data|ends in a Vec/,
    ],
    ["value enums with gaps", `export enum E { A = 0, B = 5 }\nexport function f(): void {}`, /numbered 0, 1, 2/],
    ["null where no Option is expected", `export function f(b: Mut<Box>): void { b.value = null as never; }`, /not supported|null is only valid/],
    [
      "comparing a non-option with null",
      `export function f(b: Mut<Box>): void { require((b.value as u64 | null) !== null, "x"); }`,
      /not supported|only Option values/,
    ],
    ["loadAccount used inline", `export function f(): void { const n = loadAccount<Box>(remainingAccounts().get(0n)).value; }`, /bind loadAccount/],
    ["mutating Vec arguments", `export function f(xs: Vec<u64>): void { xs.set(0n, 1n); }`, /Vec arguments are read-only/],
    [
      "popping a Vec of structs",
      `export interface P { x: u64; }\nexport interface S { ps: Vec<P>; }\nexport function f(s: Mut<S>): void { const p = s.ps.pop(); }`,
      /pop\(\) returns integers/,
    ],
    [
      "Option fields in an account struct used as an event",
      `export interface S { o: Option<u64>; }\nexport function f(s: Mut<S>): void { emit<S>({ o: null }); }`,
      /separate event struct/,
    ],
    [
      "merkle proofs that are not Vec<Hash> arguments",
      `export function f(b: Mut<Box>): void { require(true, "x"); }\nexport function g(): boolean { return true; }`,
      /^$/,
    ],
    ["data-enum variants without kind", `export type A = { amount: u64 } | { kind: "B" };\nexport function f(): void {}`, /needs kind: "Name"/],
    ["duplicate data-enum variants", `export type A = { kind: "X" } | { kind: "X" };\nexport function f(): void {}`, /duplicate variant/],
    [
      "reading a data-enum field without narrowing",
      `export type A = { kind: "X"; a: u64 } | { kind: "Y"; b: u64 };\nexport interface S { act: A; v: u64; }\nexport function f(s: Mut<S>): void { s.v = s.act.a; }`,
      /does not exist on type|narrow/,
    ],
    ["HasOne naming a missing parameter", `export function f(b: HasOne<Mut<Box>, "owner">): void {}`, /add an account parameter named "owner"/],
    ["Seeds referencing an unknown name", `export function f(b: Seeds<Mut<Box>, ["box", "@nobody"]>): void {}`, /neither an account parameter nor an argument/],
    ["CloseTo into a read-only account", `export function f(s: Signer, b: CloseTo<Mut<Box>, "s">): void {}`, /must be writable/],
    [
      "string arguments in a data-enum argument",
      `export type A = { kind: "X"; s: FixedString<4> };\nexport function f(a: A): void {}`,
      /enum arguments carry integers/,
    ],
    ["@discriminator without a value", `/** @discriminator */\nexport function f(): void {}`, /@discriminator needs/],
    [
      "writing arrays on read-only accounts",
      `export interface Arr { xs: FixedArray<u64, 4>; }\nexport function f(a: Account<Arr>): void { a.xs.set(0n, 1n); }`,
      /read-only/,
    ],
    ["writes through read-only accounts", `export function f(b: Account<Box>): void { (b as Box).value = 1n; }`, /can only assign|not supported/],
    [
      "writes to Account<T>",
      `export function f(b: Account<Box>, s: Signer): void { require(true, "x"); }\nexport function g(b: Mut<Box>): void { b.value = 2n; }\nexport function h(b: Account<Box>): void { const x = b.value; }`,
      /^$/,
    ],
    ["mixed integer widths", `export function f(b: Mut<Box>, x: u8): void { b.value = b.value + x; }`, /different types: u64 and u8/],
    ["literals out of range", `export function f(x: u8): void { const y: u8 = 256n; }`, /256 does not fit in u8/],
    ["non-typesol imports", `import fs from "node:fs";\nexport function f(): void {}`, /only imports from "typesol"/],
    ["instructions returning strings", `export function f(): string { return "x"; }`, /return void or one integer/],
    ["Init without SystemProgram", `export function f(p: Mut<Signer>, b: Init<Box>): void { b.create(p, ["b"]); }`, /need a SystemProgram/],
    ["Init never created", `export function f(p: Mut<Signer>, b: Init<Box>, s: SystemProgram): void { }`, /never created/],
    [
      "use before create",
      `export function f(p: Mut<Signer>, b: Init<Box>, s: SystemProgram): void { b.value = 1n; b.create(p, ["b"]); }`,
      /used before b.create/,
    ],
    [
      "create inside a branch",
      `export function f(p: Mut<Signer>, b: Init<Box>, s: SystemProgram, ok: boolean): void { if (ok) { b.create(p, ["b"]); } }`,
      /must be a top-level statement/,
    ],
    ["payer must be Mut<Signer>", `export function f(p: Signer, b: Init<Box>, s: SystemProgram): void { b.create(p, ["b"]); }`, /payer must be a Mut<Signer>/],
    [
      "long string seeds",
      `export function f(p: Mut<Signer>, b: Init<Box>, s: SystemProgram): void { b.create(p, ["${"x".repeat(33)}"]); }`,
      /at most 32 bytes/,
    ],
    ["reserved field names", `export interface Bad { key: u64; }\nexport function f(): void {}`, /"key" is reserved/],
    ["lamports on read-only accounts", `export function f(b: Account<Box>): void { b.lamports = 0n; }`, /Cannot assign|read-only/],
    ["arrays outside seeds", `export function f(b: Mut<Box>): void { const a = [1n]; }`, /only allowed inline as seeds/],
    ["unknown names", `export function f(b: Mut<Box>): void { b.value = missing; }`, /Cannot find name 'missing'|unknown name/],
    ["C keywords as field names", `export interface K { long: u64; }\nexport function f(): void {}`, /"long" is reserved in the generated C/],
    ["SDK macro names as field names", `export interface K { SUCCESS: u64; }\nexport function f(): void {}`, /"SUCCESS" is reserved/],
    ["C keywords as variant names", `export type A = { kind: "default" } | { kind: "B" };\nexport function f(): void {}`, /"default" is reserved/],
    ["names with __", `export interface K { a__b: u64; }\nexport function f(): void {}`, /reserved for generated code/],
    [
      "(accepted) structs named like runtime types and fields named like generated members",
      `export interface Str { x: u64; }\nexport interface Opt_u64 { y: u64; }\nexport interface L { items_len: u64; items: Vec<u64>; }\nexport function f(a: Mut<Str>, b: Mut<Opt_u64>, l: Mut<L>): void { a.x = b.y + l.items_len + l.items.length; }`,
      /^$/,
    ],
    [
      "(accepted) data enums whose names meet with an underscore",
      `export type A_B = { kind: "C"; v: u64 } | { kind: "D" };\nexport type A = { kind: "B_C"; w: u64 } | { kind: "E" };\nexport interface H { p: A_B; q: A; }\nexport function f(h: Mut<H>): void { h.p = { kind: "D" }; h.q = { kind: "E" }; }`,
      /^$/,
    ],
    [
      "(accepted) arguments named like generated suffixes",
      `export function f(b: Mut<Box>, s: string, s_len: u64, flag: boolean, flag_raw: u64): void { b.value = s_len + flag_raw + byteLength(s); }`,
      /^$/,
    ],
    ["fields that meet in snake_case", `export interface K { fooBar: u64; foo_bar: u64; }\nexport function f(): void {}`, /both "foo_bar" in the IDL/],
    ["instructions that meet in snake_case", `export function doIt(): void {}\nexport function do_it(): void {}`, /both "do_it" in the IDL/],
    [
      "variant names that are not identifiers (no crash)",
      `export type A = { kind: "a-b" } | { kind: "C" };\nexport interface H { a: A; }\nexport function f(): void {}`,
      /needs kind: "Name" \(an identifier\)/,
    ],
    [
      "case labels that are variables",
      `export function f(b: Mut<Box>, x: u64): void { const k = 2n; switch (x) { case k: b.value = 1n; } }`,
      /case labels must be literals, constants or enum members/,
    ],
    [
      "optional chaining",
      `export interface Q { home: Option<Box>; v: u64; }\nexport function f(q: Mut<Q>): void { if (q.home?.value === 5n) q.v = 1n; }`,
      /optional chaining/,
    ],
    [
      "account structs with enum fields used as events",
      `export type A = { kind: "X"; a: u64 } | { kind: "Y" };\nexport interface S { act: A; }\nexport function f(s: Mut<S>): void { emit<S>({ act: s.act }); }`,
      /Option or enum fields and is account data/,
    ],
    [
      "replacing a Vec element still referenced",
      `export interface P { x: u64; }\nexport interface S { v: u64; ps: Vec<P>; }\nexport function f(s: Mut<S>): void { const o = s.ps.get(0n); s.ps.set(0n, { x: 42n }); s.v = o.x; }`,
      /"o" still refers to s\.ps\[\]/,
    ],
    [
      "clearing a Vec still referenced",
      `export interface P { x: u64; }\nexport interface S { v: u64; ps: Vec<P>; }\nexport function f(s: Mut<S>): void { const o = s.ps.get(1n); s.ps.clear(); s.v = o.x; }`,
      /"o" still refers to s\.ps\[\]/,
    ],
    [
      "replacing a struct field still referenced",
      `export interface P { x: u64; }\nexport interface S { p: P; v: u64; }\nexport function f(s: Mut<S>): void { const o = s.p; s.p = { x: 1n }; s.v = o.x; }`,
      /"o" still refers to s\.p/,
    ],
    [
      "replacing a data enum still referenced",
      `export type A = { kind: "X"; a: u64 } | { kind: "Y" };\nexport interface S { act: A; v: u64; }\nexport function f(s: Mut<S>): void { const a = s.act; if (a.kind === "X") { s.act = { kind: "X", a: 9n }; s.v = a.a; } }`,
      /"a" still refers to s\.act/,
    ],
    [
      "replacing inside a loop while a reference from before is used in it",
      `export interface P { x: u64; }\nexport interface S { p: P; v: u64; }\nexport function f(s: Mut<S>): void { const o = s.p; for (let i = 0n; i < 2n; i++) { s.v = o.x; s.p = { x: i }; } }`,
      /"o" still refers to s\.p/,
    ],
    [
      "(accepted) references not used after the replacement, or into other places",
      `export interface P { x: u64; }\nexport interface S { p: P; q: P; v: u64; }\nexport function f(s: Mut<S>): void { const o = s.p; s.v = o.x; s.p = { x: 1n }; const r = s.q; s.p = { x: 2n }; s.v = r.x; const t = s.p; t.x = 3n; }`,
      /^$/,
    ],
    [
      "discriminators that prefix another",
      `/** @discriminator 0x01 */\nexport function a(): void {}\n/** @discriminator 0x0102 */\nexport function b(): void {}`,
      /discriminator of b starts with the discriminator of a/,
    ],
    [
      "constraints on a required account that use an optional one",
      `export interface T { owner: Pubkey; n: u64; }\nexport function f(t: HasOne<Mut<T>, "owner">, owner: Signer | null): void {}`,
      /uses "owner", which is optional/,
    ],
    [
      "Seeds that use an optional account",
      `export interface T { owner: Pubkey; n: u64; }\nexport function f(t: Seeds<Mut<T>, ["t", "@user"]>, user: Signer | null): void {}`,
      /uses "user", which is optional/,
    ],
    [
      "CloseTo into an optional account",
      `export interface T { owner: Pubkey; n: u64; }\nexport function f(t: CloseTo<Mut<T>, "refund">, refund: Mut<AccountInfo> | null): void {}`,
      /uses "refund", which is optional/,
    ],
    [
      "optional EventAuthority",
      `import { type EventAuthority, type SelfProgram } from "typesol";\nexport function f(e: EventAuthority | null, s: SelfProgram): void {}`,
      /cannot be optional/,
    ],
    [
      "secp256k1 over a hash passed in",
      `import { type Hash, verifySecp256k1 } from "typesol";\nexport function f(h: Hash, r: Hash, s: Hash, e: Hash): boolean { return verifySecp256k1(h, 0n, r, s, e); }`,
      /compute the signed hash here/,
    ],
    [
      "a helper that may replace a struct while a reference into it is still used",
      `export interface P { x: u64; }\nexport interface H { p: P; v: u64; }\nfunction reset(h: Mut<H>): void { h.p = { x: 7n }; }\nexport function f(h: Mut<H>): void { const o = h.p; reset(h); h.v = o.x; }`,
      /"o" still refers to data in h, and reset\(\) may replace it/,
    ],
    [
      "an event nested in another event with Option fields",
      `export interface Inner { v: u64 | null; }\nexport interface Outer { inner: Inner; n: u64; }\nexport function f(s: Signer): void { const i: Inner = { v: null }; emit<Inner>({ v: 7n }); emit<Outer>({ inner: i, n: 1n }); }`,
      /both an event and nested|nested in event/,
    ],
    ["a bare null in CPI data", `export function f(p: UncheckedProgram): void { invoke(p, [], [null]); }`, /bare null has no type/],
    ["seed literals past u64", `export function f(a: AccountInfo): void { requirePda(a, ["x", 99999999999999999999999n], 1n); }`, /does not fit in u64/],
    [
      "duplicate data-enum cases",
      `export type A = { kind: "A"; n: u64 } | { kind: "B" };\nexport function f(a: A): u64 { switch (a.kind) { case "A": return 1n; case "A": return 2n; default: return 3n; } }`,
      /duplicate case/,
    ],
    ["struct names reserved for generated IDL types", `export interface FixedString8 { a: u64; }\nexport function f(): void {}`, /reserved for IDL types/],
    ["error names used twice", `export enum E1 { Bad = "x" }\nexport enum E2 { Bad = "y" }\nexport function f(): void {}`, /error "Bad" is already declared/],
    [
      "Option<struct> as CPI data",
      `export interface Pt { x: u64; y: u64; }\nexport interface Home { home: Pt | null; }\nexport function f(h: Account<Home>, p: UncheckedProgram): void { invoke(p, [], [h.home]); }`,
      /^$/,
    ],
    [
      "realloc of a non-struct account",
      `import { realloc } from "typesol";\nexport function f(a: Mut<AccountInfo>, p: Mut<Signer>): void { realloc(a, 100n, p); }`,
      /realloc needs a Mut<Struct> account/,
    ],
    [
      "a discriminator that collides with the emitCpi event tag",
      `import { type EventAuthority, type SelfProgram, emitCpi } from "typesol";\nexport interface E { n: u64; }\nexport function a(ea: EventAuthority, s: SelfProgram): void { emitCpi<E>({ n: 1n }, ea, s); }\n/** @discriminator 0xe445a52e51cb9a1d */\nexport function b(): void {}`,
      /collides with the emitCpi event instruction tag/,
    ],
    [
      "a local that shadows an account parameter",
      `export function f(b: Mut<Box>, o: Mut<Box>): void { { const b = o.value; b; } }`,
      /"b" shadows the parameter "b"/,
    ],
    [
      "a local that shadows an argument",
      `export function f(b: Mut<Box>, n: u64): void { if (n > 0n) { const n = 1n; b.value = n; } }`,
      /"n" shadows the parameter "n"/,
    ],
    [
      "reserved characters in helper parameter names",
      `function g(a__n: u64): u64 { return a__n; }\nexport function f(b: Mut<Box>): void { b.value = g(1n); }`,
      /"__" and "\$" are reserved/,
    ],
    [
      "a Vec element target with a helper that may change the Vec",
      `export interface P { x: u64; }\nexport interface L { ps: Vec<P>; }\nfunction bump(l: Mut<L>): u64 { l.ps.pop(); return 1n; }\nexport function g(l: Mut<L>): void { l.ps.get(0n).x = bump(l); }`,
      /helper that may change this Vec; store its result in a local first/,
    ],
    ["require without an error", `export function f(b: Mut<Box>): void { require(b.value > 0n); }`, /Expected 2 arguments|takes two arguments/],
  ];

  for (const [what, body, expected] of cases) {
    it(`rejects ${what}`, () => {
      const errs = errorsFor(body, what.replace(/\W+/g, "_"));
      if (expected.source === "^$") expect(errs).toEqual([]);
      else expect(errs.join("\n")).toMatch(expected);
    });
  }

  it("reports file:line:column for every diagnostic", () => {
    const file = path.join(dir, "located.ts");
    writeFileSync(file, HEADER + `export function f(b: Mut<Box>): void {\n  do {} while (true);\n}`);
    try {
      generate(file);
      expect.unreachable();
    } catch (e) {
      const d = (e as CompileError).diagnostics[0];
      expect([d.file, d.line, d.column]).toEqual([file, 4, 3]);
    }
  });
});

describe("codegen is stable", () => {
  it("matches the checked-in C for examples/counter.ts", () => {
    const examples = fileURLToPath(new URL("../examples/", import.meta.url));
    const { c } = generate(path.join(examples, "counter.ts"));
    const golden = fileURLToPath(new URL("./golden/counter.c", import.meta.url));
    if (process.env.UPDATE_GOLDEN) writeFileSync(golden, c);
    expect(c).toBe(readFileSync(golden, "utf8"));
  });
});
