import ts from "typescript";
import { MAX_RETURN_DATA, resolveValueType, structNameOf } from "../analyze.js";
import { INT_INFO, type ScalarType, type ValueType, isWritable, optionKey, scalarSize, typeName } from "../model.js";
import { U64, BOOL, type Value, type Local, type Closure, cString, optC, scalarC, scalarStorageC, valueC } from "./shared.js";
import { CpiEmitter } from "./cpi.js";

/**
 * Statements: variables, assignment, control flow and return.
 */
export abstract class StatementEmitter extends CpiEmitter {
  protected statement(stmt: ts.Statement, topLevel = false): void {
    const outer = this.where;
    this.where = this.location(stmt);
    // --profile: a marker and the remaining compute units before every statement (see profile.ts).
    if (this.profile && !ts.isBlock(stmt)) {
      this.line(`sol_log(${cString(`ts:${this.where}`)});`);
      this.line(`sol_log_compute_units();`);
    }
    try {
      this.statementInner(stmt, topLevel);
    } finally {
      this.where = outer;
    }
  }

  protected statementInner(stmt: ts.Statement, topLevel: boolean): void {
    if (ts.isVariableStatement(stmt)) return this.variable(stmt.declarationList, topLevel);
    if (ts.isExpressionStatement(stmt)) return this.expressionStatement(stmt.expression, topLevel);
    if (ts.isIfStatement(stmt)) {
      const cond = this.expect(this.expr(stmt.expression, BOOL), BOOL, stmt.expression);
      this.line(`if (${cond.c}) {`);
      this.block(() => this.body(stmt.thenStatement));
      if (stmt.elseStatement) {
        this.line(`} else {`);
        this.block(() => this.body(stmt.elseStatement!));
      }
      this.line(`}`);
      return;
    }
    if (ts.isBlock(stmt)) {
      this.line(`{`);
      this.block(() => stmt.statements.forEach((s) => this.reporter.guard(() => this.statement(s))));
      this.line(`}`);
      return;
    }
    if (ts.isReturnStatement(stmt)) return this.returnStatement(stmt);
    if (ts.isSwitchStatement(stmt)) return this.switchStatement(stmt);
    if (ts.isForStatement(stmt)) return this.forLoop(stmt);
    if (ts.isForOfStatement(stmt)) return this.forOf(stmt);
    if (ts.isWhileStatement(stmt)) return this.loop(stmt.expression, stmt.statement, undefined);
    if (ts.isBreakStatement(stmt) || ts.isContinueStatement(stmt)) {
      if (stmt.label) this.fail(stmt, "labeled break/continue is not supported");
      if (!this.loops.length) this.fail(stmt, `${ts.isBreakStatement(stmt) ? "break" : "continue"} outside a loop`);
      // Inside a switch, `break` leaves the switch (as in JS) and `continue` targets the enclosing loop.
      if (ts.isContinueStatement(stmt) && !this.loops.at(-1)) this.fail(stmt, "continue outside a loop");
      this.line(ts.isBreakStatement(stmt) ? `break;` : `goto ${this.loops.at(-1)};`);
      return;
    }
    if (ts.isDoStatement(stmt)) return this.doLoop(stmt);
    if (ts.isForInStatement(stmt)) this.fail(stmt, "for … in is not supported: use for (init; cond; step), for (const x of list), while or do … while");
    this.fail(stmt, `${ts.SyntaxKind[stmt.kind]} is not supported in TypeSOL`);
  }

  protected returnStatement(stmt: ts.ReturnStatement) {
    const frame = this.inlineFrames.at(-1);
    if (frame) return this.closureReturn(stmt, frame);
    const returns = this.helper ? this.helper.returns : this.ix!.returns;
    if (!returns) {
      if (stmt.expression) this.fail(stmt, this.helper ? "this helper returns void" : "this instruction returns void; use `return;`");
      for (const l of this.epilogue()) this.line(l);
      this.line(`return SUCCESS;`);
      return;
    }
    if (returns.kind === "struct") {
      if (!stmt.expression) this.fail(stmt, `return a ${returns.name}`);
      if (this.helper) {
        // Write the struct through the caller's out pointer (a literal, a place or another helper's result).
        this.writeAggregate({ lv: "(*ret)", type: returns, writable: true }, stmt.expression);
        this.line(`return SUCCESS;`);
        return;
      }
      // Return data: the struct's fixed layout, which the IDL describes field by field.
      const t = this.tmp("ret");
      this.line(`TSS_${returns.name} ${t};`);
      this.writeAggregate({ lv: t, type: returns, writable: true }, stmt.expression);
      if (this.model.structs.get(returns.name)!.layout === "borsh") {
        // A @layout borsh struct returns its Borsh bytes, as Anchor's return data does.
        const b = this.tmp("retb");
        const w = this.tmp("retw");
        this.line(`uint8_t *${b};`);
        this.line(`TS_TRY(ts_alloc(sizeof(${t}), &${b}));`);
        this.line(`uint64_t ${w} = 0;`);
        this.line(`TS_TRY(ts_pack_${returns.name}(&${t}, ${b}, sizeof(${t}), &${w}));`);
        this.line(`sol_set_return_data(${b}, ${w});`);
      } else this.line(`sol_set_return_data((const uint8_t *)&${t}, sizeof(${t}));`);
      for (const l of this.epilogue()) this.line(l);
      this.line(`return SUCCESS;`);
      return;
    }
    if (!stmt.expression) this.fail(stmt, `return a ${typeName(returns)}`);
    const v = this.expect(this.expr(stmt.expression, returns), returns, stmt.expression);
    if (this.helper && returns.kind === "string") {
      // The caller gets its own copy: the text may be account data the caller then changes.
      this.line(`TS_TRY(ts_str_copy(${v.c}, ret));`);
    } else if (this.helper) this.line(returns.kind === "pubkey" ? `*ret = *(${v.c});` : `*ret = ${v.c};`);
    else if (returns.kind === "string") {
      // Return data is the Borsh String: u32 length, then the bytes (at most 1024 in all).
      const s = this.tmp("rets");
      const b = this.tmp("retb");
      this.line(`TS_Str ${s} = ${v.c};`);
      this.line(
        `if (${s}.len > ${MAX_RETURN_DATA - 4}) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: returned string longer than ${MAX_RETURN_DATA - 4} bytes");`,
      );
      this.line(`uint8_t *${b};`);
      this.line(`TS_TRY(ts_alloc(4 + ${s}.len, &${b}));`);
      this.line(`ts_write_le(${b}, ${s}.len, 4);`);
      this.line(`ts_memcpy(${b} + 4, ${s}.ptr, ${s}.len);`);
      this.line(`sol_set_return_data(${b}, 4 + ${s}.len);`);
    } else if (returns.kind === "pubkey") this.line(`sol_set_return_data((const uint8_t *)(${v.c}), 32);`);
    else {
      // Return data is the Borsh encoding: little-endian at the declared width, bool as one byte.
      const t = this.tmp("ret");
      const ct = scalarStorageC(returns);
      this.line(`${ct} ${t} = (${ct})(${v.c});`);
      this.line(`sol_set_return_data((const uint8_t *)&${t}, ${scalarSize(returns)});`);
    }
    // CloseTo runs after the return value is computed (it wipes the account).
    for (const l of this.epilogue()) this.line(l);
    this.line(`return SUCCESS;`);
  }

  /** `switch` on integers, enums and `.kind` of data enums: a C switch, with JS fallthrough/break semantics. */
  protected switchStatement(stmt: ts.SwitchStatement) {
    const kindPlace = this.kindOf(stmt.expression);
    if (kindPlace) {
      const enumName = (kindPlace.type as { name: string }).name;
      const t = this.tmp("sw");
      this.line(`uint8_t ${t} = ${kindPlace.lv}.tag;`);
      this.line(`switch (${t}) {`);
      const seenVariants = new Set<number>();
      for (const clause of stmt.caseBlock.clauses) {
        if (ts.isCaseClause(clause)) {
          const vi = this.variantIndex(enumName, clause.expression);
          if (seenVariants.has(vi)) this.fail(clause.expression, "duplicate case");
          seenVariants.add(vi);
        }
        this.line(ts.isCaseClause(clause) ? `case ${this.variantIndex(enumName, clause.expression)}: {` : `default: {`);
        this.loops.push(this.loops.at(-1) ?? "");
        this.block(() => clause.statements.forEach((s) => this.reporter.guard(() => this.statement(s))));
        this.loops.pop();
        this.line(`}`);
      }
      this.line(`}`);
      return;
    }
    const subject = this.expr(stmt.expression);
    const typed = subject.literal !== undefined ? this.literal(subject.literal, U64, stmt.expression) : subject;
    if (typed.type.kind !== "int" && typed.type.kind !== "enum") this.fail(stmt.expression, "switch works on integers and enums");
    // C cannot switch on 128-bit values: pick the case's index with comparisons, then switch on that.
    const wide = typed.type.kind === "int" && INT_INFO[typed.type.name].bytes === 16;
    const t = this.tmp("sw");
    this.line(`${scalarC(typed.type as ScalarType)} ${t} = ${typed.c};`);
    const pick = wide ? this.tmp("swi") : undefined;
    const pickAt = this.lines.length;
    const cases: string[] = [];
    if (pick) this.line(`int ${pick} = -1;`);
    this.line(`switch (${pick ?? t}) {`);
    const seen = new Set<string>();
    for (const clause of stmt.caseBlock.clauses) {
      if (ts.isCaseClause(clause)) {
        // C case labels must be compile-time constants: literals, top-level constants or enum members.
        const e = clause.expression;
        const isConstLabel =
          ts.isBigIntLiteral(e) ||
          (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isBigIntLiteral(e.operand)) ||
          (ts.isIdentifier(e) && !this.lookup(e.text) && this.model.constants.has(e.text)) ||
          (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && !this.lookup(e.expression.text) && this.model.enums.has(e.expression.text));
        if (!isConstLabel) this.fail(e, "case labels must be literals, constants or enum members");
        const label = this.expect(this.expr(e, typed.type), typed.type, e);
        if (seen.has(label.c)) this.fail(clause.expression, "duplicate case");
        seen.add(label.c);
        if (pick) {
          cases.push(label.c);
          this.line(`case ${cases.length - 1}: {`);
        } else this.line(`case ${label.c}: {`);
      } else this.line(`default: {`);
      this.loops.push(this.loops.at(-1) ?? "");
      this.block(() => clause.statements.forEach((s) => this.reporter.guard(() => this.statement(s))));
      this.loops.pop();
      this.line(`}`);
    }
    this.line(`}`);
    if (pick && cases.length) {
      const pad = "  ".repeat(this.indent);
      this.lines.splice(pickAt + 1, 0, ...cases.map((c, i) => `${pad}${i ? "else " : ""}if (${t} == ${c}) ${pick} = ${i};`));
    }
  }

  protected forLoop(stmt: ts.ForStatement) {
    this.line(`{`);
    this.block(() => {
      const init = stmt.initializer;
      if (init) {
        if (ts.isVariableDeclarationList(init)) this.variable(init);
        else this.expressionStatement(init, false);
      }
      this.loop(stmt.condition, stmt.statement, stmt.incrementor);
    });
    this.line(`}`);
  }

  /**
   * `for (const x of list)` over a Vec or FixedArray: an index loop that binds `x` as `const x = list.get(i)` would,
   * so elements are values (scalars, strings) or references into the data (structs), with the same aliasing rules.
   * As in JS, the length is read again before every step, so a body that pushes or pops sees the new length.
   */
  protected forOf(stmt: ts.ForOfStatement) {
    if (stmt.awaitModifier) this.fail(stmt, "for await is not supported");
    const list = stmt.initializer;
    const d = ts.isVariableDeclarationList(list) && list.declarations.length === 1 ? list.declarations[0] : undefined;
    if (!d || !(list.flags & ts.NodeFlags.Const) || !ts.isIdentifier(d.name) || d.type)
      this.fail(stmt.initializer, "write for (const x of list): one const name, no type annotation");
    if (this.isRemaining(stmt.expression)) this.fail(stmt.expression, "iterate remaining accounts with for (let i = 0n; i < rest.length; i++) and rest.get(i)");
    // Synthetic `list.length` / `list.get(i)` nodes placed at the loop, so errors and checks point at the source.
    const f = ts.factory;
    const index = `__of${this.temp++}`;
    const place = <T extends ts.Node>(n: T): T => {
      ts.setTextRange(n, stmt.expression);
      (n as { parent?: ts.Node }).parent = stmt;
      return n;
    };
    const indexId = place(f.createIdentifier(index));
    const length = place(f.createPropertyAccessExpression(stmt.expression, "length"));
    const get = place(f.createCallExpression(place(f.createPropertyAccessExpression(stmt.expression, "get")), undefined, [indexId]));
    // The element's declaration: the source's own name (so aliasing checks find its uses) bound to list.get(i).
    const decl = f.createVariableDeclaration(d.name, undefined, undefined, get);
    ts.setTextRange(decl, d);
    (decl as { parent?: ts.Node }).parent = list;
    const declList = { ...list, flags: ts.NodeFlags.Const, declarations: [decl] } as unknown as ts.VariableDeclarationList;

    const ci = this.tmp("of_i");
    const label = this.tmp("ts_continue_");
    this.line(`{`);
    this.block(() => {
      this.line(`uint64_t ${ci} = 0;`);
      this.scopes.at(-1)!.set(index, { c: ci, type: U64, mutable: false });
      this.line(`while (1) {`);
      this.block(() => {
        const n = this.expect(this.expr(length, U64), U64, stmt.expression);
        this.line(`if (!(${ci} < ${n.c})) break;`);
        this.variable(declList);
        this.loops.push(label);
        this.line(`{`);
        this.block(() => this.body(stmt.statement));
        this.line(`}`);
        this.loops.pop();
        this.line(`${label}:;`);
        this.line(`${ci}++;`);
      });
      this.line(`}`);
    });
    this.line(`}`);
  }

  /** Whether `e` is the remaining accounts (or a const bound to them). */
  protected isRemaining(e: ts.Expression): boolean {
    if (ts.isCallExpression(e) && this.exportName(e.expression) === "remainingAccounts") return true;
    return ts.isIdentifier(e) && this.lookup(e.text)?.type.kind === "remaining";
  }

  /**
   * `while (1) { cond; if (!cond) break; body; continue_label: step }`. The condition is lowered
   * inside the loop so its checked-arithmetic temporaries are recomputed every iteration.
   */
  protected loop(cond: ts.Expression | undefined, body: ts.Statement, step: ts.Expression | undefined) {
    const label = this.tmp("ts_continue_");
    this.line(`while (1) {`);
    this.block(() => {
      if (cond) {
        const c = this.expect(this.expr(cond, BOOL), BOOL, cond);
        this.line(`if (!${c.c}) break;`);
      }
      this.loops.push(label);
      this.line(`{`);
      this.block(() => this.body(body));
      this.line(`}`);
      this.loops.pop();
      this.line(`${label}:;`);
      if (step) this.expressionStatement(step, false);
    });
    this.line(`}`);
  }

  /**
   * Expand a closure where it is called: the arguments are evaluated here, in order, into the parameters (scalars,
   * Pubkeys and strings by value, structs by reference, as JS passes objects); the body then runs with the names it
   * was declared with, so a block around the call that declares the same name does not change what it reads, and
   * writes to captured `let`s are seen by the enclosing function. Returns the result (undefined for no value).
   */
  protected expandClosure(c: Closure, args: readonly ts.Expression[], node: ts.Node): Value | undefined {
    const fn = c.node;
    if (this.inlining.has(fn)) this.fail(node, `${c.name} calls itself: closures cannot be recursive`);
    if (args.length !== fn.parameters.length) this.fail(node, `${c.name}() takes ${fn.parameters.length} argument(s)`);
    const params = new Map<string, Local>();
    fn.parameters.forEach((p, i) => {
      if (!ts.isIdentifier(p.name) || p.initializer || p.dotDotDotToken) this.fail(p, "closure parameters are plain names");
      const arg = args[i]!;
      const name = p.name.text;
      const c2 = `l_${name}_${this.temp++}`;
      const annotated = p.type ? resolveValueType(p.type, this.scope) : undefined;
      if (!annotated && this.looksLikeStructPlace(arg)) {
        const place = this.structPlace(arg)!;
        this.line(`TSS_${place.struct} *${c2} = ${place.ptr};`);
        params.set(name, { c: c2, type: { kind: "structRef", struct: place.struct, writable: place.writable }, mutable: false, paths: this.pathsOf(arg) });
        return;
      }
      let v = this.expr(arg, annotated);
      if (v.isNull && !annotated) this.fail(arg, "give the parameter a type to pass null");
      if (v.literal !== undefined && !annotated) v = this.literal(v.literal, U64, arg);
      const type = annotated ?? v.type;
      v = this.expect(v, type, arg);
      if (type.kind === "pubkey") this.line(`SolPubkey ${c2} = *(${v.c});`);
      else this.line(`${valueC(type)}${type.kind === "account" ? "" : " "}${c2} = ${this.ownedString(v).c};`);
      params.set(name, { c: c2, type, mutable: true });
    });
    const declared = fn.type && fn.type.kind !== ts.SyntaxKind.VoidKeyword ? resolveValueType(fn.type, this.scope) : undefined;
    if (fn.type && fn.type.kind !== ts.SyntaxKind.VoidKeyword && !declared)
      this.fail(fn.type, "closures return integers, booleans, Pubkeys, strings, enums or Options");
    const frame = {
      label: this.tmp("ts_ret_"),
      result: this.tmp("ret"),
      type: declared,
      declAt: this.lines.length,
      pad: "  ".repeat(this.indent),
      node: fn,
    };
    this.line(declared ? `${declared.kind === "pubkey" ? "SolPubkey" : valueC(declared)} ${frame.result};` : `/* ${frame.result} */`);
    const saved = { scopes: this.scopes, loops: this.loops.splice(0) };
    this.scopes = [...c.scopes, params];
    this.inlining.add(fn);
    this.inlineFrames.push(frame);
    try {
      this.line(`{`);
      this.block(() => {
        const body = fn.body;
        if (ts.isBlock(body)) body.statements.forEach((s) => this.reporter.guard(() => this.statement(s)));
        else {
          // An expression body: its value is the result (a call may have none).
          const ret = ts.factory.createReturnStatement(body);
          ts.setTextRange(ret, body);
          (ret as { parent?: ts.Node }).parent = fn;
          if (ts.isCallExpression(body) && !frame.type) {
            const v = this.call(body, false);
            if (v) this.closureResult(v, body, frame);
          } else this.closureReturn(ret, frame);
        }
      });
      this.line(`}`);
      this.line(`${frame.label}:;`);
    } finally {
      this.inlineFrames.pop();
      this.inlining.delete(fn);
      this.scopes = saved.scopes;
      this.loops.push(...saved.loops);
    }
    if (!frame.type) {
      if (this.lines[frame.declAt]!.includes(`/* ${frame.result} */`)) this.lines[frame.declAt] = "";
      return undefined;
    }
    return frame.type.kind === "pubkey" ? { c: `(&${frame.result})`, type: frame.type } : { c: frame.result, type: frame.type };
  }

  /**
   * `xs.forEach / some / every / find / findIndex / reduce / includes / indexOf` on a Vec, FixedArray, FixedVec or Vec
   * argument: an index loop (the length read each step, as `for … of`), the callback (an arrow written at the call)
   * expanded with each element as `xs.get(i)` gives it (structs by reference) and, if it takes one, the index.
   * `find` gives an Option of the element (scalar elements), `findIndex` / `indexOf` an i64 (-1 when absent).
   */
  protected listMethod(node: ts.CallExpression, method: string): Value | undefined {
    const access = node.expression as ts.PropertyAccessExpression;
    const list = access.expression;
    const args = node.arguments;
    const f = ts.factory;
    const place = <T extends ts.Node>(n: T): T => {
      ts.setTextRange(n, node);
      (n as { parent?: ts.Node }).parent = node;
      return n;
    };
    const valueForm = method === "includes" || method === "indexOf";
    if (args.length !== (method === "reduce" ? 2 : 1))
      this.fail(node, method === "reduce" ? "reduce(callback, initial) takes two arguments" : `${method}() takes one argument`);
    const cb = args[0]!;
    if (!valueForm && !ts.isArrowFunction(cb) && !ts.isFunctionExpression(cb))
      this.fail(cb, `pass ${method} an arrow function written here: xs.${method}((x) => …)`);
    const fn = cb as ts.ArrowFunction | ts.FunctionExpression;
    const index = `__lm${this.temp++}`;
    const indexId = place(f.createIdentifier(index));
    const length = place(f.createPropertyAccessExpression(list, "length"));
    const element = place(f.createCallExpression(place(f.createPropertyAccessExpression(list, "get")), undefined, [indexId]));
    const I64: ValueType = { kind: "int", name: "i64" };

    // The result, declared before the loop.
    const res = this.tmp("lm");
    let result: Value | undefined;
    let elemType: ValueType | undefined;
    let accType: ValueType | undefined;
    let needle: string | undefined;
    if (method === "some" || method === "includes") (this.line(`bool ${res} = false;`), (result = { c: res, type: BOOL }));
    if (method === "every") (this.line(`bool ${res} = true;`), (result = { c: res, type: BOOL }));
    if (method === "findIndex" || method === "indexOf") (this.line(`int64_t ${res} = -1;`), (result = { c: res, type: I64 }));
    if (method === "reduce") {
      const accParam = fn.parameters[0];
      const annotated = accParam?.type ? resolveValueType(accParam.type, this.scope) : undefined;
      let init = this.expr(args[1]!, annotated);
      if (init.literal !== undefined && !annotated) init = this.literal(init.literal, U64, args[1]!);
      accType = annotated ?? init.type;
      init = this.expect(init, accType, args[1]!);
      if (!["int", "bool", "pubkey", "string", "enum", "option"].includes(accType.kind))
        this.fail(args[1]!, `reduce accumulates integers, booleans, Pubkeys, strings, enums or Options, not ${typeName(accType)}`);
      this.line(accType.kind === "pubkey" ? `SolPubkey ${res} = *(${init.c});` : `${valueC(accType)} ${res} = ${this.ownedString(init).c};`);
      result = accType.kind === "pubkey" ? { c: `(&${res})`, type: accType } : { c: res, type: accType };
    }
    if (valueForm) {
      // The value looked for, read once, compared with === (scalars and strings).
      const v = this.expr(cb);
      needle = `__lv${this.temp++}`;
      const t = this.tmp("needle");
      const vt = v.literal !== undefined ? U64 : v.type;
      if (!["int", "bool", "pubkey", "string", "enum"].includes(vt.kind)) this.fail(cb, `${method} compares integers, booleans, Pubkeys, strings or enums`);
      const typed = v.literal !== undefined ? v : this.expect(v, vt, cb);
      this.line(vt.kind === "pubkey" ? `SolPubkey ${t} = *(${typed.c});` : `${valueC(vt)} ${t} = ${typed.c};`);
      this.scopes.at(-1)!.set(needle, { c: t, type: vt, mutable: false });
    }
    if (method === "find") {
      // Typed from the first element read inside the loop; declared here.
      result = { c: res, type: BOOL };
      this.line(`/* ${res} */`);
    }
    const findDecl = method === "find" ? this.lines.length - 1 : -1;

    const ci = this.tmp("lm_i");
    this.line(`{`);
    this.block(() => {
      this.line(`uint64_t ${ci} = 0;`);
      this.scopes.at(-1)!.set(index, { c: ci, type: U64, mutable: false });
      this.line(`while (1) {`);
      this.block(() => {
        const n = this.expect(this.expr(length, U64), U64, list);
        this.line(`if (!(${ci} < ${n.c})) break;`);
        if (valueForm) {
          const eq = place(f.createBinaryExpression(element, ts.SyntaxKind.EqualsEqualsEqualsToken, place(f.createIdentifier(needle!))));
          const hit = this.expect(this.expr(eq, BOOL), BOOL, node);
          this.line(`if (${hit.c}) {`);
          this.line(method === "includes" ? `  ${res} = true;` : `  ${res} = (int64_t)${ci};`);
          this.line(`  break;`);
          this.line(`}`);
        } else {
          const closure: Closure = { node: fn, name: `${method}'s callback`, scopes: [...this.scopes] };
          const accId = method === "reduce" ? place(f.createIdentifier(`__acc${this.temp++}`)) : undefined;
          if (accId) this.scopes.at(-1)!.set(accId.text, { c: res, type: accType!, mutable: true });
          const all = method === "reduce" ? [accId!, element, indexId] : [element, indexId];
          const v = this.expandClosure(closure, all.slice(0, fn.parameters.length), cb);
          if (method === "forEach") {
            if (v) this.fail(cb, "forEach's callback returns nothing");
          } else if (method === "reduce") {
            if (!v) this.fail(cb, "reduce's callback returns the new accumulator");
            const nv = this.expect(v, accType!, cb);
            this.line(accType!.kind === "pubkey" ? `${res} = *(${nv.c});` : `${res} = ${nv.c};`);
          } else {
            if (!v) this.fail(cb, `${method}'s callback returns a boolean`);
            const b = this.expect(v, BOOL, cb);
            if (method === "some") this.line(`if (${b.c}) { ${res} = true; break; }`);
            if (method === "every") this.line(`if (!(${b.c})) { ${res} = false; break; }`);
            if (method === "findIndex") this.line(`if (${b.c}) { ${res} = (int64_t)${ci}; break; }`);
            if (method === "find") {
              this.line(`if (${b.c}) {`);
              this.block(() => {
                const e = this.expr(element);
                elemType = e.type;
                if (!["int", "bool", "pubkey", "enum"].includes(e.type.kind))
                  this.fail(node, "find returns an Option of the element, so the elements must be integers, booleans, Pubkeys or enums; use findIndex");
                this.line(`${res}.some = 1;`);
                this.line(e.type.kind === "pubkey" ? `${res}.v = *(${e.c});` : `${res}.v = ${e.c};`);
                this.line(`break;`);
              });
              this.line(`}`);
            }
          }
        }
        this.line(`${ci}++;`);
      });
      this.line(`}`);
    });
    this.line(`}`);
    if (method === "find") {
      const inner = elemType as ScalarType;
      this.model.options.set(optionKey(inner), inner);
      this.lines[findDecl] = `${"  ".repeat(this.indent)}${optC(inner)} ${res};\n${"  ".repeat(this.indent)}ts_memzero(&${res}, sizeof(${res}));`;
      return { c: res, type: { kind: "option", inner } as ValueType };
    }
    return result;
  }

  /** `return` inside an expanded closure: the value goes to the closure's result, then past its body. */
  protected closureReturn(stmt: ts.ReturnStatement, frame: (typeof this.inlineFrames)[number]) {
    if (!stmt.expression) {
      if (frame.type) this.fail(stmt, "this function returns a value");
      this.line(`goto ${frame.label};`);
      return;
    }
    this.closureResult(this.expr(stmt.expression, frame.type), stmt.expression, frame);
  }

  /** Store a closure's result (fixing its type on the first one) and jump past the rest of its body. */
  protected closureResult(value: Value, at: ts.Expression, frame: (typeof this.inlineFrames)[number]) {
    let v = value;
    const stmt = { expression: at };
    if (v.isNull && !frame.type) this.fail(stmt.expression, "give the function a return type to return null");
    if (!frame.type) {
      if (v.literal !== undefined) v = this.literal(v.literal, U64, stmt.expression);
      const t = v.type;
      if (!["int", "bool", "pubkey", "string", "enum", "option"].includes(t.kind))
        this.fail(stmt.expression, `closures return integers, booleans, Pubkeys, strings, enums or Options, not ${typeName(t)}`);
      frame.type = t;
      this.lines[frame.declAt] = `${frame.pad}${t.kind === "pubkey" ? "SolPubkey" : valueC(t)} ${frame.result};`;
    }
    v = this.expect(v, frame.type, stmt.expression);
    if (frame.type.kind === "pubkey") this.line(`${frame.result} = *(${v.c});`);
    else if (frame.type.kind === "option" && v.isNull) this.line(`ts_memzero(&${frame.result}, sizeof(${frame.result}));`);
    else this.line(`${frame.result} = ${this.ownedString(v).c};`);
    this.line(`goto ${frame.label};`);
  }

  /** `do { … } while (cond)`: the body once, then the test; `continue` goes to the test. */
  protected doLoop(stmt: ts.DoStatement) {
    const label = this.tmp("ts_continue_");
    this.line(`while (1) {`);
    this.block(() => {
      this.loops.push(label);
      this.line(`{`);
      this.block(() => this.body(stmt.statement));
      this.line(`}`);
      this.loops.pop();
      this.line(`${label}:;`);
      const c = this.expect(this.expr(stmt.expression, BOOL), BOOL, stmt.expression);
      this.line(`if (!${c.c}) break;`);
    });
    this.line(`}`);
  }

  protected body(stmt: ts.Statement) {
    if (ts.isBlock(stmt)) stmt.statements.forEach((s) => this.reporter.guard(() => this.statement(s)));
    else this.statement(stmt);
  }

  protected variable(list: ts.VariableDeclarationList, topLevel = false) {
    const mutable = !(list.flags & ts.NodeFlags.Const);
    if (!(list.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let))) this.fail(list, "use const or let, not var");
    for (const d of list.declarations) {
      if (ts.isObjectBindingPattern(d.name) && d.initializer) {
        this.destructure(list, d, d.name, d.initializer, topLevel);
        continue;
      }
      if (!ts.isIdentifier(d.name) || !d.initializer) this.fail(d, "declare one plain name with an initializer");
      // A local function is a helper of its own (lifted when the program was analyzed): nothing to run here.
      if (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) {
        // A closure: remembered with the scopes it can see, and expanded where it is called.
        if (this.model.closureDecls.has(d)) {
          this.scopes.at(-1)!.set(d.name.text, {
            c: "",
            type: BOOL,
            mutable: false,
            closure: { node: d.initializer, name: d.name.text, scopes: [...this.scopes] },
          });
          continue;
        }
        if (!this.model.helperDecls.has(d)) this.fail(d, "declare local functions with const: const f = (…) => …");
        continue;
      }
      const name = d.name.text;
      if (this.scopes.at(-1)!.has(name)) this.fail(d.name, `"${name}" is already declared`);
      // Account lookups go by name, so a local must not hide a parameter (it would read the parameter instead).
      if (this.accounts.has(name) || this.args.has(name)) this.fail(d.name, `"${name}" shadows the parameter "${name}"; use another name`);
      const c = `l_${name}_${this.temp++}`;

      const init = d.initializer;
      const fn = ts.isCallExpression(init) ? this.exportName(init.expression) : undefined;
      if (fn === "fixedArray") {
        const t = this.localArray(init as ts.CallExpression, c);
        this.scopes.at(-1)!.set(name, { c, type: t, mutable });
        continue;
      }
      if (fn === "loadAccount" || fn === "loadAccountMut" || fn === "loadForeign") {
        if (mutable) this.fail(d, "bind loaded accounts with const");
        const t = fn === "loadForeign" ? this.loadForeign(init as ts.CallExpression) : this.loadAccount(init as ts.CallExpression, fn === "loadAccountMut");
        this.line(`${valueC(t.type)}${c} = ${t.c};`);
        this.scopes.at(-1)!.set(name, { c, type: t.type, mutable: false, paths: [`@${c}`], decl: d });
        continue;
      }
      // Struct values: `const p: Point = { x, y }` (or a copy of another Point) is a local of its own.
      const structType = d.type && structNameOf(d.type, this.scope) ? this.model.structs.get(structNameOf(d.type, this.scope)!) : undefined;
      if (structType) {
        if (mutable) this.fail(d, "bind struct values with const (their fields can still be updated)");
        if (structType.size === undefined || structType.vec) this.fail(d.type!, `${structType.name} has variable-size fields and cannot be a local`);
        this.line(`TSS_${structType.name} ${c}__v;`);
        this.writeAggregate({ lv: `${c}__v`, type: { kind: "struct", name: structType.name }, writable: true }, init);
        this.line(`TSS_${structType.name} *${c} = &${c}__v;`);
        this.scopes.at(-1)!.set(name, { c, type: { kind: "structRef", struct: structType.name, writable: true }, mutable: false, paths: [`@${c}`], decl: d });
        continue;
      }
      // Data enums: `const a: Action = { kind: "X", ... }` builds a local; `const a = acct.action` aliases storage.
      const enumType =
        d.type && ts.isTypeReferenceNode(d.type) && ts.isIdentifier(d.type.typeName) ? this.model.dataEnums.get(d.type.typeName.text) : undefined;
      if (enumType || (!d.type && this.looksLikeDataEnum(init))) {
        let name2: string;
        let ptr: string;
        let writable = true;
        let paths = [`@${c}`];
        if (enumType && ts.isObjectLiteralExpression(init)) {
          name2 = enumType.name;
          this.line(`TSE_${name2} ${c}__v;`);
          this.writeAggregate({ lv: `${c}__v`, type: { kind: "dataEnum", name: name2 }, writable: true }, init);
          ptr = `&${c}__v`;
        } else {
          const r = this.ref(init);
          if (!r || r.type.kind !== "dataEnum" || (enumType && r.type.name !== enumType.name)) this.fail(init, `expected a ${enumType?.name ?? "data enum"}`);
          name2 = r.type.name;
          ptr = `(&${r.lv})`;
          writable = r.writable;
          paths = this.pathsOf(init) ?? paths;
        }
        if (mutable) this.fail(d, "bind data enums with const (the value itself can still be updated)");
        this.line(`TSE_${name2} *${c} = ${ptr};`);
        this.scopes.at(-1)!.set(name, { c, type: { kind: "enumRef", name: name2, writable }, mutable: false, paths, decl: d });
        continue;
      }
      // `const o = book.asks.get(i)` (or a ternary of two such places) aliases account data, like a JS object reference.
      const target = d.type ? undefined : this.structPlace(init);
      if (target) {
        if (mutable) this.fail(d, "bind struct references with const");
        this.line(`TSS_${target.struct} *${c} = ${target.ptr};`);
        this.scopes.at(-1)!.set(name, {
          c,
          type: { kind: "structRef", struct: target.struct, writable: target.writable },
          mutable: false,
          paths: this.pathsOf(init),
          decl: d,
        });
        continue;
      }
      let declared: ValueType | undefined;
      if (d.type) {
        declared = resolveValueType(d.type, this.scope);
        if (!declared || declared.kind === "vecArg") this.fail(d.type, "local type must be an integer, boolean, Pubkey, enum, option or string");
      }
      // `const bump = acct.create(...)` / `const fresh = acct.createIfNeeded(...)` count as top-level statements.
      const isCreate =
        topLevel && ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression) && /^create(IfNeeded)?$/.test(init.expression.name.text);
      const raw = isCreate ? this.call(init as ts.CallExpression, true) : undefined;
      const v = this.expect(raw ?? this.expr(init, declared), declared, init);
      const type = declared ?? v.type;
      if (type.kind === "remaining") {
        if (mutable) this.fail(d, "bind remainingAccounts() with const");
        this.scopes.at(-1)!.set(name, { c: "", type, mutable: false });
        continue;
      }
      if ((type.kind === "account" || type.kind === "structRef") && mutable) this.fail(d, "bind accounts with const");
      if (type.kind === "pubkey") this.line(`SolPubkey ${c} = *(${v.c});`);
      else this.line(`${valueC(type)}${type.kind === "account" ? "" : " "}${c} = ${this.ownedString(v).c};`);
      this.scopes.at(-1)!.set(name, { c, type, mutable });
    }
  }

  /**
   * `const { a, b: c } = s`: one declaration per name, `const a = s.a`, in source order. The source must be a name or
   * a field path (no calls), so reading it once per name reads the same thing JS reads once.
   */
  protected destructure(list: ts.VariableDeclarationList, d: ts.VariableDeclaration, pattern: ts.ObjectBindingPattern, init: ts.Expression, topLevel: boolean) {
    if (d.type) this.fail(d.type, "destructuring takes the types from the source; drop the annotation");
    const plain = (e: ts.Expression): boolean =>
      ts.isIdentifier(e) ||
      (ts.isPropertyAccessExpression(e) && !e.questionDotToken && plain(e.expression)) ||
      (ts.isParenthesizedExpression(e) && plain(e.expression));
    if (!plain(init)) this.fail(init, "destructure a variable or a field (a.b.c); bind a call to a const first");
    const f = ts.factory;
    for (const el of pattern.elements) {
      if (el.dotDotDotToken) this.fail(el, "...rest is not supported in destructuring");
      if (el.initializer) this.fail(el, "default values are not supported in destructuring");
      if (!ts.isIdentifier(el.name)) this.fail(el, "nested destructuring is not supported; destructure in two steps");
      const prop = el.propertyName ?? el.name;
      if (!ts.isIdentifier(prop)) this.fail(el, "use plain field names");
      const access = f.createPropertyAccessExpression(init, prop.text);
      ts.setTextRange(access, el);
      (access as { parent?: ts.Node }).parent = d;
      // The element's own name node, so aliasing checks and the type checker find its uses.
      const decl = f.createVariableDeclaration(el.name, undefined, undefined, access);
      ts.setTextRange(decl, el);
      (decl as { parent?: ts.Node }).parent = list;
      this.variable({ ...list, declarations: [decl] } as unknown as ts.VariableDeclarationList, topLevel);
    }
  }

  protected expressionStatement(e: ts.Expression, topLevel: boolean) {
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.EqualsToken) return this.assign(e.left, e.right, undefined, topLevel);
      const compound: Partial<Record<ts.SyntaxKind, ts.BinaryOperator>> = {
        [ts.SyntaxKind.PlusEqualsToken]: ts.SyntaxKind.PlusToken,
        [ts.SyntaxKind.MinusEqualsToken]: ts.SyntaxKind.MinusToken,
        [ts.SyntaxKind.AsteriskEqualsToken]: ts.SyntaxKind.AsteriskToken,
        [ts.SyntaxKind.SlashEqualsToken]: ts.SyntaxKind.SlashToken,
        [ts.SyntaxKind.PercentEqualsToken]: ts.SyntaxKind.PercentToken,
        [ts.SyntaxKind.AmpersandEqualsToken]: ts.SyntaxKind.AmpersandToken,
        [ts.SyntaxKind.BarEqualsToken]: ts.SyntaxKind.BarToken,
        [ts.SyntaxKind.CaretEqualsToken]: ts.SyntaxKind.CaretToken,
        [ts.SyntaxKind.LessThanLessThanEqualsToken]: ts.SyntaxKind.LessThanLessThanToken,
        [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken]: ts.SyntaxKind.GreaterThanGreaterThanToken,
      };
      const base = compound[op];
      if (base !== undefined) return this.assign(e.left, e.right, base);
      if (op === ts.SyntaxKind.AsteriskAsteriskEqualsToken) {
        // x **= n is x = x ** n; the target is read twice, so it must not run anything (no calls in it).
        let hasCall = false;
        const visit = (n: ts.Node): void => {
          if (ts.isCallExpression(n) && !this.isStorageCall(n)) hasCall = true;
          ts.forEachChild(n, visit);
        };
        visit(e.left);
        if (hasCall) this.fail(e.left, "**= on a target that calls a function: write x = x ** n with the target in a local");
        const f = ts.factory;
        const pow = f.createBinaryExpression(e.left, ts.SyntaxKind.AsteriskAsteriskToken, e.right);
        ts.setTextRange(pow, e);
        (pow as { parent?: ts.Node }).parent = e;
        return this.assign(e.left, pow);
      }
    }
    if (
      (ts.isPostfixUnaryExpression(e) || ts.isPrefixUnaryExpression(e)) &&
      (e.operator === ts.SyntaxKind.PlusPlusToken || e.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      const place = this.place(e.operand);
      if (place.type.kind !== "int") this.fail(e, "++ and -- need an integer");
      const one = this.literal(1n, place.type, e);
      const op = e.operator === ts.SyntaxKind.PlusPlusToken ? ts.SyntaxKind.PlusToken : ts.SyntaxKind.MinusToken;
      this.line(place.write(this.arith(op, { c: place.read, type: place.type }, one, e).c) + ";");
      return;
    }
    if (ts.isCallExpression(e)) {
      this.call(e, topLevel);
      return;
    }
    this.fail(e, "this expression has no effect; only assignments and calls can be statements");
  }

  protected assign(target: ts.Expression, valueNode: ts.Expression, op?: ts.BinaryOperator, topLevel = false) {
    if (op !== undefined) {
      const place = this.place(target);
      let current: Value = { c: place.read, type: place.type };
      if (place.type.kind === "string") {
        // s += x: concatenation into a fresh heap string (x may be a string, integer or boolean).
        if (op !== ts.SyntaxKind.PlusToken) this.fail(target, "strings support += only");
        // Account text is read before the right side runs (which may change it), as in JS.
        let cur = current.c;
        if (!/^\w+$/.test(cur)) {
          cur = this.tmp("cur");
          this.line(`TS_Str ${cur};`);
          this.line(`TS_TRY(ts_str_copy(${current.c}, &${cur}));`);
        }
        const rhs = this.toText(valueNode);
        const t = this.tmp("cat");
        this.line(`TS_Str ${t};`);
        this.line(`TS_TRY(ts_str_concat(${cur}, ${rhs}, &${t}));`);
        this.line(place.write(t) + ";");
        return;
      }
      const mark = this.lines.length;
      const rhs = this.expect(this.expr(valueNode, place.type), place.type, valueNode);
      current = this.settle(current, mark);
      this.line(place.write(this.arith(op, current, rhs, target).c) + ";");
      return;
    }
    // JS evaluates the target (`a.get(i).x`: which element) before the right side. The exception is
    // `acct.field = acct.create(...)`, which must create the account before the field can be touched.
    // `fixedVec([…])` is a value written in place, not a call.
    const isCall = ts.isCallExpression(valueNode) && !this.isStorageCall(valueNode) && this.exportName(valueNode.expression) !== "fixedVec";
    const createsFirst = isCall && ts.isPropertyAccessExpression(valueNode.expression) && ["create", "createIfNeeded"].includes(valueNode.expression.name.text);
    let raw = createsFirst ? this.call(valueNode as ts.CallExpression, topLevel) : undefined;
    if (createsFirst && !raw) this.fail(valueNode, "this call does not produce a value");
    // A helper's struct result is copied like any struct (the target first, as JS evaluates it first).
    const structCall =
      isCall && ts.isIdentifier((valueNode as ts.CallExpression).expression)
        ? this.helperOf(valueNode as ts.CallExpression)?.returns?.kind === "struct"
        : false;
    if (structCall && this.writesThroughVec(target) && this.helperTakesMutAccounts(valueNode as ts.CallExpression))
      this.fail(target, "the right side calls a helper that may change this Vec; store its result in a local first");
    // Whole arrays / structs: copy between identical layouts.
    const targetRef = isCall && !structCall ? undefined : this.ref(target);
    if (
      targetRef &&
      (targetRef.type.kind === "array" ||
        targetRef.type.kind === "struct" ||
        targetRef.type.kind === "dataEnum" ||
        (targetRef.type.kind === "vec" && targetRef.type.cap !== undefined) ||
        (targetRef.type.kind === "option" && targetRef.type.inner.kind === "struct"))
    ) {
      if (!targetRef.writable) this.fail(target, this.readOnly(targetRef));
      this.assertNotAliased(this.pathsOf(target), target);
      this.writeAggregate(targetRef, valueNode);
      return;
    }
    const place = this.place(target);
    if (isCall && !createsFirst) {
      // A helper that may replace a Vec element would leave `place` pointing at the new one (JS writes the old object).
      if (this.writesThroughVec(target) && this.helperTakesMutAccounts(valueNode as ts.CallExpression))
        this.fail(target, "the right side calls a helper that may change this Vec; store its result in a local first");
      raw = this.call(valueNode as ts.CallExpression, topLevel);
      if (!raw) this.fail(valueNode, "this call does not produce a value");
    }
    let value = this.expect(raw ?? this.expr(valueNode, place.type), place.type, valueNode);
    // A local, or a string field of a variable enum (a view), keeps its own copy of account text.
    if (ts.isIdentifier(target) || (value.type.kind === "string" && this.peekKind(target) === "string")) value = this.ownedString(value);
    this.line(place.write(value.c) + ";");
  }

  /** Whether a place goes through a Vec element (`v.get(i).x`, `v.get(i)`). */
  protected writesThroughVec(node: ts.Expression): boolean {
    for (let n: ts.Expression = node; ;) {
      if (ts.isParenthesizedExpression(n)) n = n.expression;
      else if (ts.isPropertyAccessExpression(n)) n = n.expression;
      else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "get") {
        if (this.peekKind(n.expression.expression) === "vec") return true;
        n = n.expression.expression;
      } else return false;
    }
  }

  protected helperTakesMutAccounts(node: ts.CallExpression): boolean {
    const h = this.helperOf(node);
    return !!h?.params.some((p) => p.account && isWritable(p.account));
  }
}
