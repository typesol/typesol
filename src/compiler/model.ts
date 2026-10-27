import type ts from "typescript";

export type IntName = "u8" | "u16" | "u32" | "u64" | "u128" | "i8" | "i16" | "i32" | "i64" | "i128";
export const INT_NAMES: readonly IntName[] = ["u8", "u16", "u32", "u64", "u128", "i8", "i16", "i32", "i64", "i128"];

export const INT_INFO: Record<IntName, { bytes: number; signed: boolean; c: string; min: bigint; max: bigint }> = {
  u8: { bytes: 1, signed: false, c: "uint8_t", min: 0n, max: 0xffn },
  u16: { bytes: 2, signed: false, c: "uint16_t", min: 0n, max: 0xffffn },
  u32: { bytes: 4, signed: false, c: "uint32_t", min: 0n, max: 0xffff_ffffn },
  u64: { bytes: 8, signed: false, c: "uint64_t", min: 0n, max: 2n ** 64n - 1n },
  u128: { bytes: 16, signed: false, c: "unsigned __int128", min: 0n, max: 2n ** 128n - 1n },
  i8: { bytes: 1, signed: true, c: "int8_t", min: -(2n ** 7n), max: 2n ** 7n - 1n },
  i16: { bytes: 2, signed: true, c: "int16_t", min: -(2n ** 15n), max: 2n ** 15n - 1n },
  i32: { bytes: 4, signed: true, c: "int32_t", min: -(2n ** 31n), max: 2n ** 31n - 1n },
  i64: { bytes: 8, signed: true, c: "int64_t", min: -(2n ** 63n), max: 2n ** 63n - 1n },
  i128: { bytes: 16, signed: true, c: "__int128", min: -(2n ** 127n), max: 2n ** 127n - 1n },
};

/** The unsigned C type of the same width, for shifts. */
export function unsignedC(name: IntName): string {
  return INT_INFO[name].bytes === 16 ? "unsigned __int128" : `uint${INT_INFO[name].bytes * 8}_t`;
}

/** Fixed-size scalars: what fits in a register and in account data as-is. `enum` is a unit-variant enum stored as u8. */
export type ScalarType =
  | { kind: "int"; name: IntName }
  | { kind: "bool" }
  /** 32 bytes. `hash` marks a Hash (sha256/keccak output, Merkle roots): same layout, distinct type. */
  | { kind: "pubkey"; hash?: boolean }
  | { kind: "enum"; name: string };

/**
 * Types of values an expression can produce. `string` is a read-only view (pointer + length)
 * of a literal, an instruction argument, or a FixedString in account data.
 */
export type ValueType =
  | ScalarType
  | { kind: "string" }
  /** `T | null`: C struct `TS_Opt_<T>` { uint8_t some; T v; } */
  | { kind: "option"; inner: ScalarType }
  /** `Vec<T>` instruction argument: a read-only view into instruction data. T is a scalar or a fixed-size struct. */
  | { kind: "vecArg"; elem: FieldType }
  /** `FixedArray<T, N>` instruction argument (Borsh [T; N]), parsed into a read-only copy. */
  | { kind: "arrayArg"; array: FieldType & { kind: "array" } }
  /** A Solana `SignerSeeds` helper parameter: the seeds of one PDA signature, built with signer([...]). */
  | { kind: "signerSeeds" }
  /** An extra account from remainingAccounts(): `SolAccountInfo *`. */
  | { kind: "account" }
  /** The remainingAccounts() list itself. */
  | { kind: "remaining" }
  /** A struct loaded from a remaining account with loadAccount / loadAccountMut. */
  | { kind: "structRef"; struct: string; writable: boolean }
  /** A data-enum place (local value, argument, or alias into account data): `TS_DE_<name> *`. */
  | { kind: "enumRef"; name: string; writable: boolean }
  /** A data-enum instruction argument (Borsh enum), parsed into a local. */
  | { kind: "dataEnumArg"; name: string };

/** Types that can live in account data or events. */
export type FieldType =
  | ScalarType
  | { kind: "array"; elem: FieldType; len: number }
  | { kind: "struct"; name: string }
  /** FixedString<N>: u32 length + N bytes, fixed footprint. */
  | { kind: "fstring"; cap: number }
  /** Borsh `string` (u32 length + bytes, variable). Only allowed in events. */
  | { kind: "string" }
  /** `Option<T>` in account data: fixed { u8 is_some; T value } (value zeroed when None). T may be a struct here. */
  | { kind: "option"; inner: ScalarType | { kind: "struct"; name: string } }
  /** A data-carrying enum (discriminated union): fixed { u8 tag; payload sized for the largest variant }. */
  | { kind: "dataEnum"; name: string }
  /** `Vec<T>`: Borsh u32 length + elements. Only as the last field of an account struct. */
  | { kind: "vec"; elem: FieldType };

export interface StructField {
  name: string;
  type: FieldType;
}

/** Every exported interface. Used as account data, nested in other structs, or emitted as an event. */
export interface StructDef {
  name: string;
  fields: StructField[];
  /**
   * Fixed byte size (for a struct ending in a Vec: everything up to and including the Vec's u32 length),
   * or undefined when a field is a variable-length string (event-only structs).
   */
  size: number | undefined;
  /** The trailing Vec field, if any. Such structs can only be account data. */
  vec?: { name: string; elem: FieldType; elemSize: number };
  accountDiscriminator: number[];
  eventDiscriminator: number[];
  node: ts.InterfaceDeclaration;
}

export type TokenProgramKind = "token" | "token2022" | "tokenInterface";

export type ParamKind =
  | { kind: "signer"; mut: boolean }
  | { kind: "info"; mut: boolean }
  | { kind: "account"; struct: StructDef; mut: boolean }
  | { kind: "init"; struct: StructDef }
  /** Created on first use, otherwise verified like Mut<T>: `acct.createIfNeeded(payer, seeds)`. */
  | { kind: "initIfNeeded"; struct: StructDef }
  /** A large account the client already allocated (zeroed, owned by this program); initialized here. */
  | { kind: "zeroed"; struct: StructDef }
  /** `init`: an associated token account this instruction creates (`Ata<Init<TokenAccount>, …>`, create) or creates when
   * missing (`Ata<InitIfNeeded<TokenAccount>, …>`, createIfNeeded); it is a TokenAccount once that call has run. */
  | { kind: "token"; mut: boolean; init?: "create" | "ifNeeded" }
  | { kind: "mint"; mut: boolean }
  | { kind: "system" }
  | { kind: "instructionsSysvar" }
  | { kind: "pyth" }
  /** Metaplex Core (CoREEN…) and Bubblegum (BGUMAp…): their addresses are checked. */
  | { kind: "coreProgram" }
  | { kind: "bubblegumProgram" }
  /** Anchor's event authority PDA ["__event_authority"] for emitCpi. */
  | { kind: "eventAuthority" }
  /** This program itself (for self-CPI). */
  | { kind: "selfProgram" }
  /** This program's ProgramData account (BPF upgradeable loader): address, owner and state checked. */
  | { kind: "programData" }
  | { kind: "ataProgram" }
  | { kind: "metadataProgram" }
  | { kind: "switchboard"; devnet: boolean }
  | { kind: "tokenProgram"; flavor: TokenProgramKind }
  /** `address` is set for Program<"..."> and absent for UncheckedProgram. */
  | { kind: "program"; address?: { base58: string; bytes: number[] } };

/** Declarative checks written in the parameter type: HasOne / Seeds / CloseTo. */
export interface Constraints {
  /** Pubkey fields that must equal the key of the account parameter with the same name. */
  hasOne: string[];
  /** PDA seeds by name (account param -> its key, argument -> its bytes, otherwise a literal string), and the bump field. */
  /** `program`: "@param" (an account parameter's key) or a base58 address, when the PDA belongs to another program. */
  seeds?: { names: string[]; bump?: string; program?: string };
  /** Owner<A, "base58">: the account's owner program. */
  owner?: { base58: string; bytes: number[] };
  /** Executable<A>: the account must be an executable program. */
  executable?: boolean;
  /** Close this account into that parameter when the instruction succeeds. */
  closeTo?: string;
  /** Address<A, "base58">: the account must be exactly this address. */
  address?: { base58: string; bytes: number[] };
  /** Ata<A, "owner", "mint">: the account must be the associated token account of those parameters. */
  ata?: { owner: string; mint: string };
}

export interface AccountParam {
  name: string;
  index: number;
  kind: ParamKind;
  /** `A | null` / `Optional<A>`: the client passes this program's id instead of an account to leave it out. */
  optional?: boolean;
  node: ts.ParameterDeclaration;
  constraints: Constraints;
}

export interface ArgParam {
  name: string;
  type: ValueType;
  node: ts.ParameterDeclaration;
}

/** One element of a PDA derivation, in Anchor IDL terms. */
export type IdlSeed = { kind: "const"; value: number[] } | { kind: "account"; path: string; account?: string } | { kind: "arg"; path: string };

export interface Instruction {
  name: string;
  discriminator: number[];
  accounts: AccountParam[];
  args: ArgParam[];
  /** Fixed bytes of the arguments; strings add their length on top. */
  minArgsSize: number;
  /** Sent as return data: a scalar in Borsh, or a fixed-size struct in its fixed layout (as the IDL describes it). */
  returns: ScalarType | { kind: "struct"; name: string } | undefined;
  /** account name -> seeds, recorded when the body creates or verifies a PDA with describable seeds. */
  pdas: Map<string, IdlSeed[]>;
  /** account name -> the program its PDA is derived under, when not this program (e.g. associated token accounts). */
  pdaPrograms: Map<string, IdlSeed>;
  node: ts.FunctionDeclaration;
  /** The declaring file's `typesol` imports (local name -> export name). */
  imports: Map<string, string>;
}

export interface HelperParam {
  name: string;
  /** `{ kind: "account" }` for account parameters (then `account` says which kind). */
  type: ValueType;
  account?: ParamKind;
  node: ts.ParameterDeclaration;
}

/** A non-exported function (or any function of an imported file): values and accounts in; void, a scalar or a struct out. */
export interface Helper {
  name: string;
  params: HelperParam[];
  /** A struct result is written through an out pointer (`TSS_<name> *ret`) that the caller provides. */
  returns: ScalarType | { kind: "struct"; name: string } | undefined;
  node: ts.FunctionDeclaration;
  /** The declaring file's `typesol` imports (local name -> export name). */
  imports: Map<string, string>;
}

/** A top-level compile-time constant. `type` is set when annotated (`const FEE: u16 = 30n`). */
export interface ConstDef {
  name: string;
  /** `{ pubkey }` for `const ADMIN = pubkey("…")`: the decoded 32 bytes. */
  value: bigint | boolean | string | { pubkey: number[] };
  type?: ScalarType;
}

/** A data-carrying enum: `export type Action = { kind: "Deposit"; amount: u64 } | { kind: "Pause" }`. */
export interface DataEnumDef {
  name: string;
  variants: { name: string; fields: StructField[]; size: number }[];
  /** Largest variant size: the fixed payload in account data. */
  payload: number;
  /**
   * A variant holds a `string` (directly or in a nested enum): such an enum is Borsh in instruction arguments and
   * events and a local value otherwise, never account data or part of a fixed layout. Its C payload holds TS_Str views.
   */
  variable?: boolean;
  node: ts.TypeAliasDeclaration;
}

/** A unit-variant enum: `export enum Status { Open, Closed }`. */
export interface EnumDef {
  name: string;
  variants: string[];
}

export interface ErrorDef {
  code: number;
  name: string;
  msg: string;
}

export interface ProgramModel {
  name: string;
  structs: Map<string, StructDef>;
  instructions: Instruction[];
  helpers: Map<string, Helper>;
  errors: ErrorDef[];
  /** Enum name -> member name -> error */
  errorEnums: Map<string, Map<string, ErrorDef>>;
  /** Unit-variant value enums. */
  enums: Map<string, EnumDef>;
  /** Data-carrying enums (discriminated unions). */
  dataEnums: Map<string, DataEnumDef>;
  /** Top-level `const NAME = literal` compile-time constants. */
  constants: Map<string, ConstDef>;
  /** Types used inside Option<...>, for C typedefs and IDL types (scalars, or structs in account data). */
  options: Map<string, ScalarType | { kind: "struct"; name: string }>;
  /** Structs passed to emit(), filled in while emitting. */
  events: Set<string>;
  /** Structs used as Account/Mut/Init. */
  accountStructs: Set<string>;
  /** Structs passed as instruction arguments (directly, in arrays or in Vecs): their IDL layout is the fixed one. */
  argStructs: Set<string>;
  /** FixedString capacities in use, for C typedefs and IDL types. */
  fstrings: Set<number>;
}

export function isWritable(k: ParamKind): boolean {
  switch (k.kind) {
    case "init":
    case "zeroed":
    case "initIfNeeded":
      return true;
    case "signer":
    case "info":
    case "account":
    case "token":
    case "mint":
      return k.mut;
    default:
      return false;
  }
}

export function typeName(t: ValueType | FieldType): string {
  switch (t.kind) {
    case "int":
      return t.name;
    case "bool":
      return "boolean";
    case "pubkey":
      return t.hash ? "Hash" : "Pubkey";
    case "string":
      return "string";
    case "array":
      return `FixedArray<${typeName(t.elem)}, ${t.len}>`;
    case "struct":
      return t.name;
    case "fstring":
      return `FixedString<${t.cap}>`;
    case "enum":
      return t.name;
    case "option":
      return `Option<${typeName(t.inner)}>`;
    case "dataEnum":
    case "dataEnumArg":
    case "enumRef":
      return t.name;
    case "vec":
      return `Vec<${typeName(t.elem)}>`;
    case "vecArg":
      return `Vec<${typeName(t.elem)}>`;
    case "arrayArg":
      return typeName(t.array);
    case "signerSeeds":
      return "SignerSeeds";
    case "account":
      return "AccountInfo";
    case "remaining":
      return "RemainingAccounts";
    case "structRef":
      return t.struct;
  }
}

export function sameType(a: ValueType | FieldType, b: ValueType | FieldType): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "int":
      return a.name === (b as { name: IntName }).name;
    case "array": {
      const o = b as typeof a;
      return a.len === o.len && sameType(a.elem, o.elem);
    }
    case "struct":
      return a.name === (b as typeof a).name;
    case "fstring":
      return a.cap === (b as typeof a).cap;
    case "enum":
      return a.name === (b as typeof a).name;
    case "pubkey":
      return !a.hash === !(b as typeof a).hash;
    case "option":
      return sameType(a.inner, (b as typeof a).inner);
    case "vec":
      return sameType(a.elem, (b as typeof a).elem);
    case "vecArg":
      return sameType(a.elem, (b as typeof a).elem);
    case "arrayArg":
      return sameType(a.array, (b as typeof a).array);
    case "structRef":
      return a.struct === (b as typeof a).struct;
    case "dataEnum":
    case "dataEnumArg":
    case "enumRef":
      return a.name === (b as typeof a).name;
    default:
      return true;
  }
}

export function scalarSize(t: ScalarType): number {
  return t.kind === "int" ? INT_INFO[t.name].bytes : t.kind === "pubkey" ? 32 : 1;
}

export function isScalar(t: ValueType | FieldType): t is ScalarType {
  return t.kind === "int" || t.kind === "bool" || t.kind === "pubkey" || t.kind === "enum";
}

/** Stable C identifier suffix for a scalar, used in TS_Opt_<suffix>. */
export function optionKey(t: ScalarType | { kind: "struct"; name: string }): string {
  return t.kind === "struct" ? `s_${t.name}` : scalarKey(t);
}

export function scalarKey(t: ScalarType): string {
  return t.kind === "int" ? t.name : t.kind === "enum" ? `e_${t.name}` : t.kind === "pubkey" && t.hash ? "hash" : t.kind;
}
