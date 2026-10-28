import ts from "typescript";
import { type Analysis, type TypeScope, calleeName, resolveScalarType } from "../analyze.js";
import type { Reporter } from "../diagnostics.js";
import {
  type AccountParam,
  type GenericHelper,
  type Helper,
  type IdlSeed,
  type Instruction,
  type ProgramModel,
  type ScalarType,
  type ValueType,
  isScalar,
} from "../model.js";
import { type Value, type Local, type Closure, isStable, cString, valueC, type EmitOptions } from "./shared.js";

/**
 * State of one function being lowered, and the primitives every layer uses: emitting lines, temporaries,
 * scopes, evaluation-order snapshots and account lookups.
 */
export abstract class EmitterBase {
  protected readonly reporter: Reporter;
  protected readonly model: ProgramModel;
  protected readonly imports: Map<string, string>;
  protected readonly accounts = new Map<string, AccountParam>();
  protected readonly args = new Map<string, Local>();
  protected scopes: Map<string, Local>[] = [];
  protected lines: string[] = [];
  /** Declarations placed at the top of the function (buffers reused by every pass through a loop). */
  protected hoisted: string[] = [];
  protected indent = 1;
  protected temp = 0;
  /** Init accounts whose create() has run (top-level, in order). */
  protected readonly created = new Set<string>();
  protected readonly pendingInit = new Set<string>();
  /** Bump temporaries from create()/createIfNeeded(), for `acct.pdaBump`. */
  protected readonly bumps = new Map<string, string>();
  /** Closures being expanded, innermost last: a `return` inside one assigns `result` and jumps to `label`. */
  protected inlineFrames: { label: string; result: string; type?: ValueType; declAt: number; pad: string; node: ts.Node }[] = [];
  /** Closures being expanded (a closure calling itself cannot be expanded). */
  protected readonly inlining = new Set<ts.Node>();
  /** Enclosing loops, innermost last; each has a `continue` label. */
  protected readonly loops: string[] = [];
  protected readonly ix: Instruction | undefined;
  protected readonly helper: Helper | undefined;
  protected readonly scope: TypeScope;
  protected readonly checker: ts.TypeChecker;
  protected readonly analysis: Analysis;
  /** Calls already resolved to a helper (a generic one's instance is found by probing its arguments). */
  private readonly calleeCache = new Map<ts.CallExpression, Helper | null>();

  /** `file.ts:line` of the statement being lowered. */
  protected where: string | undefined;
  protected readonly profile: boolean;

  constructor(analysis: Analysis, target: Instruction | Helper, opts: EmitOptions = {}) {
    this.profile = !!opts.profile;
    this.reporter = analysis.reporter;
    this.model = analysis.model;
    // Each function resolves `typesol` names through its own file's imports.
    this.imports = target.imports;
    this.scope = {
      imports: target.imports,
      enums: analysis.model.enums,
      options: analysis.model.options,
      dataEnums: analysis.model.dataEnums,
      typeArgs: "accounts" in target ? undefined : target.typeArgs,
    };
    this.checker = analysis.checker;
    this.analysis = analysis;
    if ("accounts" in target) {
      this.ix = target;
      for (const a of target.accounts) {
        this.accounts.set(a.name, a);
        if (a.kind.kind === "init" || a.kind.kind === "initIfNeeded" || ((a.kind.kind === "token" || a.kind.kind === "mint") && a.kind.init))
          this.pendingInit.add(a.name);
      }
      for (const a of target.args)
        this.args.set(
          a.name,
          a.type.kind === "dataEnumArg"
            ? { c: `arg_${a.name}`, type: { kind: "enumRef", name: a.type.name, writable: false }, mutable: false }
            : a.type.kind === "arrayArg"
              ? { c: `(*arg_${a.name})`, type: a.type.array, mutable: false, readonly: true }
              : { c: `arg_${a.name}`, type: a.type, mutable: false },
        );
    } else {
      this.helper = target;
      for (const p of target.params) {
        if (p.account) this.accounts.set(p.name, { name: p.name, index: -1, kind: p.account, node: p.node, constraints: { hasOne: [] } });
        else if (p.type.kind === "arrayArg") this.args.set(p.name, { c: `(*p_${p.name})`, type: p.type.array, mutable: false, readonly: true });
        else if (p.type.kind === "dataEnumArg")
          this.args.set(p.name, { c: `p_${p.name}`, type: { kind: "enumRef", name: p.type.name, writable: false }, mutable: false });
        else this.args.set(p.name, { c: `p_${p.name}`, type: p.type, mutable: false });
      }
    }
  }

  /** The helper a call runs: a function, a const arrow function (top-level or local), or a generic one's instance. */
  protected helperOf(node: ts.CallExpression): Helper | undefined {
    if (!ts.isIdentifier(node.expression)) return undefined;
    const cached = this.calleeCache.get(node);
    if (cached !== undefined) return cached ?? undefined;
    const callee = node.expression;
    // A function parameter of this helper instance: the function it was given.
    const passed = this.helper?.fnArgs?.get(callee.text);
    const name = passed ?? calleeName(callee, this.model.helperDecls, this.checker) ?? (this.lookup(callee.text) ? undefined : callee.text);
    const g = name ? this.model.generics.get(name) : undefined;
    let h = name ? this.model.helpers.get(name) : undefined;
    if (g) h = this.analysis.instantiate(g, g.typeParams.length ? this.typeArgsOf(node, g) : [], this.fnArgsOf(node, g));
    else if (h && node.typeArguments) this.fail(node, `${h.display} takes no type arguments`);
    this.calleeCache.set(node, h ?? null);
    return h;
  }

  /**
   * The functions passed for a helper's function parameters: named functions only (a helper, or a local function that
   * captures nothing). A closure can only run where it is declared, so it cannot be passed.
   */
  private fnArgsOf(node: ts.CallExpression, g: GenericHelper): string[] {
    return g.fnParams.map((i) => {
      const arg = node.arguments[i];
      const pname = (g.node.parameters[i]!.name as ts.Identifier).text;
      if (!arg || !ts.isIdentifier(arg)) this.fail(arg ?? node, `pass ${g.display}'s ${pname} a named function (declare it: const f = (…) => …)`);
      const passed = this.helper?.fnArgs?.get(arg.text);
      if (passed) return passed;
      if (this.lookup(arg.text)?.closure)
        this.fail(arg, `${arg.text} reads the variables of the function around it, so it can only be called there, not passed to ${g.display}`);
      const name = calleeName(arg, this.model.helperDecls, this.checker) ?? arg.text;
      if (this.model.generics.has(name)) this.fail(arg, `${arg.text} is generic or takes functions itself: pass a plain function`);
      if (!this.model.helpers.has(name)) this.fail(arg, `${arg.text} is not a function of this program`);
      return name;
    });
  }

  /** A generic call's type arguments: written out (`max<u64>(a, b)`), or the types of the arguments in `T` positions. */
  private typeArgsOf(node: ts.CallExpression, g: GenericHelper): ScalarType[] {
    const usage = `write ${g.display}<u64>(…) with the types`;
    if (node.typeArguments) {
      if (node.typeArguments.length !== g.typeParams.length) this.fail(node, `${g.display} takes ${g.typeParams.length} type argument(s)`);
      return node.typeArguments.map((t) => resolveScalarType(t, this.scope) ?? this.fail(t, "type arguments are integers, boolean, Pubkey or enums"));
    }
    return g.typeParams.map((tp) => {
      for (const [i, p] of g.node.parameters.entries()) {
        const arg = node.arguments[i];
        if (!arg || !p.type || !ts.isTypeReferenceNode(p.type) || !ts.isIdentifier(p.type.typeName) || p.type.typeName.text !== tp || p.type.typeArguments)
          continue;
        // Type the argument without emitting it: it is lowered again, once, by the call.
        const saved = { lines: this.lines.length, hoisted: this.hoisted.length, temp: this.temp, diagnostics: this.reporter.diagnostics.length };
        const probe = this.reporter.guard(() => this.expr(arg));
        this.lines.length = saved.lines;
        this.hoisted.length = saved.hoisted;
        this.temp = saved.temp;
        this.reporter.diagnostics.length = saved.diagnostics;
        if (!probe || probe.literal !== undefined || probe.isNull) continue;
        if (!isScalar(probe.type as never)) this.fail(arg, `${tp} stands for an integer, boolean, Pubkey or enum, not ${probe.type.kind}`);
        const t = probe.type as ScalarType;
        return t.kind === "pubkey" ? (t.hash ? { kind: "pubkey", hash: true } : { kind: "pubkey" }) : t;
      }
      return this.fail(node, `cannot tell what ${tp} is from literal arguments; ${usage}`);
    });
  }

  protected line(s: string) {
    // Runtime failures name the TypeScript line they come from: "TypeSOL: arithmetic overflow (vault.ts:42)".
    if (this.where) s = s.replace(/"TypeSOL: ((?:[^"\\]|\\.)*)"\)/g, (_, msg: string) => `"TypeSOL: ${msg} (${cString(this.where!).slice(1, -1)})")`);
    // `*(&a_x->key)` reads the key in place: write it as `a_x->key`.
    s = s.replace(/\*\(&(\w+->(?:key|owner))\)/g, "$1");
    this.lines.push("  ".repeat(this.indent) + s);
  }

  /** `file.ts:line` of a node, for messages. */
  protected location(node: ts.Node): string {
    const sf = node.getSourceFile();
    return `${sf.fileName.split("/").pop()}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
  }

  protected tmp(prefix = "t"): string {
    return `${prefix}${this.temp++}`;
  }

  /**
   * JS evaluates operands left to right, but a lowered Value is a C expression read where it is used.
   * When lowering a later operand emitted statements (from line `mark` on, e.g. a pop() or a helper call),
   * copy an earlier operand that reads storage into a temporary just before them, so it sees the old state.
   */
  protected settle(v: Value, mark: number): Value {
    if (this.lines.length === mark || v.isNull || v.literal !== undefined || v.stringLiteral !== undefined) return v;
    if (isStable(v.c)) return v;
    const t = this.tmp("snap");
    const pad = "  ".repeat(this.indent);
    const decl: string[] = [];
    let out: Value;
    switch (v.type.kind) {
      case "pubkey":
        decl.push(`SolPubkey ${t} = *(${v.c});`);
        out = { c: `(&${t})`, type: v.type };
        break;
      case "string":
        // A view of account text: copy the bytes, not just the view.
        if (v.c.startsWith("ts_fstr_view")) decl.push(`TS_Str ${t};`, `TS_TRY(ts_str_copy(${v.c}, &${t}));`);
        else decl.push(`TS_Str ${t} = ${v.c};`);
        out = { c: t, type: v.type };
        break;
      case "int":
      case "bool":
      case "enum":
      case "option":
        decl.push(`${valueC(v.type)} ${t} = ${v.c};`);
        out = { c: t, type: v.type };
        break;
      default:
        return v; // handles and references: pointers that later operands do not move
    }
    this.lines.splice(mark, 0, ...decl.map((l) => pad + l));
    return out;
  }

  /** A string that stays valid when account data changes: views of account text are copied to the heap. */
  protected ownedString(v: Value): Value {
    if (v.type.kind !== "string" || !v.c.startsWith("ts_fstr_view")) return v;
    const t = this.tmp("str");
    this.line(`TS_Str ${t};`);
    this.line(`TS_TRY(ts_str_copy(${v.c}, &${t}));`);
    return { c: t, type: v.type };
  }

  /** Reject `a?.b` / `f?.()`: there is no undefined in TypeSOL. */
  protected noOptionalChain(node: ts.Node) {
    if ((ts.isPropertyAccessExpression(node) || ts.isCallExpression(node) || ts.isElementAccessExpression(node)) && node.questionDotToken)
      this.fail(node, "optional chaining (?.) is not supported; check `x !== null` first");
    if (ts.isNonNullExpression(node)) this.fail(node, "the ! assertion works on Option values only; check `x !== null` so TypeScript narrows it");
  }

  protected lookup(name: string): Local | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const l = this.scopes[i].get(name);
      if (l) return l;
    }
    return this.args.get(name);
  }

  protected block(fn: () => void) {
    this.scopes.push(new Map());
    this.indent++;
    fn();
    this.indent--;
    this.scopes.pop();
  }

  protected fail(node: ts.Node, message: string): never {
    return this.reporter.fail(node, message);
  }

  protected exportName(node: ts.Expression): string | undefined {
    return ts.isIdentifier(node) ? this.imports.get(node.text) : undefined;
  }

  protected accountParam(node: ts.Expression, what: string): AccountParam {
    if (!ts.isIdentifier(node)) this.fail(node, `${what} must be an account parameter`);
    const a = this.accounts.get(node.text);
    if (!a) this.fail(node, `${what} must be an account parameter, "${node.text}" is not one`);
    this.assertUsable(a, node);
    return a;
  }

  protected assertUsable(a: AccountParam, node: ts.Node) {
    // TypeScript makes you check `x !== null` first; this is the runtime backstop.
    if (a.optional) this.line(`if (a_${a.name} == NULL) TS_FAIL(TS_ERR_ACCOUNT_MISSING, "TypeSOL: optional account ${a.name} was not passed");`);
    const createdBy =
      a.kind.kind === "init"
        ? "create"
        : a.kind.kind === "initIfNeeded"
          ? "createIfNeeded"
          : (a.kind.kind === "token" || a.kind.kind === "mint") && a.kind.init
            ? a.kind.init === "create"
              ? "create"
              : "createIfNeeded"
            : undefined;
    if (createdBy && !this.created.has(a.name)) this.fail(node, `"${a.name}" is used before ${a.name}.${createdBy}(...) runs`);
  }

  // ---- implemented by later layers --------------------------------------------------

  protected abstract expect(v: Value, want: ValueType | undefined, node: ts.Node): Value;
  protected abstract literal(value: bigint, type: ValueType, node: ts.Node): Value;
  protected abstract expr(node: ts.Expression, hint?: ValueType): Value;
  protected abstract call(node: ts.CallExpression, topLevel: boolean): Value | undefined;
  protected abstract isRemaining(node: ts.Expression): boolean;
  protected abstract handle(node: ts.Expression): string | undefined;
  protected abstract seeds(node: ts.Expression, extra: number): { name: string; count: number; idl: IdlSeed[] | undefined };
  protected abstract recordPda(account: AccountParam, idl: IdlSeed[] | undefined): void;
  protected abstract create(node: ts.CallExpression, target: AccountParam, topLevel: boolean, ifNeeded?: boolean): Value;
  protected abstract createAta(node: ts.CallExpression, target: AccountParam, topLevel: boolean): Value | undefined;
  protected abstract createToken(node: ts.CallExpression, target: AccountParam, topLevel: boolean): Value;
  protected abstract systemTransfer(node: ts.CallExpression): undefined;
  protected abstract createAccount(node: ts.CallExpression, system: AccountParam): undefined;
  protected abstract tokenOp(node: ts.CallExpression, program: AccountParam, method: string): undefined;
  protected abstract ataOp(node: ts.CallExpression, program: AccountParam, method: string): undefined;
  protected abstract metadataOp(node: ts.CallExpression, program: AccountParam, method: string): undefined;
  protected abstract coreOp(node: ts.CallExpression, core: AccountParam, method: string): undefined;
  protected abstract bubblegumOp(node: ts.CallExpression, bg: AccountParam, method: string): undefined;
  protected abstract invoke(node: ts.CallExpression): undefined;
  protected abstract emitEvent(node: ts.CallExpression, cpi?: { authority: string; program: string }): undefined;
  protected abstract epilogue(): string[];
  protected abstract expandClosure(c: Closure, args: readonly ts.Expression[], node: ts.Node): Value | undefined;
  protected abstract listMethod(node: ts.CallExpression, method: string): Value | undefined;
}
