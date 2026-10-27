import ts from "typescript";
import { resolveValueType } from "../analyze.js";
import { INT_INFO, type ScalarType, type ValueType, isWritable, scalarSize, typeName } from "../model.js";
import { U64, BOOL, type Value, cString, scalarC, scalarStorageC, valueC } from "./shared.js";
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
    if (ts.isDoStatement(stmt) || ts.isForInStatement(stmt))
      this.fail(stmt, "only for (init; cond; step), for (const x of list) and while loops are supported");
    this.fail(stmt, `${ts.SyntaxKind[stmt.kind]} is not supported in TypeSOL`);
  }

  protected returnStatement(stmt: ts.ReturnStatement) {
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
      this.line(`sol_set_return_data((const uint8_t *)&${t}, sizeof(${t}));`);
      for (const l of this.epilogue()) this.line(l);
      this.line(`return SUCCESS;`);
      return;
    }
    if (!stmt.expression) this.fail(stmt, `return a ${typeName(returns)}`);
    const v = this.expect(this.expr(stmt.expression, returns), returns, stmt.expression);
    if (this.helper) this.line(returns.kind === "pubkey" ? `*ret = *(${v.c});` : `*ret = ${v.c};`);
    else if (returns.kind === "pubkey") this.line(`sol_set_return_data((const uint8_t *)(${v.c}), 32);`);
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
    if (typed.type.kind === "int" && INT_INFO[typed.type.name].bytes === 16)
      this.fail(stmt.expression, "switch on 128-bit integers is not supported; use if/else");
    const t = this.tmp("sw");
    this.line(`${scalarC(typed.type as ScalarType)} ${t} = ${typed.c};`);
    this.line(`switch (${t}) {`);
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
        this.line(`case ${label.c}: {`);
      } else this.line(`default: {`);
      this.loops.push(this.loops.at(-1) ?? "");
      this.block(() => clause.statements.forEach((s) => this.reporter.guard(() => this.statement(s))));
      this.loops.pop();
      this.line(`}`);
    }
    this.line(`}`);
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
      const structType =
        d.type && ts.isTypeReferenceNode(d.type) && ts.isIdentifier(d.type.typeName) && !d.type.typeArguments
          ? this.model.structs.get(d.type.typeName.text)
          : undefined;
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
      if (op === ts.SyntaxKind.AsteriskAsteriskEqualsToken) this.fail(e.operatorToken, "write x = x ** n instead of **=");
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
    const isCall = ts.isCallExpression(valueNode) && !this.isStorageCall(valueNode);
    const createsFirst = isCall && ts.isPropertyAccessExpression(valueNode.expression) && ["create", "createIfNeeded"].includes(valueNode.expression.name.text);
    let raw = createsFirst ? this.call(valueNode as ts.CallExpression, topLevel) : undefined;
    if (createsFirst && !raw) this.fail(valueNode, "this call does not produce a value");
    // A helper's struct result is copied like any struct (the target first, as JS evaluates it first).
    const structCall =
      isCall && ts.isIdentifier((valueNode as ts.CallExpression).expression)
        ? this.model.helpers.get(((valueNode as ts.CallExpression).expression as ts.Identifier).text)?.returns?.kind === "struct"
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
    if (ts.isIdentifier(target)) value = this.ownedString(value); // a local keeps its own copy of account text
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
    const h = ts.isIdentifier(node.expression) ? this.model.helpers.get(node.expression.text) : undefined;
    return !!h?.params.some((p) => p.account && isWritable(p.account));
  }
}
