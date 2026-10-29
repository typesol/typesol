import ts from "typescript";
import {
  INT_INFO,
  type AccountParam,
  type FieldType,
  type ProgramModel,
  type Helper,
  type IntName,
  type ParamKind,
  type ScalarType,
  type StructDef,
  type ValueType,
  fixedVecName,
  heapVecName,
  isWritable,
  optionKey,
} from "../model.js";

// Types, limits and C type helpers shared by the emitter modules.

/** Maximum accounts the generated entrypoint deserializes. */
export const MAX_ACCOUNTS = 32;
/** The most accounts one instruction takes: 32, or what the program declares with `const MAX_ACCOUNTS = …n` (33–255). */
export function accountLimit(model: Pick<ProgramModel, "constants">): number {
  const c = model.constants.get("MAX_ACCOUNTS");
  return c && typeof c.value === "bigint" && c.value >= 32n && c.value <= 255n ? Number(c.value) : MAX_ACCOUNTS;
}
export const MAX_SEEDS = 15; // + bump = 16, the runtime limit
/** Max instruction data an invoke() may build, and max event payload. */
export const MAX_CPI_DATA = 1024;
export const MAX_EVENT = 1024;

/** The Associated Token Account program (ATokenGP…), for IDL PDA descriptions. */
export const ATA_PROGRAM_BYTES = [
  140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
];

export const U64: ScalarType = { kind: "int", name: "u64" };
export const U8: ScalarType = { kind: "int", name: "u8" };
export const I64: ScalarType = { kind: "int", name: "i64" };
export const I32: ScalarType = { kind: "int", name: "i32" };
export const BOOL: ScalarType = { kind: "bool" };
export const PUBKEY: ScalarType = { kind: "pubkey" };
export const STRING: ValueType = { kind: "string" };
export const HASH: ScalarType = { kind: "pubkey", hash: true };

/**
 * A lowered expression: a side-effect-free C expression plus its type.
 * Pubkeys are `const SolPubkey *`, strings are `TS_Str` views.
 */
export interface Value {
  c: string;
  type: ValueType;
  /** Set for bigint literals whose type was inferred, so they can adapt to the other operand. */
  literal?: bigint;
  /** Set for string literals, so seeds can stay compile-time constants. */
  stringLiteral?: string;
  /** The `null` literal; becomes an empty option once the expected Option type is known. */
  isNull?: boolean;
}

/** A storage location: account data, a nested field, an array element, or a local array. */
export interface Ref {
  lv: string;
  type: FieldType;
  writable: boolean;
  /** Owning account, for diagnostics and IDL seed paths. */
  account?: AccountParam;
  /** Field path from the account root, when it is a plain chain of fields. */
  path?: string[];
  /** For a Vec: the u32 length lvalue, the fixed-part size expression, and whether it may be resized here. */
  /**
   * A Vec place: `len` the u32 length (an lvalue), `items` the element array. A trailing Vec grows the account
   * (`fixed` bytes before it); a FixedVec (`cap`) has room for `cap` elements and never resizes.
   */
  vec?: {
    len: string;
    items: string;
    /** The account's size without this Vec's elements (so with `n` of them: 8 + fixed + n × elemSize). */
    fixed: string;
    elemSize: number;
    resizable: boolean;
    cap?: number;
    /** A heap Vec (in a `@layout borsh` struct): `cap` is the C lvalue of its capacity, grown by ts_hvec_reserve. */
    heap?: boolean;
    /** Growable Vecs stored after this one move when it grows or shrinks: where its elements end, and their paths. */
    tail?: { end: string; dataEnd: string; paths: string[] };
  };
}

export interface Local {
  c: string;
  /** A value, or a local FixedArray / FixedVec (`fixedArray<T, N>(…)`, `const ys = xs.map(…)`) held in place. */
  type: ValueType | (FieldType & { kind: "array" }) | (FieldType & { kind: "vec"; cap: number });
  mutable: boolean;
  /** Pubkey held as a `const SolPubkey *` (helper parameters) rather than a value. */
  ptr?: boolean;
  /** Arrays from instruction arguments: readable, not writable. */
  readonly?: boolean;
  /** For struct / data-enum references: the storage paths they alias (e.g. "book.asks[]"), and the declaration. */
  paths?: string[];
  decl?: ts.VariableDeclaration | ts.ParameterDeclaration;
  /** A local closure (`const f = (…) => …` reading the enclosing function's variables), expanded where it is called. */
  closure?: Closure;
}

/** A closure and the scopes it was declared in (its free names resolve there, wherever it is called). */
export interface Closure {
  /** The function expanded: a closure, or a helper expanded where it is called because it was given one. */
  node: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;
  name: string;
  scopes: Map<string, Local>[];
  /**
   * The instruction arguments and accounts its body may name: those where it was written for a closure, none for a
   * helper or a function a helper made (they see only their parameters and the module).
   */
  env: { args: Map<string, Local>; accounts: Map<string, AccountParam> };
  /** The `typesol` imports of the file it is written in: its type names mean what they mean there. */
  imports: Map<string, string>;
}

export const cBytes = (bytes: number[]) => `{${bytes.join(", ")}}`;
/** C expressions that nothing in a TypeSOL expression can change: temporaries, locals, arguments, account keys, constants. */
export const isStable = (c: string) =>
  /^\w+$/.test(c) || /^\(&\w+\)$/.test(c) || /^&\w+->key$/.test(c) || /^\(\(uint8_t\)\d+\)$/.test(c) || /^\(?-?\d+U?LL\)?$/.test(c);

/** A C string literal of the UTF-8 bytes. Octal escapes (at most three digits) cannot swallow following characters. */
export const cString = (s: string) =>
  `"${[...Buffer.from(s, "utf8")].map((b) => (b >= 0x20 && b < 0x7f && b !== 0x22 && b !== 0x5c && b !== 0x3f ? String.fromCharCode(b) : `\\${b.toString(8).padStart(3, "0")}`)).join("")}"`;

export function intLiteral(value: bigint, name: IntName): string {
  if (name === "i64") {
    if (value === INT_INFO.i64.min) return "(-9223372036854775807LL - 1)";
    return value < 0n ? `(${value}LL)` : `${value}LL`;
  }
  if (name === "u128" || name === "i128") {
    // C has no 128-bit literals: build the two's-complement bits from two 64-bit halves.
    const bits = BigInt.asUintN(128, value);
    const hi = bits >> 64n;
    const lo = bits & (2n ** 64n - 1n);
    const t = INT_INFO[name].c;
    return hi === 0n ? `((${t})${lo}ULL)` : `((${t})((((unsigned __int128)${hi}ULL) << 64) | ${lo}ULL))`;
  }
  if (INT_INFO[name].signed) return `((${INT_INFO[name].c})(${value}LL))`;
  return `${value}ULL`;
}

/** C type of a scalar held in a local or argument. */
export function scalarC(t: ScalarType): string {
  return t.kind === "int" ? INT_INFO[t.name].c : t.kind === "bool" ? "bool" : t.kind === "enum" ? "uint8_t" : "SolPubkey";
}

/** C type of a scalar as stored in account data (bool and enums are one byte). */
export function scalarStorageC(t: ScalarType): string {
  return t.kind === "int" ? INT_INFO[t.name].c : t.kind === "pubkey" ? "SolPubkey" : "uint8_t";
}

export const optC = (inner: ScalarType | { kind: "struct"; name: string }) => `TS_Opt_${optionKey(inner)}`;

/** C type of any value held in a local. */
export function valueC(t: ValueType): string {
  switch (t.kind) {
    case "string":
      return "TS_Str";
    case "option":
      return optC(t.inner);
    case "vecArg":
      return "TS_VecArg";
    case "account":
      return "TsAccount *";
    case "txIx":
      return "TsIx";
    case "structRef":
      return `TSS_${t.struct} *`;
    case "enumRef":
    case "dataEnumArg":
      return `TSE_${t.name} *`;
    case "remaining":
    case "arrayArg":
    case "signerSeeds":
      throw new Error(`unreachable: ${t.kind} is not held in a C value`);
    default:
      return scalarC(t);
  }
}

/** C type of one fixed-size element (struct, string, option, enum or scalar) as laid out in data. */
export function fieldC(t: FieldType): string {
  switch (t.kind) {
    case "struct":
      return `TSS_${t.name}`;
    case "fstring":
      return `TS_FStr${t.cap}`;
    case "option":
      return optC(t.inner);
    case "dataEnum":
      return `TSE_${t.name}`;
    case "int":
    case "bool":
    case "pubkey":
    case "enum":
      return scalarStorageC(t);
    case "vec":
      if (t.cap !== undefined) return fixedVecC(t);
      if (t.heap) return heapVecName(t);
      throw new Error("unreachable: a Vec is never an element");
    default:
      throw new Error(`unreachable: no element C type for ${t.kind}`);
  }
}

/** C declaration of a field stored in account data (packed, Borsh-identical). */
export function storageDecl(t: FieldType, name: string): string {
  switch (t.kind) {
    case "int":
      return `${INT_INFO[t.name].c} ${name}`;
    case "bool":
      return `uint8_t ${name}`;
    case "pubkey":
      return `SolPubkey ${name}`;
    case "enum":
      return `uint8_t ${name}`;
    case "option":
      return `${optC(t.inner)} ${name}`;
    case "dataEnum":
      return `TSE_${t.name} ${name}`;
    case "fstring":
      return `TS_FStr${t.cap} ${name}`;
    case "struct":
      return `TSS_${t.name} ${name}`;
    case "array":
      return storageDecl(t.elem, `${name}[${t.len}]`);
    case "vec":
      if (t.cap !== undefined) return `${fixedVecC(t)} ${name}`;
      if (t.heap) return `${heapVecName(t)} ${name}`;
      // Borsh Vec as a trailing flexible array: u32 length, then the elements.
      return `uint32_t ${name}__len;
  ${storageDecl(t.elem, `${name}[]`)}`;
    case "string":
      // Only in a variable data enum's payload (arguments, events, locals): a view of the text.
      return `TS_Str ${name}`;
  }
}

/** Why an account of kind `have` cannot be passed where a helper takes `want`, or undefined when it can. */
export function accountMismatch(have: ParamKind, want: ParamKind): string | undefined {
  const name = (k: ParamKind): string => {
    switch (k.kind) {
      case "info":
        return k.mut ? "Mut<AccountInfo>" : "AccountInfo";
      case "signer":
        return k.mut ? "Mut<Signer>" : "Signer";
      case "account":
        return k.mut ? `Mut<${k.struct.name}>` : `Account<${k.struct.name}>`;
      case "token":
        return k.mut ? "Mut<TokenAccount>" : "TokenAccount";
      case "mint":
        return k.mut ? "Mut<Mint>" : "Mint";
      case "program":
        return k.address ? `Program<"${k.address.base58}">` : "UncheckedProgram";
      default:
        return k.kind;
    }
  };
  const mutOk = !("mut" in want) || !want.mut || isWritable(have);
  let ok: boolean;
  switch (want.kind) {
    case "info":
      ok = true;
      break;
    case "signer":
      ok = have.kind === "signer";
      break;
    case "account":
      ok = (have.kind === "account" || have.kind === "init" || have.kind === "initIfNeeded" || have.kind === "zeroed") && have.struct.name === want.struct.name;
      break;
    case "program":
      ok = want.address
        ? have.kind === "program" && have.address?.base58 === want.address.base58
        : have.kind === "program" || have.kind === "system" || have.kind === "tokenProgram" || have.kind === "ataProgram" || have.kind === "metadataProgram";
      break;
    case "tokenProgram":
      ok = have.kind === "tokenProgram" && (want.flavor === "tokenInterface" || have.flavor === want.flavor);
      break;
    case "switchboard":
      ok = have.kind === "switchboard" && have.devnet === want.devnet;
      break;
    default:
      ok = have.kind === want.kind;
  }
  return ok && mutOk ? undefined : name(want);
}

/** Helpers get the instruction's parameters (for CPIs and accounts), then their own, then the result slot. */
export function helperSignature(h: Helper): string {
  const params = ["TsParams *params"];
  for (const p of h.params) {
    if (p.account) {
      params.push(`TsAccount *a_${p.name}`);
      if (p.account.kind === "account" && p.account.struct.layout === "borsh") params.push(`TSS_${p.account.struct.name} *d_${p.name}`);
      // A writable account with a growable Vec: its length at instruction entry, for push / pop / clear.
      if (p.account.kind === "account" && p.account.mut && p.account.struct.vec) params.push(`uint64_t entry_${p.name}`);
    } else if (p.type.kind === "signerSeeds") params.push(`const SolSignerSeed *p_${p.name}`, `int p_${p.name}__n`);
    else if (p.type.kind === "pubkey")
      params.push(`SolPubkey p_${p.name}`); // by value: a copy taken at the call
    else if (p.type.kind === "arrayArg") params.push(storageDecl(p.type.array, `(*p_${p.name})`));
    else params.push(`${valueC(p.type)} p_${p.name}`);
  }
  if (h.returns)
    params.push(h.returns.kind === "struct" ? `TSS_${h.returns.name} *ret` : h.returns.kind === "string" ? `TS_Str *ret` : `${scalarC(h.returns)} *ret`);
  return `static uint64_t fn_${h.name}(${params.join(", ")})`;
}

export interface EmitOptions {
  /** Log a marker and the remaining compute units before every statement (`typesol build --profile`). */
  profile?: boolean;
}

/** C type of a growable Vec stored after the first one of struct `s`: `{ uint32_t len; T items[]; }`. */
export function laterVecC(s: string, field: string): string {
  return `TSW_${s}__${field}`;
}

/** The account size of struct `s` with every growable Vec empty, as C (8-byte discriminator not included). */
export function emptySizeC(s: StructDef): string {
  const n = s.vecs?.length ?? 0;
  return n > 1 ? `(sizeof(TSS_${s.name}) + ${4 * (n - 1)})` : `sizeof(TSS_${s.name})`;
}

/**
 * Where growable Vec `k` of a struct at `base` (a C lvalue of type TSS_<S>) starts, as C: its length and elements.
 * The first is a member of the struct; each further one starts right after the previous one's elements.
 */
export function vecPlace(s: StructDef, base: string, k: number): { len: string; items: string; end: string } {
  const vs = s.vecs!;
  const first = vs[0]!;
  let end = `((uint8_t *)${base}.${first.name} + (uint64_t)${base}.${first.name}__len * ${first.elemSize})`;
  let place = { len: `${base}.${first.name}__len`, items: `${base}.${first.name}`, end };
  for (let j = 1; j <= k; j++) {
    const v = vs[j]!;
    const h = `((${laterVecC(s.name, v.name)} *)${end})`;
    end = `((uint8_t *)${h}->items + (uint64_t)${h}->len * ${v.elemSize})`;
    place = { len: `${h}->len`, items: `${h}->items`, end };
  }
  return place;
}

/**
 * C lines checking that an account's size matches its growable Vecs' lengths (`d`: its TSS_<S> pointer, `a`: its
 * TsAccount). One Vec: ts_check_vec_len; more: each length read only once the bytes before it are known to exist.
 */
export function vecLenCheck(s: StructDef, a: string, d: string, pad = "  "): string[] {
  const vs = s.vecs ?? [];
  if (vs.length === 1) return [`${pad}TS_TRY(ts_check_vec_len(${a}, sizeof(TSS_${s.name}), ${d}->${vs[0]!.name}__len, TS_ELEM_${s.name}));`];
  const o = `${d.replace(/\W/g, "")}__vo`;
  const lines = [`${pad}{`, `${pad}  uint64_t ${o} = sizeof(TSS_${s.name}) + (uint64_t)${d}->${vs[0]!.name}__len * ${vs[0]!.elemSize};`];
  for (const v of vs.slice(1)) {
    lines.push(`${pad}  if (${a}->data_len < 8 + ${o} + 4) TS_FAIL(TS_ERR_ACCOUNT_TOO_SMALL, "TypeSOL: account size does not match its Vec lengths");`);
    lines.push(`${pad}  ${o} += 4 + (uint64_t)((${laterVecC(s.name, v.name)} *)(${a}->data + 8 + ${o}))->len * ${v.elemSize};`);
  }
  lines.push(`${pad}  if (${a}->data_len != 8 + ${o}) TS_FAIL(TS_ERR_ACCOUNT_TOO_SMALL, "TypeSOL: account size does not match its Vec lengths");`, `${pad}}`);
  return lines;
}

/** C typedef name of a FixedVec<T, N>: `{ uint32_t len; T items[N]; }`. */
export function fixedVecC(t: FieldType & { kind: "vec" }): string {
  return `TSF_${fixedVecName(t)}`;
}

/** The element count of a Vec place to read: a FixedVec's stored length is clamped to its capacity. */
export function vecCount(v: NonNullable<Ref["vec"]>): string {
  return v.cap === undefined || v.heap ? `((uint64_t)${v.len})` : `((uint64_t)(${v.len} < ${v.cap} ? ${v.len} : ${v.cap}))`;
}
