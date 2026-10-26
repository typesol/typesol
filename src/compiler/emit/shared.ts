import ts from "typescript";
import {
  INT_INFO,
  type AccountParam,
  type FieldType,
  type Helper,
  type IntName,
  type ParamKind,
  type ScalarType,
  type ValueType,
  isWritable,
  optionKey,
} from "../model.js";

// Types, limits and C type helpers shared by the emitter modules.

/** Maximum accounts the generated entrypoint deserializes. */
export const MAX_ACCOUNTS = 32;
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
  vec?: { len: string; fixed: string; elemSize: number; resizable: boolean };
}

export interface Local {
  c: string;
  type: ValueType | (FieldType & { kind: "array" });
  mutable: boolean;
  /** Pubkey held as a `const SolPubkey *` (helper parameters) rather than a value. */
  ptr?: boolean;
  /** Arrays from instruction arguments: readable, not writable. */
  readonly?: boolean;
  /** For struct / data-enum references: the storage paths they alias (e.g. "book.asks[]"), and the declaration. */
  paths?: string[];
  decl?: ts.VariableDeclaration;
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
      // Borsh Vec as a trailing flexible array: u32 length, then the elements.
      return `uint32_t ${name}__len;
  ${storageDecl(t.elem, `${name}[]`)}`;
    case "string":
      throw new Error("unreachable: variable strings are not stored");
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
    if (p.account) params.push(`TsAccount *a_${p.name}`);
    else if (p.type.kind === "signerSeeds") params.push(`const SolSignerSeed *p_${p.name}`, `int p_${p.name}__n`);
    else if (p.type.kind === "pubkey")
      params.push(`SolPubkey p_${p.name}`); // by value: a copy taken at the call
    else if (p.type.kind === "arrayArg") params.push(storageDecl(p.type.array, `(*p_${p.name})`));
    else params.push(`${valueC(p.type)} p_${p.name}`);
  }
  if (h.returns) params.push(`${scalarC(h.returns)} *ret`);
  return `static uint64_t fn_${h.name}(${params.join(", ")})`;
}

export interface EmitOptions {
  /** Log a marker and the remaining compute units before every statement (`typesol build --profile`). */
  profile?: boolean;
}
