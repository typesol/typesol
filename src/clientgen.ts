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
import { ANCHOR_ERRORS } from "./compiler/anchor-errors.js";
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
    throw new ClientIdlError(`invalid IDL: ${what}`);
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
      type((o.array as unknown[])[0], where);
      return;
    }
    for (const k of ["vec", "option", "coption"]) if (o[k] !== undefined) return type(o[k], where);
    if (o.defined !== undefined) {
      const d = o.defined as unknown;
      name(typeof d === "string" ? d : (d as { name?: unknown })?.name, where);
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

export function generateClient(idl: ClientIdl, opts: { address?: string } = {}): ClientGenResult {
  const programAddress = opts.address ?? idl.address;
  validate(idl, programAddress);
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

  // ---- What can be expressed --------------------------------------------------------------------------------
  const typeIssues = new Map<string, string | undefined>();
  /** Why a type cannot be generated, or undefined when it can. */
  function issue(t: IdlType): string | undefined {
    if (typeof t === "string") {
      if (t in INTS || t in FLOATS || ["bool", "pubkey", "publicKey", "string", "bytes"].includes(t)) return undefined;
      return `type "${t}" is not supported`;
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
    else if (d.generics?.length) why = `type ${n} is generic`;
    else if (d.serialization && d.serialization !== "borsh") why = `type ${n} uses ${d.serialization} serialization (zero-copy layouts are not supported)`;
    else if (special(n)?.kind === "foption") why = issue((special(n) as { inner: IdlType }).inner);
    else if (d.type.kind === "struct") why = (d.type.fields ?? []).map((f) => issue(isField(f) ? f.type : f)).find(Boolean);
    else if (d.type.kind === "enum") why = (d.type.variants ?? []).flatMap((v) => (v.fields ?? []).map((f) => issue(isField(f) ? f.type : f))).find(Boolean);
    else if (d.type.kind === "type" && d.type.alias !== undefined) why = issue(d.type.alias);
    else why = `type ${n} (${d.type.kind}) is not supported`;
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
  /** Byte size of a fixed-size IDL type (undefined when it varies). */
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

    const seedExpr = (s: IdlSeed, group: string): string | { why: string } => {
      if (s.kind === "const") return bytes(s.value!);
      if (s.kind === "arg") {
        if (s.path!.includes(".")) return { why: `the seed ${s.path} is a field of an argument` };
        const t = argType.get(s.path!);
        if (t === undefined) return { why: `the seed argument ${s.path} does not exist` };
        const v = `args.${camel(s.path!)}`;
        if (t === "string") return (use("getUtf8Encoder"), `getUtf8Encoder().encode(${v})`);
        if (t === "bytes" || (typeof t === "object" && t.vec !== undefined && isU8(t.vec))) return v; // raw, like `blob.as_ref()`
        if (t === "pubkey" || t === "publicKey") return (use("getAddressEncoder"), `getAddressEncoder().encode(${v})`);
        return `${codec(t)}.encode(${v})`;
      }
      if (s.path!.includes(".")) return { why: `the seed ${s.path} is read from account data` };
      const target = byPath(s.path!, group);
      if (!target) return { why: `the seed account ${s.path} is not an account of the instruction` };
      use("getAddressEncoder");
      return `getAddressEncoder().encode(key($${target.key}))`;
    };
    const resolvable = new Map<string, { seeds: string[]; program?: string; deps: string[] }>();
    for (const a of flat) {
      if (!a.pda || a.address) continue;
      const seeds = a.pda.seeds.map((s) => seedExpr(s, a.group));
      let program: string | { why: string } | undefined;
      const p = a.pda.program;
      if (p?.kind === "const") program = (use("getAddressDecoder"), `programFromBytes(${bytes(p.value!)})`);
      else if (p?.kind === "account") {
        const target = p.path!.includes(".") ? undefined : byPath(p.path!, a.group);
        program = target ? `key($${target.key})` : { why: `the PDA program ${p.path} is not an account of the instruction` };
      } else if (p?.kind === "arg") {
        const t = p.path!.includes(".") ? undefined : argType.get(p.path!);
        program = t === "pubkey" || t === "publicKey" ? `args.${camel(p.path!)}` : { why: "the PDA program comes from an argument that is not a Pubkey" };
      }
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
    // account out (sent as the program id); `undefined` fills it in.
    const input = (a: Flat) => `input${NAME.test(a.key) && !JS_RESERVED.has(a.key) ? `.${a.key}` : `[${JSON.stringify(a.key)}]`}`;
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
            if (s.kind === "arg") return [camel(s.path!), `${camel(s.path!)}: ${tsType(argType.get(s.path!)!, "in")}`];
            const k = byPath(s.path!, a.group)!.key;
            return [k, `${k}: Address | TransactionSigner`];
          }),
        ).values(),
      ];
      const rewrite = (e: string) => e.replace(/\bargs\.([A-Za-z0-9_$]+)/g, "seeds.$1").replace(/key\(\$([A-Za-z0-9_]+)\)/g, "key(seeds.$1)");
      use("type ProgramDerivedAddress");
      pdaFns.set(pn, {
        json,
        source: `    /** The ${a.name} PDA (as ${ix.name} derives it). */\n    ${prop(pn)}(seeds: { ${params.join("; ")} }): Promise<ProgramDerivedAddress> {\n      return getProgramDerivedAddress({ programAddress: ${rewrite(r.program ?? "PROGRAM_ADDRESS")}, seeds: [${r.seeds.map(rewrite).join(", ")}] });\n    },`,
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
    const acc = (f: Flat) => `acc${NAME.test(f.key) && !JS_RESERVED.has(f.key) ? `.${f.key}` : `[${JSON.stringify(f.key)}]`}`;
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
      const own: { field: string; type: IdlType }[] = [];
      // Inputs of a `pdas` helper for a PDA seeded from its own fields: its own field values, accounts and arguments.
      const params = new Map<string, string>();
      let autoDep = false;
      let ok = true;
      let usesArgs = p?.kind === "arg";
      for (const sd of a.pda.seeds) {
        if (sd.kind === "const") seeds.push(bytes(sd.value!));
        else if (sd.kind === "arg") {
          const e = seedExpr(sd, a.group);
          if (typeof e !== "string") ok = false;
          else {
            seeds.push(e);
            usesArgs = true;
            params.set(camel(sd.path!), `${camel(sd.path!)}: ${tsType(argType.get(sd.path!)!, "in")}`);
          }
        } else if (!sd.path!.includes(".")) {
          const t = byPath(sd.path!, a.group);
          if (!t || t === a || t.optional) ok = false;
          else {
            use("getAddressEncoder");
            seeds.push(`getAddressEncoder().encode(key(${acc(t)}!))`);
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
        const rewrite = (e: string) =>
          e
            .replace(/\bargs\.([A-Za-z0-9_$]+)/g, "seeds.$1")
            .replace(/key\(acc\.([A-Za-z0-9_$]+)!\)/g, "key(seeds.$1)")
            .replace(/key\(acc\["([^"]+)"\]!\)/g, 'key(seeds["$1"])');
        use("type ProgramDerivedAddress", "getProgramDerivedAddress");
        pdaFns.set(pn, {
          json,
          source: `    /** The ${a.name} PDA (as ${ix.name} derives it), from the values of its own fields it is seeded with (${own.map((o) => camel(o.field)).join(", ")}). */\n    ${prop(pn)}(seeds: { ${[...params.values()].join("; ")} }): Promise<ProgramDerivedAddress> {\n      return getProgramDerivedAddress({ programAddress: ${rewrite(program)}, seeds: [${seeds.map(rewrite).join(", ")}] });\n    },`,
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
          `        ${acc(a)} = (await getProgramDerivedAddress({ programAddress: ${program}, seeds: [${seeds.join(", ")}] }))[0];`,
          `      }`,
        ],
      });
    }
    if (rels.length || fieldPdas.length || signers.length) {
      const filled = [...signers, ...rels.map((r) => r.a), ...fieldPdas.map((f) => f.a)];
      const keysOf = [...new Set(filled.map((a) => JSON.stringify(a.key)))].join(" | ");
      const withArgs = fieldPdas.some((f) => f.usesArgs);
      const what = [
        ...(signers.length ? [`${signers.map((a) => a.key).join(", ")} (options.signer when left out)`] : []),
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
                `      if (${acc(a)} === undefined) {\n        if (!options.signer) throw new Error(${JSON.stringify(`${ix.name}: pass ${a.key}, or a default signer as options.signer`)});\n        ${acc(a)} = options.signer;\n      }`,
            ),
            ...rels.map((r) => `      ${acc(r.a)} ??= await readRelation(rpc, key(${acc(r.source)}!), ${JSON.stringify(r.a.key)}, [${r.readers.join(", ")}]);`),
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
        `const key = (v: TransactionSigner | Address | undefined | null): Address => {`,
        `  if (v === undefined || v === null) throw new Error("a seed account is missing");`,
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
      name: "readRelation",
      lines: [
        `/** A Pubkey field of an account on chain, read by the first reader that knows its type. */`,
        `const readRelation = async (rpc: Rpc<GetAccountInfoApi>, at: Address, name: string, readers: ((data: ReadonlyUint8Array) => Address | undefined)[]): Promise<Address> => {`,
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
    ` * Events in a transaction's log messages (\`Program data:\` lines, as \`emit\` writes them). Lines are matched by`,
    ` * discriminator, whichever program wrote them; lines that do not decode are skipped. \`emitCpi\` events travel in inner`,
    ` * instructions: see parseCpiEvents and eventsOf.`,
    ` */`,
    `export function parseEvents(logs: readonly string[]): Event[] {`,
    `  const found: Event[] = [];`,
    `  for (const line of logs) {`,
    `    if (!line.startsWith("Program data: ")) continue;`,
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
    `/** \`emitCpi\` events: the data of inner instructions (bytes, or base58 as RPC returns them) that carry one. */`,
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
    `/** Every event of a fetched transaction (getTransaction, json encoding): its logs, then its inner instructions. */`,
    `export function eventsOf(tx: { meta: { logMessages?: readonly string[] | null; innerInstructions?: readonly { instructions: readonly { data: string }[] }[] | null } | null } | null): Event[] {`,
    `  const meta = tx?.meta;`,
    `  if (!meta) return [];`,
    `  return [...parseEvents(meta.logMessages ?? []), ...parseCpiEvents((meta.innerInstructions ?? []).flatMap((g) => g.instructions.map((i) => i.data)))];`,
    `}`,
    `/**`,
    ` * Events of every transaction that mentions the program, as their logs arrive, until \`abortSignal\` aborts. With`,
    ` * \`rpc\`, \`emitCpi\` events too: a transaction in which the program invoked itself is fetched (getTransaction) and its`,
    ` * inner instructions read, after its log events.`,
    ` */`,
    `export async function* watchEvents(`,
    `  rpcSubscriptions: RpcSubscriptions<LogsNotificationsApi>,`,
    `  options: { abortSignal: AbortSignal; commitment?: Commitment; rpc?: Rpc<GetTransactionApi> },`,
    `): AsyncGenerator<{ signature: Signature; event: Event }> {`,
    `  const logs = await rpcSubscriptions.logsNotifications({ mentions: [PROGRAM_ADDRESS] }, options.commitment ? { commitment: options.commitment } : {}).subscribe({ abortSignal: options.abortSignal });`,
    `  const selfInvoke = new RegExp("^Program " + PROGRAM_ADDRESS + " invoke \\\\[([2-9]|\\\\d{2,})\\\\]$");`,
    `  for await (const n of logs) {`,
    `    for (const event of parseEvents(n.value.logs)) yield { signature: n.value.signature, event };`,
    `    if (!options.rpc || !n.value.logs.some((l) => selfInvoke.test(l))) continue;`,
    `    // The transaction can trail its logs by a moment: a few tries.`,
    `    for (let attempt = 0; attempt < 5 && !options.abortSignal.aborted; attempt++) {`,
    `      const tx = await options.rpc`,
    `        .getTransaction(n.value.signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: options.commitment === "finalized" ? "finalized" : "confirmed" })`,
    `        .send();`,
    `      if (tx) {`,
    `        for (const event of parseCpiEvents((tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions.map((i) => i.data)))) yield { signature: n.value.signature, event };`,
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
