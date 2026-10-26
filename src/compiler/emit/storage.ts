import ts from "typescript";
import { resolveScalarType } from "../analyze.js";
import { INT_INFO, type FieldType, type ValueType, isScalar, isWritable, sameType, scalarSize, typeName } from "../model.js";
import { U64, BOOL, PUBKEY, STRING, type Value, type Ref, optC, fieldC, storageDecl } from "./shared.js";
import { EmitterBase } from "./base.js";

/**
 * Places in account data and locals: references, reads and writes, Vec/array indexing, aliasing rules and
 * argument validation.
 */
export abstract class StorageEmitter extends EmitterBase {
  /** C lines rejecting malformed fixed-layout data at `lv`: bools, enums, option tags, string lengths, enum tags. */
  protected validation(lv: string, t: FieldType, pad: string, fail = `TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSol: invalid argument data")`): string[] {
    switch (t.kind) {
      case "bool":
        return [`${pad}if (${lv} > 1) ${fail};`];
      case "enum":
        return [`${pad}if (${lv} >= ${this.model.enums.get(t.name)!.variants.length}) ${fail};`];
      case "fstring":
        return [`${pad}if (${lv}.len > ${t.cap} || !ts_utf8_valid(${lv}.bytes, ${lv}.len)) ${fail};`];
      case "option": {
        const sub = this.validation(`${lv}.v`, t.inner as FieldType, `${pad}  `, fail);
        return [
          `${pad}if (${lv}.some > 1 || (!${lv}.some && !ts_is_zero(&${lv}.v, sizeof(${lv}.v)))) ${fail};`,
          ...(sub.length ? [`${pad}if (${lv}.some) {`, ...sub, `${pad}}`] : []),
        ];
      }
      case "struct":
        return this.model.structs.get(t.name)!.fields.flatMap((f) => this.validation(`${lv}.${f.name}`, f.type, pad, fail));
      case "array": {
        const i = this.tmp("vi");
        const sub = this.validation(`${lv}[${i}]`, t.elem, `${pad}  `, fail);
        return sub.length ? [`${pad}for (uint64_t ${i} = 0; ${i} < ${t.len}; ${i}++) {`, ...sub, `${pad}}`] : [];
      }
      case "dataEnum": {
        const e = this.model.dataEnums.get(t.name)!;
        const out = [`${pad}switch (${lv}.tag) {`];
        e.variants.forEach((v, i) => {
          out.push(`${pad}case ${i}: {`);
          for (const f of v.fields) out.push(...this.validation(`${lv}.v.${v.name}.${f.name}`, f.type, `${pad}  `, fail));
          out.push(`${pad}  break; }`);
        });
        out.push(`${pad}default: ${fail};`, `${pad}}`);
        return out;
      }
      default:
        return [];
    }
  }

  /** The variants TypeScript has narrowed a data-enum expression to (e.g. inside `if (a.kind === "X")`). */
  protected narrowedVariants(node: ts.Expression): string[] {
    const t = this.checker.getTypeAtLocation(node);
    const kinds = new Set<string>();
    for (const member of t.isUnion() ? t.types : [t]) {
      const prop = member.getProperty("kind");
      const pt = prop && this.checker.getTypeOfSymbolAtLocation(prop, node);
      if (pt?.isStringLiteral()) kinds.add(pt.value);
      else if (pt?.isUnion()) pt.types.forEach((x) => x.isStringLiteral() && kinds.add(x.value));
    }
    if (kinds.size === 0) this.fail(node, 'cannot tell which variant this is; narrow it with if (x.kind === "…") or switch (x.kind)');
    return [...kinds];
  }

  /** `x.kind` where x is a data-enum place: returns the place, else undefined. */
  protected kindOf(node: ts.Expression): Ref | undefined {
    if (!ts.isPropertyAccessExpression(node) || node.name.text !== "kind") return undefined;
    if (!this.looksLikeDataEnum(node.expression)) return undefined;
    const r = this.ref(node.expression);
    return r?.type.kind === "dataEnum" ? r : undefined;
  }

  protected looksLikeDataEnum(node: ts.Expression): boolean {
    const saved = { lines: this.lines.length, temp: this.temp, diagnostics: this.reporter.diagnostics.length };
    try {
      return this.reporter.guard(() => this.ref(node))?.type.kind === "dataEnum";
    } finally {
      this.lines.length = saved.lines;
      this.temp = saved.temp;
      this.reporter.diagnostics.length = saved.diagnostics;
    }
  }

  protected variantIndex(enumName: string, lit: ts.Expression): number {
    const e = this.model.dataEnums.get(enumName)!;
    if (!ts.isStringLiteral(lit)) this.fail(lit, `compare ${enumName}.kind with a string literal variant name`);
    const i = e.variants.findIndex((v) => v.name === lit.text);
    if (i < 0) this.fail(lit, `${enumName} has no variant "${lit.text}"`);
    return i;
  }

  /**
   * Storage paths an expression names, syntactically: `acct.a.b` -> ["acct.a.b"], `v.get(i)` -> ["v[]"],
   * a reference local -> the paths it aliases, a ternary -> both sides. Undefined when unknown.
   */
  protected pathsOf(node: ts.Expression): string[] | undefined {
    if (ts.isParenthesizedExpression(node)) return this.pathsOf(node.expression);
    if (ts.isIdentifier(node)) {
      const l = this.lookup(node.text);
      if (l) return l.paths ?? (l.type.kind === "array" ? [`@${l.c}`] : undefined);
      return this.accounts.has(node.text) ? [node.text] : undefined;
    }
    if (ts.isPropertyAccessExpression(node)) return this.pathsOf(node.expression)?.map((p) => `${p}.${node.name.text}`);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "get")
      return this.pathsOf(node.expression.expression)?.map((p) => `${p}[]`);
    if (ts.isConditionalExpression(node)) {
      const a = this.pathsOf(node.whenTrue);
      const b = this.pathsOf(node.whenFalse);
      return a && b ? [...a, ...b] : undefined;
    }
    return undefined;
  }

  /**
   * In JS, replacing an object (`acct.pos = {...}`, `v.set(i, {...})`, `v.pop()`) leaves earlier references
   * to the old object unchanged. Here a reference is a pointer into account data, so it would see the new
   * value. Refuse when a live reference into the replaced place is still used afterwards.
   */
  protected assertNotAliased(replaced: string[] | undefined, at: ts.Node, helper?: string) {
    if (!replaced) return;
    for (const scope of this.scopes)
      for (const [name, l] of scope) {
        if (!l.paths || !l.decl) continue;
        const hit = replaced.find((r) => l.paths!.some((p) => p === r || p.startsWith(`${r}.`) || p.startsWith(`${r}[]`)));
        if (!hit || !this.usedAfter(l.decl, at)) continue;
        this.fail(
          at,
          helper
            ? `"${name}" still refers to data in ${hit}, and ${helper}() may replace it (then "${name}" would read the new value; in JS it keeps the old one). Copy the fields you need into locals first`
            : `"${name}" still refers to ${hit}; replacing it here would change what "${name}" reads (in JS it keeps the old value). Copy the fields you need into locals first`,
        );
      }
  }

  /** Whether the variable declared by `decl` is read after `at` (later in its block, or anywhere in a loop around `at`). */
  protected usedAfter(decl: ts.VariableDeclaration, at: ts.Node): boolean {
    const symbol = this.checker.getSymbolAtLocation(decl.name);
    if (!symbol) return true;
    // Loops around `at` that do not also contain the declaration run their earlier statements again later.
    let loop: ts.Node | undefined;
    for (let n: ts.Node | undefined = at.parent; n && n !== decl.parent; n = n.parent)
      if ((ts.isForStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n)) && !(decl.pos >= n.pos && decl.end <= n.end)) loop = n;
    let found = false;
    const scope = decl.parent.parent.parent; // VariableDeclaration -> List -> Statement -> enclosing block
    const visit = (n: ts.Node) => {
      if (found) return;
      if (ts.isIdentifier(n) && n !== decl.name && this.checker.getSymbolAtLocation(n) === symbol) {
        if (n.pos >= at.end || (loop && n.pos >= loop.pos && n.end <= loop.end)) found = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(scope);
    return found;
  }

  /**
   * A pointer to a struct in storage, from `place` or `cond ? placeA : placeB` (same struct type).
   * Returns undefined when the expression is not such a place.
   */
  protected structPlace(node: ts.Expression): { ptr: string; struct: string; writable: boolean } | undefined {
    if (ts.isParenthesizedExpression(node)) return this.structPlace(node.expression);
    if (ts.isConditionalExpression(node)) {
      if (!this.looksLikeStructPlace(node.whenTrue) || !this.looksLikeStructPlace(node.whenFalse)) return undefined;
      const cond = this.expect(this.expr(node.condition, BOOL), BOOL, node.condition);
      const t = this.tmp("sel");
      const declAt = this.lines.length;
      this.line(`/* ${t} */`);
      this.line(`if (${cond.c}) {`);
      let a: { ptr: string; struct: string; writable: boolean } | undefined;
      let b: typeof a;
      this.block(() => {
        a = this.structPlace(node.whenTrue);
        if (a) this.line(`${t} = ${a.ptr};`);
      });
      this.line(`} else {`);
      this.block(() => {
        b = this.structPlace(node.whenFalse);
        if (b) this.line(`${t} = ${b.ptr};`);
      });
      this.line(`}`);
      if (!a || !b || a.struct !== b.struct) this.fail(node, "both branches must be the same kind of struct");
      this.lines[declAt] = this.lines[declAt].replace(`/* ${t} */`, `TSS_${a.struct} *${t};`);
      return { ptr: t, struct: a.struct, writable: a.writable && b.writable };
    }
    if (!this.looksLikeStructPlace(node)) return undefined;
    const r = this.ref(node);
    if (!r || r.type.kind !== "struct") return undefined;
    return { ptr: `(&${r.lv})`, struct: r.type.name, writable: r.writable };
  }

  /** Cheap syntactic pre-check (no code emitted) for struct places. */
  protected looksLikeStructPlace(node: ts.Expression): boolean {
    if (ts.isParenthesizedExpression(node)) return this.looksLikeStructPlace(node.expression);
    if (ts.isConditionalExpression(node)) return this.looksLikeStructPlace(node.whenTrue) && this.looksLikeStructPlace(node.whenFalse);
    const saved = { lines: this.lines.length, temp: this.temp, diagnostics: this.reporter.diagnostics.length };
    try {
      const r = this.reporter.guard(() => this.ref(node));
      return r?.type.kind === "struct";
    } finally {
      this.lines.length = saved.lines;
      this.temp = saved.temp;
      this.reporter.diagnostics.length = saved.diagnostics;
    }
  }

  /** `fixedArray<T, N>(fill)` as a local declaration. */
  protected localArray(init: ts.CallExpression, c: string): FieldType & { kind: "array" } {
    const [elemNode, lenNode] = init.typeArguments ?? [];
    const elem = elemNode && resolveScalarType(elemNode, this.scope);
    if (!elem) this.fail(init, "fixedArray<T, N>(fill): T must be an integer, boolean or Pubkey");
    const len = lenNode && ts.isLiteralTypeNode(lenNode) && ts.isNumericLiteral(lenNode.literal) ? Number(lenNode.literal.text) : NaN;
    if (!Number.isInteger(len) || len < 1 || len > 256) this.fail(init, "fixedArray<T, N>: N must be a literal 1..256 (locals live on the 4KB stack)");
    if (init.arguments.length !== 1) this.fail(init, "fixedArray<T, N>(fill) takes the fill value");
    const fill = this.expect(this.expr(init.arguments[0], elem), elem, init.arguments[0]);
    const type: FieldType & { kind: "array" } = { kind: "array", elem, len };
    this.line(`${storageDecl(type, c)};`);
    const i = this.tmp("i");
    this.line(`for (uint64_t ${i} = 0; ${i} < ${len}; ${i}++) ${this.writeStorage({ lv: `${c}[${i}]`, type: elem, writable: true }, fill.c)};`);
    return type;
  }

  /** Resolve an expression to a storage location, if it names one. */
  protected ref(node: ts.Expression): Ref | undefined {
    if (ts.isParenthesizedExpression(node)) return this.ref(node.expression);
    this.noOptionalChain(node);
    if (ts.isIdentifier(node)) {
      const l = this.lookup(node.text);
      if (l && l.type.kind === "array") return { lv: l.c, type: l.type, writable: !l.readonly };
      // A struct loaded from a remaining account.
      if (l && l.type.kind === "structRef") return { lv: `(*${l.c})`, type: { kind: "struct", name: l.type.struct }, writable: l.type.writable };
      if (l && l.type.kind === "enumRef") return { lv: `(*${l.c})`, type: { kind: "dataEnum", name: l.type.name }, writable: l.type.writable };
      return undefined;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const field = node.name.text;
      // acct.field on a struct account
      if (ts.isIdentifier(node.expression)) {
        const a = this.accounts.get(node.expression.text);
        if (a && (a.kind.kind === "account" || a.kind.kind === "init" || a.kind.kind === "zeroed" || a.kind.kind === "initIfNeeded")) {
          const f = a.kind.struct.fields.find((x) => x.name === field);
          if (!f) return undefined;
          this.assertUsable(a, node);
          const r: Ref = { lv: `d_${a.name}->${f.name}`, type: f.type, writable: isWritable(a.kind), account: a, path: [f.name] };
          if (f.type.kind === "vec")
            // Growing needs the account's length at instruction entry: only instructions know it.
            r.vec = {
              len: `d_${a.name}->${f.name}__len`,
              fixed: `sizeof(TSS_${a.kind.struct.name})`,
              elemSize: a.kind.struct.vec!.elemSize,
              resizable: isWritable(a.kind) && !!this.ix,
            };
          return r;
        }
      }
      // ref.field on a nested struct (or a loaded account)
      const base = this.ref(node.expression);
      if (base && base.type.kind === "dataEnum" && field !== "kind") {
        const e = this.model.dataEnums.get(base.type.name)!;
        const names = this.narrowedVariants(node.expression);
        // Several variants are fine when the field sits at the same offset with the same type in each.
        const located = names.map((n) => {
          const vi = e.variants.findIndex((v) => v.name === n);
          const fields = e.variants[vi]?.fields ?? [];
          const at = fields.findIndex((x) => x.name === field);
          const offset = fields.slice(0, Math.max(at, 0)).reduce((sum, x) => sum + this.fieldBytes(x.type), 0);
          return { vi, name: n, f: fields[at], offset };
        });
        if (located.some((l) => !l.f)) this.fail(node.name, `"${field}" is not a field of ${names.map((n) => `${e.name}.${n}`).join(" / ")}`);
        const first = located[0];
        if (located.some((l) => l.offset !== first.offset || !sameType(l.f.type, first.f.type)))
          this.fail(node, `narrow this ${e.name} to one variant first: "${field}" is laid out differently in ${names.join(" and ")}`);
        // TypeScript proved the variant set; this runtime check is the backstop.
        const cond = located.map((l) => `${base.lv}.tag != ${l.vi}`).join(" && ");
        this.line(`if (${cond}) TS_FAIL(TS_ERR_ENUM_VARIANT, "TypeSol: ${e.name} is not ${names.join("/")}");`);
        return { ...base, lv: `${base.lv}.v.${first.name}.${first.f.name}`, type: first.f.type, path: undefined, vec: undefined };
      }
      if (base && base.type.kind === "option" && base.type.inner.kind === "struct") {
        const s = this.model.structs.get(base.type.inner.name)!;
        const f = s.fields.find((x) => x.name === field);
        if (!f) this.fail(node.name, `${s.name} has no field "${field}"`);
        this.line(`if (!${base.lv}.some) TS_FAIL(TS_ERR_UNWRAP, "TypeSol: option is empty");`);
        return { ...base, lv: `${base.lv}.v.${f.name}`, type: f.type, path: undefined, vec: undefined };
      }
      if (base && base.type.kind === "struct") {
        const s = this.model.structs.get(base.type.name)!;
        const f = s.fields.find((x) => x.name === field);
        if (!f) this.fail(node.name, `${s.name} has no field "${field}"`);
        const r: Ref = { ...base, lv: `${base.lv}.${f.name}`, type: f.type, path: base.path && [...base.path, f.name], vec: undefined };
        // Vecs of loaded accounts can be read and updated in place but not resized (no entry length known).
        if (f.type.kind === "vec") r.vec = { len: `${base.lv}.${f.name}__len`, fixed: `sizeof(TSS_${s.name})`, elemSize: s.vec!.elemSize, resizable: false };
        return r;
      }
      return undefined;
    }
    // arr.get(i) / vec.get(i)
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "get") {
      const owner = node.expression.expression;
      const l = ts.isIdentifier(owner) ? this.lookup(owner.text) : undefined;
      if (l?.type.kind === "vecArg" && !isScalar(l.type.elem)) {
        // A Vec<Struct> argument: elements are read in place (validated when the instruction started).
        if (node.arguments.length !== 1) this.fail(node, "get(index) takes one argument");
        const idx = this.index(node.arguments[0], `(uint64_t)${l.c}.len`);
        return { lv: `((${fieldC(l.type.elem)} *)${l.c}.ptr)[${idx}]`, type: l.type.elem, writable: false };
      }
      const base = this.ref(node.expression.expression);
      if (base && (base.type.kind === "array" || base.type.kind === "vec")) {
        if (node.arguments.length !== 1) this.fail(node, "get(index) takes one argument");
        const idx = this.index(node.arguments[0], base.type.kind === "array" ? `${base.type.len}ULL` : `(uint64_t)${base.vec!.len}`);
        return { ...base, lv: `${base.lv}[${idx}]`, type: base.type.elem, path: undefined, vec: undefined };
      }
    }
    return undefined;
  }

  /** An SPL COption<Pubkey> (u32 tag + 32 bytes) at `at`, as an Option<Pubkey> value. */
  protected coptionKey(at: string): Value {
    const opt: ValueType = { kind: "option", inner: PUBKEY };
    this.model.options.set("pubkey", PUBKEY);
    const t = this.tmp("co");
    this.line(`${optC(PUBKEY)} ${t};`);
    this.line(`${t}.some = ts_read_le(${at}, 4) == 1;`);
    this.line(`if (${t}.some) ts_memcpy(&${t}.v, ${at} + 4, 32); else ts_memzero(&${t}.v, 32);`);
    return { c: t, type: opt };
  }

  /** Why a place cannot be written, naming what to change. */
  protected readOnly(r: Ref): string {
    if (r.account) return `"${r.account.name}" is read-only; declare it Mut<...>`;
    if (r.lv.startsWith("(*arg_") || r.lv.startsWith("arg_")) return "instruction arguments are read-only; copy the value into a local first";
    return "this is read-only: it was loaded with loadAccount() (use loadAccountMut()) or comes from a read-only account";
  }

  /** Lower call arguments left to right, settling earlier ones when a later one runs statements. */
  protected lowerInOrder(nodes: readonly ts.Expression[], types: ValueType[]): Value[] {
    const values: Value[] = [];
    nodes.forEach((n, i) => {
      const mark = this.lines.length;
      const v = this.expect(this.expr(n, types[i]), types[i], n);
      for (let j = 0; j < values.length; j++) values[j] = this.settle(values[j], mark);
      values.push(v);
    });
    return values;
  }

  /** An index evaluated into a temporary (sign and 128-bit range checked), bounds not yet checked. */
  protected indexValue(n: ts.Expression): string {
    const v = this.expr(n, U64);
    const idx = v.literal !== undefined ? this.literal(v.literal, U64, n) : v;
    if (idx.type.kind !== "int") this.fail(n, "array index must be an integer");
    const t = this.tmp("idx");
    if (INT_INFO[idx.type.name].signed) this.line(`if (${idx.c} < 0) TS_FAIL(TS_ERR_INDEX, "TypeSol: array index out of bounds");`);
    if (INT_INFO[idx.type.name].bytes === 16) this.line(`if (${idx.c} > UINT64_MAX) TS_FAIL(TS_ERR_INDEX, "TypeSol: array index out of bounds");`);
    this.line(`uint64_t ${t} = (uint64_t)(${idx.c});`);
    return t;
  }

  protected checkIndex(t: string, len: string) {
    this.line(`if (${t} >= ${len}) TS_FAIL(TS_ERR_INDEX, "TypeSol: array index out of bounds");`);
  }

  /** Bounds-checked index into a temporary. `len` is a C expression. */
  protected index(n: ts.Expression, len: string | number): string {
    const v = this.expr(n, U64);
    const idx = v.literal !== undefined ? this.literal(v.literal, U64, n) : v;
    if (idx.type.kind !== "int") this.fail(n, "array index must be an integer");
    const t = this.tmp("idx");
    if (INT_INFO[idx.type.name].signed) this.line(`if (${idx.c} < 0) TS_FAIL(TS_ERR_INDEX, "TypeSol: array index out of bounds");`);
    if (INT_INFO[idx.type.name].bytes === 16) this.line(`if (${idx.c} > UINT64_MAX) TS_FAIL(TS_ERR_INDEX, "TypeSol: array index out of bounds");`);
    this.line(`uint64_t ${t} = (uint64_t)(${idx.c});`);
    this.line(`if (${t} >= ${typeof len === "number" ? `${len}ULL` : len}) TS_FAIL(TS_ERR_INDEX, "TypeSol: array index out of bounds");`);
    return t;
  }

  /** Read a scalar or string from storage. */
  protected readStorage(r: Ref, node: ts.Node): Value {
    switch (r.type.kind) {
      case "int":
        return { c: r.lv, type: r.type };
      case "bool":
        return { c: `(${r.lv} != 0)`, type: BOOL };
      case "pubkey":
        return { c: `(&${r.lv})`, type: r.type };
      case "fstring":
        return { c: `ts_fstr_view((const uint8_t *)&${r.lv}, ${r.type.cap})`, type: STRING };
      case "enum":
        return { c: r.lv, type: r.type };
      case "option":
        // Option<struct> values only take part in `=== null` / `!== null`; fields are read through the place.
        return { c: r.lv, type: r.type as ValueType };
      case "dataEnum":
        this.fail(node, `this is a ${r.type.name}; compare .kind or read a field of the narrowed variant`);
      case "array":
      case "vec":
        this.fail(node, "this is a list; use .get(i), .set(i, v) or .length");
      case "struct":
        this.fail(node, `this is a ${r.type.name}; read one of its fields`);
      default:
        this.fail(node, "unsupported storage read");
    }
  }

  /** C statement (without `;`) writing a lowered value into storage. */
  protected writeStorage(r: Ref, c: string): string {
    switch (r.type.kind) {
      case "int":
        return `${r.lv} = ${c}`;
      case "bool":
        return `${r.lv} = (uint8_t)(${c})`;
      case "pubkey":
        return `${r.lv} = *(${c})`;
      case "fstring":
        return `TS_TRY(ts_fstr_set((uint8_t *)&${r.lv}, ${r.type.cap}, ${c}))`;
      case "enum":
      case "option":
        return `${r.lv} = ${c}`;
      default:
        throw new Error("unreachable: aggregate writes go through memcpy");
    }
  }

  protected storageValueType(t: FieldType): ValueType | undefined {
    if (isScalar(t)) return t;
    if (t.kind === "fstring") return STRING;
    if (t.kind === "option" && t.inner.kind !== "struct") return t as ValueType;
    return undefined;
  }

  /**
   * Write a struct or array into storage: from an object literal (field by field, every field
   * required) or by copying another location of the same type.
   */
  protected writeAggregate(target: Ref, valueNode: ts.Expression) {
    if (target.type.kind === "option" && target.type.inner.kind === "struct") {
      if (valueNode.kind === ts.SyntaxKind.NullKeyword) {
        this.line(`${target.lv}.some = 0;`);
        this.line(`ts_memzero(&${target.lv}.v, sizeof(${target.lv}.v));`);
        return;
      }
      // Another Option<same struct>: copy it whole (tag and value).
      const whole = ts.isObjectLiteralExpression(valueNode) ? undefined : this.ref(valueNode);
      if (whole && sameType(whole.type, target.type)) {
        this.line(`ts_copy(&${target.lv}, &${whole.lv}, sizeof(${target.lv}));`);
        return;
      }
      this.writeAggregate({ ...target, lv: `${target.lv}.v`, type: target.type.inner }, valueNode);
      this.line(`${target.lv}.some = 1;`);
      return;
    }
    if (target.type.kind === "dataEnum" && ts.isObjectLiteralExpression(valueNode)) {
      const e = this.model.dataEnums.get(target.type.name)!;
      const kindProp = valueNode.properties.find((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "kind") as
        ts.PropertyAssignment | undefined;
      if (!kindProp) this.fail(valueNode, `a ${e.name} literal needs kind: "Variant"`);
      const vi = this.variantIndex(e.name, kindProp.initializer);
      const variant = e.variants[vi];
      const given = new Map<string, ts.Expression>();
      for (const p of valueNode.properties) {
        if (p === kindProp) continue;
        if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) given.set(p.name.text, p.initializer);
        else if (ts.isShorthandPropertyAssignment(p)) given.set(p.name.text, p.name);
        else this.fail(p, "use plain `field: value` entries");
      }
      for (const k of given.keys()) if (!variant.fields.some((f) => f.name === k)) this.fail(valueNode, `${e.name}.${variant.name} has no field "${k}"`);
      // Build the new value in a temporary: its fields may read the old value of the target.
      const tmp = this.tmp("de");
      this.line(`TSE_${e.name} ${tmp};`);
      this.line(`ts_memzero(&${tmp}, sizeof(${tmp}));`);
      this.line(`${tmp}.tag = ${vi};`);
      for (const f of variant.fields) if (!given.has(f.name)) this.fail(valueNode, `missing field "${f.name}" of ${e.name}.${variant.name}`);
      // Fields are evaluated in source order, as in JS, straight into the temporary.
      for (const [name, ex] of given) {
        const f = variant.fields.find((x) => x.name === name)!;
        const sub: Ref = { lv: `${tmp}.v.${variant.name}.${f.name}`, type: f.type, writable: true };
        const vt = this.storageValueType(f.type);
        if (vt) this.line(this.writeStorage(sub, this.expect(this.expr(ex, vt), vt, ex).c) + ";");
        else this.writeAggregate(sub, ex);
      }
      this.line(`ts_memcpy(&${target.lv}, &${tmp}, sizeof(${tmp}));`);
      return;
    }
    if (ts.isObjectLiteralExpression(valueNode)) {
      if (target.type.kind !== "struct") this.fail(valueNode, `expected a ${typeName(target.type)}, not an object literal`);
      const s = this.model.structs.get(target.type.name)!;
      const given = new Map<string, ts.Expression>();
      for (const p of valueNode.properties) {
        if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) given.set(p.name.text, p.initializer);
        else if (ts.isShorthandPropertyAssignment(p)) given.set(p.name.text, p.name);
        else this.fail(p, "use plain `field: value` entries");
      }
      for (const k of given.keys()) if (!s.fields.some((f) => f.name === k)) this.fail(valueNode, `${s.name} has no field "${k}"`);
      // Build in a temporary so `p = { x: p.y, y: p.x }` reads the old values.
      const tmp = this.tmp("st");
      this.line(`TSS_${s.name} ${tmp};`);
      for (const f of s.fields) if (!given.has(f.name)) this.fail(valueNode, `missing field "${f.name}" of ${s.name}`);
      // Fields are evaluated in source order, as in JS, straight into the temporary.
      for (const [name, e] of given) {
        const f = s.fields.find((x) => x.name === name)!;
        const sub: Ref = { lv: `${tmp}.${f.name}`, type: f.type, writable: true };
        const vt = this.storageValueType(f.type);
        if (vt) this.line(this.writeStorage(sub, this.expect(this.expr(e, vt), vt, e).c) + ";");
        else this.writeAggregate(sub, e);
      }
      this.line(`ts_memcpy(&${target.lv}, &${tmp}, sizeof(${tmp}));`);
      return;
    }
    const src = this.ref(valueNode);
    if (!src || !sameType(src.type, target.type))
      this.fail(valueNode, `expected a ${typeName(target.type)}: an object literal or another ${typeName(target.type)}`);
    // Same-typed places are either distinct or identical (`a.p = a.p`); ts_copy skips the latter.
    this.line(`ts_copy(&${target.lv}, &${src.lv}, sizeof(${target.lv}));`);
  }

  /** `arr.get(i)` reads storage rather than calling anything. */
  protected isStorageCall(node: ts.CallExpression): boolean {
    return ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "get" && !!this.peekArray(node.expression.expression);
  }

  /** Whether an expression names an array, without emitting code or failing. */
  protected peekArray(node: ts.Expression): boolean {
    const k = this.peekKind(node);
    return k === "array" || k === "vec";
  }

  /** The kind of storage an expression names (struct, array, dataEnum…), without emitting code or failing. */
  protected peekKind(node: ts.Expression): FieldType["kind"] | undefined {
    const saved = { lines: this.lines.length, temp: this.temp, diagnostics: this.reporter.diagnostics.length };
    try {
      return this.reporter.guard(() => this.ref(node))?.type.kind;
    } finally {
      this.lines.length = saved.lines;
      this.temp = saved.temp;
      this.reporter.diagnostics.length = saved.diagnostics;
    }
  }

  protected place(node: ts.Expression): { type: ValueType; read: string; write: (c: string) => string } {
    if (ts.isIdentifier(node)) {
      const l = this.lookup(node.text);
      if (!l) this.fail(node, `"${node.text}" is not a local variable`);
      if (l.type.kind === "array") this.fail(node, `use ${node.text}.set(i, v) to change array elements`);
      if (!l.mutable) this.fail(node, `"${node.text}" is const or an argument and cannot be reassigned`);
      if (l.type.kind === "pubkey") return { type: l.type, read: `(&${l.c})`, write: (c) => `${l.c} = *(${c})` };
      return { type: l.type, read: l.c, write: (c) => `${l.c} = ${c}` };
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.name.text === "lamports") {
      const a = this.accounts.get(node.expression.text);
      if (a) {
        this.assertUsable(a, node);
        if (!isWritable(a.kind)) this.fail(node, `"${a.name}" is read-only; declare it Mut<...> to change lamports`);
        return { type: U64, read: `(*a_${a.name}->lamports)`, write: (c) => `*a_${a.name}->lamports = ${c}` };
      }
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "lamports") {
      const h = this.handle(node.expression);
      if (h) {
        // Remaining accounts carry no static guarantees: check writability where it is written, and that it is not
        // also another (declared or remaining) account, which would let one balance be counted twice.
        this.line(`TS_TRY(ts_check_writable(${h}));`);
        this.line(`TS_TRY(ts_check_unaliased(params, ${h}));`);
        return { type: U64, read: `(*${h}->lamports)`, write: (c) => `*${h}->lamports = ${c}` };
      }
    }
    const r = this.ref(node);
    if (r) {
      if (!r.writable) this.fail(node, this.readOnly(r));
      const vt = this.storageValueType(r.type);
      if (!vt) this.fail(node, `assign a whole ${typeName(r.type)} from another one of the same type`);
      const read = this.readStorage(r, node).c;
      return { type: vt, read, write: (c) => this.writeStorage(r, c) };
    }
    this.fail(node, "can only assign to local variables, account fields, array elements and .lamports");
  }

  protected fieldBytes(t: FieldType): number {
    switch (t.kind) {
      case "int":
      case "bool":
      case "pubkey":
      case "enum":
        return scalarSize(t);
      case "option":
        return 1 + (t.inner.kind === "struct" ? this.fieldBytes(t.inner) : scalarSize(t.inner));
      case "dataEnum":
        return 1 + this.model.dataEnums.get(t.name)!.payload;
      case "fstring":
        return 4 + t.cap;
      case "array":
        return this.fieldBytes(t.elem) * t.len;
      case "struct":
        return this.model.structs.get(t.name)!.size!;
      case "string":
      case "vec":
        throw new Error("unreachable: variable-size field has no fixed size");
    }
  }
}
