/**
 * `typesol port <idl.json>`: a TypeSOL program skeleton from an Anchor IDL (0.30+/1.x), to port an Anchor program.
 *
 * It writes the account structs, enums, errors, events and one function per instruction with its accounts and
 * arguments, bodies left to fill in. Instructions keep their discriminators (an explicit `@discriminator` when the
 * name would derive another), account structs keep their names (so their discriminators), errors keep their order —
 * so existing clients keep working. Account structs holding a String, Vec or Option get `@layout borsh`, so they keep
 * Anchor's bytes (existing accounts stay readable); where a layout still differs (a String or Vec nested in a struct, a
 * data enum, a COption) it says so in a note and a comment.
 */
import { createHash } from "node:crypto";
import { cNameProblem } from "./compiler/analyze.js";

type IdlType =
  | string
  | { vec?: IdlType; option?: IdlType; coption?: IdlType; array?: [IdlType, number | unknown]; defined?: string | { name: string; generics?: unknown[] } };
interface IdlField {
  name: string;
  type: IdlType;
  docs?: string[];
}
interface IdlTypeDef {
  name: string;
  docs?: string[];
  type: { kind: string; fields?: (IdlField | IdlType)[]; variants?: { name: string; fields?: (IdlField | IdlType)[] }[] };
  generics?: unknown[];
}
interface IdlAccountItem {
  name: string;
  writable?: boolean;
  signer?: boolean;
  optional?: boolean;
  address?: string;
  docs?: string[];
  pda?: { seeds: { kind: string; value?: number[]; path?: string }[]; program?: unknown };
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
export interface PortIdl {
  address?: string;
  metadata?: { name?: string };
  instructions: IdlInstruction[];
  accounts?: { name: string; discriminator: number[] }[];
  events?: { name: string; discriminator: number[] }[];
  errors?: { code: number; name: string; msg?: string }[];
  types?: IdlTypeDef[];
  constants?: { name: string; type: IdlType; value: string }[];
}

export interface PortResult {
  source: string;
  /** What the skeleton cannot carry over as is, and where Anchor clients would see a different layout. */
  notes: string[];
}

const RESERVED = new Set(
  "break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await".split(
    " ",
  ),
);
const camel = (s: string) => s.replace(/[_-]+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase()).replace(/^[A-Z]/, (c) => c.toLowerCase());
const pascal = (s: string) => camel(s).replace(/^[a-z]/, (c) => c.toUpperCase());
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
/** Names TypeSOL source cannot use as written: TypeScript keywords, the generated C's reserved names, the builtins
 *  a skeleton imports, names starting with "_". */
const BUILTINS = new Set(["require"]); // what a skeleton imports as a value
/** A function, parameter or local name; `member`: a struct field or variant, which also becomes a C member name. */
const ident = (s: string, member = false) => {
  let n = camel(s).replace(/^_+/, "") || "value";
  if (/^\d/.test(n)) n = `v${n}`;
  while (RESERVED.has(n) || BUILTINS.has(n) || (member && cNameProblem(n))) n = `${n}Value`;
  return n;
};
/** A type name: kept as written when it is a valid one (account names decide account discriminators). */
const typeName = (s: string) => (/^[A-Za-z][A-Za-z0-9_]*$/.test(s) && !s.includes("__") && !RESERVED.has(s) ? s : pascal(s).replace(/^(\d)/, "T$1"));
const sighash = (preimage: string) => [...createHash("sha256").update(preimage).digest().subarray(0, 8)];
const sameBytes = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const INTS = new Set(["u8", "u16", "u32", "u64", "u128", "i8", "i16", "i32", "i64", "i128"]);
const PROGRAMS: Record<string, string> = {
  "11111111111111111111111111111111": "SystemProgram",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "TokenProgram",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token2022Program",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "AssociatedTokenProgram",
};

export function generatePort(idl: PortIdl): PortResult {
  const notes: string[] = [];
  const imports = new Set<string>();
  const use = (n: string) => (imports.add(n), n);
  const accountNames = new Set((idl.accounts ?? []).map((a) => a.name));
  const eventNames = new Set((idl.events ?? []).map((e) => e.name));
  const definedName = (d: string | { name: string }) => (typeof d === "string" ? d : d.name);
  const defs = new Map((idl.types ?? []).map((t) => [t.name, t]));
  // The fixed layouts a TypeSOL-built IDL spells out as helper types map back to TypeSOL's own types.
  const helperDefs = new Map((idl.types ?? []).filter((t) => /^(FixedString\d+|FixedOption_|FixedEnum_)/.test(t.name)).map((t) => [t.name, t]));
  const isTuple = (fields: unknown[] | undefined) =>
    !!fields?.length && (typeof fields[0] !== "object" || fields[0] === null || !("name" in (fields[0] as object)));
  // Types the skeleton cannot declare: references to them become a placeholder with a note.
  const skipped = new Set(
    (idl.types ?? [])
      .filter(
        (d) =>
          !helperDefs.has(d.name) &&
          (d.generics?.length || (d.type.kind === "struct" && isTuple(d.type.fields)) || (d.type.kind !== "struct" && d.type.kind !== "enum")),
      )
      .map((d) => d.name),
  );
  const dataEnum = (name: string) => defs.get(name)?.type.kind === "enum" && (defs.get(name)?.type.variants ?? []).some((v) => v.fields?.length);

  // Where each struct is used decides what a field can be: account data and struct arguments keep fixed layouts.
  const usage = new Map<string, Set<"account" | "arg" | "event">>();
  const mark = (t: IdlType | undefined, as: "account" | "arg" | "event") => {
    if (!t || typeof t === "string") return;
    const inner = t.vec ?? t.option ?? t.coption ?? t.array?.[0];
    if (inner) return mark(inner, as);
    if (!t.defined) return;
    const name = definedName(t.defined);
    const set = usage.get(name) ?? new Set();
    if (set.has(as)) return;
    usage.set(name, set.add(as));
    const def = defs.get(name);
    for (const f of (def?.type.fields ?? []) as IdlField[]) if (typeof f === "object" && f && "type" in f) mark(f.type, as);
    for (const v of def?.type.variants ?? [])
      for (const f of v.fields ?? []) mark(typeof f === "object" && f && "type" in (f as object) ? (f as IdlField).type : (f as IdlType), as);
  };
  for (const a of accountNames) mark({ defined: a }, "account");
  for (const e of eventNames) mark({ defined: e }, "event");
  for (const ix of idl.instructions) for (const g of ix.args) mark(g.type, "arg");

  /**
   * A TypeScript type for an IDL type. `where`: "account" (account data), "struct" (a struct argument: fixed layout
   * too), "arg" (a plain argument: Borsh, as Anchor), "event" (Borsh), "variant" (a data-enum field: fixed size).
   */
  type Where = "account" | "struct" | "arg" | "event" | "variant";
  const fixed = (w: Where) => w === "account" || w === "struct" || w === "variant";
  const describe = (w: Where) => (w === "account" ? "account data" : w === "struct" ? "a struct argument" : "a data-enum variant");
  const tsType = (t: IdlType, where: Where, at: string, last = false): string => {
    if (typeof t === "string") {
      if (INTS.has(t)) return use(t);
      if (t === "bool") return "boolean";
      if (t === "pubkey" || t === "publicKey") return use("Pubkey");
      if (t === "string") {
        if (!fixed(where)) return "string";
        notes.push(
          `${at}: Anchor encodes this String with its length (Borsh); TypeSOL holds FixedString<N> (u32 length + N bytes) in ${describe(where)}, so this layout differs. Set N.`,
        );
        return `${use("FixedString")}<32> /* TODO: capacity; Anchor has a variable String */`;
      }
      if (t === "bytes") return tsType({ vec: "u8" }, where, at, last);
      notes.push(`${at}: IDL type "${t}" has no TypeSOL equivalent; left as u64`);
      return `${use("u64")} /* TODO: ${t} */`;
    }
    if (t.array) {
      const n = Number(t.array[1]);
      if (!Number.isInteger(n) || n < 1) {
        notes.push(`${at}: an array of length ${JSON.stringify(t.array[1])}; set it`);
        return `${use("FixedArray")}<${tsType(t.array[0], where, at)}, 1> /* TODO: length */`;
      }
      return `${use("FixedArray")}<${tsType(t.array[0], where, at)}, ${n}>`;
    }
    if (t.coption) notes.push(`${at}: a COption (4-byte tag in Anchor); TypeSOL's Option has a 1-byte tag, so this layout differs.`);
    if (t.option || t.coption) {
      const inner = tsType((t.option ?? t.coption)!, where === "variant" ? "variant" : where, at);
      if (fixed(where))
        notes.push(`${at}: an Option in ${describe(where)} is fixed-size in TypeSOL (1 + size of T), Borsh (1, or 1 + size) in Anchor: the layout differs.`);
      return `${use("Option")}<${inner}>`;
    }
    if (t.vec) {
      const inner = tsType(t.vec, where, at);
      if (where === "variant" || where === "struct" || (where === "account" && !last)) {
        notes.push(`${at}: a Vec here (TypeSOL keeps a Vec only as an account's last field or as an argument); replaced by FixedArray, so the layout differs.`);
        return `${use("FixedArray")}<${inner}, 8> /* TODO: Anchor has a Vec here */`;
      }
      return `${use("Vec")}<${inner}>`;
    }
    if (t.defined) {
      const name = definedName(t.defined);
      const fs = /^FixedString(\d+)$/.exec(name);
      if (fs) return `${use("FixedString")}<${fs[1]}>`;
      const helper = helperDefs.get(name);
      if (helper && name.startsWith("FixedOption_")) {
        const value = ((helper.type.fields ?? []) as IdlField[]).find((f) => f.name === "value");
        if (value) return `${use("Option")}<${tsType(value.type, "arg", at)}>`;
      }
      if (name.startsWith("FixedEnum_")) return typeName(name.slice("FixedEnum_".length));
      if (skipped.has(name)) {
        notes.push(`${at}: ${name} could not be ported (generic, tuple or unsupported type); replaced by a placeholder`);
        return `${use("u8")} /* TODO: ${name} */`;
      }
      if ((where === "account" || where === "struct") && dataEnum(name))
        notes.push(`${at}: ${name} is a data enum: Anchor stores the variant's own size (Borsh), TypeSOL the largest variant's, so this layout differs.`);
      return typeName(name);
    }
    notes.push(`${at}: unsupported IDL type ${JSON.stringify(t)}; left as u64`);
    return `${use("u64")} /* TODO */`;
  };

  /** A String, Vec or Option at a struct's top level: Borsh-sized in Anchor. */
  const borshOnly = (t: IdlType) => t === "string" || t === "bytes" || (typeof t === "object" && (!!t.vec || !!t.option));
  /** A field's type in a `@layout borsh` struct, or undefined when that layout cannot hold it. Notes the capacities. */
  const borshField = (t: IdlType, at: string): string | undefined => {
    const quiet = at === "";
    const fixedOk = (u: IdlType): boolean => {
      if (typeof u === "string") return INTS.has(u) || u === "bool" || u === "pubkey" || u === "publicKey";
      if (u.array) return Number.isInteger(Number(u.array[1])) && fixedOk(u.array[0]);
      if (u.defined) {
        const name = definedName(u.defined);
        const d = defs.get(name);
        if (!d || skipped.has(name) || helperDefs.has(name)) return false;
        if (d.type.kind === "enum") return (d.type.variants ?? []).every((v) => !v.fields?.length);
        return ((d.type.fields ?? []) as IdlField[]).every((f) => fixedOk(f.type));
      }
      return false;
    };
    if (t === "string") {
      if (!quiet) notes.push(`${at}: set the String's capacity to Anchor's #[max_len] (Borsh bytes are kept: @layout borsh)`);
      return `${use("FixedString")}<32> /* TODO: #[max_len] */`;
    }
    if (t === "bytes") return borshField({ vec: "u8" }, at);
    if (typeof t === "object" && t.vec) {
      const elem =
        t.vec === "string"
          ? `${use("FixedString")}<32> /* TODO: #[max_len] */`
          : fixedOk(t.vec) && !quiet
            ? tsType(t.vec, "account", at)
            : fixedOk(t.vec)
              ? "x"
              : undefined;
      if (elem === undefined) return undefined;
      if (!quiet) notes.push(`${at}: set the Vec's capacity to Anchor's #[max_len] (Borsh bytes are kept: @layout borsh)`);
      return `${use("FixedVec")}<${elem}, 8> /* TODO: #[max_len] */`;
    }
    if (typeof t === "object" && t.option) {
      if (!fixedOk(t.option)) return undefined;
      return quiet ? "x" : `${use("Option")}<${tsType(t.option, "account", at)}>`;
    }
    if (!fixedOk(t)) return undefined;
    return quiet ? "x" : tsType(t, "account", at);
  };
  const esc = (s: string) => s.replace(/\*\//g, "* /");
  const docs = (lines: string[] | undefined, pad = "") => (lines?.length ? `${pad}/** ${esc(lines.join(" "))} */\n` : "");
  const out: string[] = [];

  // Constants: integer literals and strings; expressions are left to port by hand.
  for (const c of idl.constants ?? []) {
    const ty = typeof c.type === "string" && INTS.has(c.type) ? c.type : undefined;
    const name = /^[A-Za-z_][A-Za-z0-9_]*$/.test(c.name) ? c.name : ident(c.name);
    if (ty && /^-?\d[\d_]*$/.test(c.value.trim())) out.push(`export const ${name}: ${use(ty)} = ${c.value.trim().replace(/_/g, "")}n;`);
    else if (c.type === "string" && /^".*"$/.test(c.value.trim())) out.push(`export const ${name} = ${c.value.trim()};`);
    else notes.push(`constant ${c.name} = ${c.value}: not a literal; port it by hand`);
  }
  if (out.length) out.push("");

  // Types: structs (account data, events or arguments), enums.
  for (const def of idl.types ?? []) {
    if (helperDefs.has(def.name)) continue;
    if (skipped.has(def.name)) {
      notes.push(
        `type ${def.name}: ${def.generics?.length ? "generics are" : def.type.kind === "struct" ? "tuple structs are" : `kind "${def.type.kind}" is`} not supported; skipped`,
      );
      continue;
    }
    const used = usage.get(def.name) ?? new Set(["account" as const]);
    const where: Where = used.has("account") ? "account" : used.has("arg") ? "struct" : used.has("event") ? "event" : "account";
    if (def.type.kind === "struct") {
      const fields = (def.type.fields ?? []) as IdlField[];
      // An account struct with a String, Vec or Option of its own: `@layout borsh` keeps Anchor's bytes.
      const borsh =
        accountNames.has(def.name) && !isTuple(fields) && fields.some((f) => borshOnly(f.type)) && fields.every((f) => borshField(f.type, "") !== undefined);
      const tag = accountNames.has(def.name) ? " (account)" : eventNames.has(def.name) ? ` (event: emit<${typeName(def.name)}>({ … }))` : "";
      const doc = def.docs?.length ? esc(def.docs.join(" ")) : `${def.name}${tag}`;
      out.push(borsh ? `/**\n * ${doc}\n * @layout borsh\n */` : `/** ${doc} */`);
      out.push(`export interface ${typeName(def.name)} {`);
      const seen = new Set<string>();
      fields.forEach((f, i) => {
        let n = ident(f.name, true);
        while (seen.has(n)) n = `${n}2`;
        seen.add(n);
        const ty = borsh ? borshField(f.type, `${def.name}.${f.name}`)! : tsType(f.type, where, `${def.name}.${f.name}`, i === fields.length - 1);
        out.push(`${docs(f.docs, "  ")}  ${n}: ${ty};`);
      });
      out.push("}", "");
    } else {
      const variants = def.type.variants ?? [];
      if (variants.every((v) => !v.fields?.length)) {
        out.push(
          `${docs(def.docs)}export enum ${typeName(def.name)} {`,
          ...variants.map((v) => `  ${ident(v.name, true).replace(/^[a-z]/, (c) => c.toUpperCase())},`),
          "}",
          "",
        );
      } else {
        // Strings in variants are fine in arguments and events (Borsh); account data needs fixed-size variants.
        const vw: Where = used.has("account") || (!used.has("arg") && !used.has("event")) ? "variant" : "event";
        const parts = variants.map((v) => {
          const fs = (v.fields ?? []).map((f, i) =>
            typeof f === "object" && f !== null && "name" in f
              ? `${ident((f as IdlField).name, true)}: ${tsType((f as IdlField).type, vw, `${def.name}.${v.name}`)}`
              : `f${i}: ${tsType(f as IdlType, vw, `${def.name}.${v.name}`)}`,
          );
          return `{ kind: "${pascal(v.name)}"${fs.map((x) => `; ${x}`).join("")} }`;
        });
        out.push(`${docs(def.docs)}export type ${typeName(def.name)} =\n  | ${parts.join("\n  | ")};`, "");
      }
    }
  }

  // Errors: TypeSOL numbers them 6000 + their index. NotPorted, last, marks the instructions still to write, so the
  // codes of the program's own errors do not move.
  const errors = idl.errors ?? [];
  const program = typeName(pascal(idl.metadata?.name ?? "program"));
  const errorEnum = `${program}Error`;
  if (!errors.every((e, i) => e.code === 6000 + i))
    notes.push(
      `errors: TypeSOL numbers an error enum from 6000 in order; the IDL's codes (${errors.map((e) => e.code).join(", ")}) differ, so clients see other codes`,
    );
  const memberNames = new Set<string>();
  const member = (name: string) => {
    // RequireFailedN is TypeSOL's own name for require("message") errors; it is reserved in source.
    let n = /^RequireFailed\d+$/.test(name) ? name.replace("RequireFailed", "Check") : pascal(name);
    while (memberNames.has(n)) n += "_";
    memberNames.add(n);
    return n;
  };
  const errorLines = errors.map((e) => `  ${member(e.name)} = ${JSON.stringify(e.msg ?? e.name)},`);
  const notPorted = member("NotPorted");
  out.push(`export enum ${errorEnum} {`, ...errorLines, `  ${notPorted} = "This instruction is not ported yet",`, "}", "");

  // Accounts of an instruction, nested groups flattened.
  const flatten = (items: IdlAccountItem[], prefix = ""): IdlAccountItem[] =>
    items.flatMap((a) => (a.accounts ? flatten(a.accounts, `${prefix}${a.name}_`) : [{ ...a, name: `${prefix}${a.name}` }]));

  for (const ix of idl.instructions) {
    const fn = ident(ix.name);
    const params: string[] = [];
    const comments: string[] = [];
    const taken = new Set<string>();
    const unique = (n: string, kind: string) => {
      let m = n;
      while (taken.has(m)) m = `${m}${kind}`;
      if (m !== n) notes.push(`${ix.name}: ${kind.toLowerCase()} "${n}" renamed to "${m}" (an account and an argument share the name)`);
      taken.add(m);
      return m;
    };
    for (const a of flatten(ix.accounts)) {
      let ty: string;
      if (a.address && PROGRAMS[a.address]) ty = use(PROGRAMS[a.address]);
      else if (a.signer) ty = a.writable ? `${use("Mut")}<${use("Signer")}>` : use("Signer");
      else {
        // The IDL does not say which struct an account holds: AccountInfo until you pick Account<T> / Mut<T> / Init<T>.
        const base = a.writable ? `${use("Mut")}<${use("AccountInfo")}>` : use("AccountInfo");
        ty = a.address ? `${use("Address")}<${base}, "${a.address}">` : base;
      }
      if (a.optional) ty = `${ty} | null`;
      params.push(`${unique(ident(a.name), "Account")}: ${ty}`);
      if (a.pda) {
        const seeds = a.pda.seeds.map((s) =>
          s.kind === "const"
            ? JSON.stringify(Buffer.from(s.value ?? []).toString("utf8"))
            : s.kind === "arg"
              ? `@${camel(s.path ?? "")} (argument)`
              : `@${camel(s.path ?? "")}`,
        );
        comments.push(`${ident(a.name)}: PDA [${seeds.join(", ")}]`);
      }
      if (a.relations?.length) comments.push(`${ident(a.name)}: has_one ${a.relations.map(camel).join(", ")}`);
    }
    for (const g of ix.args) params.push(`${unique(ident(g.name), "Arg")}: ${tsType(g.type, "arg", `${ix.name}(${g.name})`)}`);

    let ret = "void";
    let body = `  ${use("require")}(false, ${errorEnum}.${notPorted}); // TODO: port ${ix.name}`;
    if (ix.returns) {
      const r = typeof ix.returns === "string" ? ix.returns : undefined;
      if (r && INTS.has(r)) ((ret = use(r)), (body += "\n  return 0n;"));
      else if (r === "bool") ((ret = "boolean"), (body += "\n  return false;"));
      else notes.push(`${ix.name}: returns ${JSON.stringify(ix.returns)}; set the return type and value`);
    }
    const derived = sighash(`global:${snake(fn)}`);
    const tags = sameBytes(derived, ix.discriminator) ? [] : [`@discriminator 0x${Buffer.from(ix.discriminator).toString("hex")}`];
    const doc = [...(ix.docs ?? []), ...comments.map((c) => `- ${c}`), ...tags];
    if (doc.length) out.push(`/**\n${doc.map((l) => ` * ${esc(l)}`).join("\n")}\n */`);
    out.push(`export function ${fn}(${params.join(", ")}): ${ret} {`, body, "}", "");
  }

  for (const a of idl.accounts ?? []) {
    if (!sameBytes(sighash(`account:${a.name}`), a.discriminator))
      notes.push(`account ${a.name}: its discriminator is not sha256("account:${a.name}"); TypeSOL derives that one, so existing accounts would not load`);
  }

  const header = [
    `// Ported from the ${idl.metadata?.name ?? "program"} IDL by \`typesol port\`. Fill in the instruction bodies;`,
    "// pick Account<T> / Mut<T> / Init<T> for the AccountInfo parameters that hold one of the structs below.",
    `import { ${[
      ...[...imports]
        .filter((n) => n !== "require")
        .sort()
        .map((n) => `type ${n}`),
      ...(imports.has("require") ? ["require"] : []),
    ].join(", ")} } from "typesol";`,
    "",
  ];
  return { source: [...header, ...out].join("\n").replace(/\n{3,}/g, "\n\n"), notes };
}
