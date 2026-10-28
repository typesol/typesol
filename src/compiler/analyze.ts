import ts from "typescript";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CompileError, Reporter, type Diagnostic } from "./diagnostics.js";
import { decodeAddress } from "../keys.js";
import { borshIdentical } from "./emit/borsh.js";
import {
  optionKey,
  INT_INFO,
  INT_NAMES,
  scalarKey,
  type AccountParam,
  type ArgParam,
  type ConstDef,
  type DataEnumDef,
  type Constraints,
  type EnumDef,
  type ErrorDef,
  type FieldType,
  type GenericHelper,
  fixedVecName,
  type Helper,
  type HelperNode,
  type Instruction,
  type IntName,
  type ParamKind,
  type ProgramModel,
  type ScalarType,
  type StructDef,
  type StructField,
  type ValueType,
  isScalar,
  scalarSize,
  typeName,
} from "./model.js";

export const LIB_PATH = fileURLToPath(new URL("../../lib/typesol.d.ts", import.meta.url));

/** Names a struct field may not use because account parameters already expose them. */
const RESERVED_FIELDS = new Set(["key", "lamports", "dataLen", "create", "equals", "get", "set", "length", "isSigner", "isWritable", "pdaBump"]);

/**
 * Struct fields and enum variants become C member names as written. C keywords and the object-like
 * macros of the Solana C SDK / TypeSOL runtime would break or silently change the generated C.
 */
const C_RESERVED = new Set([
  ..."auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while bool true false asm typeof".split(
    " ",
  ),
  ..."NULL SUCCESS HEAP_LENGTH HEAP_START_ADDRESS MAX_PERMITTED_DATA_INCREASE MAX_RETURN_DATA MAX_SEED_LENGTH_EXCEEDED INVALID_SEEDS SIZE_PUBKEY memcpy memset strlen static_assert offsetof sol_log_64".split(
    " ",
  ),
]);

/** Why a name cannot be used as a C member, or undefined when it can. */
export function cNameProblem(name: string): string | undefined {
  if (name.includes("__") || name.startsWith("_")) return `"${name}": names starting with "_" or containing "__" are reserved for generated code`;
  if (name.includes("$")) return `"${name}": "$" is not allowed in names`;
  if (C_RESERVED.has(name) || /^(_[A-Z]|ERROR_|TS_|INT\d|UINT\d|ALT_BN128_|SECP256K1_|POSEIDON_|SHA256_|KECCAK_|BLAKE3_)/.test(name))
    return `"${name}" is reserved in the generated C; pick another name`;
  return undefined;
}

/** Report names that differ in TypeScript but meet in snake_case (the IDL and Anchor clients use snake_case). */
function checkSnakeDuplicates(names: { name: string; node: ts.Node }[], what: string, reporter: Reporter) {
  const seen = new Map<string, string>();
  for (const n of names) {
    const snake = snakeCase(n.name);
    const prev = seen.get(snake);
    if (prev !== undefined) reporter.error(n.node, `${what} "${n.name}" and "${prev}" are both "${snake}" in the IDL; rename one`);
    else seen.set(snake, n.name);
  }
}

/** Exports of the `typesol` module that are types (everything else is a function). */
const TYPE_EXPORTS = new Set([
  ...INT_NAMES,
  "Pubkey",
  "AccountMeta",
  "Signer",
  "AccountInfo",
  "Account",
  "Mut",
  "Init",
  "Seed",
  "TokenAccount",
  "Mint",
  "SystemProgram",
  "TokenProgram",
  "Token2022Program",
  "TokenInterface",
  "FixedArray",
  "FixedString",
  "FixedVec",
  "Program",
  "UncheckedProgram",
  "CpiAccount",
  "CpiData",
  "Bytes",
  "Option",
  "Vec",
  "Zeroed",
  "RemainingAccounts",
  "RemainingAccount",
  "Hash",
  "InstructionsSysvar",
  "InitIfNeeded",
  "PythPriceUpdate",
  "AssociatedTokenProgram",
  "TokenMetadataProgram",
  "SwitchboardFeed",
  "HasOne",
  "Seeds",
  "CloseTo",
  "Address",
  "Ata",
  "Owner",
  "Executable",
  "Optional",
  "EventAuthority",
  "MplCoreProgram",
  "BubblegumProgram",
  "SelfProgram",
  "ProgramData",
  "SignerSeeds",
  "SystemAccount",
]);

/** Largest fixed array a struct may declare, and largest FixedString. */
const MAX_ARRAY_LEN = 1_000_000;
const MAX_STRING_CAP = 10_240;
/** Solana's account size limit, and what a program can allocate itself through a CPI (Init<T>). */
export const MAX_ACCOUNT_SIZE = 10 * 1024 * 1024;
/** sol_set_return_data's limit. */
export const MAX_RETURN_DATA = 1024;
export const MAX_CPI_ALLOCATION = 10 * 1024;

export interface Analysis {
  model: ProgramModel;
  /** A generic helper's instance for these type arguments (analyzed once, then kept in `model.helpers`). */
  instantiate(g: GenericHelper, typeArgs: TypeArg[], fnArgs?: string[]): Helper;
  /** TypeScript's checker: used for narrowing (which variant a data-enum value is in a branch). */
  checker: ts.TypeChecker;
  sourceFile: ts.SourceFile;
  /** Every TypeSOL file of the program, entry last. */
  files: string[];
  /** Local identifier -> `typesol` export name, for imports. */
  imports: Map<string, string>;
  reporter: Reporter;
}

/** What a generic helper's type parameter stands for: a scalar, or a fixed-size struct. */
export type TypeArg = ScalarType | { kind: "struct"; name: string };

/** A struct named by a type reference, through the type parameters of a generic helper's instance. */
export function structNameOf(node: ts.TypeNode, scope: Pick<TypeScope, "structArgs">): string | undefined {
  if (!ts.isTypeReferenceNode(node) || !ts.isIdentifier(node.typeName) || node.typeArguments?.length) return undefined;
  return scope.structArgs?.get(node.typeName.text) ?? node.typeName.text;
}

/** What type resolution needs: imports, unit enums, and where to record Option<T> uses. */
export interface TypeScope {
  imports: Map<string, string>;
  /** Inside a generic helper's instance: type parameter -> the type it stands for. */
  typeArgs?: Map<string, ScalarType>;
  /** Inside a generic helper's instance: type parameter -> the struct it stands for. */
  structArgs?: Map<string, string>;
  enums: Map<string, EnumDef>;
  dataEnums?: Map<string, DataEnumDef>;
  options: Map<string, ScalarType | { kind: "struct"; name: string }>;
}

export function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

export function discriminator(preimage: string): number[] {
  return [...createHash("sha256").update(preimage).digest().subarray(0, 8)];
}

/** Run the TypeScript checker over the entry file with `typesol` mapped to our declarations. */
function typecheck(entry: string): { program: ts.Program; sourceFile: ts.SourceFile } {
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
    lib: ["lib.es2022.d.ts"],
    paths: { typesol: [LIB_PATH] },
    skipLibCheck: true,
  };
  const program = ts.createProgram([entry], options);
  const sourceFile = program.getSourceFile(entry);
  if (!sourceFile) throw new CompileError([{ file: entry, line: 1, column: 1, message: "cannot read source file" }]);

  // Every TypeSOL source in the program (the entry and the files it imports), not lib declarations.
  const userFiles = program.getSourceFiles().filter((f) => !f.isDeclarationFile && path.resolve(f.fileName) !== LIB_PATH);
  const tsDiagnostics = userFiles.flatMap((f) => ts.getPreEmitDiagnostics(program, f));
  if (tsDiagnostics.length > 0) {
    const diagnostics: Diagnostic[] = tsDiagnostics.map((d) => {
      const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
      if (!d.file || d.start === undefined) return { file: entry, line: 1, column: 1, message };
      const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
      return { file: d.file.fileName, line: line + 1, column: character + 1, message };
    });
    throw new CompileError(diagnostics);
  }
  return { program, sourceFile };
}

const isRelative = (spec: string) => spec.startsWith("./") || spec.startsWith("../");

/** Resolve a relative import to a `.ts` file next to `from`, or undefined. */
export function resolveRelative(from: string, spec: string): string | undefined {
  const base = path.resolve(path.dirname(from), spec.replace(/\.js$/, ""));
  for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
    if (candidate.endsWith(".ts") && ts.sys.fileExists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Reject foreign imports before typechecking so the user sees why, not "cannot find module".
 * Follows relative imports so every file of the program is checked.
 */
function checkImports(entry: string): void {
  const reporter: Reporter = new Reporter();
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = ts.sys.readFile(file);
    if (text === undefined) throw new CompileError([{ file, line: 1, column: 1, message: "cannot read source file" }]);
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) || (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier)) {
        const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
        if (spec === "typesol") continue;
        if (!isRelative(spec)) {
          reporter.error(stmt, `only imports from "typesol" and relative TypeSOL files ("./math") are allowed, got "${spec}"`);
          continue;
        }
        const target = resolveRelative(file, spec);
        if (!target) reporter.error(stmt, `cannot find "${spec}" (looked for ${spec}.ts and ${spec}/index.ts)`);
        else visit(target);
      }
    }
  };
  visit(entry);
  reporter.throwIfAny();
}

/** Program files in dependency order: imported files before the files that import them, entry last. */
function programFiles(program: ts.Program, entry: string): ts.SourceFile[] {
  const order: ts.SourceFile[] = [];
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const sf = program.getSourceFile(file)!;
    for (const stmt of sf.statements)
      if (ts.isImportDeclaration(stmt)) {
        const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
        if (isRelative(spec)) visit(resolveRelative(file, spec)!);
      }
    order.push(sf);
  };
  visit(entry);
  return order;
}

export function analyze(entry: string): Analysis {
  const entryPath = path.resolve(entry);
  checkImports(entryPath);
  const { program, sourceFile } = typecheck(entryPath);
  const reporter: Reporter = new Reporter();
  const errorEnums = new Map<string, Map<string, ErrorDef>>();
  const enums = new Map<string, EnumDef>();
  const options = new Map<string, ScalarType | { kind: "struct"; name: string }>();
  const dataEnums = new Map<string, DataEnumDef>();
  const constants = new Map<string, ConstDef>();
  const pendingConstTypes: { def: ConstDef; type: ts.TypeNode; imports: Map<string, string> }[] = [];
  const errors: ErrorDef[] = [];
  const functions: { node: ts.FunctionDeclaration; imports: Map<string, string> }[] = [];
  const helperNodes: HelperSource[] = [];
  const interfaces: { decl: ts.InterfaceDeclaration; imports: Map<string, string> }[] = [];
  const aliases: { decl: ts.TypeAliasDeclaration; imports: Map<string, string> }[] = [];
  /** Program-wide names (structs, enums, helpers) -> declaring file, for collision errors. */
  const declared = new Map<string, string>();
  let entryImports = new Map<string, string>();

  const isExported = (n: ts.Node) => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const declare = (name: ts.Identifier, file: ts.SourceFile) => {
    // These prefixes name the IDL types TypeSOL generates for FixedString<N>, Option and data enums in account data.
    if (/^(FixedString\d|FixedVec\d|FixedOption_|FixedEnum_)/.test(name.text))
      reporter.fail(name, `"${name.text}" is reserved for IDL types TypeSOL generates; pick another name`);
    const prev = declared.get(name.text);
    if (prev) reporter.fail(name, `"${name.text}" is already declared in ${path.basename(prev)}; names are program-wide`);
    declared.set(name.text, file.fileName);
  };

  for (const file of programFiles(program, entryPath)) {
    const isEntry = file === sourceFile;
    const imports = new Map<string, string>();
    if (isEntry) entryImports = imports;
    for (const stmt of file.statements) {
      reporter.guard(() => {
        if (ts.isImportDeclaration(stmt)) {
          const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
          const bindings = stmt.importClause?.namedBindings;
          if (!bindings || !ts.isNamedImports(bindings) || stmt.importClause?.name) reporter.fail(stmt, `use named imports: import { ... } from "${spec}"`);
          if (spec === "typesol") {
            for (const el of bindings.elements) imports.set(el.name.text, (el.propertyName ?? el.name).text);
          } else {
            // Structs, enums and helpers share one program-wide namespace in the generated C, so keep names.
            for (const el of bindings.elements)
              if (el.propertyName) reporter.fail(el, `renaming imports from TypeSOL files is not supported; import ${el.propertyName.text} as is`);
          }
        } else if (ts.isInterfaceDeclaration(stmt)) {
          if (!isExported(stmt)) reporter.fail(stmt, "structs must be exported");
          declare(stmt.name, file);
          interfaces.push({ decl: stmt, imports });
        } else if (ts.isTypeAliasDeclaration(stmt)) {
          if (!isExported(stmt)) reporter.fail(stmt, "data enums (type X = { kind: ... } | ...) must be exported");
          declare(stmt.name, file);
          aliases.push({ decl: stmt, imports });
        } else if (ts.isEnumDeclaration(stmt)) {
          if (!isExported(stmt)) reporter.fail(stmt, "enums must be exported");
          declare(stmt.name, file);
          const isError = stmt.members.some((m) => m.initializer && ts.isStringLiteral(m.initializer));
          if (isError) {
            // String enum: program errors, codes 6000+ in declaration order (imported files first).
            const members = new Map<string, ErrorDef>();
            for (const m of stmt.members) {
              if (!m.initializer || !ts.isStringLiteral(m.initializer)) reporter.fail(m, 'error enum members need a string message: Name = "message"');
              const def = { code: 6000 + errors.length, name: m.name.getText(file), msg: m.initializer.text };
              // Names identify errors in the IDL: they must be unique across the program.
              if (errors.some((e) => e.name === def.name)) reporter.fail(m, `error "${def.name}" is already declared; error names are program-wide`);
              if (/^RequireFailed\d+$/.test(def.name)) reporter.fail(m, `"${def.name}" is reserved for require("...") messages`);
              errors.push(def);
              members.set(def.name, def);
            }
            errorEnums.set(stmt.name.text, members);
          } else {
            // Unit-variant value enum: stored as its u8 variant index, like Borsh.
            const variants: string[] = [];
            stmt.members.forEach((m, i) => {
              if (m.initializer && !(ts.isNumericLiteral(m.initializer) && Number(m.initializer.text) === i))
                reporter.fail(m, "value enum members are numbered 0, 1, 2… in order; leave out initializers");
              variants.push(m.name.getText(file));
            });
            if (variants.length === 0 || variants.length > 256) reporter.fail(stmt, "enums need 1..256 variants");
            enums.set(stmt.name.text, { name: stmt.name.text, variants });
          }
        } else if (ts.isFunctionDeclaration(stmt)) {
          // Exported functions of the entry file are instructions; everything else is a helper.
          if (isEntry && isExported(stmt)) {
            // Instructions share the program-wide namespace too, so a helper cannot shadow one.
            if (stmt.name) declare(stmt.name, file);
            functions.push({ node: stmt, imports });
          } else {
            if (stmt.name) declare(stmt.name, file);
            if (stmt.name) helperNodes.push({ node: stmt, name: stmt.name.text, display: stmt.name.text, decl: stmt, imports });
          }
        } else if (ts.isVariableStatement(stmt)) {
          // Top-level compile-time constants: const NAME = 4n / true / "seed"
          if (!(stmt.declarationList.flags & ts.NodeFlags.Const)) reporter.fail(stmt, "top-level variables must be const literals");
          for (const d of stmt.declarationList.declarations) {
            if (!ts.isIdentifier(d.name) || !d.initializer) reporter.fail(d, "declare const NAME = literal");
            const init = d.initializer;
            // `const f = (…): T => …` / `const f = function (…) {…}`: a helper.
            if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
              if (isEntry && isExported(stmt)) reporter.fail(d.name, "instructions are function declarations: export function name(…)");
              declare(d.name, file);
              helperNodes.push({ node: init, name: d.name.text, display: d.name.text, decl: d, imports });
              continue;
            }
            let value: ConstDef["value"];
            if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && imports.get(init.expression.text) === "pubkey") {
              const arg = init.arguments[0];
              if (init.arguments.length !== 1 || !ts.isStringLiteral(arg)) reporter.fail(init, 'pubkey("…") takes one base58 string literal');
              const bytes = decodeAddress(arg.text);
              if (!bytes) reporter.fail(arg, `"${arg.text}" is not a valid base58 Solana address`);
              value = { pubkey: [...bytes] };
            } else if (ts.isBigIntLiteral(init)) value = BigInt(init.text.slice(0, -1).replace(/_/g, ""));
            else if (ts.isPrefixUnaryExpression(init) && init.operator === ts.SyntaxKind.MinusToken && ts.isBigIntLiteral(init.operand))
              value = -BigInt(init.operand.text.slice(0, -1).replace(/_/g, ""));
            else if (init.kind === ts.SyntaxKind.TrueKeyword || init.kind === ts.SyntaxKind.FalseKeyword) value = init.kind === ts.SyntaxKind.TrueKeyword;
            else if (ts.isStringLiteral(init)) value = init.text;
            else reporter.fail(init, 'top-level constants must be bigint, boolean or string literals, or pubkey("…")');
            declare(d.name, file);
            const def: ConstDef = { name: d.name.text, value };
            constants.set(def.name, def);
            if (d.type) pendingConstTypes.push({ def, type: d.type, imports });
          }
        } else {
          reporter.fail(stmt, `${ts.SyntaxKind[stmt.kind]} is not supported at the top level of a TypeSOL file`);
        }
      });
    }
  }

  const fstrings = new Set<number>();
  const fixedVecs = new Map<string, FieldType & { kind: "vec" }>();
  const scopeFor = (imports: Map<string, string>): TypeScope => ({ imports, enums, options, dataEnums });
  for (const c of pendingConstTypes) {
    reporter.guard(() => {
      const t = resolveScalarType(c.type, scopeFor(c.imports));
      if (!t || t.kind !== "int") reporter.fail(c.type, "annotate constants with an integer type, or leave the type out");
      if (typeof c.def.value !== "bigint") reporter.fail(c.type, "only integer constants take a type annotation");
      const info = INT_INFO[t.name];
      if (c.def.value < info.min || c.def.value > info.max) reporter.fail(c.type, `${c.def.value} does not fit in ${t.name}`);
      c.def.type = t;
    });
  }
  const structs = analyzeStructs(interfaces, aliases, dataEnums, reporter, scopeFor, fstrings, fixedVecs);

  const checker = program.getTypeChecker();
  // Local `const f = (…) => …` in any function body (and in those local functions): lifted to helpers.
  const locals: HelperSource[] = [];
  const taken = new Set<string>();
  const collectLocals = (body: ts.Node, outer: string, imports: Map<string, string>, fn: HelperNode) => {
    const generic = !!fn.typeParameters?.length;
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
        reporter.guard(() => {
          if (!ts.isIdentifier(n.name)) reporter.fail(n.name, "name local functions: const f = (…) => …");
          if (generic) reporter.fail(n, "local functions inside a generic helper are not supported; declare this one at the top level");
          if (!(n.parent.flags & ts.NodeFlags.Const) || !ts.isVariableStatement(n.parent.parent))
            reporter.fail(n, "declare local functions with const: const f = (…) => …");
          if (n.name.text.includes("__") || n.name.text.includes("$")) reporter.fail(n.name, `"${n.name.text}": "__" and "$" are reserved in names`);
          let name = `${outer}__${n.name.text}`;
          for (let i = 2; taken.has(name); i++) name = `${outer}__${n.name.text}__${i}`;
          taken.add(name);
          const src: HelperSource = { node: n.initializer as ts.ArrowFunction, name, display: n.name.text, decl: n, imports, outer: fn };
          locals.push(src);
          if (src.node.body) collectLocals(src.node.body, name, imports, src.node);
        });
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
  };
  for (const f of functions) if (f.node.body && f.node.name) collectLocals(f.node.body, f.node.name.text, f.imports, f.node);
  for (const h of [...helperNodes]) if (h.node.body) collectLocals(h.node.body, h.name, h.imports, h.node);
  const localDecls = new Set(locals.map((l) => l.decl));
  // A local function that reads the enclosing function's variables (or calls one that does) is a closure: it is
  // expanded where it is called, in the enclosing function. The others become helpers of their own.
  const inline = new Set(locals.filter((l) => captures(l, localDecls, checker)).map((l) => l.decl));
  for (let changed = true; changed;) {
    changed = false;
    for (const l of locals)
      if (!inline.has(l.decl) && references(l, inline, checker)) {
        inline.add(l.decl);
        changed = true;
      }
  }
  const closureDecls = new Map(locals.filter((l) => inline.has(l.decl)).map((l) => [l.decl, l.display] as const));

  const helpers = new Map<string, Helper>();
  const generics = new Map<string, GenericHelper>();
  const helperDecls = new Map<ts.Node, string>();
  for (const fn of [...helperNodes, ...locals.filter((l) => !inline.has(l.decl))]) {
    helperDecls.set(fn.decl, fn.name);
    const fnParams = fn.node.parameters.map((p, i) => (p.type && ts.isFunctionTypeNode(p.type) ? i : -1)).filter((i) => i >= 0);
    if (fn.node.typeParameters?.length || fnParams.length) {
      reporter.guard(() => {
        for (const tp of fn.node.typeParameters ?? []) if (tp.default) reporter.fail(tp, "type parameters of helpers take no default");
        generics.set(fn.name, {
          name: fn.name,
          display: fn.display,
          node: fn.node,
          typeParams: (fn.node.typeParameters ?? []).map((t) => t.name.text),
          fnParams,
          imports: fn.imports,
        });
      });
      continue;
    }
    const h = reporter.guard(() => analyzeHelper(fn.node, fn.name, fn.display, reporter, scopeFor(fn.imports), structs));
    if (h) helpers.set(h.name, h);
  }
  const instances = new Map<string, Helper>();
  const instantiate = (g: GenericHelper, typeArgs: TypeArg[], fnArgs: string[] = []): Helper => {
    const argKey = (t: TypeArg) => (t.kind === "struct" ? `S${t.name}` : scalarKey(t));
    const key = [g.name, ...typeArgs.map(argKey), ...fnArgs.map((f) => `fn_${f}`)].join("__");
    const done = instances.get(key);
    if (done) return done;
    const bound = new Map<string, ScalarType>();
    const boundStructs = new Map<string, string>();
    g.typeParams.forEach((n, i) => {
      const t = typeArgs[i]!;
      if (t.kind === "struct") boundStructs.set(n, t.name);
      else bound.set(n, t);
    });
    const display = `${g.display}<${[...typeArgs.map((t) => (t.kind === "struct" ? t.name : typeName(t))), ...fnArgs].join(", ")}>`;
    const h = analyzeHelper(
      g.node,
      key,
      display,
      reporter,
      { ...scopeFor(g.imports), typeArgs: bound, structArgs: boundStructs },
      structs,
      new Set(g.fnParams),
    );
    h.typeArgs = bound;
    h.structArgs = boundStructs;
    if (g.fnParams.length) {
      h.fnArgs = new Map(g.fnParams.map((i, k) => [(g.node.parameters[i]!.name as ts.Identifier).text, fnArgs[k]!] as const));
      h.fnArgIndexes = g.fnParams;
    }
    instances.set(key, h);
    helpers.set(key, h);
    return h;
  };
  reporter.guard(() => checkRecursion([...helperNodes, ...locals.filter((l) => !inline.has(l.decl))], helperDecls, checker, reporter));

  const accountStructs = new Set<string>();
  const argStructs = new Set<string>();
  const instructions: Instruction[] = [];
  for (const fn of functions) {
    const ix = reporter.guard(() => analyzeInstruction(fn.node, reporter, scopeFor(fn.imports), structs));
    if (!ix) continue;
    instructions.push(ix);
    for (const a of ix.args) collectStructs(a.type, structs, dataEnums, argStructs);
    for (const a of ix.args) {
      const seen = new Set<string>();
      collectStructs(a.type, structs, dataEnums, seen);
      // A @layout borsh struct is decoded as a whole argument; inside lists or enums it would need a fixed size.
      const whole = a.type.kind === "structRef" ? a.type.struct : undefined;
      for (const s of seen)
        if (structs.get(s)!.layout === "borsh" && s !== whole)
          reporter.error(fn.node.name ?? fn.node, `argument ${a.name}: ${s} is @layout borsh; pass it as a whole argument, not inside a list or enum`);
    }
    // Arguments are Borsh: a FixedVec's padded layout is account data only (a @layout borsh struct's FixedVec is a Borsh Vec).
    for (const a of ix.args) {
      const seen = new Set<string>();
      collectStructs(a.type, structs, dataEnums, seen);
      for (const s of seen)
        if (structs.get(s)!.layout !== "borsh" && structs.get(s)!.fields.some((f) => f.type.kind === "vec" && f.type.cap !== undefined))
          reporter.error(fn.node.name ?? fn.node, `argument ${a.name}: ${s} holds a FixedVec, which only account data can; pass a Vec<T> argument instead`);
    }
    // A returned struct goes out in its fixed layout, like an argument comes in: it cannot also be a Borsh event.
    if (ix.returns?.kind === "struct") collectStructs(ix.returns, structs, dataEnums, argStructs);
    for (const a of ix.accounts)
      if (a.kind.kind === "account" || a.kind.kind === "init" || a.kind.kind === "zeroed" || a.kind.kind === "initIfNeeded") {
        accountStructs.add(a.kind.struct.name);
        if (a.kind.struct.viewsOnly)
          reporter.error(
            a.node,
            `${a.kind.struct.name} holds a string (or an enum carrying one), so it is an argument, return value or event; account data uses FixedString<N>`,
          );
      }
  }
  checkSnakeDuplicates(
    instructions.map((ix) => ({ name: ix.node.name!.text, node: ix.node.name! })),
    "instructions",
    reporter,
  );
  // emitCpi's event instruction (Anchor's EVENT_IX_TAG) is dispatched before every other instruction.
  if (instructions.some((ix) => ix.accounts.some((a) => a.kind.kind === "eventAuthority"))) {
    const tag = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];
    for (const ix of instructions) {
      const n = Math.min(ix.discriminator.length, 8);
      if (ix.discriminator.slice(0, n).every((x, k) => x === tag[k]))
        reporter.error(ix.node.name ?? ix.node, `the discriminator of ${ix.name} collides with the emitCpi event instruction tag`);
    }
  }
  // The entrypoint tries discriminators in order: one that is a prefix of another would capture its calls.
  for (let i = 0; i < instructions.length; i++)
    for (let j = 0; j < instructions.length; j++) {
      const [a, b] = [instructions[i], instructions[j]];
      if (
        i !== j &&
        a.discriminator.length <= b.discriminator.length &&
        a.discriminator.every((x, k) => x === b.discriminator[k]) &&
        (a.discriminator.length < b.discriminator.length || i < j)
      )
        reporter.error(
          b.node.name ?? b.node,
          `the discriminator of ${b.name} ${a.discriminator.length < b.discriminator.length ? "starts with" : "equals"} the discriminator of ${a.name}`,
        );
    }
  if (instructions.length === 0 && reporter.diagnostics.length === 0)
    reporter.error(sourceFile, "a TypeSOL program needs at least one exported function (instruction) in its entry file");

  const name = path.basename(sourceFile.fileName).replace(/\.ts$/, "");
  return {
    model: {
      name: snakeCase(name).replace(/[^a-z0-9_]/g, "_"),
      structs,
      instructions,
      helpers,
      generics,
      helperDecls,
      closureDecls,
      errors,
      errorEnums,
      enums,
      dataEnums,
      options,
      constants,
      events: new Set(),
      accountStructs,
      argStructs,
      fstrings,
      fixedVecs,
    },
    sourceFile,
    files: programFiles(program, entryPath).map((f) => f.fileName),
    imports: entryImports,
    reporter,
    checker,
    instantiate,
  };
}

/** Every struct an argument type contains (transitively), for IDL layout decisions. */
function collectStructs(t: ValueType | FieldType, structs: Map<string, StructDef>, dataEnums: Map<string, DataEnumDef>, out: Set<string>) {
  const visitField = (f: FieldType): void => {
    if (f.kind === "struct") {
      if (out.has(f.name)) return;
      out.add(f.name);
      for (const x of structs.get(f.name)?.fields ?? []) visitField(x.type);
    } else if (f.kind === "array" || f.kind === "vec") visitField(f.elem);
    else if (f.kind === "option" && f.inner.kind === "struct") visitField(f.inner);
    else if (f.kind === "dataEnum") for (const v of dataEnums.get(f.name)?.variants ?? []) v.fields.forEach((x) => visitField(x.type));
  };
  if (t.kind === "structRef") visitField({ kind: "struct", name: t.struct });
  else if (t.kind === "arrayArg") visitField(t.array);
  else if (t.kind === "vecArg") visitField(t.elem);
}

/**
 * Instruction-argument types beyond scalars: a fixed-size struct (`p: Point`), `FixedArray<T, N>`, or
 * `Vec<Struct>`. They are Borsh-identical to TypeSOL's fixed layouts, so they are copied as is and validated.
 */
export function resolveArgAggregate(node: ts.TypeNode, scope: TypeScope, structs: Map<string, StructDef>): ValueType | undefined {
  const fixed = (t: ts.TypeNode): FieldType | undefined => {
    const scalar = resolveScalarType(t, scope);
    if (scalar) return scalar;
    if (ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName) && !t.typeArguments?.length) {
      const s = structs.get(structNameOf(t, scope)!);
      if (s && s.size !== undefined && !s.vec) return { kind: "struct", name: s.name };
    }
    if (typesolName(t, scope.imports) === "FixedArray") {
      const [e, n] = (t as ts.TypeReferenceNode).typeArguments ?? [];
      const elem = e && fixed(e);
      const len = numericLiteralArg(n);
      if (elem && len !== undefined && Number.isInteger(len) && len >= 1 && len <= MAX_ARRAY_LEN) return { kind: "array", elem, len };
    }
    return undefined;
  };
  const top = fixed(node);
  if (top?.kind === "struct") return { kind: "structRef", struct: top.name, writable: false };
  if (top?.kind === "array") return { kind: "arrayArg", array: top };
  if (typesolName(node, scope.imports) === "Vec") {
    const e = (node as ts.TypeReferenceNode).typeArguments?.[0];
    const elem = e && fixed(e);
    if (elem && (elem.kind === "struct" || elem.kind === "array")) return { kind: "vecArg", elem };
  }
  return undefined;
}

/** Resolve a type node that names a `typesol` export, returning the export name. */
export function typesolName(node: ts.TypeNode, imports: Map<string, string>): string | undefined {
  if (!ts.isTypeReferenceNode(node) || !ts.isIdentifier(node.typeName)) return undefined;
  const exported = imports.get(node.typeName.text);
  return exported && TYPE_EXPORTS.has(exported) ? exported : undefined;
}

export function resolveScalarType(node: ts.TypeNode, scope: TypeScope): ScalarType | undefined {
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return { kind: "bool" };
  if (scope.typeArgs && ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && !node.typeArguments) {
    const t = scope.typeArgs.get(node.typeName.text);
    if (t) return t;
  }
  const n = typesolName(node, scope.imports);
  if (n && (INT_NAMES as readonly string[]).includes(n)) return { kind: "int", name: n as IntName };
  if (n === "Pubkey") return { kind: "pubkey" };
  if (n === "Hash") return { kind: "pubkey", hash: true };
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && scope.enums.has(node.typeName.text)) return { kind: "enum", name: node.typeName.text };
  return undefined;
}

/** `Option<T>` or `T | null` with a scalar T. Records the use so a C typedef / IDL type is emitted. */
export function resolveOptionType(node: ts.TypeNode, scope: TypeScope): (ValueType & { kind: "option" }) | undefined {
  let innerNode: ts.TypeNode | undefined;
  if (typesolName(node, scope.imports) === "Option") innerNode = (node as ts.TypeReferenceNode).typeArguments?.[0];
  else if (ts.isUnionTypeNode(node) && node.types.length === 2) {
    const isNull = (t: ts.TypeNode) => ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword;
    if (isNull(node.types[1])) innerNode = node.types[0];
    else if (isNull(node.types[0])) innerNode = node.types[1];
  }
  if (!innerNode) return undefined;
  const inner = resolveScalarType(innerNode, scope);
  if (!inner) return undefined;
  scope.options.set(scalarKey(inner), inner);
  return { kind: "option", inner };
}

/** Values a local, argument or helper parameter can hold. */
export function resolveValueType(node: ts.TypeNode, scope: TypeScope, allowVec = false): ValueType | undefined {
  if (node.kind === ts.SyntaxKind.StringKeyword) return { kind: "string" };
  const opt = resolveOptionType(node, scope);
  if (opt) return opt;
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && scope.dataEnums?.has(node.typeName.text))
    return { kind: "dataEnumArg", name: node.typeName.text };
  if (allowVec && typesolName(node, scope.imports) === "Vec") {
    const elemNode = (node as ts.TypeReferenceNode).typeArguments?.[0];
    // Vec<string>: Borsh Vec<String>, read as views of the instruction data.
    if (elemNode?.kind === ts.SyntaxKind.StringKeyword) return { kind: "vecArg", elem: { kind: "string" } };
    const elem = elemNode && resolveScalarType(elemNode, scope);
    if (elem) return { kind: "vecArg", elem };
  }
  return resolveScalarType(node, scope);
}

function numericLiteralArg(node: ts.TypeNode | undefined): number | undefined {
  if (!node || !ts.isLiteralTypeNode(node) || !ts.isNumericLiteral(node.literal)) return undefined;
  return Number(node.literal.text);
}

/**
 * Resolve every exported interface. Field types may name other interfaces, so names are
 * collected first; sizes are computed after, rejecting cycles.
 */
function analyzeStructs(
  items: { decl: ts.InterfaceDeclaration; imports: Map<string, string> }[],
  aliases: { decl: ts.TypeAliasDeclaration; imports: Map<string, string> }[],
  dataEnums: Map<string, DataEnumDef>,
  reporter: Reporter,
  scopeFor: (imports: Map<string, string>) => TypeScope,
  fstrings: Set<number>,
  fixedVecs: Map<string, FieldType & { kind: "vec" }>,
): Map<string, StructDef> {
  const names = new Set(items.map((d) => d.decl.name.text));
  const enumNames = new Set(aliases.map((a) => a.decl.name.text));
  const structs = new Map<string, StructDef>();
  let scope: TypeScope = scopeFor(new Map());
  let imports = scope.imports;

  const fieldType = (node: ts.TypeNode): FieldType => {
    if (node.kind === ts.SyntaxKind.StringKeyword) return { kind: "string" };
    const scalar = resolveScalarType(node, scope);
    if (scalar) return scalar;
    const opt = resolveOptionType(node, scope);
    if (opt) return opt;
    // Option of a struct (account data only): Option<Point> or Point | null
    {
      let inner: ts.TypeNode | undefined;
      if (typesolName(node, imports) === "Option") inner = (node as ts.TypeReferenceNode).typeArguments?.[0];
      else if (ts.isUnionTypeNode(node) && node.types.length === 2) {
        const isNull = (t: ts.TypeNode) => ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword;
        inner = isNull(node.types[1]) ? node.types[0] : isNull(node.types[0]) ? node.types[1] : undefined;
      }
      if (inner && ts.isTypeReferenceNode(inner) && ts.isIdentifier(inner.typeName) && names.has(inner.typeName.text)) {
        const t = { kind: "struct" as const, name: inner.typeName.text };
        scope.options.set(optionKey(t), t);
        return { kind: "option", inner: t };
      }
    }
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && enumNames.has(node.typeName.text))
      return { kind: "dataEnum", name: node.typeName.text };
    if (typesolName(node, imports) === "Vec") {
      const elemNode = (node as ts.TypeReferenceNode).typeArguments?.[0];
      if (!elemNode) reporter.fail(node, "Vec<T> needs an element type");
      const elem = fieldType(elemNode);
      if (elem.kind === "string" || elem.kind === "vec") reporter.fail(elemNode, "Vec elements must have a fixed size (use FixedString<N>)");
      return { kind: "vec", elem };
    }
    const ext = typesolName(node, imports);
    const targs = (node as ts.TypeReferenceNode).typeArguments ?? [];
    if (ext === "FixedArray") {
      if (!targs[0]) reporter.fail(node, "FixedArray<T, N> needs an element type");
      const elem = fieldType(targs[0]);
      if (elem.kind === "string") reporter.fail(targs[0], "arrays of variable strings are not supported; use FixedString<N>");
      const len = numericLiteralArg(targs[1]);
      if (len === undefined) reporter.fail(node, "FixedArray<T, N> needs a numeric literal length, e.g. FixedArray<u64, 8>");
      if (!Number.isInteger(len) || len < 1 || len > MAX_ARRAY_LEN) reporter.fail(targs[1], `array length must be 1..${MAX_ARRAY_LEN}`);
      return { kind: "array", elem, len };
    }
    if (ext === "FixedVec") {
      if (!targs[0]) reporter.fail(node, "FixedVec<T, N> needs an element type");
      const elem = fieldType(targs[0]);
      if (elem.kind === "string" || elem.kind === "vec") reporter.fail(targs[0], "FixedVec elements must have a fixed size (use FixedString<N>)");
      const cap = numericLiteralArg(targs[1]);
      if (cap === undefined || !Number.isInteger(cap) || cap < 1 || cap > MAX_ARRAY_LEN)
        reporter.fail(node, `FixedVec<T, N> needs a literal capacity 1..${MAX_ARRAY_LEN}, e.g. FixedVec<u64, 16>`);
      const t = { kind: "vec" as const, elem, cap };
      fixedVecs.set(fixedVecName(t), t);
      return t;
    }
    if (ext === "FixedString") {
      const cap = numericLiteralArg(targs[0]);
      if (cap === undefined || !Number.isInteger(cap) || cap < 1 || cap > MAX_STRING_CAP)
        reporter.fail(node, `FixedString<N> needs a literal capacity 1..${MAX_STRING_CAP}`);
      fstrings.add(cap);
      return { kind: "fstring", cap };
    }
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && names.has(node.typeName.text) && !targs.length)
      return { kind: "struct", name: node.typeName.text };
    reporter.fail(
      node,
      "field type must be an integer, boolean, Pubkey, FixedArray<T, N>, FixedString<N>, FixedVec<T, N>, Vec<T> (last), string (events only) or another struct",
    );
  };

  for (const { decl, imports: fileImports } of items) {
    scope = scopeFor(fileImports);
    imports = fileImports;
    reporter.guard(() => {
      if (decl.typeParameters?.length || decl.heritageClauses?.length) reporter.fail(decl, "structs cannot be generic or extend other types");
      const fields: StructField[] = [];
      for (const m of decl.members) {
        if (!ts.isPropertySignature(m) || !m.type || !ts.isIdentifier(m.name)) reporter.fail(m, "structs may only contain plain fields");
        if (m.questionToken) reporter.fail(m, "optional fields are not supported");
        const name = m.name.text;
        if (RESERVED_FIELDS.has(name)) reporter.fail(m.name, `"${name}" is reserved; pick another field name`);
        const problem = cNameProblem(name);
        if (problem) reporter.fail(m.name, problem);
        const type = fieldType(m.type);
        if (type.kind === "vec" && type.cap === undefined && m !== decl.members[decl.members.length - 1])
          reporter.fail(
            m,
            "a Vec<T> field must be the last field of the struct (its length changes the account size); use FixedVec<T, N> for a list of at most N elsewhere",
          );
        fields.push({ name, type });
      }
      checkSnakeDuplicates(
        decl.members.map((m) => ({ name: (m.name as ts.Identifier).text, node: m })),
        "fields",
        reporter,
      );
      const name = decl.name.text;
      // `/** @layout borsh */`: stored as Anchor stores it.
      const layoutTag = ts.getJSDocTags(decl).find((t) => t.tagName.text === "layout");
      const layoutText = typeof layoutTag?.comment === "string" ? layoutTag.comment.trim() : undefined;
      if (layoutTag && layoutText !== "borsh" && layoutText !== "fixed")
        reporter.fail(layoutTag, "@layout is borsh (Anchor's account bytes) or fixed (the default)");
      structs.set(name, {
        name,
        fields,
        size: undefined,
        accountDiscriminator: discriminator(`account:${name}`),
        eventDiscriminator: discriminator(`event:${name}`),
        node: decl,
        layout: layoutText === "borsh" ? "borsh" : "fixed",
      });
    });
  }

  // Data enums: a union of object types, each with a string-literal `kind` naming the variant.
  for (const { decl, imports: fileImports } of aliases) {
    scope = scopeFor(fileImports);
    imports = fileImports;
    reporter.guard(() => {
      if (decl.typeParameters?.length) reporter.fail(decl, "data enums cannot be generic");
      const members = ts.isUnionTypeNode(decl.type) ? decl.type.types : [decl.type];
      const variants: DataEnumDef["variants"] = [];
      for (const m of members) {
        if (!ts.isTypeLiteralNode(m)) reporter.fail(m, 'each variant is an object type: { kind: "Name"; field: Type }');
        let vname: string | undefined;
        const fields: StructField[] = [];
        for (const p of m.members) {
          if (!ts.isPropertySignature(p) || !p.type || !ts.isIdentifier(p.name) || p.questionToken) reporter.fail(p, "variants contain plain fields");
          if (p.name.text === "kind") {
            if (!ts.isLiteralTypeNode(p.type) || !ts.isStringLiteral(p.type.literal)) reporter.fail(p.type, 'kind must be a string literal: kind: "Deposit"');
            vname = p.type.literal.text;
            continue;
          }
          const problem = cNameProblem(p.name.text);
          if (problem) reporter.fail(p.name, problem);
          const t = fieldType(p.type);
          if (t.kind === "vec") reporter.fail(p.type, "variant fields must have a fixed size (a Vec cannot be one; use FixedArray<T, N>)");
          fields.push({ name: p.name.text, type: t });
        }
        if (!vname || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(vname)) reporter.fail(m, 'each variant needs kind: "Name" (an identifier)');
        const vproblem = cNameProblem(vname);
        if (vproblem) reporter.fail(m, vproblem);
        checkSnakeDuplicates(
          fields.map((f) => ({ name: f.name, node: m })),
          "fields",
          reporter,
        );
        if (variants.some((v) => v.name === vname)) reporter.fail(m, `duplicate variant "${vname}"`);
        variants.push({ name: vname, fields, size: 0 });
      }
      if (variants.length < 1 || variants.length > 256) reporter.fail(decl, "data enums need 1..256 variants");
      dataEnums.set(decl.name.text, { name: decl.name.text, variants, payload: 0, node: decl });
    });
  }

  // Sizes, with cycle detection. `string` fields leave the size undefined (event-only struct).
  const state = new Map<string, "visiting" | "done">();
  const sizeOf = (t: FieldType, at: ts.Node): number | undefined => {
    switch (t.kind) {
      case "int":
      case "bool":
      case "pubkey":
      case "enum":
        return scalarSize(t);
      case "option":
        return 1 + (t.inner.kind === "struct" ? sizeOf(t.inner, at)! : scalarSize(t.inner));
      case "dataEnum": {
        const e = dataEnums.get(t.name);
        if (!e) return 0; // its declaration failed and was reported

        if (state.get(`enum:${e.name}`) === "visiting") reporter.fail(at, `data enum ${e.name} contains itself`);
        if (state.get(`enum:${e.name}`) !== "done") {
          state.set(`enum:${e.name}`, "visiting");
          // A string field is a TS_Str view (16 bytes) in the C payload and makes the enum variable-size.
          const fieldSize = (f: FieldType): number => {
            if (f.kind === "string") {
              e.variable = true;
              return 16;
            }
            if (f.kind === "dataEnum") {
              const inner = dataEnums.get(f.name);
              const size = sizeOf(f, e.node);
              if (inner?.variable) {
                e.variable = true;
                return 1 + inner.payload;
              }
              return size!;
            }
            return sizeOf(f, e.node)!;
          };
          for (const v of e.variants) v.size = v.fields.reduce((sum, f) => sum + fieldSize(f.type), 0);
          e.payload = Math.max(0, ...e.variants.map((v) => v.size));
          state.set(`enum:${e.name}`, "done");
        }
        // Variable enums have no fixed layout: a struct holding one is event-only, like one holding a string.
        if (e.variable) return undefined;
        return 1 + e.payload;
      }
      case "vec": {
        if (t.cap === undefined) return 4; // the u32 length; elements live past the fixed part
        const e = sizeOf(t.elem, at);
        if (e === undefined) reporter.fail(at, "FixedVec elements must have a fixed size");
        return 4 + e * t.cap;
      }
      case "string":
        return undefined;
      case "fstring":
        return 4 + t.cap;
      case "array": {
        const e = sizeOf(t.elem, at);
        if (e === undefined) reporter.fail(at, "arrays of variable-size structs are not supported");
        return e * t.len;
      }
      case "struct": {
        const s = structs.get(t.name);
        if (!s) return 0;
        visit(s);
        if (s.size === undefined) reporter.fail(at, `${t.name} has a string field and cannot be nested; use FixedString<N>`);
        if (s.vec) reporter.fail(at, `${t.name} ends in a Vec and can only be account data, not nested`);
        return s.size;
      }
    }
  };
  const visit = (s: StructDef) => {
    if (state.get(s.name) === "done") return;
    if (state.get(s.name) === "visiting") reporter.fail(s.node.name, `struct ${s.name} contains itself`);
    state.set(s.name, "visiting");
    let total: number | undefined = 0;
    for (const f of s.fields) {
      // In a @layout borsh struct a string (or a data enum carrying one) is held as a TS_Str view: a C size, no layout.
      const view = s.layout === "borsh" && (f.type.kind === "string" || (f.type.kind === "dataEnum" && sizeOf(f.type, s.node) === undefined));
      if (view) s.viewsOnly = true;
      const fsz = view ? (f.type.kind === "string" ? 16 : 1 + dataEnums.get((f.type as { name: string }).name)!.payload) : sizeOf(f.type, s.node);
      total = total === undefined || fsz === undefined ? undefined : total + fsz;
    }
    s.size = total;
    if (total !== undefined && total + 8 > MAX_ACCOUNT_SIZE)
      reporter.fail(s.node.name, `${s.name} is ${total + 8} bytes with its discriminator; Solana accounts are at most ${MAX_ACCOUNT_SIZE} bytes`);
    const last = s.fields.at(-1);
    if (last?.type.kind === "vec" && last.type.cap === undefined) {
      const elemSize = sizeOf(last.type.elem, s.node);
      if (elemSize === undefined) reporter.fail(s.node, "Vec elements must have a fixed size");
      s.vec = { name: last.name, elem: last.type.elem, elemSize };
    }
    state.set(s.name, "done");
  };
  for (const s of structs.values()) reporter.guard(() => visit(s));
  for (const s of structs.values()) if (s.layout === "borsh") reporter.guard(() => checkBorshLayout(s, structs, dataEnums, reporter));
  for (const e of dataEnums.values()) reporter.guard(() => sizeOf({ kind: "dataEnum", name: e.name }, e.node));
  return structs;
}

/** A function to analyze as a helper: where it is declared and the names it goes by. */
interface HelperSource {
  node: HelperNode;
  /** C name (see Helper.name). */
  name: string;
  display: string;
  /** The function declaration, or the variable declaration of an arrow (what calls resolve to). */
  decl: ts.Node;
  imports: Map<string, string>;
  /** For a local function: the function it is declared in. */
  outer?: ts.Node;
}

const isFunctionNode = (n: ts.Node) => ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n);

/** Whether a local function reads a variable or parameter of a function around it (a closure). */
function captures(l: HelperSource, localDecls: Set<ts.Node>, checker: ts.TypeChecker): boolean {
  const fn = l.node;
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n)) {
      const sym = ts.isShorthandPropertyAssignment(n.parent) ? checker.getShorthandAssignmentValueSymbol(n.parent) : checker.getSymbolAtLocation(n);
      for (const d of sym?.declarations ?? []) {
        if (!(ts.isVariableDeclaration(d) || ts.isParameter(d) || ts.isBindingElement(d)) || localDecls.has(d)) continue;
        if (d.getSourceFile() !== fn.getSourceFile() || (d.pos >= fn.pos && d.end <= fn.end)) continue;
        for (let p: ts.Node | undefined = d.parent; p; p = p.parent) if (isFunctionNode(p)) found = true;
      }
    }
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  return found;
}

/** Whether a function's body names one of `decls` (a closure it calls). */
function references(l: HelperSource, decls: Set<ts.Node>, checker: ts.TypeChecker): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n)) for (const d of checker.getSymbolAtLocation(n)?.declarations ?? []) if (decls.has(d)) found = true;
    ts.forEachChild(n, visit);
  };
  if (l.node.body) visit(l.node.body);
  return found;
}

/**
 * A `@layout borsh` struct: its own fields may be FixedString (Borsh String), FixedVec (Borsh Vec) and Option; anything
 * nested must already be Borsh-identical (fixed-size scalars, Pubkeys, enums, arrays and structs of them).
 */
function checkBorshLayout(s: StructDef, structs: Map<string, StructDef>, dataEnums: Map<string, DataEnumDef>, reporter: Reporter) {
  const model = { structs };
  const fixed = (t: FieldType) => borshIdentical(t, model);
  for (const f of s.fields) {
    const t = f.type;
    const at = s.node.members.find((m) => m.name && ts.isIdentifier(m.name) && m.name.text === f.name) ?? s.node;
    if (fixed(t) || t.kind === "fstring" || t.kind === "string") continue;
    if (t.kind === "dataEnum") {
      // Borsh enum: tag, then the variant's fields; each a fixed-size value or a string.
      for (const v of dataEnums.get(t.name)?.variants ?? [])
        for (const vf of v.fields)
          if (!fixed(vf.type) && vf.type.kind !== "string")
            reporter.fail(at, `${t.name}.${v.name}.${vf.name} in a @layout borsh struct: enum variants hold fixed-size values and strings`);
      continue;
    }
    if (t.kind === "vec" && t.cap === undefined)
      reporter.fail(at, "a @layout borsh struct cannot end in a growable Vec<T>; use FixedVec<T, N> (Anchor's #[max_len(N)] Vec)");
    if (t.kind === "vec" && (fixed(t.elem) || t.elem.kind === "fstring")) continue;
    if (t.kind === "option" && fixed(t.inner as FieldType)) continue;
    if (t.kind === "struct" && structs.get(t.name)?.layout === "borsh")
      reporter.fail(at, `${t.name} is @layout borsh itself: only account structs take a layout; nest a struct without one`);
    reporter.fail(
      at,
      `${typeName(t)} in a @layout borsh struct: its fields may be fixed-size values, FixedString<N>, FixedVec<T, N> (of those or of FixedString) and Option<T>; nested structs and lists hold fixed-size values only`,
    );
  }
  for (const other of structs.values())
    for (const f of other.fields) {
      const inner = f.type.kind === "array" || f.type.kind === "vec" ? f.type.elem : f.type.kind === "option" ? (f.type.inner as FieldType) : f.type;
      if (inner.kind === "struct" && inner.name === s.name)
        reporter.error(s.node.name, `${s.name} is @layout borsh, so it is account data only; ${other.name}.${f.name} cannot hold one`);
    }
}
function analyzeHelper(
  fn: HelperNode,
  name: string,
  display: string,
  reporter: Reporter,
  scope: TypeScope,
  structs: Map<string, StructDef>,
  skip: Set<number> = new Set(),
): Helper {
  if (!fn.body) reporter.fail(fn, "helper functions need a body");
  if (fn.asteriskToken) reporter.fail(fn, "helper functions cannot be generators");
  if ((ts.getModifiers(fn) ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) reporter.fail(fn, "helper functions cannot be async");
  if (!fn.type) reporter.fail(fn.name ?? fn, "helper functions need an explicit return type (void, an integer, boolean, Pubkey or a struct)");
  let returns: Helper["returns"] =
    fn.type.kind === ts.SyntaxKind.VoidKeyword
      ? undefined
      : fn.type.kind === ts.SyntaxKind.StringKeyword
        ? { kind: "string" }
        : resolveScalarType(fn.type, scope);
  if (fn.type.kind !== ts.SyntaxKind.VoidKeyword && !returns) {
    const sn = structNameOf(fn.type, scope);
    const s = sn ? structs.get(sn) : undefined;
    if (s && (s.size === undefined || s.vec))
      reporter.fail(fn.type, `${s.name} has variable-size fields and cannot be returned; return a struct of fixed size`);
    if (!s) reporter.fail(fn.type, "helpers return void, an integer, boolean, Pubkey, string, a struct or a type parameter");
    returns = { kind: "struct", name: s.name };
  }
  const params = fn.parameters
    .filter((_, i) => !skip.has(i))
    .map((p) => {
      if (!ts.isIdentifier(p.name) || !p.type || p.initializer || p.questionToken || p.dotDotDotToken)
        reporter.fail(p, "parameters need a plain name and an explicit type");
      // `p_<name>__n` carries a SignerSeeds count: "__" in a name could collide with it.
      if (p.name.text.includes("__") || p.name.text.includes("$")) reporter.error(p.name, `"${p.name.text}": "__" and "$" are reserved in names`);
      const type = resolveValueType(p.type, scope, true) ?? resolveArgAggregate(p.type, scope, structs);
      if (type) return { name: p.name.text, type, node: p };
      if (typesolName(p.type, scope.imports) === "SignerSeeds") return { name: p.name.text, type: { kind: "signerSeeds" } as ValueType, node: p };
      // Accounts the caller already checked: Signer, AccountInfo, Account<T>/Mut<T>, token accounts, programs.
      const wrapped = typesolName(p.type, scope.imports);
      if (wrapped === "HasOne" || wrapped === "Seeds" || wrapped === "CloseTo" || wrapped === "Address" || wrapped === "Ata")
        reporter.fail(p.type, "constraints belong on instruction parameters; helpers take the plain account type");
      const account = resolveAccountKind(p.type, reporter, scope.imports, structs);
      if (account.kind === "init" || account.kind === "initIfNeeded" || account.kind === "zeroed")
        reporter.fail(p.type, "helpers take accounts that exist: create Init/InitIfNeeded/Zeroed accounts in the instruction, then pass them as Mut<T>");
      return { name: p.name.text, type: { kind: "account" } as ValueType, account, node: p };
    });
  return { name, display, params, returns, node: fn, statements: bodyStatements(fn, !returns), imports: scope.imports };
}

/** A function's statements; an arrow's expression body is a `return expr;` (or `expr;` when it returns void). */
function bodyStatements(fn: HelperNode, isVoid: boolean): readonly ts.Statement[] {
  const body = fn.body!;
  if (ts.isBlock(body)) return body.statements;
  const f = ts.factory;
  const stmt = isVoid ? f.createExpressionStatement(body) : f.createReturnStatement(body);
  ts.setTextRange(stmt, body);
  (stmt as { parent?: ts.Node }).parent = fn;
  return [stmt];
}

/** The helper (or generic) a call's callee names: a local function by its declaration, others by name. */
export function calleeName(callee: ts.Identifier, decls: Map<ts.Node, string>, checker: ts.TypeChecker): string | undefined {
  let sym = checker.getSymbolAtLocation(callee);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  for (const d of sym?.declarations ?? []) {
    const name = decls.get(d);
    if (name) return name;
  }
  return undefined;
}

/** Helpers may call each other, but not recursively: SBF has a small fixed call depth. */
function checkRecursion(sources: HelperSource[], decls: Map<ts.Node, string>, checker: ts.TypeChecker, reporter: Reporter) {
  const calls = new Map<string, string[]>();
  const byName = new Map(sources.map((s) => [s.name, s]));
  for (const h of sources) {
    const out: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const c = calleeName(n.expression, decls, checker);
        if (c) out.push(c);
      }
      ts.forEachChild(n, visit);
    };
    visit(h.node.body!);
    calls.set(h.name, out);
  }
  const state = new Map<string, "visiting" | "done">();
  const walk = (name: string, path: string[]) => {
    if (state.get(name) === "done") return;
    const src = byName.get(name)!;
    if (state.get(name) === "visiting")
      reporter.fail(src.node.name ?? src.node, `recursion is not supported: ${[...path, name].map((n) => byName.get(n)!.display).join(" -> ")}`);
    state.set(name, "visiting");
    for (const c of calls.get(name) ?? []) walk(c, [...path, name]);
    state.set(name, "done");
  };
  for (const name of byName.keys()) walk(name, []);
}

function analyzeInstruction(fn: ts.FunctionDeclaration, reporter: Reporter, scope: TypeScope, structs: Map<string, StructDef>): Instruction {
  const imports = scope.imports;
  if (!fn.name || !fn.body) reporter.fail(fn, "instructions need a name and a body");
  if (fn.typeParameters?.length) reporter.fail(fn, "instructions cannot be generic");
  if (fn.asteriskToken || (ts.getModifiers(fn) ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword))
    reporter.fail(fn, "instructions cannot be async or generators");
  let returns: Instruction["returns"];
  if (fn.type && fn.type.kind !== ts.SyntaxKind.VoidKeyword) {
    returns = fn.type.kind === ts.SyntaxKind.StringKeyword ? { kind: "string" } : resolveScalarType(fn.type, scope);
    const s =
      !returns && ts.isTypeReferenceNode(fn.type) && ts.isIdentifier(fn.type.typeName) && !fn.type.typeArguments
        ? structs.get(fn.type.typeName.text)
        : undefined;
    if (s) {
      if (s.size === undefined || s.vec) reporter.fail(fn.type, `${s.name} has variable-size fields and cannot be return data`);
      // The runtime caps return data at 1024 bytes.
      if (s.size > MAX_RETURN_DATA) reporter.fail(fn.type, `${s.name} is ${s.size} bytes; return data holds at most ${MAX_RETURN_DATA}`);
      returns = { kind: "struct", name: s.name };
    }
    if (!returns) reporter.fail(fn.type, "instructions return void, one integer, boolean, Pubkey or string, or a fixed-size struct (sent as return data)");
  }

  const accounts: AccountParam[] = [];
  const args: ArgParam[] = [];
  let minArgsSize = 0;
  for (const p of fn.parameters) {
    reporter.guard(() => {
      if (!ts.isIdentifier(p.name) || !p.type || p.initializer || p.questionToken || p.dotDotDotToken)
        reporter.fail(p, "parameters need a plain name and an explicit type");
      const value = resolveValueType(p.type, scope, true) ?? resolveArgAggregate(p.type, scope, structs);
      if (value) {
        args.push({ name: p.name.text, type: value, node: p });
        minArgsSize +=
          value.kind === "string" || value.kind === "vecArg"
            ? 4
            : value.kind === "option" || value.kind === "dataEnumArg"
              ? 1
              : value.kind === "structRef"
                ? structs.get(value.struct)!.size!
                : isScalar(value)
                  ? scalarSize(value)
                  : 0;
        return;
      }
      // Optional accounts: `Mut<Vault> | null` or `Optional<Mut<Vault>>`.
      let typeNode = p.type;
      let optional = false;
      const isNull = (t: ts.TypeNode) => ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword;
      if (ts.isUnionTypeNode(typeNode) && typeNode.types.length === 2 && typeNode.types.some(isNull)) {
        optional = true;
        typeNode = typeNode.types.find((t) => !isNull(t))!;
      } else if (typesolName(typeNode, imports) === "Optional") {
        optional = true;
        typeNode = (typeNode as ts.TypeReferenceNode).typeArguments?.[0] ?? typeNode;
      }
      const constraints: Constraints = { hasOne: [] };
      const inner = unwrapConstraints(typeNode, reporter, imports, constraints);
      const kind = resolveAccountKind(inner, reporter, imports, structs);
      if (
        optional &&
        (["init", "initIfNeeded", "zeroed", "pyth", "eventAuthority", "selfProgram", "programData"].includes(kind.kind) ||
          ((kind.kind === "token" || kind.kind === "mint") && kind.init))
      )
        reporter.fail(p, "Init, InitIfNeeded, Zeroed, PythPriceUpdate, EventAuthority, SelfProgram and ProgramData accounts cannot be optional");
      accounts.push({ name: p.name.text, index: accounts.length, kind, node: p, constraints, ...(optional ? { optional } : {}) });
    });
  }

  checkSnakeDuplicates(
    args.map((a) => ({ name: a.name, node: a.node })),
    "arguments",
    reporter,
  );
  checkSnakeDuplicates(
    accounts.map((a) => ({ name: a.name, node: a.node })),
    "accounts",
    reporter,
  );
  for (const p of [...args, ...accounts])
    if (p.name.includes("__") || p.name.includes("$")) reporter.error(p.node, `"${p.name}": "__" and "$" are reserved in names`);
  // Constraints refer to other parameters by name: check them now that all are known.
  for (const a of accounts) {
    const c = a.constraints;
    if (a.kind.kind === "token" && a.kind.init && c.ata && (c.hasOne.length || c.seeds || c.address || c.owner || c.executable))
      reporter.fail(a.node, "an associated token account created here is checked against Ata<…>'s owner and mint; drop HasOne/Seeds/Address/Owner/Executable");
    // Token accounts and mints created in the body are checked there (seeds, mint, authorities).
    if ((a.kind.kind === "token" || a.kind.kind === "mint") && a.kind.init && !c.ata && (c.hasOne.length || c.seeds || c.address || c.owner || c.executable))
      reporter.fail(a.node, `${a.name}.create(...) takes the seeds, mint and authorities; drop HasOne/Seeds/Address/Owner/Executable`);
    if (!c.hasOne.length && !c.seeds && !c.closeTo && !c.ata) continue;
    const struct =
      a.kind.kind === "account" || a.kind.kind === "init" || a.kind.kind === "initIfNeeded" || a.kind.kind === "zeroed" ? a.kind.struct : undefined;
    reporter.guard(() => {
      for (const f of c.hasOne) {
        if (!accounts.some((o) => o.name === f)) reporter.fail(a.node, `HasOne<…, "${f}">: add an account parameter named "${f}"`);
        if (a.kind.kind === "token") {
          if (f !== "mint" && f !== "owner") reporter.fail(a.node, `HasOne on a TokenAccount checks "mint" or "owner", not "${f}"`);
          continue;
        }
        if (a.kind.kind === "mint") {
          if (f !== "mintAuthority" && f !== "freezeAuthority")
            reporter.fail(a.node, `HasOne on a Mint checks "mintAuthority" or "freezeAuthority", not "${f}"`);
          continue;
        }
        if (!struct) reporter.fail(a.node, "HasOne needs a struct account, a TokenAccount or a Mint");
        const field = struct.fields.find((x) => x.name === f);
        if (!field || field.type.kind !== "pubkey" || field.type.hash) reporter.fail(a.node, `HasOne<…, "${f}">: ${struct.name} needs a Pubkey field "${f}"`);
        if (!accounts.some((o) => o.name === f)) reporter.fail(a.node, `HasOne<…, "${f}">: add an account parameter named "${f}"`);
      }
      if (c.seeds?.bump) {
        if (!struct) reporter.fail(a.node, "Seeds with a bump field needs a struct account");
        const bf = struct.fields.find((x) => x.name === c.seeds!.bump);
        if (!bf || bf.type.kind !== "int" || bf.type.name !== "u8") reporter.fail(a.node, `Seeds bump: ${struct.name} needs a u8 field "${c.seeds.bump}"`);
      }
      if (c.seeds && (a.kind.kind === "init" || a.kind.kind === "initIfNeeded"))
        reporter.fail(a.node, "Init/InitIfNeeded accounts take their seeds in create()/createIfNeeded()");
      if (c.ata) {
        if (a.kind.kind !== "token" && a.kind.kind !== "info")
          reporter.fail(a.node, "Ata<…> applies to a TokenAccount (or an AccountInfo about to be created)");
        for (const n of [c.ata.owner, c.ata.mint])
          if (!accounts.some((o) => o.name === n)) reporter.fail(a.node, `Ata<…>: add an account parameter named "${n}"`);
      }
      if (c.closeTo) {
        if (a.kind.kind !== "account" || !a.kind.mut) reporter.fail(a.node, "CloseTo needs a Mut<Struct> account");
        const dest = accounts.find((o) => o.name === c.closeTo);
        if (!dest) reporter.fail(a.node, `CloseTo<…, "${c.closeTo}">: add an account parameter named "${c.closeTo}"`);
      }
    });
  }
  // A constraint may not depend on an optional account: when it is left out the check could not run, and
  // skipping it would let a caller remove the check by omitting the account.
  for (const a of accounts) {
    const c = a.constraints;
    const refs = [
      ...c.hasOne,
      ...(c.seeds?.names ?? []).filter((n) => n.startsWith("@")).map((n) => n.slice(1).split(".")[0]!),
      ...(c.seeds?.program?.startsWith("@") ? [c.seeds.program.slice(1)] : []),
      ...(c.closeTo ? [c.closeTo] : []),
      ...(c.ata
        ? [c.ata.owner, c.ata.mint, ...(a.kind.kind === "token" ? [] : accounts.filter((o) => o.kind.kind === "tokenProgram").map((o) => o.name))]
        : []),
    ];
    for (const r of refs) {
      const other = accounts.find((o) => o.name === r);
      if (other && other !== a && other.optional)
        reporter.error(a.node, `${a.name}'s constraint uses "${r}", which is optional: make ${r} required, or check it in the body when it is present`);
    }
  }
  const needs = (kind: ParamKind["kind"]) => accounts.some((a) => a.kind.kind === kind);
  const pushes = (() => {
    let found = false;
    const visit = (n: ts.Node) => {
      // Vec.push(value, payer) grows the account; FixedVec.push(value) does not.
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "push" && n.arguments.length === 2) found = true;
      ts.forEachChild(n, visit);
    };
    visit(fn.body);
    return found;
  })();
  if (pushes && !needs("system")) reporter.error(fn.name, "instructions that grow a Vec (push) need a SystemProgram parameter to top up rent");
  if (needs("init") && !needs("system")) reporter.error(fn.name, "instructions with Init<...> accounts need a SystemProgram parameter");

  const name = snakeCase(fn.name.text);
  // `/** @discriminator spl-transfer-hook-interface:execute */` (sha256 preimage) or `@discriminator 0x...` (raw bytes)
  // lets an instruction implement another program's interface.
  let disc = discriminator(`global:${name}`);
  const tag = ts.getJSDocTags(fn).find((t) => t.tagName.text === "discriminator");
  if (tag) {
    const text = (typeof tag.comment === "string" ? tag.comment : (ts.getTextOfJSDocComment(tag.comment) ?? "")).trim();
    if (/^0x([0-9a-fA-F]{2}){1,8}$/.test(text)) disc = [...Buffer.from(text.slice(2), "hex")];
    else if (text) disc = discriminator(text);
    else reporter.fail(fn.name, "@discriminator needs a sha256 preimage (e.g. spl-transfer-hook-interface:execute) or 0x-hex bytes");
  }
  return {
    name,
    discriminator: disc,
    accounts,
    args,
    minArgsSize,
    returns,
    pdas: new Map(),
    pdaPrograms: new Map(),
    node: fn,
    imports,
  };
}

/** Peel HasOne / Seeds / CloseTo wrappers off a parameter type, recording what they ask for. */
function unwrapConstraints(node: ts.TypeNode, reporter: Reporter, imports: Map<string, string>, out: Constraints): ts.TypeNode {
  const name = typesolName(node, imports);
  if (!["HasOne", "Seeds", "CloseTo", "Address", "Ata", "Owner", "Executable"].includes(name ?? "")) return node;
  const args = (node as ts.TypeReferenceNode).typeArguments ?? [];
  const lit = (t: ts.TypeNode | undefined): string[] => {
    if (!t) return [];
    if (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)) return [t.literal.text];
    if (ts.isUnionTypeNode(t)) return t.types.flatMap(lit);
    reporter.fail(t, "expected a string literal type");
  };
  if (name === "HasOne") out.hasOne.push(...lit(args[1]));
  if (name === "CloseTo") out.closeTo = lit(args[1])[0];
  if (name === "Owner") {
    const text = lit(args[1])[0];
    const bytes = text === undefined ? undefined : decodeAddress(text);
    if (!bytes) reporter.fail(args[1] ?? node, `Owner<…, "base58">: "${text}" is not a valid base58 Solana address`);
    out.owner = { base58: text!, bytes: [...bytes] };
  }
  if (name === "Executable") out.executable = true;
  if (name === "Address") {
    const text = lit(args[1])[0];
    const bytes = text === undefined ? undefined : decodeAddress(text);
    if (!bytes) reporter.fail(args[1] ?? node, `Address<…, "base58">: "${text}" is not a valid base58 Solana address`);
    out.address = { base58: text!, bytes: [...bytes] };
  }
  if (name === "Ata") {
    const [owner] = lit(args[1]);
    const [mint] = lit(args[2]);
    if (!owner || !mint) reporter.fail(node, 'Ata<TokenAccount, "ownerParam", "mintParam">');
    out.ata = { owner, mint };
  }
  if (name === "Seeds") {
    const tuple = args[1];
    if (!tuple || !ts.isTupleTypeNode(tuple)) reporter.fail(node, 'Seeds<Account, ["seed", "owner"], "bump"> needs a tuple of string literals');
    const names = tuple.elements.flatMap((e) => lit(e as ts.TypeNode));
    // `never` or "" means no bump field (e.g. to name a program in the fourth slot).
    const bump = args[2] && args[2].kind !== ts.SyntaxKind.NeverKeyword ? lit(args[2])[0] || undefined : undefined;
    const program = args[3] ? lit(args[3])[0] : undefined;
    if (program && !program.startsWith("@") && !decodeAddress(program))
      reporter.fail(args[3], `Seeds program: "${program}" is neither "@param" nor a base58 address`);
    out.seeds = { names, bump, program };
  }
  if (!args[0]) reporter.fail(node, `${name}<…> wraps an account type`);
  return unwrapConstraints(args[0], reporter, imports, out);
}

function resolveAccountKind(node: ts.TypeNode, reporter: Reporter, imports: Map<string, string>, structs: Map<string, StructDef>): ParamKind {
  const outer = typesolName(node, imports);
  const ref = node as ts.TypeReferenceNode;
  const inner = (): ts.TypeNode => {
    if (ref.typeArguments?.length !== 1) reporter.fail(node, `${outer}<...> takes exactly one type argument`);
    return ref.typeArguments[0];
  };
  const structOf = (t: ts.TypeNode): StructDef | undefined => {
    const s = ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName) ? structs.get(t.typeName.text) : undefined;
    if (s && s.size === undefined) reporter.fail(t, `${s.name} has a variable-length string field and cannot be account data; use FixedString<N>`);
    return s;
  };

  switch (outer) {
    case "Signer":
      return { kind: "signer", mut: false };
    case "AccountInfo":
    // Any account (helpers that accept every kind, e.g. generated CPI helpers).
    case "AccountMeta":
      return { kind: "info", mut: false };
    case "SystemAccount":
      return { kind: "info", mut: false, systemOwned: true };
    case "TokenAccount":
      return { kind: "token", mut: false };
    case "Mint":
      return { kind: "mint", mut: false };
    case "SystemProgram":
      return { kind: "system" };
    case "InstructionsSysvar":
      return { kind: "instructionsSysvar" };
    case "PythPriceUpdate":
      return { kind: "pyth" };
    case "ProgramData":
      return { kind: "programData" };
    case "EventAuthority":
      return { kind: "eventAuthority" };
    case "MplCoreProgram":
      return { kind: "coreProgram" };
    case "BubblegumProgram":
      return { kind: "bubblegumProgram" };
    case "SelfProgram":
      return { kind: "selfProgram" };
    case "AssociatedTokenProgram":
      return { kind: "ataProgram" };
    case "TokenMetadataProgram":
      return { kind: "metadataProgram" };
    case "SwitchboardFeed": {
      const arg = ref.typeArguments?.[0];
      const cluster = arg && ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal) ? arg.literal.text : "mainnet";
      if (cluster !== "mainnet" && cluster !== "devnet") reporter.fail(node, 'SwitchboardFeed<"mainnet" | "devnet">');
      return { kind: "switchboard", devnet: cluster === "devnet" };
    }
    case "TokenProgram":
      return { kind: "tokenProgram", flavor: "token" };
    case "Token2022Program":
      return { kind: "tokenProgram", flavor: "token2022" };
    case "TokenInterface":
      return { kind: "tokenProgram", flavor: "tokenInterface" };
    case "UncheckedProgram":
      return { kind: "program" };
    case "Program": {
      const arg = ref.typeArguments?.[0];
      if (!arg || !ts.isLiteralTypeNode(arg) || !ts.isStringLiteral(arg.literal))
        reporter.fail(node, 'pin the program address: Program<"Address...">, or use UncheckedProgram and check .key yourself');
      const bytes = decodeAddress(arg.literal.text);
      if (!bytes) reporter.fail(arg, `"${arg.literal.text}" is not a valid base58 Solana address`);
      return { kind: "program", address: { base58: arg.literal.text, bytes: [...bytes] } };
    }
    case "Account": {
      const s = structOf(inner());
      if (!s) reporter.fail(node, "Account<T> needs a struct declared in this program");
      return { kind: "account", struct: s, mut: false };
    }
    case "Init": {
      if (typesolName(inner(), imports) === "TokenAccount") return { kind: "token", mut: true, init: "create" };
      if (typesolName(inner(), imports) === "Mint") return { kind: "mint", mut: true, init: "create" };
      const s = structOf(inner());
      if (!s) reporter.fail(node, "Init<T> needs a struct declared in this program, TokenAccount or Mint");
      if (s.size! + 8 > MAX_CPI_ALLOCATION)
        reporter.fail(
          node,
          `${s.name} needs ${s.size! + 8} bytes but a program can create at most ${MAX_CPI_ALLOCATION} through Init<T>; have the client allocate it and take it as Zeroed<${s.name}>`,
        );
      return { kind: "init", struct: s };
    }
    case "InitIfNeeded": {
      if (typesolName(inner(), imports) === "TokenAccount") return { kind: "token", mut: true, init: "ifNeeded" };
      if (typesolName(inner(), imports) === "Mint") return { kind: "mint", mut: true, init: "ifNeeded" };
      const s = structOf(inner());
      if (!s) reporter.fail(node, "InitIfNeeded<T> needs a struct declared in this program");
      if (s.size! + 8 > MAX_CPI_ALLOCATION) reporter.fail(node, `${s.name} is too large to create in a program; use Zeroed<${s.name}>`);
      return { kind: "initIfNeeded", struct: s };
    }
    case "Zeroed": {
      const s = structOf(inner());
      if (!s) reporter.fail(node, "Zeroed<T> needs a struct declared in this program");
      if (s.vec) reporter.fail(node, `${s.name} ends in a Vec; Zeroed<T> is for fixed-size (large) accounts`);
      if (s.layout === "borsh") reporter.fail(node, `${s.name} is @layout borsh; Zeroed<T> reads large accounts in place, so it takes fixed layouts only`);
      return { kind: "zeroed", struct: s };
    }
    case "Mut": {
      const t = inner();
      const s = structOf(t);
      if (s) return { kind: "account", struct: s, mut: true };
      const innerName = typesolName(t, imports);
      if (innerName === "Signer") return { kind: "signer", mut: true };
      if (innerName === "AccountInfo" || innerName === "AccountMeta") return { kind: "info", mut: true };
      if (innerName === "SystemAccount") return { kind: "info", mut: true, systemOwned: true };
      if (innerName === "TokenAccount") return { kind: "token", mut: true };
      if (innerName === "Mint") return { kind: "mint", mut: true };
      reporter.fail(t, "Mut<T> takes a struct, Signer, AccountInfo, TokenAccount or Mint");
    }
  }
  reporter.fail(
    node,
    "parameter type must be an integer, boolean, Pubkey, string, or an account type (Signer, Account<T>, Mut<T>, Init<T>, AccountInfo, TokenAccount, Mint, SystemProgram, TokenProgram, Token2022Program, TokenInterface, Program<...>)",
  );
}

export { isScalar };
