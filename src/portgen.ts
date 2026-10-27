/**
 * `typesol port <idl.json>`: a TypeSOL program skeleton from an Anchor IDL (0.30+/1.x), to port an Anchor program.
 *
 * It writes the account structs, enums, errors, events and one function per instruction with its accounts and
 * arguments, bodies left to fill in. Instructions keep their discriminators (an explicit `@discriminator` when the
 * name would derive another), account structs keep their names (so their discriminators), errors keep their order —
 * so existing clients keep working when the layout allows it. Where TypeSOL stores data differently from Anchor's Borsh
 * layout (String, Option and a Vec that is not the last field in account data), it says so in a note and a comment.
 */
import { createHash } from "node:crypto";

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
const ident = (s: string) => (RESERVED.has(camel(s)) ? `${camel(s)}_` : camel(s));
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
  // The fixed layouts a TypeSOL-built IDL spells out as helper types map back to TypeSOL's own types.
  const helperDefs = new Map((idl.types ?? []).filter((t) => /^(FixedString\d+|FixedOption_|FixedEnum_)/.test(t.name)).map((t) => [t.name, t]));

  /** A TypeScript type for an IDL type. `where` is "account" (account data) or "arg" (Borsh, as Anchor). */
  const tsType = (t: IdlType, where: "account" | "arg" | "event", at: string, last = false): string => {
    if (typeof t === "string") {
      if (INTS.has(t)) return use(t);
      if (t === "bool") return "boolean";
      if (t === "pubkey" || t === "publicKey") return use("Pubkey");
      if (t === "string") {
        if (where !== "account") return "string";
        notes.push(
          `${at}: a Borsh String in Anchor; TypeSOL account data holds FixedString<N> (u32 length + N bytes). Set N; the layout differs from the Anchor account.`,
        );
        return `${use("FixedString")}<32> /* TODO: capacity; Anchor stores a variable String */`;
      }
      if (t === "bytes") return where === "arg" ? `${use("Vec")}<${use("u8")}>` : `${use("Vec")}<${use("u8")}>`;
      notes.push(`${at}: IDL type "${t}" has no TypeSOL equivalent; left as u64`);
      return `${use("u64")} /* TODO: ${t} */`;
    }
    if (t.array) return `${use("FixedArray")}<${tsType(t.array[0], where, at)}, ${Number(t.array[1])}>`;
    if (t.option || t.coption) {
      const inner = tsType((t.option ?? t.coption)!, where, at);
      if (where === "account")
        notes.push(`${at}: Option in account data is fixed-size in TypeSOL (1 + size of T), Borsh (1, or 1 + size) in Anchor: the layout differs.`);
      return `${use("Option")}<${inner}>`;
    }
    if (t.vec) {
      const inner = tsType(t.vec, where, at);
      if (where === "account" && !last) {
        notes.push(
          `${at}: a Vec that is not the last field; TypeSOL keeps a Vec only as an account's last field. Move it last (the layout then differs) or use FixedArray.`,
        );
        return `${use("FixedArray")}<${inner}, 8> /* TODO: Anchor stores a Vec here */`;
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
      if (name.startsWith("FixedEnum_")) return pascal(name.slice("FixedEnum_".length));
      return pascal(name);
    }
    notes.push(`${at}: unsupported IDL type ${JSON.stringify(t)}; left as u64`);
    return `${use("u64")} /* TODO */`;
  };

  const docs = (lines: string[] | undefined, pad = "") => (lines?.length ? `${pad}/** ${lines.join(" ").replace(/\*\//g, "* /")} */\n` : "");
  const out: string[] = [];

  // Constants.
  for (const c of idl.constants ?? []) {
    const ty = typeof c.type === "string" && INTS.has(c.type) ? c.type : undefined;
    if (ty) out.push(`export const ${c.name}: ${use(ty)} = ${c.value.replace(/_/g, "")}n;`);
    else if (c.type === "string") out.push(`export const ${c.name} = ${c.value};`);
    else notes.push(`constant ${c.name}: ${JSON.stringify(c.type)} not carried over`);
  }
  if (out.length) out.push("");

  // Types: structs (account data, events or nested), enums.
  for (const def of idl.types ?? []) {
    if (helperDefs.has(def.name)) continue;
    if (def.generics?.length) {
      notes.push(`type ${def.name}: generics are not supported; skipped`);
      continue;
    }
    const where = eventNames.has(def.name) ? "event" : "account";
    if (def.type.kind === "struct") {
      const fields = (def.type.fields ?? []) as IdlField[];
      if (fields.length && typeof fields[0] !== "object") {
        notes.push(`type ${def.name}: tuple structs are not supported; skipped`);
        continue;
      }
      const tag = accountNames.has(def.name) ? " (account)" : eventNames.has(def.name) ? " (event: emit<" + pascal(def.name) + ">({ … }))" : "";
      out.push(docs(def.docs).trimEnd() || `/** ${def.name}${tag} */`);
      out.push(`export interface ${pascal(def.name)} {`);
      fields.forEach((f, i) =>
        out.push(`${docs(f.docs, "  ")}  ${ident(f.name)}: ${tsType(f.type, where, `${def.name}.${f.name}`, i === fields.length - 1)};`),
      );
      out.push("}", "");
    } else if (def.type.kind === "enum") {
      const variants = def.type.variants ?? [];
      if (variants.every((v) => !v.fields?.length)) {
        out.push(`${docs(def.docs)}export enum ${pascal(def.name)} {`, ...variants.map((v) => `  ${pascal(v.name)},`), "}", "");
      } else {
        const parts = variants.map((v) => {
          const fs = (v.fields ?? []).map((f, i) =>
            typeof f === "object" && f !== null && "name" in f
              ? `${ident((f as IdlField).name)}: ${tsType((f as IdlField).type, "arg", `${def.name}.${v.name}`)}`
              : `_${i}: ${tsType(f as IdlType, "arg", `${def.name}.${v.name}`)}`,
          );
          return `{ kind: "${pascal(v.name)}"${fs.map((x) => `; ${x}`).join("")} }`;
        });
        out.push(`${docs(def.docs)}export type ${pascal(def.name)} =\n  | ${parts.join("\n  | ")};`, "");
      }
    } else notes.push(`type ${def.name}: kind "${def.type.kind}" is not supported; skipped`);
  }

  // Errors: TypeSOL numbers them 6000 + their index. NotPorted, last, marks the instructions still to write, so the
  // codes of the program's own errors do not move.
  const errors = idl.errors ?? [];
  const program = pascal(idl.metadata?.name ?? "program");
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
      params.push(`${ident(a.name)}: ${ty}`);
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
    for (const g of ix.args) params.push(`${ident(g.name)}: ${tsType(g.type, "arg", `${ix.name}(${g.name})`)}`);

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
    if (doc.length) out.push(`/**\n${doc.map((l) => ` * ${l}`).join("\n")}\n */`);
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
