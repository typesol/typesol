/**
 * A typed TypeScript client for a program, generated from its Anchor IDL (spec 0.1.0, as written by TypeSOL and by
 * Anchor 0.30+). `typesol build` writes one next to each program (`<name>.client.ts`, see workspace.ts and cli.ts);
 * `typesol client <idl.json>` writes one for any program.
 *
 * The client depends only on `@solana/kit`. For each program it exports:
 *   - instruction builders that fill in fixed addresses and PDAs from the IDL (`await counter.increment({ authority }, { by: 5n })`),
 *   - account decoders and fetchers (`counter.accounts.Counter.fetch(rpc, address)`),
 *   - PDA helpers, error names (`counter.isError(e, "Unauthorized")`), event parsing and return-data decoders,
 *   - every defined type as a TypeScript type and a kit codec.
 *
 * TypeSOL stores Options, FixedStrings and data enums in account data with fixed layouts (`FixedOption_*`,
 * `FixedString*`, `FixedEnum_*` in the IDL). For TypeSOL IDLs those are exposed as `T | null`, `string` and the enum's
 * union; other IDLs keep their types as written.
 *
 * IDLs can come from anywhere (a file, a chain), so every name and number is validated before it reaches the output:
 * names are identifiers, bytes are 0-255, codes are integers, and text only appears inside JSON string literals or
 * sanitized comments.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { ANCHOR_ERRORS } from "../compiler/anchor-errors.js";
import path from "node:path";

type IdlType =
  | string
  | {
      vec?: IdlType;
      option?: IdlType;
      coption?: IdlType;
      array?: [IdlType, unknown];
      defined?: string | { name: string; generics?: unknown[] };
      generic?: string;
    };
interface IdlField {
  name: string;
  docs?: string[];
  type: IdlType;
}
interface IdlTypeDef {
  name: string;
  docs?: string[];
  type: { kind: string; fields?: (IdlField | IdlType)[]; variants?: { name: string; fields?: (IdlField | IdlType)[] }[]; alias?: IdlType };
  generics?: unknown[];
  serialization?: string;
  repr?: unknown;
}
interface IdlSeed {
  kind: "const" | "arg" | "account";
  value?: number[];
  path?: string;
  account?: string;
}
interface IdlAccountItem {
  name: string;
  docs?: string[];
  writable?: boolean;
  signer?: boolean;
  optional?: boolean;
  address?: string;
  pda?: { seeds: IdlSeed[]; program?: IdlSeed };
  relations?: string[];
  accounts?: IdlAccountItem[];
}
interface IdlInstruction {
  name: string;
  docs?: string[];
  discriminator: number[];
  accounts: IdlAccountItem[];
  args: IdlField[];
  returns?: IdlType;
}
export interface ClientIdl {
  address?: string;
  metadata?: { name?: string; description?: string; version?: string; spec?: string };
  instructions: IdlInstruction[];
  accounts?: { name: string; discriminator: number[] }[];
  events?: { name: string; discriminator: number[] }[];
  errors?: { code: number; name: string; msg?: string }[];
  types?: IdlTypeDef[];
}

export interface ClientGenResult {
  source: string;
  /** What the client leaves out or cannot fill in by itself (one line each). */
  notes: string[];
}

/** An IDL the generator refuses: malformed, unsafe to embed, or older than the 0.30 IDL format. */
export class ClientIdlError extends Error {}

/**
 * Errors a TypeSOL program can return, by code: every Anchor framework error (`AnchorError` raises any of them, and
 * the constraints raise their Anchor codes), then TypeSOL's own runtime errors (runtime/typesol_rt.h).
 */
export const TYPESOL_ERRORS: Record<number, string> = {
  ...Object.fromEntries(Object.entries(ANCHOR_ERRORS).map(([name, code]) => [code, name])),
  100: "InstructionMissing",
  101: "InstructionFallbackNotFound",
  102: "InstructionDidNotDeserialize",
  2000: "ConstraintMut",
  2001: "ConstraintHasOne",
  2002: "ConstraintSigner",
  2004: "ConstraintOwner",
  2005: "ConstraintRentExempt",
  2006: "ConstraintSeeds",
  2007: "ConstraintExecutable",
  2009: "ConstraintAssociated",
  2012: "ConstraintAddress",
  2014: "ConstraintTokenMint",
  2015: "ConstraintTokenOwner",
  2016: "ConstraintMintMintAuthority",
  2017: "ConstraintMintFreezeAuthority",
  2018: "ConstraintMintDecimals",
  2021: "ConstraintTokenTokenProgram",
  2022: "ConstraintMintTokenProgram",
  2040: "ConstraintDuplicateMutableAccount",
  3000: "AccountDiscriminatorAlreadySet",
  3002: "AccountDiscriminatorMismatch",
  3003: "AccountDidNotDeserialize",
  3004: "AccountDidNotSerialize",
  3005: "AccountNotEnoughKeys",
  3006: "AccountNotMutable",
  3007: "AccountOwnedByWrongProgram",
  3008: "InvalidProgramId",
  3009: "InvalidProgramExecutable",
  3010: "AccountNotSigner",
  3011: "AccountNotSystemOwned",
  3012: "AccountNotInitialized",
  3016: "AccountReallocExceedsLimit",
  4102: "InvalidNumericConversion",
  5100: "ArithmeticOverflow",
  5101: "DivisionByZero",
  5103: "SysvarUnavailable",
  5104: "IndexOutOfBounds",
  5105: "StringTooLong",
  5106: "ReturnDataMismatch",
  5107: "EventTooLarge",
  5108: "EmptyOption",
  5110: "HeapExhausted",
  5111: "OracleRejected",
  5112: "WrongEnumVariant",
  5113: "TooManyAccounts",
  5114: "NoReturnData",
  5115: "AccountMissing",
};

const INTS: Record<string, number> = { u8: 8, u16: 16, u32: 32, u64: 64, u128: 128, i8: 8, i16: 16, i32: 32, i64: 64, i128: 128 };
const FLOATS: Record<string, number> = { f32: 32, f64: 64 };
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const JS_RESERVED = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends false finally for function if import in " +
    "instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package " +
    "private protected public await arguments eval undefined NaN Infinity"
  ).split(" "),
);
// Top-level names the output uses, so no IDL type or program can take them.
const TAKEN = [
  // helpers
  "concat",
  "hasPrefix",
  "isSigner",
  "key",
  "required",
  "meta",
  "programFromBytes",
  "ownProp",
  "readRelation",
  "memcmp",
  "cpiData",
  "FetchedTransaction",
  "fixedString",
  "fixedOption",
  "unitEnum",
  // exports
  "PROGRAM_ADDRESS",
  "ERRORS",
  "ErrorName",
  "errorCode",
  "isError",
  "Event",
  "parseEvents",
  // kit
  "AccountRole",
  "Address",
  "Codec",
  "FetchAccountConfig",
  "GetAccountInfoApi",
  "Instruction",
  "ProgramDerivedAddress",
  "ReadonlyUint8Array",
  "Rpc",
  "SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM",
  "TransactionSigner",
  "addCodecSizePrefix",
  "address",
  "createCodec",
  "fetchEncodedAccount",
  "fixCodecSize",
  "getAddressCodec",
  "getAddressDecoder",
  "getAddressEncoder",
  "getArrayCodec",
  "getBase64Encoder",
  "getBooleanCodec",
  "getBytesCodec",
  "getDiscriminatedUnionCodec",
  "getF32Codec",
  "getF64Codec",
  "getI128Codec",
  "getI16Codec",
  "getI32Codec",
  "getI64Codec",
  "getI8Codec",
  "getNullableCodec",
  "getProgramDerivedAddress",
  "getStructCodec",
  "getTupleCodec",
  "getU128Codec",
  "getU16Codec",
  "getU32Codec",
  "getU64Codec",
  "getU8Codec",
  "getUnitCodec",
  "getUtf8Codec",
  "getUtf8Decoder",
  "getUtf8Encoder",
  "isSolanaError",
  "transformCodec",
  // globals the output refers to
  "Array",
  "Promise",
  "Error",
  "Uint8Array",
  "Record",
  "Number",
  "String",
  "Math",
  "Object",
  "BigInt",
  "JSON",
  "Symbol",
  "Map",
  "Set",
  "globalThis",
];
const KIT_TYPES = [
  "AccountMeta",
  "AccountNotificationsApi",
  "Address",
  "Base58EncodedBytes",
  "Commitment",
  "FetchAccountsConfig",
  "GetEpochInfoApi",
  "GetLatestBlockhashApi",
  "GetMultipleAccountsApi",
  "GetProgramAccountsApi",
  "GetSignatureStatusesApi",
  "GetTransactionApi",
  "LogsNotificationsApi",
  "RpcSubscriptions",
  "SendTransactionApi",
  "Signature",
  "SignatureNotificationsApi",
  "SimulateTransactionApi",
  "SlotNotificationsApi",
  "Codec",
  "FetchAccountConfig",
  "GetAccountInfoApi",
  "Instruction",
  "ProgramDerivedAddress",
  "ReadonlyUint8Array",
  "Rpc",
  "TransactionSigner",
];
const KIT_VALUES = [
  "AccountRole",
  "appendTransactionMessageInstructions",
  "assertIsTransactionWithBlockhashLifetime",
  "compileTransaction",
  "createTransactionMessage",
  "fetchEncodedAccounts",
  "getBase58Decoder",
  "getBase58Encoder",
  "getBase64EncodedWireTransaction",
  "getSignatureFromTransaction",
  "pipe",
  "sendAndConfirmTransactionFactory",
  "setTransactionMessageFeePayer",
  "setTransactionMessageFeePayerSigner",
  "setTransactionMessageLifetimeUsingBlockhash",
  "signTransactionMessageWithSigners",
  "SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM",
  "addCodecSizePrefix",
  "address",
  "createCodec",
  "fetchEncodedAccount",
  "fixCodecSize",
  "getAddressCodec",
  "getAddressDecoder",
  "getAddressEncoder",
  "getArrayCodec",
  "getBase64Encoder",
  "getBooleanCodec",
  "getBytesCodec",
  "getDiscriminatedUnionCodec",
  "getF32Codec",
  "getF64Codec",
  "getI128Codec",
  "getI16Codec",
  "getI32Codec",
  "getI64Codec",
  "getI8Codec",
  "getNullableCodec",
  "getProgramDerivedAddress",
  "getStructCodec",
  "getTupleCodec",
  "getU128Codec",
  "getU16Codec",
  "getU32Codec",
  "getU64Codec",
  "getU8Codec",
  "getUnitCodec",
  "getUtf8Codec",
  "getUtf8Decoder",
  "getUtf8Encoder",
  "isSolanaError",
  "transformCodec",
];
// Keys of the program object that instructions must not take.
const PROGRAM_KEYS = new Set([
  "address",
  "accounts",
  "pdas",
  "returns",
  "views",
  "resolve",
  "errors",
  "errorCode",
  "isError",
  "parseEvents",
  "parseCpiEvents",
  "eventsOf",
  "watchEvents",
  "sendInstructions",
  "simulate",
]);

// snake_case → camelCase by splitting (linear time, whatever the input): "taker_token_a" → "takerTokenA".
const camel = (s: string) =>
  s
    .split("_")
    .map((p, i) => (i === 0 || p === "" ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join("") || s;
const pascal = (s: string) => {
  const c = camel(s);
  return c.charAt(0).toUpperCase() + c.slice(1);
};
const prop = (s: string) => (NAME.test(s) && !JS_RESERVED.has(s) ? s : JSON.stringify(s));
/** Text safe to print on a terminal (notes, errors): C0 and C1 control characters and bidi overrides escaped. */
const printable = (s: string) =>
  s.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
/** Text that can sit inside a block comment: printable ASCII, no comment terminator. */
const commentText = (s: string) => s.replace(/[^\x20-\x7e]/g, " ").replace(/\*\//g, "* /");
const doc = (lines: unknown, indent = "") =>
  Array.isArray(lines) && lines.length && lines.every((l) => typeof l === "string")
    ? `${indent}/** ${(lines as string[]).map(commentText).join(`\n${indent} * `)} */\n`
    : "";
const bytes = (b: number[]) => `new Uint8Array([${b.join(", ")}])`;
const definedName = (t: IdlType) =>
  typeof t === "object" && t !== null && t.defined ? (typeof t.defined === "string" ? t.defined : t.defined.name) : undefined;
const isField = (f: IdlField | IdlType): f is IdlField => typeof f === "object" && f !== null && "name" in f && "type" in f;
const sortCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Throws ClientIdlError unless every value that reaches the generated source is well-formed. */
function validate(idl: ClientIdl, programAddress: string | undefined) {
  const fail = (what: string): never => {
    throw new ClientIdlError(printable(`invalid IDL: ${what}`));
  };
  const name = (n: unknown, where: string) => (typeof n === "string" && NAME.test(n) ? n : fail(`${where}: name ${JSON.stringify(n)} is not an identifier`));
  const byteList = (b: unknown, where: string) =>
    Array.isArray(b) && b.every((x) => Number.isInteger(x) && x >= 0 && x <= 255) ? b : fail(`${where}: expected a list of bytes (0-255)`);
  const type = (t: unknown, where: string): void => {
    if (typeof t === "string") return;
    if (typeof t !== "object" || t === null) return fail(`${where}: bad type ${JSON.stringify(t)}`);
    const o = t as Record<string, unknown>;
    if (o.array !== undefined) {
      if (!Array.isArray(o.array) || o.array.length !== 2) fail(`${where}: bad array type`);
      const len = (o.array as unknown[])[1];
      // A length: a whole number, or a const generic parameter (`{ generic: "N" }`).
      if (typeof len === "object" && len !== null) name((len as { generic?: unknown }).generic, `${where} array length`);
      else if (!(Number.isSafeInteger(len) && (len as number) >= 0)) fail(`${where}: array length ${JSON.stringify(len)} is not a whole number`);
      type((o.array as unknown[])[0], where);
      return;
    }
    for (const k of ["vec", "option", "coption"]) if (o[k] !== undefined) return type(o[k], where);
    if (o.defined !== undefined) {
      const d = o.defined as unknown;
      if (typeof d === "string") return void name(d, where);
      if (typeof d !== "object" || d === null) return fail(`${where}: bad defined type ${JSON.stringify(d)}`);
      name((d as { name?: unknown }).name, where);
      // Generic arguments: `{ kind: "type", type }` or `{ kind: "const", value: "4" }`.
      const args = (d as { generics?: unknown }).generics;
      if (args === undefined) return;
      if (!Array.isArray(args)) return fail(`${where}: generic arguments must be a list`);
      for (const a of args as unknown[]) {
        const g = (typeof a === "object" && a !== null ? a : {}) as { kind?: unknown; type?: unknown; value?: unknown };
        if (g.kind === "type") type(g.type, `${where} generic argument`);
        else if (g.kind !== "const" || !(typeof g.value === "string" && /^\d{1,15}$/.test(g.value)))
          fail(`${where}: bad generic argument ${JSON.stringify(a)}`);
      }
      return;
    }
    if (o.generic !== undefined) return void name(o.generic, where);
    fail(`${where}: unknown type ${JSON.stringify(t)}`);
  };
  const fields = (fs: unknown, where: string) => {
    if (fs === undefined) return;
    if (!Array.isArray(fs)) fail(`${where}: fields must be a list`);
    for (const f of fs as unknown[])
      if (isField(f as IdlField)) {
        name((f as IdlField).name, where);
        type((f as IdlField).type, `${where}.${(f as IdlField).name}`);
      } else type(f, where);
  };
  if (programAddress !== undefined && !BASE58.test(programAddress)) fail(`program address ${JSON.stringify(programAddress)} is not base58`);
  if (!Array.isArray(idl.instructions)) fail("no instructions list");
  for (const ix of idl.instructions) {
    name(ix.name, "instruction");
    if (ix.discriminator === undefined)
      fail(`instruction ${ix.name} has no discriminator: this looks like a pre-0.30 Anchor IDL (convert it with \`anchor idl convert\`)`);
    byteList(ix.discriminator, `instruction ${ix.name}`);
    const walk = (items: unknown, where: string) => {
      if (!Array.isArray(items)) fail(`${where}: accounts must be a list`);
      for (const a of items as IdlAccountItem[]) {
        name(a.name, where);
        if (a.accounts) {
          walk(a.accounts, `${where}.${a.name}`);
          continue;
        }
        if (a.address !== undefined && !(typeof a.address === "string" && BASE58.test(a.address))) fail(`${where}.${a.name}: address is not base58`);
        if (a.pda) {
          if (!Array.isArray(a.pda.seeds)) fail(`${where}.${a.name}: pda seeds must be a list`);
          for (const s of [...a.pda.seeds, ...(a.pda.program ? [a.pda.program] : [])]) {
            if (!["const", "arg", "account"].includes(s.kind)) fail(`${where}.${a.name}: unknown seed kind ${JSON.stringify(s.kind)}`);
            if (s.kind === "const") byteList(s.value, `${where}.${a.name} seed`);
            else if (!(typeof s.path === "string" && PATH.test(s.path))) fail(`${where}.${a.name}: seed path ${JSON.stringify(s.path)} is not a path`);
          }
        }
      }
    };
    walk(ix.accounts, `instruction ${ix.name}`);
    if (!Array.isArray(ix.args)) fail(`instruction ${ix.name}: args must be a list`);
    for (const a of ix.args) {
      name(a.name, `instruction ${ix.name} argument`);
      type(a.type, `instruction ${ix.name}.${a.name}`);
    }
    if (ix.returns !== undefined) type(ix.returns, `instruction ${ix.name} return`);
  }
  for (const t of idl.types ?? []) {
    name(t.name, "type");
    if (typeof t.type !== "object" || t.type === null) fail(`type ${t.name} has no definition`);
    if (t.generics !== undefined) {
      if (!Array.isArray(t.generics)) fail(`type ${t.name}: generics must be a list`);
      for (const g of t.generics) name((g as { name?: unknown } | null)?.name, `type ${t.name} generic parameter`);
    }
    if (t.repr !== undefined) {
      const align = (t.repr as { align?: unknown } | null)?.align;
      if (typeof t.repr !== "object" || t.repr === null) fail(`type ${t.name}: bad repr`);
      if (align !== undefined && !(Number.isSafeInteger(align) && (align as number) > 0 && Number.isInteger(Math.log2(align as number))))
        fail(`type ${t.name}: repr align ${JSON.stringify(align)} is not a power of two`);
    }
    fields(t.type.fields, `type ${t.name}`);
    for (const v of t.type.variants ?? []) {
      name(v.name, `type ${t.name} variant`);
      fields(v.fields, `type ${t.name}.${v.name}`);
    }
    if (t.type.alias !== undefined) type(t.type.alias, `type ${t.name}`);
  }
  for (const [list, what] of [
    [idl.accounts, "account"],
    [idl.events, "event"],
  ] as const)
    for (const a of list ?? []) {
      name(a.name, what);
      byteList(a.discriminator, `${what} ${a.name}`);
    }
  for (const e of idl.errors ?? []) {
    if (!Number.isInteger(e.code) || e.code < 0 || e.code > 0xffffffff) fail(`error code ${JSON.stringify(e.code)} is not a u32`);
    name(e.name, "error");
    if (e.msg !== undefined && typeof e.msg !== "string") fail(`error ${e.name}: msg must be text`);
  }
}

/** Names declared at the top level of the output: one namespace for types and values, first come first served. */
class Names {
  private readonly taken = new Set<string>(TAKEN);
  /** The first of `base`, `base2`, … for which every `forms(candidate)` name is free; claims them all. */
  claim(base: string, forms: (n: string) => string[] = (n) => [n]): string {
    for (let i = 1; ; i++) {
      const cand = i === 1 ? base : `${base}${i}`;
      const all = forms(cand);
      if (all.some((n) => this.taken.has(n) || JS_RESERVED.has(n))) continue;
      all.forEach((n) => this.taken.add(n));
      return cand;
    }
  }
}

/**
 * Generic types (Anchor `struct Wrap<T, const N: usize>`) as concrete ones: each use with type and const arguments
 * (`Wrap<u64, 4>`) becomes its own type definition (`WrapU64N4`), and the uses point at it. Generic definitions
 * themselves are left as they are (and out of the client); uses whose arguments are still generic are kept.
 */
function monomorphize(idl: ClientIdl): ClientIdl {
  const defs = new Map((idl.types ?? []).map((t) => [t.name, t]));
  if (![...defs.values()].some((d) => d.generics?.length)) return idl;
  const taken = new Set(defs.keys());
  const made = new Map<string, string>(); // instantiation key → new type name
  const extra: IdlTypeDef[] = [];
  type Env = Map<string, IdlType | number>;
  const label = (t: IdlType | number): string => {
    if (typeof t === "number") return `N${t}`;
    if (typeof t === "string") return pascal(t.replace(/[^A-Za-z0-9_]/g, ""));
    if (t.vec !== undefined) return `Vec${label(t.vec)}`;
    if (t.option !== undefined) return `Option${label(t.option)}`;
    if (t.coption !== undefined) return `COption${label(t.coption)}`;
    if (t.array) return `Array${label(t.array[0])}N${String(t.array[1]).replace(/[^0-9]/g, "")}`;
    return pascal((definedName(t) ?? "T").replace(/[^A-Za-z0-9_]/g, ""));
  };
  const hasGeneric = (t: unknown): boolean => JSON.stringify(t ?? null).includes('"generic"');
  // Instantiations can nest without end (`A<T> { next: Option<A<Vec<T>>> }`): cap their number and nesting.
  const MAX_INSTANCES = 256;
  const MAX_DEPTH = 16;
  const inst = (t: IdlType, env: Env, depth = 0): IdlType => {
    if (typeof t === "string") return t;
    if (t.generic !== undefined) {
      const v = env.get(t.generic);
      return v === undefined || typeof v === "number" ? t : v;
    }
    if (t.vec !== undefined) return { vec: inst(t.vec, env, depth) };
    if (t.option !== undefined) return { option: inst(t.option, env, depth) };
    if (t.coption !== undefined) return { coption: inst(t.coption, env, depth) };
    if (t.array) {
      const len = t.array[1] as unknown;
      const g = typeof len === "object" && len !== null ? (len as { generic?: string }).generic : undefined;
      const n = g !== undefined ? env.get(g) : len;
      return { array: [inst(t.array[0], env, depth), typeof n === "number" ? n : len] };
    }
    const name = definedName(t);
    const args = typeof t.defined === "object" ? (t.defined.generics ?? []) : [];
    if (name === undefined || !args.length) return t;
    const values = (args as { kind?: string; type?: IdlType; value?: unknown }[]).map((a) =>
      a?.kind === "const"
        ? Number.isSafeInteger(Number(a.value)) && /^\d+$/.test(String(a.value))
          ? Number(a.value)
          : undefined
        : a?.type === undefined
          ? undefined
          : inst(a.type, env, depth),
    );
    const def = defs.get(name);
    const params = (def?.generics ?? []) as { kind?: string; name?: string }[];
    if (
      !def ||
      values.some((v) => v === undefined || hasGeneric(v)) ||
      params.length !== values.length ||
      params.some((p) => typeof p?.name !== "string" || !NAME.test(p.name))
    )
      return { defined: { name, generics: args } };
    const key = JSON.stringify([name, values]);
    let made1 = made.get(key);
    if (!made1) {
      if (extra.length >= MAX_INSTANCES || depth >= MAX_DEPTH)
        throw new ClientIdlError(
          `generic type ${name} is instantiated ${depth >= MAX_DEPTH ? `more than ${MAX_DEPTH} levels deep` : `more than ${MAX_INSTANCES} times`} (a generic type that uses itself with growing arguments?)`,
        );
      let base = `${name}${values.map((v) => label(v!)).join("")}`;
      if (!NAME.test(base)) base = `${name}Instance`;
      made1 = base;
      for (let i = 2; taken.has(made1); i++) made1 = `${base}${i}`;
      taken.add(made1);
      made.set(key, made1);
      const env2: Env = new Map(params.map((p, i) => [p.name!, values[i]!]));
      const body = def.type;
      const field = (f: IdlField | IdlType) => (isField(f) ? { ...f, type: inst(f.type, env2, depth + 1) } : inst(f, env2, depth + 1));
      extra.push({
        ...def,
        name: made1,
        generics: undefined,
        type: {
          ...body,
          ...(body.fields ? { fields: body.fields.map(field) } : {}),
          ...(body.variants ? { variants: body.variants.map((v) => ({ ...v, ...(v.fields ? { fields: v.fields.map(field) } : {}) })) } : {}),
          ...(body.alias !== undefined ? { alias: inst(body.alias, env2, depth + 1) } : {}),
        },
      });
    }
    return { defined: made1 };
  };
  const none: Env = new Map();
  const field = (f: IdlField | IdlType) => (isField(f) ? { ...f, type: inst(f.type, none) } : inst(f, none));
  const types = (idl.types ?? []).map((d) =>
    d.generics?.length
      ? d
      : {
          ...d,
          type: {
            ...d.type,
            ...(d.type.fields ? { fields: d.type.fields.map(field) } : {}),
            ...(d.type.variants ? { variants: d.type.variants.map((v) => ({ ...v, ...(v.fields ? { fields: v.fields.map(field) } : {}) })) } : {}),
            ...(d.type.alias !== undefined ? { alias: inst(d.type.alias, none) } : {}),
          },
        },
  );
  const instructions = idl.instructions.map((ix) => ({
    ...ix,
    args: ix.args.map((a) => ({ ...a, type: inst(a.type, none) })),
    ...(ix.returns !== undefined ? { returns: inst(ix.returns, none) } : {}),
  }));
  return { ...idl, instructions, types: [...types, ...extra] };
}

export function generateClient(idl: ClientIdl, opts: { address?: string } = {}): ClientGenResult {
  try {
    const res = generate(idl, opts);
    return { ...res, notes: res.notes.map(printable) };
  } catch (e) {
    if (e instanceof ClientIdlError) throw e;
    // A malformed IDL that validation let through is still the IDL's fault: the same error, the original as cause.
    throw new ClientIdlError(printable(`cannot generate a client from this IDL: ${e instanceof Error ? e.message : String(e)}`), { cause: e });
  }
}

function generate(idl: ClientIdl, opts: { address?: string }): ClientGenResult {
  const programAddress = opts.address ?? idl.address;
  validate(idl, programAddress);
  idl = monomorphize(idl);
  if (!programAddress) throw new ClientIdlError("the IDL has no program address; pass one");
  const typesol = idl.metadata?.description === "Built with TypeSOL";
  const defs = new Map((idl.types ?? []).map((t) => [t.name, t]));
  const notes: string[] = [];
  const names = new Names();
  // Imports are worked out from the finished source (see the end); `use` only documents what each part needs.
  const use = (..._n: string[]) => undefined;

  // ---- TypeSOL fixed layouts in account data ------------------------------------------------------------------
  type Special =
    | { kind: "fstring"; cap: number }
    | { kind: "fvec"; elem: IdlType; cap: number }
    | { kind: "foption"; inner: IdlType }
    | { kind: "fenum"; base: string; size: number };
  const special = (n: string): Special | undefined => {
    if (!typesol) return undefined;
    const d = defs.get(n);
    const f = d?.type.kind === "struct" ? (d.type.fields ?? []).filter(isField) : [];
    if (f.length !== 2) return undefined;
    const arrayLen = (t: IdlType) => (typeof t === "object" && t.array ? Number(t.array[1]) : NaN);
    if (/^FixedString\d+$/.test(n) && f[0]!.name === "len" && Number.isInteger(arrayLen(f[1]!.type))) return { kind: "fstring", cap: arrayLen(f[1]!.type) };
    if (/^FixedVec\d+_/.test(n) && f[0]!.name === "len" && f[1]!.name === "items" && Number.isInteger(arrayLen(f[1]!.type)))
      return { kind: "fvec", elem: (f[1]!.type as { array: [IdlType, number] }).array[0], cap: arrayLen(f[1]!.type) };
    if (n.startsWith("FixedOption_") && f[0]!.name === "is_some") return { kind: "foption", inner: f[1]!.type };
    if (n.startsWith("FixedEnum_") && f[0]!.name === "tag" && defs.has(n.slice("FixedEnum_".length)) && Number.isInteger(arrayLen(f[1]!.type)))
      return { kind: "fenum", base: n.slice("FixedEnum_".length), size: 1 + arrayLen(f[1]!.type) };
    return undefined;
  };

  // ---- Zero-copy (bytemuck) layouts: #[repr(C)] in memory, as the program sees it on SBF ------------------------
  const zeroCopy = (d: IdlTypeDef | undefined) => d?.serialization === "bytemuck" || d?.serialization === "bytemuckunsafe";
  const layouts = new Map<string, { size: number; align: number; offsets: number[] } | string>();
  /** Size and alignment of a type inside a zero-copy struct, or why it cannot be in one. */
  function cLayout(t: IdlType): { size: number; align: number } | string {
    if (typeof t === "string") {
      if (t in INTS) return { size: INTS[t]! / 8, align: Math.min(INTS[t]! / 8, 8) }; // SBF aligns u128/i128 to 8, not 16
      if (t in FLOATS) return { size: FLOATS[t]! / 8, align: FLOATS[t]! / 8 };
      if (t === "bool") return { size: 1, align: 1 };
      if (t === "pubkey" || t === "publicKey") return { size: 32, align: 1 };
      return `"${t}" has no fixed size`;
    }
    if (t.array) {
      const e = cLayout(t.array[0]);
      const n = Number(t.array[1]);
      return typeof e === "string" ? e : { size: e.size * n, align: e.align };
    }
    const n = definedName(t);
    const d = defs.get(n ?? "");
    if (!n || !d || !zeroCopy(d)) return `${n ?? "the type"} is not a zero-copy type`;
    const l = structLayout(d);
    return typeof l === "string" ? l : { size: l.size, align: l.align };
  }
  function structLayout(d: IdlTypeDef): { size: number; align: number; offsets: number[] } | string {
    const known = layouts.get(d.name);
    if (known) return known;
    layouts.set(d.name, `type ${d.name} contains itself`);
    const repr = (d.repr ?? {}) as { kind?: string; packed?: boolean; align?: number };
    const fields = d.type.kind === "struct" ? (d.type.fields ?? []) : undefined;
    let out: { size: number; align: number; offsets: number[] } | string;
    if (!fields || !fields.every(isField)) out = `zero-copy type ${d.name} is not a struct with named fields`;
    else if (repr.kind === "rust") out = `zero-copy type ${d.name} has Rust's unspecified layout`;
    else {
      let offset = 0;
      let align = 1;
      const offsets: number[] = [];
      let why: string | undefined;
      for (const f of fields as IdlField[]) {
        const l = cLayout(f.type);
        if (typeof l === "string") {
          why = `${d.name}.${f.name}: ${l}`;
          break;
        }
        const a = repr.packed ? 1 : l.align;
        offset = Math.ceil(offset / a) * a;
        offsets.push(offset);
        offset += l.size;
        align = Math.max(align, a);
      }
      if (Number.isInteger(repr.align) && repr.align! > 0) align = Math.max(align, repr.align!);
      out = why ?? { size: Math.ceil(offset / align) * align, align, offsets };
    }
    layouts.set(d.name, out);
    return out;
  }

  // ---- What can be expressed --------------------------------------------------------------------------------
  const typeIssues = new Map<string, string | undefined>();
  /** Why a type cannot be generated, or undefined when it can. */
  function issue(t: IdlType): string | undefined {
    if (typeof t === "string") {
      if (t in INTS || t in FLOATS || ["bool", "pubkey", "publicKey", "string", "bytes"].includes(t)) return undefined;
      return `type ${JSON.stringify(t)} is not supported`;
    }
    if (t.generic !== undefined) return "generic parameters are not supported";
    if (t.array) return Number.isInteger(Number(t.array[1])) ? issue(t.array[0]) : "array lengths must be numbers (generic lengths are not supported)";
    if (t.vec !== undefined) return issue(t.vec);
    if (t.option !== undefined) return issue(t.option);
    if (t.coption !== undefined) return issue(t.coption);
    const n = definedName(t);
    if (n === undefined) return "unknown type";
    if (typeof t.defined === "object" && t.defined.generics?.length) return `${n} with generic arguments is not supported`;
    return typeIssue(n);
  }
  function typeIssue(n: string): string | undefined {
    if (typeIssues.has(n)) return typeIssues.get(n);
    typeIssues.set(n, undefined); // recursion through Vec/Option is fine
    const d = defs.get(n);
    let why: string | undefined;
    if (!d) why = `type ${n} is not defined in the IDL`;
    else if (d.generics?.length) why = `type ${n} is generic (each use with concrete arguments is generated as its own type)`;
    else if (zeroCopy(d)) {
      const l = structLayout(d);
      if (typeof l === "string") why = l;
    } else if (d.serialization && d.serialization !== "borsh") why = `type ${n} uses ${JSON.stringify(d.serialization)} serialization, which is not supported`;
    else if (special(n)?.kind === "foption") why = issue((special(n) as { inner: IdlType }).inner);
    else if (d.type.kind === "struct") why = (d.type.fields ?? []).map((f) => issue(isField(f) ? f.type : f)).find(Boolean);
    else if (d.type.kind === "enum") why = (d.type.variants ?? []).flatMap((v) => (v.fields ?? []).map((f) => issue(isField(f) ? f.type : f))).find(Boolean);
    else if (d.type.kind === "type" && d.type.alias !== undefined) why = issue(d.type.alias);
    else why = `type ${n} (${JSON.stringify(d.type.kind)}) is not supported`;
    typeIssues.set(n, why);
    return why;
  }

  // ---- Types: decoded (`out`), accepted (`in`), codec ----------------------------------------------------------
  const isUnitEnum = (d: IdlTypeDef) => d.type.kind === "enum" && (d.type.variants ?? []).every((v) => !v.fields?.length);
  const tsNames = new Map<string, string>(); // IDL type name → TS name
  for (const d of idl.types ?? []) {
    if (special(d.name) || typeIssue(d.name)) continue;
    tsNames.set(
      d.name,
      names.claim(pascal(d.name), (n) => [n, `${n}Args`, `get${n}Codec`]),
    );
  }
  const tsName = (n: string) => tsNames.get(n)!;
  const isU8 = (t: IdlType) => t === "u8";
  function tsType(t: IdlType, dir: "in" | "out"): string {
    if (typeof t === "string") {
      if (t in INTS) return INTS[t]! >= 64 ? (dir === "in" ? "number | bigint" : "bigint") : "number";
      if (t in FLOATS) return "number";
      if (t === "bool") return "boolean";
      if (t === "pubkey" || t === "publicKey") return "Address";
      if (t === "string") return "string";
      return "ReadonlyUint8Array"; // bytes
    }
    if (t.array) return isU8(t.array[0]) ? "ReadonlyUint8Array" : `Array<${tsType(t.array[0], dir)}>`;
    if (t.vec !== undefined) return isU8(t.vec) ? "ReadonlyUint8Array" : `Array<${tsType(t.vec, dir)}>`;
    if (t.option !== undefined) return `${tsType(t.option, dir)} | null`;
    if (t.coption !== undefined) return `${tsType(t.coption, dir)} | null`;
    const n = definedName(t)!;
    const s = special(n);
    if (s?.kind === "fstring") return "string";
    if (s?.kind === "fvec") return `Array<${tsType(s.elem, dir)}>`;
    if (s?.kind === "foption") return `${tsType(s.inner, dir)} | null`;
    if (s?.kind === "fenum") return dir === "in" ? `${tsName(s.base)}Args` : tsName(s.base);
    return isUnitEnum(defs.get(n)!) || dir === "out" ? tsName(n) : `${tsName(n)}Args`;
  }
  let needsFixedString = false;
  let needsFixedOption = false;
  let needsFixedVec = false;
  let needsUnitEnum = false;
  let needsCStruct = false;
  function codec(t: IdlType): string {
    if (typeof t === "string") {
      if (t in INTS || t in FLOATS) {
        const fn = `get${t.toUpperCase()}Codec`;
        use(fn);
        return `${fn}()`;
      }
      if (t === "bool") return (use("getBooleanCodec"), "getBooleanCodec()");
      if (t === "pubkey" || t === "publicKey") return (use("getAddressCodec"), "getAddressCodec()");
      if (t === "string") return (use("addCodecSizePrefix", "getUtf8Codec", "getU32Codec"), "addCodecSizePrefix(getUtf8Codec(), getU32Codec())");
      return (use("addCodecSizePrefix", "getBytesCodec", "getU32Codec"), "addCodecSizePrefix(getBytesCodec(), getU32Codec())");
    }
    if (t.array) {
      const n = Number(t.array[1]);
      if (isU8(t.array[0])) return (use("fixCodecSize", "getBytesCodec"), `fixCodecSize(getBytesCodec(), ${n})`);
      return (use("getArrayCodec"), `getArrayCodec(${codec(t.array[0])}, { size: ${n} })`);
    }
    if (t.vec !== undefined) {
      if (isU8(t.vec)) return (use("addCodecSizePrefix", "getBytesCodec", "getU32Codec"), "addCodecSizePrefix(getBytesCodec(), getU32Codec())");
      return (use("getArrayCodec"), `getArrayCodec(${codec(t.vec)})`);
    }
    if (t.option !== undefined) return (use("getNullableCodec"), `getNullableCodec(${codec(t.option)})`);
    if (t.coption !== undefined) {
      const size = idlSize(t.coption);
      if (size === undefined) throw new ClientIdlError("a COption must hold a fixed-size value");
      use("getU32Codec");
      needsFixedOption = true;
      return `fixedOption(${codec(t.coption)}, ${size}, getU32Codec(), 4)`;
    }
    const n = definedName(t)!;
    const s = special(n);
    if (s?.kind === "fstring") return ((needsFixedString = true), `fixedString(${s.cap})`);
    if (s?.kind === "fvec") {
      if (idlSize(s.elem) === undefined) throw new ClientIdlError(`${n}: the elements have no fixed size`);
      return ((needsFixedVec = true), `fixedVec(${codec(s.elem)}, ${idlSize(s.elem)}, ${s.cap})`);
    }
    if (s?.kind === "foption") {
      const size = idlSize(s.inner);
      if (size === undefined) throw new ClientIdlError(`${n}: the value has no fixed size`);
      needsFixedOption = true;
      use("getU8Codec");
      return `fixedOption(${codec(s.inner)}, ${size}, getU8Codec(), 1)`;
    }
    if (s?.kind === "fenum") return (use("fixCodecSize"), `fixCodecSize(get${tsName(s.base)}Codec(), ${s.size})`);
    return `get${tsName(n)}Codec()`;
  }
  /** Byte size of a fixed-size IDL type (undefined when it varies). Memoized by type name, so shared types are sized once. */
  const sizes = new Map<string, number | undefined>();
  function idlSize(t: IdlType): number | undefined {
    if (typeof t === "string") {
      if (t in INTS) return INTS[t]! / 8;
      if (t in FLOATS) return FLOATS[t]! / 8;
      if (t === "bool") return 1;
      if (t === "pubkey" || t === "publicKey") return 32;
      return undefined;
    }
    if (t.array) {
      const e = idlSize(t.array[0]);
      return e === undefined ? undefined : e * Number(t.array[1]);
    }
    const n = definedName(t);
    if (n === undefined) return undefined;
    if (sizes.has(n)) return sizes.get(n);
    sizes.set(n, undefined); // a type that holds itself has no fixed size
    const size = definedSize(n);
    sizes.set(n, size);
    return size;
  }
  function definedSize(n: string): number | undefined {
    const sp = special(n);
    if (sp?.kind === "fstring") return 4 + sp.cap;
    if (sp?.kind === "fvec") {
      const e = idlSize(sp.elem);
      return e === undefined ? undefined : 4 + e * sp.cap;
    }
    if (sp?.kind === "fenum") return sp.size;
    if (sp?.kind === "foption") {
      const v = idlSize(sp.inner);
      return v === undefined ? undefined : 1 + v;
    }
    const d = defs.get(n);
    if (!d) return undefined;
    if (zeroCopy(d)) {
      const l = structLayout(d);
      return typeof l === "string" ? undefined : l.size;
    }
    if (isUnitEnum(d)) return 1;
    if (d.type.kind !== "struct") return undefined;
    let size = 0;
    for (const f of d.type.fields ?? []) {
      const x = idlSize(isField(f) ? f.type : f);
      if (x === undefined) return undefined;
      size += x;
    }
    return size;
  }

  const typeOut: string[] = [];
  use("type Codec");
  for (const d of idl.types ?? []) {
    if (special(d.name)) continue;
    const why = typeIssue(d.name);
    if (why) {
      notes.push(`${why}; it is left out`);
      continue;
    }
    const T = tsName(d.name);
    const cast = `as unknown as Codec<${T}Args, ${T}>`;
    if (d.type.kind === "struct") {
      const fields = d.type.fields ?? [];
      if (fields.length && !fields.every(isField)) {
        const items = fields as IdlType[];
        use("getTupleCodec");
        typeOut.push(
          `${doc(d.docs)}export type ${T} = [${items.map((f) => tsType(f, "out")).join(", ")}];\n` +
            `export type ${T}Args = [${items.map((f) => tsType(f, "in")).join(", ")}];\n` +
            `export function get${T}Codec(): Codec<${T}Args, ${T}> {\n  return getTupleCodec([${items.map(codec).join(", ")}]) ${cast};\n}\n`,
        );
        continue;
      }
      const named = fields as IdlField[];
      if (zeroCopy(d)) {
        // Fields at their #[repr(C)] offsets (padding written as zeros), not one after another as Borsh would.
        const l = structLayout(d) as { size: number; offsets: number[] };
        needsCStruct = true;
        typeOut.push(
          `${doc(d.docs)}export interface ${T} {\n${named.map((f) => `${doc(f.docs, "  ")}  ${prop(camel(f.name))}: ${tsType(f.type, "out")};`).join("\n")}\n}\n` +
            `export interface ${T}Args {\n${named.map((f) => `  ${prop(camel(f.name))}: ${tsType(f.type, "in")};`).join("\n")}\n}\n` +
            `/** Zero-copy (#[repr(C)]) layout: ${l.size} bytes. */\n` +
            `export function get${T}Codec(): Codec<${T}Args, ${T}> {\n  return cStruct([${named.map((f, i) => `[${JSON.stringify(camel(f.name))}, ${codec(f.type)}, ${l.offsets[i]}]`).join(", ")}], ${l.size}) ${cast};\n}\n`,
        );
        continue;
      }
      use("getStructCodec");
      typeOut.push(
        `${doc(d.docs)}export interface ${T} {\n${named.map((f) => `${doc(f.docs, "  ")}  ${prop(camel(f.name))}: ${tsType(f.type, "out")};`).join("\n")}\n}\n` +
          `export interface ${T}Args {\n${named.map((f) => `  ${prop(camel(f.name))}: ${tsType(f.type, "in")};`).join("\n")}\n}\n` +
          `export function get${T}Codec(): Codec<${T}Args, ${T}> {\n  return getStructCodec([${named.map((f) => `[${JSON.stringify(camel(f.name))}, ${codec(f.type)}]`).join(", ")}]) ${cast};\n}\n`,
      );
    } else if (isUnitEnum(d)) {
      // A const object rather than a TypeScript `enum`, so the file also runs under Node's type stripping.
      const vs = d.type.variants ?? [];
      needsUnitEnum = true;
      typeOut.push(
        `${doc(d.docs)}export const ${T} = { ${vs.map((v, i) => `${prop(v.name)}: ${i}`).join(", ")} } as const;\n` +
          `export type ${T} = (typeof ${T})[keyof typeof ${T}];\n` +
          `export type ${T}Args = ${T};\n` +
          `export function get${T}Codec(): Codec<${T}Args, ${T}> {\n  return unitEnum<${T}>(${vs.length});\n}\n`,
      );
    } else if (d.type.kind === "enum") {
      // Data enum: a discriminated union on `kind` (TypeSOL's own field name) or `__kind` (other IDLs, as Codama does).
      const k = typesol ? "kind" : "__kind";
      const variant = (v: { name: string; fields?: (IdlField | IdlType)[] }, dir: "in" | "out") => {
        const fs = v.fields ?? [];
        if (!fs.length) return `{ ${k}: ${JSON.stringify(v.name)} }`;
        if (fs.every(isField))
          return `{ ${k}: ${JSON.stringify(v.name)}; ${(fs as IdlField[]).map((f) => `${prop(camel(f.name))}: ${tsType(f.type, dir)}`).join("; ")} }`;
        return `{ ${k}: ${JSON.stringify(v.name)}; fields: [${(fs as IdlType[]).map((f) => tsType(f, dir)).join(", ")}] }`;
      };
      const vcodec = (v: { name: string; fields?: (IdlField | IdlType)[] }) => {
        const fs = v.fields ?? [];
        if (!fs.length) return (use("getUnitCodec"), "getUnitCodec()");
        use("getStructCodec");
        if (fs.every(isField)) return `getStructCodec([${(fs as IdlField[]).map((f) => `[${JSON.stringify(camel(f.name))}, ${codec(f.type)}]`).join(", ")}])`;
        use("getTupleCodec");
        return `getStructCodec([["fields", getTupleCodec([${(fs as IdlType[]).map(codec).join(", ")}])]])`;
      };
      use("getDiscriminatedUnionCodec");
      const vs = d.type.variants ?? [];
      typeOut.push(
        `${doc(d.docs)}export type ${T} =\n${vs.map((v) => `  | ${variant(v, "out")}`).join("\n")};\n` +
          `export type ${T}Args =\n${vs.map((v) => `  | ${variant(v, "in")}`).join("\n")};\n` +
          `export function get${T}Codec(): Codec<${T}Args, ${T}> {\n  return getDiscriminatedUnionCodec([${vs.map((v) => `[${JSON.stringify(v.name)}, ${vcodec(v)}]`).join(", ")}], { discriminator: ${JSON.stringify(k)} }) ${cast};\n}\n`,
      );
    } else {
      typeOut.push(
        `${doc(d.docs)}export type ${T} = ${tsType(d.type.alias!, "out")};\nexport type ${T}Args = ${tsType(d.type.alias!, "in")};\n` +
          `export function get${T}Codec(): Codec<${T}Args, ${T}> {\n  return ${codec(d.type.alias!)} ${cast};\n}\n`,
      );
    }
  }

  // ---- Accounts ---------------------------------------------------------------------------------------------
  const accountOut: string[] = [];
  const accountKeys: string[] = [];
  /** Each account's decoder object and its Pubkey fields (snake_case), for has_one relations. */
  const accountConsts: { name: string; A: string; pubkeys: Set<string> }[] = [];
  for (const a of idl.accounts ?? []) {
    if (!defs.has(a.name) || typeIssue(a.name) || special(a.name)) {
      notes.push(`account ${a.name}: ${typeIssue(a.name) ?? "no type definition"}; it is left out`);
      continue;
    }
    const T = tsName(a.name);
    const A = names.claim(`${T}Account`, (n) => [n, `${n}_DISCRIMINATOR`]);
    use("fetchEncodedAccount", "type FetchAccountConfig", "type GetAccountInfoApi", "type Rpc", "type Address", "type ReadonlyUint8Array");
    accountOut.push(
      `const ${A}_DISCRIMINATOR = ${bytes(a.discriminator)};\n` +
        `/** ${a.name} account data: the ${a.discriminator.length}-byte discriminator, then the fields. */\n` +
        `const ${A} = {\n` +
        `  discriminator: ${A}_DISCRIMINATOR,\n` +
        `  decode(data: ReadonlyUint8Array): ${T} {\n` +
        `    if (!hasPrefix(data, ${A}_DISCRIMINATOR)) throw new Error(${JSON.stringify(`not a ${a.name} account (discriminator mismatch)`)});\n` +
        `    return get${T}Codec().decode(data, ${a.discriminator.length});\n` +
        `  },\n` +
        `  encode(value: ${T}Args): ReadonlyUint8Array {\n` +
        `    return concat([${A}_DISCRIMINATOR, get${T}Codec().encode(value)]);\n` +
        `  },\n` +
        `  async fetch(rpc: Rpc<GetAccountInfoApi>, at: Address, config?: FetchAccountConfig): Promise<${T}> {\n` +
        `    const found = await fetchEncodedAccount(rpc, at, config);\n` +
        `    if (!found.exists) throw new Error(${JSON.stringify(`${a.name} account does not exist: `)} + at);\n` +
        `    return ${A}.decode(found.data);\n` +
        `  },\n` +
        `  async fetchMaybe(rpc: Rpc<GetAccountInfoApi>, at: Address, config?: FetchAccountConfig): Promise<${T} | null> {\n` +
        `    const found = await fetchEncodedAccount(rpc, at, config);\n` +
        `    return found.exists ? ${A}.decode(found.data) : null;\n` +
        `  },\n` +
        `  /** Several accounts in one request, in order; null where one does not exist. */\n` +
        `  async fetchMultiple(rpc: Rpc<GetMultipleAccountsApi>, at: readonly Address[], config?: FetchAccountsConfig): Promise<(${T} | null)[]> {\n` +
        `    const found = await fetchEncodedAccounts(rpc, [...at], config);\n` +
        `    return found.map((a) => (a.exists ? ${A}.decode(a.data) : null));\n` +
        `  },\n` +
        `  /** Every ${commentText(a.name)} account of the program (getProgramAccounts by discriminator), optionally where \`bytes\` are at \`offset\` of the data. */\n` +
        `  async fetchAll(rpc: Rpc<GetProgramAccountsApi>, filters: readonly { offset: number; bytes: ReadonlyUint8Array }[] = []): Promise<{ address: Address; data: ${T} }[]> {\n` +
        `    const found = await rpc.getProgramAccounts(PROGRAM_ADDRESS, { encoding: "base64", filters: memcmp([{ offset: 0, bytes: ${A}_DISCRIMINATOR }, ...filters]) }).send();\n` +
        `    return found.map((a) => ({ address: a.pubkey, data: ${A}.decode(getBase64Encoder().encode(a.account.data[0])) }));\n` +
        `  },\n` +
        `  /** Each change of the account, decoded (null once it is closed), until \`abortSignal\` aborts. */\n` +
        `  async *watch(rpcSubscriptions: RpcSubscriptions<AccountNotificationsApi>, at: Address, options: { abortSignal: AbortSignal; commitment?: Commitment }): AsyncGenerator<${T} | null> {\n` +
        `    const updates = await rpcSubscriptions.accountNotifications(at, { encoding: "base64", ...(options.commitment ? { commitment: options.commitment } : {}) }).subscribe({ abortSignal: options.abortSignal });\n` +
        `    for await (const u of updates) {\n` +
        `      const data = getBase64Encoder().encode(u.value.data[0]);\n` +
        `      yield data.length === 0 ? null : ${A}.decode(data);\n` +
        `    }\n` +
        `  },\n` +
        `};\n`,
    );
    accountKeys.push(`${prop(a.name)}: ${A}`);
    const fields = ((defs.get(a.name)!.type.fields ?? []) as IdlField[]).filter((f) => typeof f === "object" && f !== null && "name" in f);
    accountConsts.push({ name: a.name, A, pubkeys: new Set(fields.filter((f) => f.type === "pubkey" || f.type === "publicKey").map((f) => f.name)) });
  }

  // ---- Events -----------------------------------------------------------------------------------------------
  const events = (idl.events ?? []).filter((e) => {
    const why = !defs.has(e.name) ? "no type definition" : typeIssue(e.name);
    if (why) notes.push(`event ${e.name}: ${why}; it is left out`);
    return !why;
  });
  if (events.length) use("getBase64Encoder");

  // ---- Errors -----------------------------------------------------------------------------------------------
  const errors = new Map<number, { name: string; msg?: string }>();
  if (typesol) for (const [code, n] of Object.entries(TYPESOL_ERRORS)) errors.set(Number(code), { name: n });
  for (const e of idl.errors ?? []) errors.set(e.code, { name: e.name, ...(e.msg ? { msg: e.msg } : {}) });
  use("isSolanaError", "SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM");

  // ---- Instructions -----------------------------------------------------------------------------------------
  const ixOut: string[] = [];
  const ixKeys: string[] = [];
  const pdaFns = new Map<string, { json: string; source: string }>();
  const returnKeys: string[] = [];
  const viewKeys: string[] = [];
  const resolveKeys: string[] = [];
  const usedKeys = new Set<string>();
  for (const ix of idl.instructions) {
    const argIssue = ix.args.map((a) => issue(a.type)).find(Boolean);
    if (argIssue) {
      notes.push(`instruction ${ix.name}: ${argIssue}; it is left out`);
      continue;
    }
    let fn = camel(ix.name);
    if (PROGRAM_KEYS.has(fn) || usedKeys.has(fn)) fn = `${fn}Ix`;
    for (let i = 2; usedKeys.has(fn); i++) fn = `${camel(ix.name)}Ix${i}`;
    usedKeys.add(fn);
    const P = names.claim(pascal(ix.name), (n) => [`${n}Accounts`, `${n}Args`, `build${n}`]);

    // Composite account groups are flattened with their group as prefix; locals are `$<name>`.
    interface Flat extends IdlAccountItem {
      key: string; // property of the accounts input, unique
      group: string; // "" or "group_" (snake prefix in the IDL)
    }
    const flat: Flat[] = [];
    const keys = new Set<string>();
    const walk = (items: IdlAccountItem[], group: string) => {
      for (const it of items) {
        if (it.accounts) {
          walk(it.accounts, `${group}${it.name}_`);
          continue;
        }
        let k = camel(`${group}${it.name}`);
        for (let i = 2; keys.has(k); i++) k = `${camel(`${group}${it.name}`)}${i}`;
        keys.add(k);
        flat.push({ ...it, key: k, group });
      }
    };
    walk(ix.accounts, "");
    // A seed or program path names an account: in the same group first, then at the top level.
    const byPath = (p: string, group: string) => flat.find((f) => `${f.group}${f.name}` === `${group}${p}`) ?? flat.find((f) => f.group === "" && f.name === p);
    const argType = new Map(ix.args.map((a) => [a.name, a.type]));

    /**
     * Where a seed's inputs come from in the code being written: the instruction builder (`args.x`, the local `$x`),
     * a `pdas` helper (`seeds.x` for both) or `resolve` (`args.x`, the account in `acc`).
     */
    type Refs = { arg: (camelName: string) => string; account: (key: string) => string };
    const seedsProp = (k: string) => `seeds${NAME.test(k) && !JS_RESERVED.has(k) ? `.${k}` : `[${JSON.stringify(k)}]`}`;
    const BUILDER: Refs = { arg: (n) => `args.${n}`, account: (k) => `$${k}` };
    const HELPER: Refs = { arg: (n) => seedsProp(n), account: (k) => seedsProp(k) };
    const seedExpr = (s: IdlSeed, group: string, refs: Refs = BUILDER): string | { why: string } => {
      if (s.kind === "const") return bytes(s.value!);
      if (s.kind === "arg") {
        // `params.id`: a field (of a field…) of a struct argument.
        const [head, ...rest] = s.path!.split(".");
        let t = argType.get(head!);
        if (t === undefined) return { why: `the seed argument ${head} does not exist` };
        let v = refs.arg(camel(head!));
        for (const part of rest) {
          const d = defs.get(definedName(t) ?? "");
          const f = d?.type.kind === "struct" ? ((d.type.fields ?? []) as IdlField[]).find((x) => isField(x) && x.name === part) : undefined;
          if (!f || !NAME.test(part)) return { why: `the seed ${s.path} is not a field of a struct argument` };
          t = f.type;
          v += `[${JSON.stringify(camel(part))}]`;
        }
        if (t === "string") return (use("getUtf8Encoder"), `getUtf8Encoder().encode(${v})`);
        if (t === "bytes" || (typeof t === "object" && t.vec !== undefined && isU8(t.vec))) return v; // raw, like `blob.as_ref()`
        if (t === "pubkey" || t === "publicKey") return (use("getAddressEncoder"), `getAddressEncoder().encode(${v})`);
        return `${codec(t)}.encode(${v})`;
      }
      if (s.path!.includes(".")) return { why: `the seed ${s.path} is read from account data` };
      const target = byPath(s.path!, group);
      if (!target) return { why: `the seed account ${s.path} is not an account of the instruction` };
      use("getAddressEncoder");
      return `getAddressEncoder().encode(key(${refs.account(target.key)}))`;
    };
    /** A PDA's program as the code being written names it (undefined: this program). */
    const pdaProgram = (a: Flat, refs: Refs): string | { why: string } | undefined => {
      const p = a.pda!.program;
      if (p?.kind === "const") return (use("getAddressDecoder"), `programFromBytes(${bytes(p.value!)})`);
      if (p?.kind === "account") {
        const target = p.path!.includes(".") ? undefined : byPath(p.path!, a.group);
        return target ? `key(${refs.account(target.key)})` : { why: `the PDA program ${p.path} is not an account of the instruction` };
      }
      if (p?.kind === "arg") {
        const t = p.path!.includes(".") ? undefined : argType.get(p.path!);
        return t === "pubkey" || t === "publicKey" ? refs.arg(camel(p.path!)) : { why: "the PDA program comes from an argument that is not a Pubkey" };
      }
      return undefined;
    };
    const resolvable = new Map<string, { seeds: string[]; program?: string; deps: string[] }>();
    for (const a of flat) {
      if (!a.pda || a.address) continue;
      const seeds = a.pda.seeds.map((s) => seedExpr(s, a.group));
      const program = pdaProgram(a, BUILDER);
      const p = a.pda.program;
      const why = [...seeds, ...(program === undefined ? [] : [program])].find((x) => typeof x === "object");
      if (why) {
        notes.push(`instruction ${ix.name}: ${a.name} is not filled in (${(why as { why: string }).why}); pass it`);
        continue;
      }
      const deps = [...a.pda.seeds, ...(p ? [p] : [])].filter((s) => s.kind === "account").map((s) => byPath(s.path!, a.group)!.key);
      resolvable.set(a.key, { seeds: seeds as string[], program: program as string | undefined, deps });
    }
    // Order PDAs after the accounts their seeds name; a PDA in a cycle stays a required input.
    const order: Flat[] = [];
    const known = new Set(flat.filter((a) => !resolvable.has(a.key)).map((a) => a.key));
    const pending = flat.filter((a) => resolvable.has(a.key));
    for (let progress = true; progress && pending.length;) {
      progress = false;
      for (let i = 0; i < pending.length; i++)
        if (resolvable.get(pending[i]!.key)!.deps.every((d) => known.has(d))) {
          const a = pending.splice(i--, 1)[0]!;
          order.push(a);
          known.add(a.key);
          progress = true;
        }
    }
    for (const a of pending) {
      notes.push(`instruction ${ix.name}: the seeds of ${a.name} depend on each other; pass it`);
      resolvable.delete(a.key);
    }
    const auto = (a: Flat) => Boolean(a.address) || resolvable.has(a.key);

    use("type Address", "type TransactionSigner", "type Instruction", "type AccountMeta", "AccountRole");
    const accType = (a: Flat) => `${a.signer ? "TransactionSigner | Address" : "Address"}${a.optional ? " | null" : ""}`;
    const accountsIface =
      `export interface ${P}Accounts {\n` +
      flat.map((a) => `${doc(a.docs, "  ")}  ${prop(a.key)}${auto(a) || a.optional ? "?" : ""}: ${accType(a)};`).join("\n") +
      `\n}\n`;
    const argsField = ix.args.map((a) => ({ ...a, key: camel(a.name) }));
    const argsIface = argsField.length
      ? `export interface ${P}Args {\n${argsField.map((a) => `${doc(a.docs, "  ")}  ${prop(a.key)}: ${tsType(a.type, "in")};`).join("\n")}\n}\n`
      : "";

    // Locals: given accounts and fixed addresses first, then PDAs in dependency order. `null` leaves an optional
    // account out (sent as the program id); `undefined` fills it in. Accounts are read as own properties, so one named
    // `constructor` or `toString` is not taken from Object.prototype.
    const input = (a: Flat) => `ownProp(input, ${JSON.stringify(a.key)})`;
    const fill = (a: Flat, value: string) => (a.optional ? `${input(a)} === null ? null : (${input(a)} ?? ${value})` : `${input(a)} ?? ${value}`);
    const lines: string[] = [];
    for (const a of flat) {
      if (a.address) {
        use("address");
        lines.push(`  const $${a.key} = ${fill(a, `address(${JSON.stringify(a.address)})`)};`);
      } else if (!resolvable.has(a.key)) lines.push(`  const $${a.key} = ${input(a)}${a.optional ? " ?? null" : ""};`);
    }
    for (const a of order) {
      const r = resolvable.get(a.key)!;
      use("getProgramDerivedAddress");
      lines.push(
        `  const $${a.key} = ${fill(a, `(await getProgramDerivedAddress({ programAddress: ${r.program ?? "PROGRAM_ADDRESS"}, seeds: [${r.seeds.join(", ")}] }))[0]`)};`,
      );
      // A helper per PDA, shared between instructions that derive it the same way.
      const json = JSON.stringify(a.pda);
      let pn = camel(a.name);
      if (pdaFns.has(pn) && pdaFns.get(pn)!.json !== json) {
        pn = `${fn}${pascal(a.name)}`;
        for (let i = 2; pdaFns.has(pn) && pdaFns.get(pn)!.json !== json; i++) pn = `${fn}${pascal(a.name)}${i}`;
      }
      if (pdaFns.has(pn)) continue;
      const inputs = [...a.pda!.seeds, ...(a.pda!.program ? [a.pda!.program] : [])].filter((s) => s.kind !== "const");
      const params = [
        ...new Map(
          inputs.map((s) => {
            if (s.kind === "arg") {
              const head = s.path!.split(".")[0]!;
              return [camel(head), `${camel(head)}: ${tsType(argType.get(head)!, "in")}`];
            }
            const k = byPath(s.path!, a.group)!.key;
            return [k, `${k}: Address | TransactionSigner`];
          }),
        ).values(),
      ];
      // The same derivation, its inputs named as the helper's `seeds` parameter.
      const helperSeeds = a.pda!.seeds.map((s) => seedExpr(s, a.group, HELPER) as string);
      const helperProgram = (pdaProgram(a, HELPER) as string | undefined) ?? "PROGRAM_ADDRESS";
      use("type ProgramDerivedAddress");
      pdaFns.set(pn, {
        json,
        source: `    /** The ${a.name} PDA (as ${ix.name} derives it). */\n    ${prop(pn)}(seeds: { ${params.join("; ")} }): Promise<ProgramDerivedAddress> {\n      return getProgramDerivedAddress({ programAddress: ${helperProgram}, seeds: [${helperSeeds.join(", ")}] });\n    },`,
      });
    }

    const metas = flat.map((a) => {
      const role = a.signer
        ? a.writable
          ? "AccountRole.WRITABLE_SIGNER"
          : "AccountRole.READONLY_SIGNER"
        : a.writable
          ? "AccountRole.WRITABLE"
          : "AccountRole.READONLY";
      if (a.optional) return `      $${a.key} === null ? { address: PROGRAM_ADDRESS, role: AccountRole.READONLY } : meta($${a.key}, ${role}),`;
      return auto(a) ? `      meta($${a.key}, ${role}),` : `      meta(required($${a.key}, ${JSON.stringify(a.key)}), ${role}),`;
    });
    if (argsField.length) use("getStructCodec");
    const data = argsField.length
      ? `concat([${bytes(ix.discriminator)}, getStructCodec([${argsField.map((a) => `[${JSON.stringify(a.key)}, ${codec(a.type)}]`).join(", ")}]).encode(args)])`
      : bytes(ix.discriminator);
    ixOut.push(
      accountsIface +
        argsIface +
        `${doc(ix.docs)}async function build${P}(input: ${P}Accounts${argsField.length ? `, args: ${P}Args` : ""}, remaining: readonly AccountMeta[] = []): Promise<Instruction> {\n` +
        lines.join("\n") +
        `\n  return {\n    programAddress: PROGRAM_ADDRESS,\n    accounts: [\n${metas.join("\n")}\n      ...remaining,\n    ],\n    data: ${data},\n  } as Instruction;\n}\n`,
    );
    ixKeys.push(`${prop(fn)}: build${P}`);
    // `resolve.<instruction>`: what needs the chain or the caller's wallet, filled in on a copy of the accounts in this
    // order: signers (a default signer), has_one accounts, then PDAs seeded from other accounts' fields.
    const acc = (f: Flat) => `ownProp(acc, ${JSON.stringify(f.key)})`;
    const setAcc = (f: Flat) => `acc${NAME.test(f.key) && !JS_RESERVED.has(f.key) ? `.${f.key}` : `[${JSON.stringify(f.key)}]`}`;
    // A field's value as seed bytes: scalars by their codec, strings as UTF-8, byte fields as they are.
    const seedOfField = (t: IdlType, v: string): string | undefined => {
      if (typeof t === "string") {
        if (t in INTS || t === "bool" || t === "pubkey" || t === "publicKey") return `${codec(t)}.encode(${v})`;
        if (t === "string") return (use("getUtf8Encoder"), `getUtf8Encoder().encode(${v})`);
        if (t === "bytes") return `Uint8Array.from(${v})`;
        return undefined;
      }
      if ((t.vec !== undefined && isU8(t.vec)) || (t.array && isU8(t.array[0]))) return `Uint8Array.from(${v})`;
      const name = definedName(t);
      if (name === undefined) return undefined;
      if (special(name)?.kind === "fstring") return (use("getUtf8Encoder"), `getUtf8Encoder().encode(${v})`);
      const d = defs.get(name);
      return d?.type.kind === "enum" && (d.type.variants ?? []).every((x) => !x.fields?.length) ? `${codec(t)}.encode(${v})` : undefined;
    };
    // The builder's "pass it" note for an account, pointing at what fills it in instead.
    const renote = (a: Flat, how: string) => {
      const i = notes.findIndex((n) => n.startsWith(`instruction ${ix.name}: ${a.name} is not filled in (`));
      if (i >= 0) notes[i] = `${notes[i]!.replace(/; pass it$/, "")}; ${how}`;
    };
    const fieldOf = (accountType: string | undefined, field: string): IdlField | undefined =>
      ((defs.get(accountType ?? "")?.type.fields ?? []) as IdlField[]).find((f) => typeof f === "object" && f !== null && f.name === field);
    const signers = flat.filter((a) => a.signer && !auto(a) && !a.optional);
    const rels: { a: Flat; source: Flat; readers: string[] }[] = [];
    for (const a of flat) {
      if (auto(a) || a.optional || a.signer || !a.relations?.length) continue;
      for (const r of a.relations) {
        const source = byPath(r, a.group);
        if (!source || source.optional) continue;
        const readers = accountConsts
          .filter((c) => c.pubkeys.has(a.name))
          .map((c) => `(d) => (hasPrefix(d, ${c.A}.discriminator) ? ${c.A}.decode(d)[${JSON.stringify(camel(a.name))}] : undefined)`);
        if (!readers.length) continue;
        rels.push({ a, source, readers });
        break;
      }
    }
    const fieldPdas: { a: Flat; lines: string[]; usesArgs: boolean }[] = [];
    for (const a of flat) {
      if (!a.pda || a.address || resolvable.has(a.key) || a.optional) continue;
      const p = a.pda.program;
      if (p && p.kind === "account") continue;
      let program = "PROGRAM_ADDRESS";
      if (p?.kind === "const") program = `programFromBytes(${bytes(p.value!)})`;
      else if (p?.kind === "arg") {
        const t = argType.get(p.path ?? "");
        if (t !== "pubkey" && t !== "publicKey") continue;
        program = `args.${camel(p.path!)}`;
      }
      const bases = new Map<string, { base: Flat; A: string }>();
      const seeds: string[] = [];
      const helperSeeds: string[] = []; // the same seeds, named as a `pdas` helper's `seeds` (for one seeded from its own fields)
      const own: { field: string; type: IdlType }[] = [];
      // Inputs of a `pdas` helper for a PDA seeded from its own fields: its own field values, accounts and arguments.
      const params = new Map<string, string>();
      let autoDep = false;
      let ok = true;
      let usesArgs = p?.kind === "arg";
      for (const sd of a.pda.seeds) {
        if (sd.kind === "const") (seeds.push(bytes(sd.value!)), helperSeeds.push(bytes(sd.value!)));
        else if (sd.kind === "arg") {
          const e = seedExpr(sd, a.group);
          if (typeof e !== "string") ok = false;
          else {
            seeds.push(e);
            helperSeeds.push(seedExpr(sd, a.group, HELPER) as string);
            usesArgs = true;
            const head = sd.path!.split(".")[0]!;
            params.set(camel(head), `${camel(head)}: ${tsType(argType.get(head)!, "in")}`);
          }
        } else if (!sd.path!.includes(".")) {
          const t = byPath(sd.path!, a.group);
          if (!t || t === a || t.optional) ok = false;
          else {
            use("getAddressEncoder");
            seeds.push(`getAddressEncoder().encode(key(${acc(t)}!))`);
            helperSeeds.push(`getAddressEncoder().encode(key(${seedsProp(t.key)}))`);
            params.set(t.key, `${t.key}: Address | TransactionSigner`);
            if (auto(t)) autoDep = true;
          }
        } else {
          const parts = sd.path!.split(".");
          const base = parts.length === 2 ? byPath(parts[0]!, a.group) : undefined;
          const field = fieldOf(sd.account, parts[1]!);
          const consts = accountConsts.find((c) => c.name === sd.account);
          const enc =
            field && seedOfField(field.type, base === a ? `seeds.${camel(parts[1]!)}` : `${"$$" + (base?.key ?? "")}[${JSON.stringify(camel(parts[1]!))}]`);
          if (!base || !field || !enc || base.optional) ok = false;
          else if (base === a) {
            own.push({ field: parts[1]!, type: field.type });
            params.set(camel(parts[1]!), `${camel(parts[1]!)}: ${tsType(field.type, "in")}`);
            seeds.push(enc);
            helperSeeds.push(enc);
          } else if (!consts || auto(base)) ok = false;
          else {
            bases.set(base.key, { base, A: consts.A });
            seeds.push(enc);
          }
        }
        if (!ok) break;
      }
      if (!ok) continue;
      if (own.length) {
        // Seeded from its own fields: the address is needed to read them, so the caller gives the values instead.
        if (bases.size) continue;
        const json = JSON.stringify(a.pda);
        let pn = camel(a.name);
        if (pdaFns.has(pn) && pdaFns.get(pn)!.json !== json) {
          pn = `${fn}${pascal(a.name)}`;
          for (let i = 2; pdaFns.has(pn) && pdaFns.get(pn)!.json !== json; i++) pn = `${fn}${pascal(a.name)}${i}`;
        }
        renote(a, `pass it (pdas.${pn} derives it from the field values)`);
        if (pdaFns.has(pn)) continue;
        if (p?.kind === "arg") params.set(camel(p.path!), `${camel(p.path!)}: Address`);
        const helperProgram = p?.kind === "arg" ? seedsProp(camel(p.path!)) : program;
        use("type ProgramDerivedAddress", "getProgramDerivedAddress");
        pdaFns.set(pn, {
          json,
          source: `    /** The ${a.name} PDA (as ${ix.name} derives it), from the values of its own fields it is seeded with (${own.map((o) => camel(o.field)).join(", ")}). */\n    ${prop(pn)}(seeds: { ${[...params.values()].join("; ")} }): Promise<ProgramDerivedAddress> {\n      return getProgramDerivedAddress({ programAddress: ${helperProgram}, seeds: [${helperSeeds.join(", ")}] });\n    },`,
        });
        continue;
      }
      if (bases.size === 0 || autoDep) continue;
      renote(a, `resolve.${fn} fills it in`);
      fieldPdas.push({
        a,
        usesArgs,
        lines: [
          `      if (${acc(a)} === undefined) {`,
          ...[...bases.values()].map(({ base, A }) => `        const ${"$$" + base.key} = await ${A}.fetch(rpc, key(${acc(base)}!));`),
          `        ${setAcc(a)} = (await getProgramDerivedAddress({ programAddress: ${program}, seeds: [${seeds.join(", ")}] }))[0];`,
          `      }`,
        ],
      });
    }
    // A has_one source the builder derives (a `config` PDA) is derived here too, after the accounts its seeds name,
    // so its fields can be read.
    const needed = new Set<string>();
    const need = (k: string) => {
      if (!resolvable.has(k) || needed.has(k)) return;
      needed.add(k);
      for (const d of resolvable.get(k)!.deps) need(d);
    };
    for (const r of rels) need(r.source.key);
    const derived = order.filter((a) => needed.has(a.key));
    const ref = (f: Flat) => (f.address ? `(${acc(f)} ?? address(${JSON.stringify(f.address)}))` : acc(f));
    const sub = (e: string) => e.replace(/key\(\$([A-Za-z0-9_]+)\)/g, (_, k: string) => `key(${ref(flat.find((f) => f.key === k)!)}, ${JSON.stringify(k)})`);
    const deriveLines = derived.map((a) => {
      const r = resolvable.get(a.key)!;
      return `      if (${acc(a)} === undefined) ${setAcc(a)} = (await getProgramDerivedAddress({ programAddress: ${sub(r.program ?? "PROGRAM_ADDRESS")}, seeds: [${r.seeds.map(sub).join(", ")}] }))[0];`;
    });
    if (rels.length || fieldPdas.length || signers.length) {
      const filled = [...signers, ...rels.map((r) => r.a), ...fieldPdas.map((f) => f.a)];
      const keysOf = [...new Set(filled.map((a) => JSON.stringify(a.key)))].join(" | ");
      const withArgs =
        fieldPdas.some((f) => f.usesArgs) ||
        derived.some((a) => /\bargs\./.test([...resolvable.get(a.key)!.seeds, resolvable.get(a.key)!.program ?? ""].join(" ")));
      const what = [
        ...(signers.length ? [`${signers.map((a) => a.key).join(", ")} (options.signer when left out)`] : []),
        ...derived.map((a) => `${a.key} (derived, to read it)`),
        ...rels.map((r) => `${r.a.key} (from ${r.source.key}.${camel(r.a.name)})`),
        ...fieldPdas.map((f) => `${f.a.key} (a PDA seeded from account fields)`),
      ].join(", ");
      resolveKeys.push(
        `    /** ${P}Accounts with ${what} filled in. */\n` +
          `    async ${prop(fn)}(rpc: Rpc<GetAccountInfoApi>, input: Omit<${P}Accounts, ${keysOf}> & Partial<Pick<${P}Accounts, ${keysOf}>>${withArgs ? `, args: ${P}Args` : ""}, options: { signer?: TransactionSigner } = {}): Promise<${P}Accounts> {\n` +
          `      const acc: Partial<${P}Accounts> = { ...input };\n` +
          [
            ...signers.map(
              (a) =>
                `      if (${acc(a)} === undefined) {\n        if (!options.signer) throw new Error(${JSON.stringify(`${ix.name}: pass ${a.key}, or a default signer as options.signer`)});\n        ${setAcc(a)} = options.signer;\n      }`,
            ),
            ...deriveLines,
            ...rels.map(
              (r) =>
                `      if (${acc(r.a)} === undefined) ${setAcc(r.a)} = await readRelation(rpc, ${ref(r.source)}, ${JSON.stringify(r.source.key)}, ${JSON.stringify(r.a.key)}, [${r.readers.join(", ")}]);`,
            ),
            ...fieldPdas.flatMap((f) => f.lines),
          ].join("\n") +
          `\n      void rpc;\n      return acc as ${P}Accounts;\n    },`,
      );
    }
    if (ix.returns !== undefined) {
      const why = issue(ix.returns);
      if (why) notes.push(`instruction ${ix.name}: the return value is not decoded (${why})`);
      else {
        returnKeys.push(`    ${prop(fn)}: (data: ReadonlyUint8Array): ${tsType(ix.returns, "out")} => ${codec(ix.returns)}.decode(data),`);
        // Read-only call: simulate the instruction and decode what it returns (Anchor's `.view()`).
        viewKeys.push(
          `    /** ${ix.name}'s return value, by simulation (nothing is sent). */\n` +
            `    async ${prop(fn)}(rpc: Rpc<SimulateTransactionApi & GetLatestBlockhashApi>, feePayer: Address | TransactionSigner, input: ${P}Accounts${argsField.length ? `, args: ${P}Args` : ""}): Promise<${tsType(ix.returns, "out")}> {\n` +
            `      const res = await simulate(rpc, feePayer, [await build${P}(input${argsField.length ? ", args" : ""})]);\n` +
            `      if (res.err !== null) throw new Error(${JSON.stringify(`${ix.name} failed in simulation: `)} + JSON.stringify(res.err, (_, v) => (typeof v === "bigint" ? v.toString() : v)) + "\\n" + res.logs.join("\\n"));\n` +
            `      if (res.returnData === null) throw new Error(${JSON.stringify(`${ix.name} returned nothing`)});\n` +
            `      return ${codec(ix.returns)}.decode(res.returnData);\n` +
            `    },`,
        );
      }
    }
  }

  // ---- Assemble ---------------------------------------------------------------------------------------------
  const displayName = commentText(idl.metadata?.name ?? "program");
  const base = camel(idl.metadata?.name && NAME.test(idl.metadata.name) ? idl.metadata.name : "program");
  const programName = names.claim(JS_RESERVED.has(base) ? `${base}Program` : base);
  use("address");
  // Helpers, each with the names it calls; only those the program reaches are emitted (strict noUnusedLocals).
  const helperDefs: { name: string; lines: string[] }[] = [
    {
      name: "concat",
      lines: [
        `const concat = (parts: ReadonlyUint8Array[]): Uint8Array => {`,
        `  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));`,
        `  let at = 0;`,
        `  for (const p of parts) out.set(p, (at += p.length) - p.length);`,
        `  return out;`,
        `};`,
      ],
    },
    {
      name: "hasPrefix",
      lines: [
        `const hasPrefix = (data: ReadonlyUint8Array, prefix: ReadonlyUint8Array) => data.length >= prefix.length && prefix.every((b, i) => data[i] === b);`,
      ],
    },
    {
      name: "isSigner",
      lines: [`const isSigner = (v: TransactionSigner | Address): v is TransactionSigner => typeof v === "object" && v !== null && "address" in v;`],
    },
    {
      name: "key",
      lines: [
        `const key = (v: TransactionSigner | Address | undefined | null, name?: string): Address => {`,
        `  if (v === undefined || v === null) throw new Error(name === undefined ? "a seed account is missing" : "a seed account is missing: pass " + name);`,
        `  return isSigner(v) ? v.address : v;`,
        `};`,
      ],
    },
    {
      name: "required",
      lines: [
        `const required = <T>(v: T | undefined, name: string): T => {`,
        `  if (v === undefined) throw new Error("account " + name + " is required");`,
        `  return v;`,
        `};`,
      ],
    },
    {
      name: "meta",
      lines: [
        `const meta = (v: TransactionSigner | Address, role: AccountRole) => (isSigner(v) ? { address: v.address, role, signer: v } : { address: v, role });`,
      ],
    },
    { name: "programFromBytes", lines: [`const programFromBytes = (b: Uint8Array): Address => getAddressDecoder().decode(b);`] },
    {
      name: "ownProp",
      lines: [
        `/** An account given in \`o\` (an own property: never one inherited from Object.prototype, such as \`constructor\`). */`,
        `const ownProp = <T extends object, K extends keyof T>(o: T, k: K): T[K] | undefined => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);`,
      ],
    },
    {
      name: "readRelation",
      lines: [
        `/** A Pubkey field (\`name\`) of an account on chain (\`from\`), read by the first reader that knows its type. */`,
        `const readRelation = async (`,
        `  rpc: Rpc<GetAccountInfoApi>,`,
        `  from: TransactionSigner | Address | undefined,`,
        `  fromName: string,`,
        `  name: string,`,
        `  readers: ((data: ReadonlyUint8Array) => Address | undefined)[],`,
        `): Promise<Address> => {`,
        `  if (from === undefined) throw new Error("cannot fill in " + name + ": pass " + fromName + ", the account it is read from");`,
        `  const at = key(from);`,
        `  const found = await fetchEncodedAccount(rpc, at);`,
        `  if (!found.exists) throw new Error("cannot fill in " + name + ": account " + at + " does not exist");`,
        `  for (const read of readers) {`,
        `    const v = read(found.data);`,
        `    if (v !== undefined) return v;`,
        `  }`,
        `  throw new Error("cannot fill in " + name + ": " + at + " is not an account that names it");`,
        `};`,
      ],
    },
    {
      name: "memcmp",
      lines: [
        `const memcmp = (filters: readonly { offset: number; bytes: ReadonlyUint8Array }[]) =>`,
        `  filters.map((f) => ({ memcmp: { offset: BigInt(f.offset), bytes: getBase58Decoder().decode(f.bytes) as Base58EncodedBytes, encoding: "base58" as const } }));`,
      ],
    },
  ];
  if (needsFixedString)
    helperDefs.push({
      name: "fixedString",
      lines: [
        `/** TypeSOL FixedString<N> in account data: u32 length, then N bytes (UTF-8, zero-padded). */`,
        `const fixedString = (cap: number): Codec<string, string> =>`,
        `  transformCodec(`,
        `    getStructCodec([["len", getU32Codec()], ["bytes", fixCodecSize(getBytesCodec(), cap)]]),`,
        `    (s: string) => {`,
        `      const b = getUtf8Encoder().encode(s);`,
        `      if (b.length > cap) throw new Error("string is " + b.length + " bytes; the field holds " + cap);`,
        `      const padded = new Uint8Array(cap);`,
        `      padded.set(b);`,
        `      return { len: b.length, bytes: padded };`,
        `    },`,
        `    (v) => getUtf8Decoder().decode(v.bytes.slice(0, Math.min(v.len, cap))),`,
        `  );`,
      ],
    });
  if (needsFixedOption)
    helperDefs.push({
      name: "fixedOption",
      lines: [
        `/** An Option of fixed size: a tag, then the value (all zero when empty). TypeSOL account data uses a u8 tag, COption a u32. */`,
        `const fixedOption = <From, To extends From>(inner: Codec<From, To>, size: number, tag: Codec<number, number>, tagSize: number): Codec<From | null, To | null> =>`,
        `  createCodec<From | null, To | null>({`,
        `    fixedSize: tagSize + size,`,
        `    write: (value, bytes, offset) => {`,
        `      bytes.fill(0, offset, offset + tagSize + size);`,
        `      tag.write(value === null ? 0 : 1, bytes, offset);`,
        `      if (value !== null) inner.write(value, bytes, offset + tagSize);`,
        `      return offset + tagSize + size;`,
        `    },`,
        `    read: (bytes, offset) => [tag.read(bytes, offset)[0] ? inner.read(bytes, offset + tagSize)[0] : null, offset + tagSize + size],`,
        `  });`,
      ],
    });
  if (needsFixedVec)
    helperDefs.push({
      name: "fixedVec",
      lines: [
        `/** TypeSOL FixedVec<T, N> in account data: u32 length, then room for N elements (unused ones zero). */`,
        `const fixedVec = <From, To extends From>(item: Codec<From, To>, size: number, cap: number): Codec<From[], To[]> =>`,
        `  createCodec<From[], To[]>({`,
        `    fixedSize: 4 + size * cap,`,
        `    write: (value, bytes, offset) => {`,
        `      if (value.length > cap) throw new Error(value.length + " elements; the field holds " + cap);`,
        `      bytes.fill(0, offset, offset + 4 + size * cap);`,
        `      getU32Codec().write(value.length, bytes, offset);`,
        `      value.forEach((v, i) => item.write(v, bytes, offset + 4 + i * size));`,
        `      return offset + 4 + size * cap;`,
        `    },`,
        `    read: (bytes, offset) => {`,
        `      const n = Math.min(getU32Codec().read(bytes, offset)[0], cap);`,
        `      return [Array.from({ length: n }, (_, i) => item.read(bytes, offset + 4 + i * size)[0]), offset + 4 + size * cap];`,
        `    },`,
        `  });`,
      ],
    });
  if (needsCStruct)
    helperDefs.push({
      name: "cStruct",
      lines: [
        `/** A zero-copy struct: each field at its #[repr(C)] offset in a block of \`size\` bytes (padding is zero). */`,
        `const cStruct = (fields: [string, Codec<any, any>, number][], size: number): Codec<Record<string, unknown>, Record<string, unknown>> =>`,
        `  createCodec<Record<string, unknown>, Record<string, unknown>>({`,
        `    fixedSize: size,`,
        `    write: (value, bytes, offset) => {`,
        `      bytes.fill(0, offset, offset + size);`,
        `      for (const [k, c, at] of fields) c.write(value[k], bytes, offset + at);`,
        `      return offset + size;`,
        `    },`,
        `    read: (bytes, offset) => [Object.fromEntries(fields.map(([k, c, at]) => [k, c.read(bytes, offset + at)[0]])), offset + size],`,
        `  });`,
      ],
    });
  if (needsUnitEnum)
    helperDefs.push({
      name: "unitEnum",
      lines: [
        `/** A unit enum: its variant index as a u8, checked against the number of variants. */`,
        `const unitEnum = <T extends number>(count: number): Codec<T, T> =>`,
        `  transformCodec(getU8Codec(), (v: T) => v, (n) => {`,
        `    if (n >= count) throw new Error("enum variant " + n + " is out of range");`,
        `    return n as T;`,
        `  }) as unknown as Codec<T, T>;`,
      ],
    });
  const HELPERS_AT = "\u0000helpers\u0000";
  const body = [
    "",
    `export const PROGRAM_ADDRESS = address(${JSON.stringify(programAddress)});`,
    "",
    `// ---- Helpers ----`,
    HELPERS_AT,
    "",
    `// ---- Types ----`,
    ...typeOut,
    `// ---- Accounts ----`,
    ...accountOut,
    `// ---- Instructions ----`,
    ...ixOut,
    `// ---- Errors ----`,
    `export const ERRORS: Record<number, { name: string; msg?: string }> = {`,
    ...[...errors].sort(([a], [b]) => a - b).map(([c, e]) => `  ${c}: { name: ${JSON.stringify(e.name)}${e.msg ? `, msg: ${JSON.stringify(e.msg)}` : ""} },`),
    `};`,
    `export type ErrorName = ${[...new Set([...errors.values()].map((e) => JSON.stringify(e.name)))].join(" | ") || "never"};`,
    `/**`,
    ` * The custom program error code in a failed transaction or simulation (a kit SolanaError, LiteSVM's result, a number`,
    ` * or a message), or null. The code does not say which program raised it: a program this one calls can raise the same`,
    ` * code, so check the failing instruction when that matters.`,
    ` */`,
    `export function errorCode(e: unknown): number | null {`,
    `  for (let cur: unknown = e, depth = 0; cur !== undefined && cur !== null && depth < 8; depth++) {`,
    `    if (typeof cur === "number") return cur;`,
    `    if (isSolanaError(cur, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) return Number(cur.context.code);`,
    `    // The JSON an RPC node returns (simulations, signature statuses): { InstructionError: [0, { Custom: 6000 }] }.`,
    `    if (typeof cur === "object" && "InstructionError" in cur && Array.isArray(cur.InstructionError)) {`,
    `      const inner: unknown = cur.InstructionError[1];`,
    `      if (typeof inner === "object" && inner !== null && "Custom" in inner) return Number(inner.Custom);`,
    `    }`,
    `    if (typeof cur === "object" && "err" in cur && typeof cur.err === "function") cur = String(cur.err());`,
    `    if (typeof cur === "string" || cur instanceof Error) {`,
    `      const m = /custom program error: (0x[0-9a-f]+)|Custom(?:\\(|\\s*\\{\\s*code:\\s*)(\\d+)/i.exec(String(cur instanceof Error ? cur.message : cur));`,
    `      if (m) return m[1] !== undefined ? Number.parseInt(m[1], 16) : Number(m[2]);`,
    `    }`,
    `    cur = typeof cur === "object" && cur !== null && "cause" in cur ? cur.cause : undefined;`,
    `  }`,
    `  return null;`,
    `}`,
    `/** Whether \`e\` is the error \`name\` (by code; see errorCode). */`,
    `export function isError(e: unknown, name: ErrorName): boolean {`,
    `  const code = errorCode(e);`,
    `  return code !== null && ERRORS[code]?.name === name;`,
    `}`,
    "",
    `// ---- Events ----`,
    `export type Event = ${events.length ? events.map((e) => `{ name: ${JSON.stringify(e.name)}; data: ${tsName(e.name)} }`).join(" | ") : "never"};`,
    `/** One event's bytes (discriminator, then the fields), or null when they are not one of this program's events. */`,
    `function decodeEvent(data: ReadonlyUint8Array): Event | null {`,
    events.length
      ? [
          `  try {`,
          ...events.map(
            (e) =>
              `    if (hasPrefix(data, ${bytes(e.discriminator)})) return { name: ${JSON.stringify(e.name)}, data: get${tsName(e.name)}Codec().decode(data, ${e.discriminator.length}) };`,
          ),
          `  } catch {`,
          `    // not one of this program's events`,
          `  }`,
          `  return null;`,
        ].join("\n")
      : `  void data;\n  return null;`,
    `}`,
    `/**`,
    ` * Events in a transaction's log messages (\`Program data:\` lines, as \`emit\` writes them). Only this program's lines`,
    ` * count: the \`Program <id> invoke\` and \`success\` / \`failed\` lines are followed, and a data line is read only while`,
    ` * this program is the innermost one running (as Anchor's EventParser does). Lines that do not decode are skipped.`,
    ` * \`emitCpi\` events travel in inner instructions: see eventsOf.`,
    ` */`,
    `export function parseEvents(logs: readonly string[]): Event[] {`,
    `  const found: Event[] = [];`,
    `  const running: string[] = [];`,
    `  for (const line of logs) {`,
    `    const invoke = /^Program (\\S+) invoke \\[\\d+\\]$/.exec(line);`,
    `    if (invoke) {`,
    `      running.push(invoke[1]!);`,
    `      continue;`,
    `    }`,
    `    if (/^Program \\S+ (success$|failed)/.test(line)) {`,
    `      running.pop();`,
    `      continue;`,
    `    }`,
    `    if (running.at(-1) !== PROGRAM_ADDRESS || !line.startsWith("Program data: ")) continue;`,
    `    let data: ReadonlyUint8Array;`,
    `    try {`,
    `      data = getBase64Encoder().encode(line.slice("Program data: ".length));`,
    `    } catch {`,
    `      continue;`,
    `    }`,
    `    const e = decodeEvent(data);`,
    `    if (e) found.push(e);`,
    `  }`,
    `  return found;`,
    `}`,
    `/**`,
    ` * \`emitCpi\` events in instruction data (bytes, or base58 as RPC returns them). This does not check which program the`,
    ` * instructions called, so give it only this program's inner instructions; eventsOf picks them from a transaction.`,
    ` */`,
    `export function parseCpiEvents(instructionData: Iterable<ReadonlyUint8Array | string>): Event[] {`,
    `  const tag = new Uint8Array([228, 69, 165, 46, 81, 203, 154, 29]);`,
    `  const found: Event[] = [];`,
    `  for (const item of instructionData) {`,
    `    let data: ReadonlyUint8Array;`,
    `    try {`,
    `      data = typeof item === "string" ? getBase58Encoder().encode(item) : item;`,
    `    } catch {`,
    `      continue;`,
    `    }`,
    `    if (!hasPrefix(data, tag)) continue;`,
    `    const e = decodeEvent(data.slice(tag.length));`,
    `    if (e) found.push(e);`,
    `  }`,
    `  return found;`,
    `}`,
    `/** A transaction as getTransaction returns it (json encoding), as far as events need it. */`,
    `export interface FetchedTransaction {`,
    `  transaction?: { message: { accountKeys: readonly (string | { pubkey: string })[] } } | null;`,
    `  meta: {`,
    `    logMessages?: readonly string[] | null;`,
    `    innerInstructions?: readonly { instructions: readonly { programIdIndex?: number; data: string }[] }[] | null;`,
    `    loadedAddresses?: { writable: readonly string[]; readonly: readonly string[] } | null;`,
    `  } | null;`,
    `}`,
    `/** The data of the inner instructions of \`tx\` that call this program (found by their program's account index). */`,
    `function cpiData(tx: FetchedTransaction): string[] {`,
    `  const keys = [`,
    `    ...(tx.transaction?.message.accountKeys ?? []).map((k) => (typeof k === "string" ? k : k.pubkey)),`,
    `    ...(tx.meta?.loadedAddresses?.writable ?? []),`,
    `    ...(tx.meta?.loadedAddresses?.readonly ?? []),`,
    `  ];`,
    `  return (tx.meta?.innerInstructions ?? []).flatMap((g) =>`,
    `    g.instructions.filter((i) => i.programIdIndex !== undefined && keys[i.programIdIndex] === PROGRAM_ADDRESS).map((i) => i.data),`,
    `  );`,
    `}`,
    `/**`,
    ` * Every event of a fetched transaction (getTransaction, json encoding): its log events, then the \`emitCpi\` events of`,
    ` * its inner instructions that call this program (read only when \`tx.transaction\` gives the account keys).`,
    ` */`,
    `export function eventsOf(tx: FetchedTransaction | null): Event[] {`,
    `  if (!tx?.meta) return [];`,
    `  return [...parseEvents(tx.meta.logMessages ?? []), ...parseCpiEvents(cpiData(tx))];`,
    `}`,
    `/**`,
    ` * Events of every transaction that mentions the program and succeeded, as their logs arrive, until \`abortSignal\``,
    ` * aborts (a failed transaction's events did not happen). With \`rpc\`, \`emitCpi\` events too: a transaction in which`,
    ` * the program invoked itself is fetched (getTransaction) and its inner instructions read, after its log events.`,
    ` */`,
    `export async function* watchEvents(`,
    `  rpcSubscriptions: RpcSubscriptions<LogsNotificationsApi>,`,
    `  options: { abortSignal: AbortSignal; commitment?: Commitment; rpc?: Rpc<GetTransactionApi> },`,
    `): AsyncGenerator<{ signature: Signature; event: Event }> {`,
    `  const logs = await rpcSubscriptions.logsNotifications({ mentions: [PROGRAM_ADDRESS] }, options.commitment ? { commitment: options.commitment } : {}).subscribe({ abortSignal: options.abortSignal });`,
    `  const selfInvoke = new RegExp("^Program " + PROGRAM_ADDRESS + " invoke \\\\[([2-9]|\\\\d{2,})\\\\]$");`,
    `  for await (const n of logs) {`,
    `    if (n.value.err !== null) continue;`,
    `    for (const event of parseEvents(n.value.logs)) yield { signature: n.value.signature, event };`,
    `    if (!options.rpc || !n.value.logs.some((l) => selfInvoke.test(l))) continue;`,
    `    // The transaction can trail its logs by a moment: a few tries.`,
    `    for (let attempt = 0; attempt < 5 && !options.abortSignal.aborted; attempt++) {`,
    `      const tx = await options.rpc`,
    `        .getTransaction(n.value.signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: options.commitment === "finalized" ? "finalized" : "confirmed" })`,
    `        .send();`,
    `      if (tx) {`,
    `        for (const event of parseCpiEvents(cpiData(tx))) yield { signature: n.value.signature, event };`,
    `        break;`,
    `      }`,
    `      await new Promise((resolve) => setTimeout(resolve, 400));`,
    `    }`,
    `  }`,
    `}`,
    "",
    `// ---- Transactions ----`,
    `/** Send instructions in one transaction paid by \`feePayer\` (signers in the accounts sign too) and wait for confirmation. */`,
    `export async function sendInstructions(`,
    `  connection: { rpc: Rpc<GetEpochInfoApi & GetLatestBlockhashApi & GetSignatureStatusesApi & SendTransactionApi>; rpcSubscriptions: RpcSubscriptions<SignatureNotificationsApi & SlotNotificationsApi> },`,
    `  feePayer: TransactionSigner,`,
    `  instructions: readonly Instruction[],`,
    `  options: { commitment?: Commitment; abortSignal?: AbortSignal } = {},`,
    `): Promise<Signature> {`,
    `  const { value: latestBlockhash } = await connection.rpc.getLatestBlockhash().send();`,
    `  const message = pipe(`,
    `    createTransactionMessage({ version: 0 }),`,
    `    (m) => setTransactionMessageFeePayerSigner(feePayer, m),`,
    `    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),`,
    `    (m) => appendTransactionMessageInstructions(instructions, m),`,
    `  );`,
    `  const signed = await signTransactionMessageWithSigners(message);`,
    `  assertIsTransactionWithBlockhashLifetime(signed);`,
    `  await sendAndConfirmTransactionFactory(connection)(signed, { commitment: options.commitment ?? "confirmed", ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}) });`,
    `  return getSignatureFromTransaction(signed);`,
    `}`,
    `/** Simulate instructions (nothing is sent, signatures are not checked): the error if any, logs, units and the program's return data. */`,
    `export async function simulate(`,
    `  rpc: Rpc<SimulateTransactionApi & GetLatestBlockhashApi>,`,
    `  feePayer: Address | TransactionSigner,`,
    `  instructions: readonly Instruction[],`,
    `): Promise<{ err: unknown; logs: readonly string[]; unitsConsumed: bigint | null; returnData: ReadonlyUint8Array | null }> {`,
    `  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();`,
    `  const message = pipe(`,
    `    createTransactionMessage({ version: 0 }),`,
    `    (m) => setTransactionMessageFeePayer(key(feePayer), m),`,
    `    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),`,
    `    (m) => appendTransactionMessageInstructions(instructions, m),`,
    `  );`,
    `  const wire = getBase64EncodedWireTransaction(compileTransaction(message));`,
    `  const { value } = await rpc.simulateTransaction(wire, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true }).send();`,
    `  const ret = value.returnData;`,
    `  return {`,
    `    err: value.err,`,
    `    logs: value.logs ?? [],`,
    `    unitsConsumed: value.unitsConsumed ?? null,`,
    `    returnData: ret && ret.programId === PROGRAM_ADDRESS ? getBase64Encoder().encode(ret.data[0]) : null,`,
    `  };`,
    `}`,
    "",
    `/** The ${displayName} program: instructions, accounts, PDAs, errors, events, return values and transactions. */`,
    `export const ${programName} = {`,
    `  address: PROGRAM_ADDRESS,`,
    ...ixKeys.map((k) => `  ${k},`),
    `  accounts: { ${accountKeys.join(", ")} },`,
    `  pdas: {`,
    ...[...pdaFns.values()].map((p) => p.source),
    `  },`,
    `  returns: {`,
    ...returnKeys,
    `  },`,
    `  views: {`,
    ...viewKeys,
    `  },`,
    `  resolve: {`,
    ...resolveKeys,
    `  },`,
    `  errors: ERRORS,`,
    `  errorCode,`,
    `  isError,`,
    `  parseEvents,`,
    `  parseCpiEvents,`,
    `  eventsOf,`,
    `  watchEvents,`,
    `  sendInstructions,`,
    `  simulate,`,
    `};`,
    "",
  ];

  // Keep only the helpers the program calls (comments do not count), so the file passes strict noUnusedLocals.
  let source = body.join("\n");
  // The source without comments (scanned linearly; comments carry IDL docs, which must not keep a helper alive).
  const code = (s: string) => {
    let out = "";
    for (let i = 0; ;) {
      const start = s.indexOf("/**", i);
      if (start < 0) {
        out += s.slice(i);
        break;
      }
      out += s.slice(i, start);
      const end = s.indexOf("*/", start + 3);
      if (end < 0) break;
      i = end + 2;
    }
    return out
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//"))
      .join("\n");
  };
  const calls = (text: string, name: string) => text.includes(`${name}(`) || text.includes(`${name}<`);
  const kept = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    const reach =
      code(source) +
      helperDefs
        .filter((h) => kept.has(h.name))
        .flatMap((h) => h.lines)
        .join("\n");
    for (const h of helperDefs)
      if (!kept.has(h.name) && calls(reach, h.name)) {
        kept.add(h.name);
        changed = true;
      }
  }
  source = source.replace(
    HELPERS_AT,
    helperDefs
      .filter((h) => kept.has(h.name))
      .flatMap((h) => h.lines)
      .join("\n"),
  );
  const used = code(source);
  const imports = [...KIT_VALUES.map((k) => [k, k]), ...KIT_TYPES.map((k) => [k, `type ${k}`])]
    .filter(([k]) => new RegExp(`(?<![\\w$.])${k}\\b`).test(used))
    .sort(([a], [b]) => sortCodeUnits(a!, b!))
    .map(([, line]) => line!);
  const header = [
    `// Client for the ${displayName} program, generated by TypeSOL from its IDL. Do not edit: \`typesol build\` (or \`typesol client\`) rewrites it.`,
    `import {\n${imports.map((k) => `  ${k},`).join("\n")}\n} from "@solana/kit";`,
  ];
  return { source: [...header, source].join("\n"), notes };
}

/** Write a program's client next to its build output (`<dir>/<name>.client.ts`); returns the path and notes. */
export function writeClient(idl: unknown, file: string): { path: string; notes: string[] } {
  const res = generateClient(idl as ClientIdl);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, res.source);
  return { path: file, notes: res.notes };
}
