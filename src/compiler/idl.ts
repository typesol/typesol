import ts from "typescript";
import { snakeCase } from "./analyze.js";
import { decodeAddress } from "../keys.js";
import {
  type FieldType,
  type Instruction,
  type ParamKind,
  type ProgramModel,
  type ScalarType,
  type ValueType,
  fixedVecName,
  isWritable,
  optionKey,
  typeName,
} from "./model.js";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const BPF_UPGRADEABLE_LOADER = [
  2, 168, 246, 145, 78, 136, 161, 176, 226, 16, 21, 62, 247, 99, 174, 43, 0, 194, 185, 61, 22, 193, 36, 210, 192, 83, 122, 16, 4, 128, 0, 0,
];

/** JSDoc text of a declaration, as IDL `docs` lines (omitted when empty). */
function docsOf(node: ts.Node | undefined): { docs?: string[] } {
  if (!node) return {};
  const text = ts
    .getJSDocCommentsAndTags(node)
    .filter(ts.isJSDoc)
    .map((d) => (typeof d.comment === "string" ? d.comment : (ts.getTextOfJSDocComment(d.comment) ?? "")))
    .join("\n")
    .trim();
  return text ? { docs: text.split("\n").map((l) => l.trim()) } : {};
}

/** `@param name text` of a function parameter. */
function paramDocs(param: ts.ParameterDeclaration | ts.PropertySignature): { docs?: string[] } {
  // A group's field: its own doc comment.
  if (ts.isPropertySignature(param)) return docsOf(param);
  const text = ts
    .getJSDocParameterTags(param)
    .map((t) => (typeof t.comment === "string" ? t.comment : (ts.getTextOfJSDocComment(t.comment) ?? "")))
    .join("\n")
    .replace(/^[-\s]+/, "")
    .trim();
  return text ? { docs: text.split("\n").map((l) => l.trim()) } : {};
}

const fstringTypeName = (cap: number) => `FixedString${cap}`;
const fixedOptionName = (inner: ScalarType | { kind: "struct"; name: string }) => `FixedOption_${optionKey(inner)}`;
const fixedEnumName = (name: string) => `FixedEnum_${name}`;

/**
 * IDL type of a field or value. `borshOption` picks the encoding of Option: Borsh `option` for
 * instruction arguments and events, the fixed { is_some, value } struct for account data.
 */
/** IDL type of a @layout borsh account's field: Anchor's own (`string`, `{ vec }`, `{ option }`). */
function borshIdlType(t: FieldType): unknown {
  if (t.kind === "fstring") return "string";
  if (t.kind === "vec") return { vec: borshIdlType(t.elem) };
  if (t.kind === "option") return { option: idlType(t.inner) };
  // A data enum in a Borsh struct is the Borsh enum itself (tag, then the variant's fields).
  if (t.kind === "dataEnum") return { defined: { name: t.name } };
  return idlType(t);
}

function idlType(t: FieldType | ValueType, borshOption = false): unknown {
  switch (t.kind) {
    case "int":
      return t.name;
    case "bool":
      return "bool";
    case "pubkey":
      return t.hash ? { array: ["u8", 32] } : "pubkey";
    case "string":
      return "string";
    case "array":
      return { array: [idlType(t.elem), t.len] };
    case "struct":
      return { defined: { name: t.name } };
    case "fstring":
      return { defined: { name: fstringTypeName(t.cap) } };
    case "enum":
      return { defined: { name: t.name } };
    case "option":
      return borshOption ? { option: idlType(t.inner) } : { defined: { name: fixedOptionName(t.inner) } };
    case "dataEnum":
    case "dataEnumArg":
      // Borsh enum in arguments and events; fixed tag + payload in account data.
      return borshOption || t.kind === "dataEnumArg" ? { defined: { name: t.name } } : { defined: { name: fixedEnumName(t.name) } };
    case "vec":
      return t.cap === undefined ? { vec: idlType(t.elem) } : { defined: { name: fixedVecName(t) } };
    case "vecArg":
      return { vec: idlType(t.elem) };
    case "arrayArg":
      return idlType(t.array);
    case "structRef":
      return { defined: { name: t.struct } };
    default:
      throw new Error(`no IDL type for ${t.kind}`);
  }
}

/**
 * An account path as the IDL writes it from where it is used: a field of the same group by its own name (Anchor's
 * composite accounts), a field of another group as `<group>_<field>` (how clients flatten groups), else the name.
 */
function relativePath(path: string, from: string | undefined): string {
  const at = path.indexOf("__");
  if (at < 0) return path;
  const group = path.slice(0, at);
  return group === from ? path.slice(at + 2) : `${group}_${path.slice(at + 2)}`;
}

function relativeSeeds(seeds: unknown, from: string | undefined): unknown {
  if (!Array.isArray(seeds)) return seeds;
  return seeds.map((sd: { kind: string; path?: string }) => (sd.kind === "account" && sd.path ? { ...sd, path: relativePath(sd.path, from) } : sd));
}

function accountEntry(ix: Instruction, name: string, k: ParamKind, programAddress: string) {
  const param = ix.accounts.find((a) => a.name === name);
  const group = param?.group ? snakeCase(param.group.param) : undefined;
  const entry: Record<string, unknown> = { name: snakeCase(param?.group ? param.group.field : name), ...(param ? paramDocs(param.node) : {}) };
  if (isWritable(k)) entry.writable = true;
  if (param?.optional) entry.optional = true;
  if (k.kind === "signer" || param?.signsInit || param?.constraints.signed) entry.signer = true;
  if (k.kind === "system") entry.address = SYSTEM_PROGRAM;
  if (k.kind === "instructionsSysvar") entry.address = "Sysvar1nstructions1111111111111111111111111";
  if (k.kind === "ataProgram") entry.address = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
  if (k.kind === "memoProgram") entry.address = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
  if (k.kind === "stakeProgram") entry.address = "Stake11111111111111111111111111111111111111";
  if (k.kind === "slotHashes") entry.address = "SysvarS1otHashes111111111111111111111111111";
  if (k.kind === "metadataProgram") entry.address = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
  if (k.kind === "coreProgram") entry.address = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
  if (k.kind === "bubblegumProgram") entry.address = "BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY";
  if (k.kind === "tokenProgram" && k.flavor === "token") entry.address = TOKEN_PROGRAM;
  if (k.kind === "tokenProgram" && k.flavor === "token2022") entry.address = TOKEN_2022_PROGRAM;
  if (k.kind === "program" && k.address) entry.address = k.address.base58;
  // Anchor's direction: the account named by a has_one lists the accounts that hold it (Anchor clients then read
  // `holder.data[name]` to fill it in). Only struct accounts' HasOne are has_one relations in Anchor's sense.
  const holds = (a: Instruction["accounts"][number]) =>
    a.constraints.hasOne.some((f) => !f.includes("=") && (a.constraints.hasOneParams?.get(f) ?? f) === name);
  const relations = ix.accounts.filter((a) => a.kind.kind === "account" && holds(a)).map((a) => relativePath(snakeCase(a.name), group));
  if (relations.length) entry.relations = relations;
  const seeds = ix.pdas.get(name);
  const program = ix.pdaPrograms.get(name);
  if (seeds) {
    const own = relativeSeeds(seeds, group);
    entry.pda = program ? { seeds: own, program: (relativeSeeds([program], group) as unknown[])[0] } : { seeds: own };
  }
  const address = ix.accounts.find((a) => a.name === name)?.constraints.address;
  if (address) entry.address = address.base58;
  const programId = decodeAddress(programAddress);
  if (k.kind === "eventAuthority") entry.pda = { seeds: [{ kind: "const", value: [...Buffer.from("__event_authority")] }] };
  if (k.kind === "selfProgram") entry.address = programAddress;
  if (k.kind === "programData" && programId)
    entry.pda = { seeds: [{ kind: "const", value: [...programId] }], program: { kind: "const", value: BPF_UPGRADEABLE_LOADER } };
  return entry;
}

/** The instruction's account entries, an account group's fields nested under it: `{ name: "pool", accounts: [...] }`. */
function nestGroups(ix: Instruction, entry: (a: Instruction["accounts"][number]) => Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let open: { param: string; accounts: Record<string, unknown>[] } | undefined;
  for (const a of ix.accounts) {
    if (!a.group) {
      open = undefined;
      out.push(entry(a));
      continue;
    }
    if (open?.param !== a.group.param) {
      open = { param: a.group.param, accounts: [] };
      out.push({ name: snakeCase(a.group.param), accounts: open.accounts });
    }
    open.accounts.push(entry(a));
  }
  return out;
}

/** Anchor IDL (spec 0.1.0) so existing Anchor / Codama clients can talk to TypeSOL programs. */
export function buildIdl(model: ProgramModel, address: string, version = "0.1.0") {
  const structs = [...model.structs.values()];
  const usedStructs = structs.filter((s) => model.accountStructs.has(s.name) || model.events.has(s.name) || s.size !== undefined);
  const idl = {
    address,
    metadata: { name: model.name, version, spec: "0.1.0", description: "Built with TypeSOL" },
    instructions: model.instructions
      .filter((ix) => !ix.fallback)
      .map((ix) => ({
        name: ix.name,
        ...docsOf(ix.node),
        discriminator: ix.discriminator,
        accounts: nestGroups(ix, (a) => accountEntry(ix, a.name, a.kind, address)),
        args: ix.args.map((a) => ({ name: snakeCase(a.name), ...paramDocs(a.node), type: idlType(a.type, true) })),
        ...(ix.returns ? { returns: idlType(ix.returns) } : {}),
      })),
    accounts: structs.filter((s) => model.accountStructs.has(s.name)).map((s) => ({ name: s.name, discriminator: s.accountDiscriminator })),
    events: structs.filter((s) => model.events.has(s.name)).map((s) => ({ name: s.name, discriminator: s.eventDiscriminator })),
    errors: model.errors.map((e) => ({ code: e.code, name: e.name, msg: e.msg })),
    types: [
      ...usedStructs.map((s) => ({
        name: s.name,
        ...docsOf(s.node),
        type: {
          kind: "struct",
          fields: s.fields.map((f) => ({
            name: snakeCase(f.name),
            ...docsOf(s.node.members.find((m) => m.name && ts.isIdentifier(m.name) && m.name.text === f.name)),
            type: s.layout === "borsh" ? borshIdlType(f.type) : idlType(f.type, model.events.has(s.name) && !model.accountStructs.has(s.name)),
          })),
        },
      })),
      ...[...model.enums.values()].map((e) => ({ name: e.name, type: { kind: "enum", variants: e.variants.map((v) => ({ name: v })) } })),
      // A variable enum (it holds strings) only exists in Borsh: no fixed account-data form to describe.
      ...[...model.dataEnums.values()].flatMap((e) => [
        {
          name: e.name,
          ...docsOf(e.node),
          type: {
            kind: "enum",
            variants: e.variants.map((v) =>
              v.fields.length
                ? {
                    name: v.name,
                    // A nested variable enum only exists in Borsh; fixed fields keep the fixed forms the bytes use.
                    fields: v.fields.map((f) => ({
                      name: snakeCase(f.name),
                      type: f.type.kind === "dataEnum" && model.dataEnums.get(f.type.name)?.variable ? { defined: { name: f.type.name } } : idlType(f.type),
                    })),
                  }
                : { name: v.name },
            ),
          },
        },
        ...(e.variable
          ? []
          : [
              {
                name: fixedEnumName(e.name),
                docs: [
                  `TypeSOL ${e.name} in account data: \`tag\` is the variant index, \`payload\` the variant's fields (Borsh layout) padded to the largest variant.`,
                ],
                type: {
                  kind: "struct",
                  fields: [
                    { name: "tag", type: "u8" },
                    { name: "payload", type: { array: ["u8", e.payload] } },
                  ],
                },
              },
            ]),
      ]),
      ...[...model.options.values()].map((inner) => ({
        name: fixedOptionName(inner),
        docs: [`TypeSOL Option<${optionKey(inner)}> in account data: fixed size, \`value\` is zero when \`is_some\` is false.`],
        type: {
          kind: "struct",
          fields: [
            { name: "is_some", type: "bool" },
            { name: "value", type: idlType(inner) },
          ],
        },
      })),
      ...[...model.fixedVecs].map(([name, t]) => ({
        name,
        docs: [`TypeSOL FixedVec<${typeName(t.elem)}, ${t.cap}>: \`len\` elements in use, room for ${t.cap} (the rest zero or stale).`],
        type: {
          kind: "struct",
          fields: [
            { name: "len", type: "u32" },
            { name: "items", type: { array: [idlType(t.elem), t.cap] } },
          ],
        },
      })),
      ...[...model.fstrings]
        .sort((a, b) => a - b)
        .map((cap) => ({
          name: fstringTypeName(cap),
          docs: [`TypeSOL FixedString<${cap}>: UTF-8 bytes, \`len\` of them meaningful, zero-padded.`],
          type: {
            kind: "struct",
            fields: [
              { name: "len", type: "u32" },
              { name: "bytes", type: { array: ["u8", cap] } },
            ],
          },
        })),
    ],
  };
  // FixedString / FixedVec / FixedOption types only @layout borsh accounts declared (they list theirs as string / vec /
  // option) are left out.
  // FixedVecs first: a kept one may name a FixedString.
  for (const prefix of [/^FixedVec\d/, /^FixedOption_/, /^FixedString\d/]) {
    const text = JSON.stringify([idl.instructions, idl.types.filter((t) => !prefix.test(t.name))]);
    idl.types = idl.types.filter((t) => !prefix.test(t.name) || text.includes(`"name":"${t.name}"`));
  }
  return idl;
}
