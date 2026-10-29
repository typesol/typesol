/**
 * `typesol cpi <idl.json>`: TypeSOL helper functions that call another program's instructions,
 * generated from its Anchor IDL (spec 0.1.0, as written by Anchor 0.30+ and by TypeSOL itself).
 *
 * Each instruction becomes
 *
 *   export function vaultDeposit(program: Program<"…">, vault: Mut<AccountMeta>, owner: AccountMeta,
 *                                amount: u64, seeds: SignerSeeds): void {
 *     invoke(program, [writable(vault), readonlySigner(owner)], [hex("f223c689…"), amount], seeds);
 *   }
 *
 * Call it with `signer([...])` for a PDA of the calling program that must sign, or `signer([])`.
 * Argument types without a Borsh-identical TypeSOL type (strings or Options inside structs, data-carrying
 * enums, nested Vecs, generics) are reported and the instruction is left out.
 */

const INTS = new Set(["u8", "u16", "u32", "u64", "u128", "i8", "i16", "i32", "i64", "i128"]);
const RESERVED = new Set(
  "break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await program seeds".split(
    " ",
  ),
);

type IdlType = string | { vec?: IdlType; option?: IdlType; array?: [IdlType, number | unknown]; defined?: string | { name: string; generics?: unknown[] } };
interface IdlField {
  name: string;
  type: IdlType;
}
interface IdlTypeDef {
  name: string;
  type: { kind: string; fields?: IdlField[] | IdlType[]; variants?: { name: string; fields?: unknown[] }[] };
  generics?: unknown[];
}
interface IdlAccountItem {
  name: string;
  writable?: boolean;
  signer?: boolean;
  optional?: boolean;
  docs?: string[];
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
export interface Idl {
  address?: string;
  metadata?: { name?: string };
  instructions: IdlInstruction[];
  types?: IdlTypeDef[];
}

export interface CpiGenResult {
  source: string;
  generated: string[];
  skipped: { instruction: string; reason: string }[];
}

class Unsupported extends Error {}

const RESERVED_FIELDS = new Set([
  "key",
  "lamports",
  "dataLen",
  "create",
  "equals",
  "get",
  "set",
  "length",
  "isSigner",
  "isWritable",
  "pdaBump",
  "long",
  "int",
  "short",
  "char",
  "float",
  "double",
  "signed",
  "unsigned",
  "struct",
  "union",
  "auto",
  "register",
  "static",
  "extern",
  "goto",
  "sizeof",
  "typedef",
  "volatile",
  "bool",
]);
const fieldName = (s: string): string => {
  const n = s
    .replace(/[_-]+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase())
    .replace(/^[A-Z]/, (c) => c.toLowerCase())
    .replace(/^_+/, "");
  return RESERVED_FIELDS.has(n) || RESERVED.has(n) ? `${n}Field` : n;
};
const camel = (s: string) => s.replace(/[_-]+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase()).replace(/^[A-Z]/, (c) => c.toLowerCase());
const pascal = (s: string) => camel(s).replace(/^[a-z]/, (c) => c.toUpperCase());
const safe = (s: string) => (RESERVED.has(s) ? `${s}_` : s);

export function generateCpi(idl: Idl, opts: { prefix?: string; address?: string } = {}): CpiGenResult {
  if (!idl || typeof idl !== "object" || !Array.isArray((idl as { instructions?: unknown }).instructions))
    throw new Error("not an Anchor IDL (spec 0.1.0): expected an object with an `instructions` array");
  const address = opts.address ?? idl.address;
  if (!address) throw new Error("the IDL has no program address; pass --address <base58>");
  const programName = idl.metadata?.name ?? "program";
  const prefix = opts.prefix ?? camel(programName);
  const typeDefs = new Map((idl.types ?? []).map((t) => [t.name, t]));
  const typeImports = new Set<string>(["Program", "SignerSeeds"]);
  const valueImports = new Set<string>(["invoke", "hex"]);
  const declarations = new Map<string, string>();

  /** A TypeSOL type for an IDL type in a position where Borsh and TypeSOL layouts agree. */
  const typeOf = (t: IdlType, where: "arg" | "field" | "elem"): string => {
    if (typeof t === "string") {
      if (INTS.has(t)) {
        typeImports.add(t);
        return t;
      }
      if (t === "bool") return "boolean";
      if (t === "pubkey" || t === "publicKey") {
        typeImports.add("Pubkey");
        return "Pubkey";
      }
      if (t === "string") {
        if (where !== "arg") throw new Unsupported("a string inside a struct, Vec or array");
        return "string";
      }
      if (t === "bytes") {
        if (where !== "arg") throw new Unsupported("bytes inside a struct, Vec or array");
        typeImports.add("Vec").add("u8");
        return "Vec<u8>";
      }
      throw new Unsupported(`type "${t}"`);
    }
    if (t.vec !== undefined) {
      if (where !== "arg") throw new Unsupported("a Vec inside a struct, Vec or array");
      typeImports.add("Vec");
      return `Vec<${typeOf(t.vec, "elem")}>`;
    }
    if (t.option !== undefined) {
      if (where !== "arg") throw new Unsupported("an Option inside a struct, Vec or array");
      const inner = typeOf(t.option, "elem");
      if (!/^(u|i)\d+$|^boolean$|^Pubkey$/.test(inner) && !isUnitEnum(inner)) throw new Unsupported(`Option<${inner}>`);
      typeImports.add("Option");
      return `Option<${inner}>`;
    }
    if (t.array !== undefined) {
      const [elem, len] = t.array;
      if (typeof len !== "number") throw new Unsupported("an array with a generic length");
      typeImports.add("FixedArray");
      return `FixedArray<${typeOf(elem, "elem")}, ${len}>`;
    }
    if (t.defined !== undefined) {
      const ref = typeof t.defined === "string" ? { name: t.defined } : t.defined;
      if ("generics" in ref && ref.generics?.length) throw new Unsupported(`generic type ${ref.name}`);
      return declare(ref.name);
    }
    throw new Unsupported("an unknown IDL type");
  };
  const isUnitEnum = (name: string) => typeDefs.get(name)?.type.kind === "enum";

  /** Emit `interface`/`enum` declarations for defined types (structs of fixed-layout fields, unit enums). */
  const declare = (name: string): string => {
    // TypeSOL's own IDLs describe FixedString<N> and account-data Options as structs with these names.
    const fs = /^FixedString(\d+)$/.exec(name);
    if (fs) {
      typeImports.add("FixedString");
      return `FixedString<${fs[1]}>`;
    }
    if (name.startsWith("FixedOption_")) {
      const fields = (typeDefs.get(name)?.type.fields ?? []) as IdlField[];
      const value = fields.find((f) => f.name === "value");
      if (!value) throw new Unsupported(`type ${name}`);
      typeImports.add("Option");
      return `Option<${typeOf(value.type, "elem")}>`;
    }
    if (name.startsWith("FixedEnum_")) throw new Unsupported(`data enum ${name.slice(10)} in a struct`);
    if (declarations.has(name)) return name;
    const def = typeDefs.get(name);
    if (!def) throw new Unsupported(`type ${name} missing from the IDL`);
    if (def.generics?.length) throw new Unsupported(`generic type ${name}`);
    if (def.type.kind === "enum") {
      const variants = def.type.variants ?? [];
      if (variants.some((v) => v.fields?.length)) throw new Unsupported(`enum ${name} carries data`);
      declarations.set(name, `export enum ${name} {\n${variants.map((v) => `  ${v.name},`).join("\n")}\n}`);
      return name;
    }
    if (def.type.kind !== "struct") throw new Unsupported(`${def.type.kind} type ${name}`);
    const fields = def.type.fields ?? [];
    if (fields.some((f) => typeof f !== "object" || !("name" in (f as object)))) throw new Unsupported(`tuple struct ${name}`);
    declarations.set(name, ""); // reserve (and stop cycles) while the fields resolve
    try {
      // Only the layout must match: rename fields TypeSOL reserves (key, length...) or C does not allow.
      const lines = (fields as IdlField[]).map((f) => `  ${fieldName(f.name)}: ${typeOf(f.type, "field")};`);
      declarations.set(name, `export interface ${name} {\n${lines.join("\n")}\n}`);
    } catch (e) {
      declarations.delete(name);
      throw e;
    }
    return name;
  };

  const functions: string[] = [];
  const generated: string[] = [];
  const skipped: CpiGenResult["skipped"] = [];
  for (const ix of idl.instructions) {
    try {
      // Parameter names must not shadow the imports the body calls.
      const used = new Set<string>(["program", "seeds", "invoke", "hex", "readonly", "writable", "readonlySigner", "writableSigner", "returnData"]);
      const unique = (base: string) => {
        let n = safe(camel(base));
        while (used.has(n)) n = `${n}_`;
        used.add(n);
        return n;
      };
      const params: string[] = [`program: Program<"${address}">`];
      const metas: string[] = [];
      const notes: string[] = [];
      const flatten = (items: IdlAccountItem[], path: string[]) => {
        for (const a of items) {
          if (a.accounts) {
            flatten(a.accounts, [...path, a.name]);
            continue;
          }
          const n = unique([...path, a.name].join("_"));
          // AccountMeta: any account kind of the caller fits (Signer, AccountInfo, Account<T>, TokenAccount, programs…).
          typeImports.add("AccountMeta");
          if (a.writable) typeImports.add("Mut");
          params.push(`${n}: ${a.writable ? "Mut<AccountMeta>" : "AccountMeta"}`);
          const fn = a.writable ? (a.signer ? "writableSigner" : "writable") : a.signer ? "readonlySigner" : "readonly";
          valueImports.add(fn);
          metas.push(`${fn}(${n})`);
          if (a.optional) notes.push(`${n} is optional in the IDL: pass the called program's account to leave it out.`);
        }
      };
      flatten(ix.accounts, []);
      const args = ix.args.map((a) => {
        const n = unique(a.name);
        params.push(`${n}: ${typeOf(a.type, "arg")}`);
        return n;
      });
      params.push("seeds: SignerSeeds");
      let returns = "void";
      if (ix.returns !== undefined) {
        const r = typeOf(ix.returns, "elem");
        if (!/^(u|i)\d+$|^boolean$|^Pubkey$/.test(r)) throw new Unsupported(`return type ${r}`);
        returns = r;
        valueImports.add("returnData");
      }
      const name = `${prefix}${pascal(ix.name)}`;
      const disc = Buffer.from(ix.discriminator).toString("hex");
      const doc = [...(ix.docs ?? []), `${programName}.${ix.name} through CPI.`, ...notes].map((l) => ` * ${l.replace(/\*\//g, "*\\/")}`).join("\n");
      functions.push(
        [
          `/**\n${doc}\n */`,
          `export function ${name}(${params.join(", ")}): ${returns} {`,
          `  invoke(program, [${metas.join(", ")}], [hex("${disc}")${args.map((a) => `, ${a}`).join("")}], seeds);`,
          ...(returns !== "void" ? [`  return returnData<${returns}>(program);`] : []),
          `}`,
        ].join("\n"),
      );
      generated.push(name);
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      skipped.push({ instruction: ix.name, reason: e.message });
    }
  }

  const imports = [...[...typeImports].sort().map((t) => `type ${t}`), ...[...valueImports].sort()];
  const header = [
    `// Generated by \`typesol cpi\` from the ${programName} IDL (${address}). Edit freely.`,
    ...(skipped.length ? [`// Left out (no Borsh-identical TypeSOL type): ${skipped.map((s) => `${s.instruction} (${s.reason})`).join("; ")}.`] : []),
    `import { ${imports.join(", ")} } from "typesol";`,
  ];
  const body = [...[...declarations.values()].filter(Boolean), ...functions];
  return { source: `${header.join("\n")}\n\n${body.join("\n\n")}\n`, generated, skipped };
}
