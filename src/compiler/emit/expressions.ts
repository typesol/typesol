import ts from "typescript";
import { INT_INFO, unsignedC, type IntName, type ScalarType, type ValueType, sameType, typeName } from "../model.js";
import { U64, U8, I64, BOOL, PUBKEY, STRING, HASH, type Value, cString, intLiteral, scalarStorageC, optC, valueC } from "./shared.js";
import { StorageEmitter } from "./storage.js";

/**
 * Expressions: literals, operators with checked arithmetic, property reads, conditionals, text and casts.
 */
export abstract class ExpressionEmitter extends StorageEmitter {
  protected expect(v: Value, want: ValueType | undefined, node: ts.Node): Value {
    if (v.isNull) {
      if (want?.kind !== "option") this.fail(node, "null is only valid where an Option<T> is expected");
      return { c: `((${optC(want.inner)}){0})`, type: want };
    }
    if (!want) {
      if (v.literal !== undefined && v.type.kind === "int") return this.literal(v.literal, U64, node);
      return v;
    }
    if (want.kind === "option" && v.type.kind !== "option") {
      // Wrap a plain value: Some(v).
      const inner = this.expect(v, want.inner, node);
      const stored = inner.type.kind === "pubkey" ? `*(${inner.c})` : inner.type.kind === "bool" ? `(uint8_t)(${inner.c})` : inner.c;
      return { c: `((${optC(want.inner)}){1, ${stored}})`, type: want };
    }
    if (v.type.kind === "option" && want.kind !== "option") return this.expect(this.unwrap(v, node), want, node);
    if (v.literal !== undefined && want.kind === "int") return this.literal(v.literal, want, node);
    if (!sameType(v.type, want)) this.fail(node, `expected ${typeName(want)}, got ${typeName(v.type)}`);
    return v;
  }

  /**
   * Use an Option's value. TypeScript only allows this after narrowing (`x !== null`), so the runtime
   * check is a backstop: an empty option aborts with 5108.
   */
  protected unwrap(v: Value, node: ts.Node): Value {
    if (v.type.kind !== "option") return v;
    const inner = v.type.inner;
    if ((inner as { kind: string }).kind === "struct") this.fail(node, "read the fields of an Option<struct> after checking it is not null");
    const t = this.tmp("opt");
    this.line(`${optC(inner)} ${t} = ${v.c};`);
    this.line(`if (!${t}.some) TS_FAIL(TS_ERR_UNWRAP, "TypeSOL: option is empty");`);
    void node;
    if (inner.kind === "pubkey") return { c: `(&${t}.v)`, type: inner };
    if (inner.kind === "bool") return { c: `(${t}.v != 0)`, type: inner };
    return { c: `${t}.v`, type: inner };
  }

  protected literal(value: bigint, type: ValueType, node: ts.Node): Value {
    if (type.kind !== "int") this.fail(node, `expected ${typeName(type)}, got an integer literal`);
    const info = INT_INFO[type.name];
    if (value < info.min || value > info.max) this.fail(node, `${value} does not fit in ${type.name}`);
    return { c: intLiteral(value, type.name), type };
  }

  protected expr(node: ts.Expression, hint?: ValueType): Value {
    if (ts.isParenthesizedExpression(node)) return this.expr(node.expression, hint);
    this.noOptionalChain(node);
    if (ts.isBigIntLiteral(node)) {
      const value = BigInt(node.text.slice(0, -1).replace(/_/g, ""));
      if (hint?.kind === "int") return this.literal(value, hint, node);
      return { c: intLiteral(value, "u64"), type: U64, literal: value };
    }
    if (ts.isNumericLiteral(node))
      this.fail(
        node,
        /^\d+$/.test(node.text)
          ? `use a bigint literal (${node.text}n): TypeSOL integers are bigints`
          : "TypeSOL has no floating-point numbers: use integers in base units (e.g. lamports, or a fixed-point scale)",
      );
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const len = Buffer.byteLength(node.text, "utf8");
      return { c: `ts_str((const uint8_t *)${cString(node.text)}, ${len})`, type: STRING, stringLiteral: node.text };
    }
    if (ts.isTemplateExpression(node)) {
      // `a${x}b${y}c` -> concatenations on the heap
      let acc = this.tmp("tpl");
      const head = node.head.text;
      this.line(`TS_Str ${acc} = ts_str((const uint8_t *)${cString(head)}, ${Buffer.byteLength(head, "utf8")});`);
      for (const span of node.templateSpans) {
        for (const piece of [
          this.toText(span.expression),
          `ts_str((const uint8_t *)${cString(span.literal.text)}, ${Buffer.byteLength(span.literal.text, "utf8")})`,
        ]) {
          const next = this.tmp("tpl");
          this.line(`TS_Str ${next};`);
          this.line(`TS_TRY(ts_str_concat(${acc}, ${piece}, &${next}));`);
          acc = next;
        }
      }
      return { c: acc, type: STRING };
    }
    if (node.kind === ts.SyntaxKind.NullKeyword) return { c: "", type: BOOL, isNull: true };
    if (node.kind === ts.SyntaxKind.TrueKeyword) return { c: "true", type: BOOL };
    if (node.kind === ts.SyntaxKind.FalseKeyword) return { c: "false", type: BOOL };
    if (ts.isIdentifier(node)) {
      const l = this.lookup(node.text);
      if (l) {
        if (l.type.kind === "array") this.fail(node, `"${node.text}" is an array; use .get(i)`);
        if (l.type.kind === "remaining") return { c: "", type: l.type };
        return l.type.kind === "pubkey" && !l.ptr ? { c: `(&${l.c})`, type: l.type } : { c: l.c, type: l.type };
      }
      const k = this.model.constants.get(node.text);
      if (k) {
        if (typeof k.value === "boolean") return { c: k.value ? "true" : "false", type: BOOL };
        if (typeof k.value === "object") return { c: `(&TSK_${k.name})`, type: PUBKEY };
        if (typeof k.value === "string") {
          const len = Buffer.byteLength(k.value, "utf8");
          return { c: `ts_str((const uint8_t *)${cString(k.value)}, ${len})`, type: STRING, stringLiteral: k.value };
        }
        if (k.type) return this.literal(k.value, k.type, node);
        if (hint?.kind === "int") return this.literal(k.value, hint, node);
        return { c: intLiteral(k.value, k.value < 0n ? "i64" : "u64"), type: k.value < 0n ? I64 : U64, literal: k.value };
      }
      const exported = this.exportName(node);
      if (exported === "TOKEN_ACCOUNT_SIZE" || exported === "MINT_SIZE") {
        const v = exported === "MINT_SIZE" ? 82n : 165n;
        return hint?.kind === "int" ? this.literal(v, hint, node) : { c: intLiteral(v, "u64"), type: U64, literal: v };
      }
      if (this.accounts.has(node.text)) this.fail(node, `"${node.text}" is an account; use ${node.text}.key for its address`);
      this.fail(node, `unknown name "${node.text}"`);
    }
    if (ts.isPropertyAccessExpression(node)) return this.property(node);
    if (ts.isPrefixUnaryExpression(node)) {
      if (node.operator === ts.SyntaxKind.ExclamationToken) {
        const v = this.expect(this.expr(node.operand, BOOL), BOOL, node.operand);
        return { c: `(!${v.c})`, type: BOOL };
      }
      if (node.operator === ts.SyntaxKind.MinusToken) {
        if (ts.isBigIntLiteral(node.operand)) {
          const value = -BigInt(node.operand.text.slice(0, -1).replace(/_/g, ""));
          return this.literal(value, hint?.kind === "int" ? hint : I64, node);
        }
        const v = this.expr(node.operand, hint);
        if (v.type.kind !== "int" || !INT_INFO[v.type.name].signed) this.fail(node, "unary minus needs a signed integer (i8 … i128)");
        return this.arith(ts.SyntaxKind.MinusToken, { c: intLiteral(0n, v.type.name), type: v.type }, v, node);
      }
      if (node.operator === ts.SyntaxKind.TildeToken) {
        // Bitwise not within the type's width (for signed types this equals JS's -(x + 1)).
        const v = this.expr(node.operand, hint);
        const typed = v.literal !== undefined ? this.literal(v.literal, hint?.kind === "int" ? hint : U64, node) : v;
        if (typed.type.kind !== "int") this.fail(node, "~ needs an integer");
        return { c: `((${INT_INFO[typed.type.name].c})~${typed.c})`, type: typed.type };
      }
      this.fail(node, "this operator is not supported");
    }
    if (ts.isBinaryExpression(node)) return this.binary(node, hint);
    if (ts.isConditionalExpression(node)) return this.conditional(node, hint);
    if (ts.isArrayLiteralExpression(node))
      this.fail(node, "arrays are only allowed inline as seeds/CPI lists; declare local arrays with fixedArray<T, N>(fill)");
    if (ts.isObjectLiteralExpression(node)) this.fail(node, "object literals are only allowed as the argument of emit<T>(...)");
    if (ts.isCallExpression(node)) {
      const h = this.handle(node);
      if (h) return { c: h, type: { kind: "account" } };
      const r = this.ref(node);
      if (r) return this.readStorage(r, node);
      const v = this.call(node, false);
      if (!v && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "pop")
        this.fail(node, "pop() returns integers, booleans, Pubkeys and strings; for structs read .get(length - 1) first, then pop()");
      if (!v) this.fail(node, "this call does not produce a value");
      return v;
    }
    this.fail(node, `${ts.SyntaxKind[node.kind]} is not supported in TypeSOL expressions`);
  }

  protected property(node: ts.PropertyAccessExpression): Value {
    const field = node.name.text;
    if (field === "length") {
      if (this.isRemaining(node.expression)) return { c: `((uint64_t)(params->ka_num - ${this.ix!.accounts.length}))`, type: U64 };
      const arr = this.ref(node.expression);
      if (arr?.type.kind === "array") return { c: `${arr.type.len}ULL`, type: U64 };
      if (arr?.type.kind === "vec") return { c: `((uint64_t)${arr.vec!.len})`, type: U64 };
      if (ts.isIdentifier(node.expression)) {
        const l = this.lookup(node.expression.text);
        if (l?.type.kind === "vecArg") return { c: `((uint64_t)${l.c}.len)`, type: U64 };
      }
      this.fail(node, "use byteLength(s) for strings; .length is available on arrays, Vecs and remainingAccounts()");
    }
    const h = this.handle(node.expression);
    if (h) {
      switch (field) {
        case "key":
          return { c: `${h}->key`, type: PUBKEY };
        case "owner":
          return { c: `${h}->owner`, type: PUBKEY };
        case "lamports":
          return { c: `(*${h}->lamports)`, type: U64 };
        case "dataLen":
          return { c: `${h}->data_len`, type: U64 };
        case "isSigner":
          return { c: `${h}->is_signer`, type: BOOL };
        case "isWritable":
          return { c: `${h}->is_writable`, type: BOOL };
      }
      this.fail(node.name, `remaining accounts expose key, owner, lamports, dataLen, isSigner and isWritable, not ${field}`);
    }
    if (ts.isIdentifier(node.expression)) {
      const a = this.accounts.get(node.expression.text);
      if (a) {
        this.assertUsable(a, node);
        const v = `a_${a.name}`;
        if (field === "key") return { c: `${v}->key`, type: PUBKEY };
        if (field === "lamports") return { c: `(*${v}->lamports)`, type: U64 };
        if (field === "dataLen") return { c: `${v}->data_len`, type: U64 };
        if (field === "pdaBump") {
          const b = this.bumps.get(a.name);
          if (!b) this.fail(node, `pdaBump is available on Init/InitIfNeeded accounts after create()/createIfNeeded()`);
          return { c: b, type: U8 };
        }
        const k = a.kind;
        if (field === "isSigner") return { c: `${v}->is_signer`, type: BOOL };
        if (field === "isWritable") return { c: `${v}->is_writable`, type: BOOL };
        if (k.kind === "token") {
          if (field === "mint") return { c: `ts_token_mint(${v})`, type: PUBKEY };
          if (field === "owner") return { c: `ts_token_owner(${v})`, type: PUBKEY };
          if (field === "amount") return { c: `ts_token_amount(${v})`, type: U64 };
          // SPL token account layout: delegate COption<Pubkey> @72, state @108, is_native COption<u64> @109,
          // delegated_amount @121, close_authority COption<Pubkey> @129.
          if (field === "delegate") return this.coptionKey(`${v}->data + 72`);
          if (field === "isFrozen") return { c: `(${v}->data[108] == 2)`, type: BOOL };
          if (field === "isNative") return { c: `(ts_read_le(${v}->data + 109, 4) == 1)`, type: BOOL };
          if (field === "delegatedAmount") return { c: `ts_read_le(${v}->data + 121, 8)`, type: U64 };
          if (field === "closeAuthority") return this.coptionKey(`${v}->data + 129`);
          if (field === "tokenProgram") return { c: `${v}->owner`, type: PUBKEY };
        }
        if (k.kind === "pyth") {
          // Raw fields of the update; pythPrice() is the checked read.
          const m = `${v}->data + pm_${a.name}`;
          if (field === "feedId") return { c: `((const SolPubkey *)(${m}))`, type: HASH };
          if (field === "price") return { c: `ts_le_i64(${m} + 32)`, type: I64 };
          if (field === "conf") return { c: `((uint64_t)ts_le_i64(${m} + 40))`, type: U64 };
          if (field === "exponent") return { c: `((int64_t)(int32_t)ts_read_le(${m} + 48, 4))`, type: I64 };
          if (field === "publishTime") return { c: `ts_le_i64(${m} + 52)`, type: I64 };
          if (field === "fullyVerified") return { c: `pf_${a.name}`, type: BOOL };
        }
        if (k.kind === "programData") {
          // UpgradeableLoaderState::ProgramData: u32 tag 3, u64 slot, Option<Pubkey> (u8 tag + 32 bytes).
          if (field === "deploySlot") return { c: `ts_read_le(${v}->data + 4, 8)`, type: U64 };
          if (field === "upgradeAuthority") {
            this.model.options.set("pubkey", PUBKEY);
            const t = this.tmp("ua");
            this.line(`${optC(PUBKEY)} ${t};`);
            this.line(`${t}.some = ${v}->data[12] == 1;`);
            this.line(`if (${t}.some) ts_memcpy(&${t}.v, ${v}->data + 13, 32); else ts_memzero(&${t}.v, 32);`);
            return { c: t, type: { kind: "option", inner: PUBKEY } };
          }
        }
        if (k.kind === "mint") {
          if (field === "decimals") return { c: `${v}->data[44]`, type: U8 };
          if (field === "supply") return { c: `ts_read_le(${v}->data + 36, 8)`, type: U64 };
          // mint_authority COption<Pubkey> @0, freeze_authority COption<Pubkey> @46.
          if (field === "mintAuthority") return this.coptionKey(`${v}->data`);
          if (field === "freezeAuthority") return this.coptionKey(`${v}->data + 46`);
          if (field === "tokenProgram") return { c: `${v}->owner`, type: PUBKEY };
        }
        // Struct accounts are always ours; their own fields (an `owner` field is common) take these names.
        if (k.kind === "info" || k.kind === "signer" || k.kind === "program") {
          if (field === "owner") return { c: `${v}->owner`, type: PUBKEY };
          if (field === "executable") return { c: `${v}->executable`, type: BOOL };
        }
        const r = this.ref(node);
        if (r) return this.readStorage(r, node);
        this.fail(node.name, `"${field}" is not available on ${a.name}`);
      }
      if (this.model.errorEnums.has(node.expression.text)) this.fail(node, "error enum members can only be used as the second argument of require()");
      if (this.exportName(node.expression) === "AuthorityType") {
        const i = ["MintTokens", "FreezeAccount", "AccountOwner", "CloseAccount"].indexOf(field);
        if (i < 0) this.fail(node.name, `AuthorityType has MintTokens, FreezeAccount, AccountOwner and CloseAccount`);
        return { c: `((uint8_t)${i})`, type: U8 };
      }
      const en = this.model.enums.get(node.expression.text);
      if (en) {
        const i = en.variants.indexOf(field);
        if (i < 0) this.fail(node.name, `${en.name} has no variant "${field}"`);
        return { c: `((uint8_t)${i})`, type: { kind: "enum", name: en.name } };
      }
    }
    const r = this.ref(node);
    if (r) return this.readStorage(r, node);
    // Surface the more specific message a call might give (e.g. loadAccount used inline).
    if (ts.isCallExpression(node.expression)) this.call(node.expression, false);
    this.fail(node, "unsupported property access");
  }

  /** Whether TypeScript sees this expression as a string (decides `+` between concatenation and arithmetic). */
  protected looksLikeString(node: ts.Expression): boolean {
    // Ask the checker (constant time) rather than lowering the operand, which is exponential in nested `+`.
    const isText = (t: ts.Type): boolean =>
      !!(t.flags & ts.TypeFlags.StringLike) || (t.isIntersection() && t.types.some(isText)) || (t.isUnion() && t.types.every(isText));
    return isText(this.checker.getTypeAtLocation(node));
  }

  /** A string view of a string, integer or boolean (for concatenation and templates). */
  protected toText(node: ts.Expression): string {
    const v = this.expr(node);
    if (v.type.kind === "string") return v.c;
    if (v.type.kind === "option" && (v.type.inner.kind === "int" || v.type.inner.kind === "bool")) {
      // `${opt}`: the value, or "null" like JS.
      const inner = v.type.inner;
      const o = this.tmp("o");
      const t = this.tmp("txt");
      this.line(`${optC(inner)} ${o} = ${v.c};`);
      this.line(`TS_Str ${t} = ts_str((const uint8_t *)"null", 4);`);
      this.line(`if (${o}.some) {`);
      this.indent++;
      if (inner.kind === "bool") this.line(`${t} = ${o}.v ? ts_str((const uint8_t *)"true", 4) : ts_str((const uint8_t *)"false", 5);`);
      else this.line(this.textOfInt(inner.name, `${o}.v`, t));
      this.indent--;
      this.line(`}`);
      return t;
    }
    const typed = v.literal !== undefined ? this.literal(v.literal, U64, node) : v;
    if (typed.type.kind === "bool") return `(${typed.c} ? ts_str((const uint8_t *)"true", 4) : ts_str((const uint8_t *)"false", 5))`;
    if (typed.type.kind === "int") {
      const t = this.tmp("num");
      this.line(`TS_Str ${t};`);
      this.line(this.textOfInt(typed.type.name, typed.c, t));
      return t;
    }
    this.fail(node, `only strings, integers and booleans can be joined into text, not ${typeName(typed.type)}`);
  }

  /** C statement writing the decimal text of an integer into the TS_Str `out`. */
  protected textOfInt(name: IntName, c: string, out: string): string {
    const info = INT_INFO[name];
    if (info.bytes === 16) return info.signed ? `TS_TRY(ts_str_i128(${c}, &${out}));` : `TS_TRY(ts_str_u128(${c}, false, &${out}));`;
    return info.signed ? `TS_TRY(ts_str_i64((int64_t)(${c}), &${out}));` : `TS_TRY(ts_str_u64((uint64_t)(${c}), false, &${out}));`;
  }

  /** `c ? a : b` on values: only the chosen branch runs (its checks and side effects included). */
  protected conditional(node: ts.ConditionalExpression, hint?: ValueType): Value {
    if (this.looksLikeStructPlace(node.whenTrue)) this.fail(node, "bind a choice between structs to a const: const o = c ? a.get(i) : b.get(i)");
    const cond = this.expect(this.expr(node.condition, BOOL), BOOL, node.condition);
    const t = this.tmp("cond");
    const declAt = this.lines.length;
    this.line(`/* ${t} */`);
    this.line(`if (${cond.c}) {`);
    let a!: Value;
    let b!: Value;
    let type: ValueType | undefined = hint;
    // When neither side fixes the type, an integer literal defaults to u64.
    const bothLiteral =
      (ts.isBigIntLiteral(node.whenTrue) || ts.isPrefixUnaryExpression(node.whenTrue)) &&
      (ts.isBigIntLiteral(node.whenFalse) || ts.isPrefixUnaryExpression(node.whenFalse));
    if (!type && !bothLiteral && (ts.isBigIntLiteral(node.whenTrue) || node.whenTrue.kind === ts.SyntaxKind.NullKeyword)) {
      // Type the non-literal branch first, without emitting it, to give the literal its type.
      const saved = { lines: this.lines.length, temp: this.temp, diagnostics: this.reporter.diagnostics.length };
      const probe = this.reporter.guard(() => this.expr(node.whenFalse));
      this.lines.length = saved.lines;
      this.temp = saved.temp;
      this.reporter.diagnostics.length = saved.diagnostics;
      if (probe && probe.literal === undefined && !probe.isNull) type = probe.type;
    }
    this.block(() => {
      a = this.expr(node.whenTrue, type);
      if (!type && a.literal === undefined && !a.isNull) type = a.type;
      a = this.ownedString(this.expect(a, type ?? U64, node.whenTrue));
      type = a.type;
      this.line(a.type.kind === "pubkey" ? `${t} = *(${a.c});` : `${t} = ${a.c};`);
    });
    this.line(`} else {`);
    this.block(() => {
      b = this.ownedString(this.expect(this.expr(node.whenFalse, type), type, node.whenFalse));
      this.line(b.type.kind === "pubkey" ? `${t} = *(${b.c});` : `${t} = ${b.c};`);
    });
    this.line(`}`);
    const vt = type!;
    if (vt.kind === "account" || vt.kind === "remaining" || vt.kind === "structRef" || vt.kind === "vecArg")
      this.fail(node, "choose between plain values (integers, booleans, Pubkeys, strings, options)");
    this.lines[declAt] = this.lines[declAt].replace(`/* ${t} */`, `${vt.kind === "pubkey" ? "SolPubkey" : valueC(vt)} ${t};`);
    return vt.kind === "pubkey" ? { c: `(&${t})`, type: vt } : { c: t, type: vt };
  }

  protected binary(node: ts.BinaryExpression, hint?: ValueType): Value {
    const op = node.operatorToken.kind;
    const K = ts.SyntaxKind;
    if (op === K.AsteriskAsteriskToken) this.fail(node.operatorToken, "** is not supported; multiply, or use mulDiv/isqrt");
    if (op === K.AmpersandAmpersandToken || op === K.BarBarToken) {
      const left = this.expect(this.expr(node.left, BOOL), BOOL, node.left);
      const t = this.tmp();
      this.line(`bool ${t} = ${left.c};`);
      this.line(op === K.AmpersandAmpersandToken ? `if (${t}) {` : `if (!${t}) {`);
      this.block(() => {
        const right = this.expect(this.expr(node.right, BOOL), BOOL, node.right);
        this.line(`${t} = ${right.c};`);
      });
      this.line(`}`);
      return { c: t, type: BOOL };
    }

    // x.kind === "Variant" on a data enum
    if (op === K.EqualsEqualsEqualsToken || op === K.ExclamationEqualsEqualsToken || op === K.EqualsEqualsToken || op === K.ExclamationEqualsToken) {
      const leftKind = this.kindOf(node.left);
      const rightKind = leftKind ? undefined : this.kindOf(node.right);
      const place = leftKind ?? rightKind;
      if (place) {
        const idx = this.variantIndex((place.type as { name: string }).name, leftKind ? node.right : node.left);
        const neg = op === K.ExclamationEqualsEqualsToken || op === K.ExclamationEqualsToken;
        return { c: `(${place.lv}.tag ${neg ? "!=" : "=="} ${idx})`, type: BOOL };
      }
    }
    if (op === K.PlusToken && (this.looksLikeString(node.left) || this.looksLikeString(node.right))) {
      const leftText = this.toText(node.left);
      const mark = this.lines.length;
      const b = this.toText(node.right);
      const a = this.settle({ c: leftText, type: STRING }, mark).c;
      const t = this.tmp("cat");
      this.line(`TS_Str ${t};`);
      this.line(`TS_TRY(ts_str_concat(${a}, ${b}, &${t}));`);
      return { c: t, type: STRING };
    }
    const isEq = op === K.EqualsEqualsEqualsToken || op === K.ExclamationEqualsEqualsToken || op === K.EqualsEqualsToken || op === K.ExclamationEqualsToken;
    // x === null / x !== null on an Option
    const isNullNode = (n: ts.Expression) => n.kind === ts.SyntaxKind.NullKeyword;
    if (isEq && (isNullNode(node.left) || isNullNode(node.right))) {
      const other = isNullNode(node.left) ? node.right : node.left;
      const optionalAccount = ts.isIdentifier(other) ? this.accounts.get(other.text) : undefined;
      if (optionalAccount?.optional) {
        const neg = op === K.ExclamationEqualsEqualsToken || op === K.ExclamationEqualsToken;
        return { c: `(a_${optionalAccount.name} ${neg ? "!=" : "=="} NULL)`, type: BOOL };
      }
      const v = this.expr(other);
      if (v.type.kind !== "option") this.fail(other, "only Option values can be compared with null");
      const neg = op === K.ExclamationEqualsEqualsToken || op === K.ExclamationEqualsToken;
      return { c: neg ? `((${v.c}).some != 0)` : `((${v.c}).some == 0)`, type: BOOL };
    }
    const isCmp = op === K.LessThanToken || op === K.LessThanEqualsToken || op === K.GreaterThanToken || op === K.GreaterThanEqualsToken;
    if (op === K.LessThanLessThanToken || op === K.GreaterThanGreaterThanToken) {
      // The shift amount may be any integer type; the result has the left operand's type.
      const leftIsLiteral = ts.isBigIntLiteral(node.left) || (ts.isPrefixUnaryExpression(node.left) && ts.isBigIntLiteral(node.left.operand));
      let left = this.expr(node.left, hint?.kind === "int" ? hint : undefined);
      if (leftIsLiteral && left.literal !== undefined) left = this.literal(left.literal, hint?.kind === "int" ? hint : U64, node.left);
      const mark = this.lines.length;
      let right = this.expr(node.right);
      if (right.literal !== undefined) right = this.literal(right.literal, U64, node.right);
      left = this.settle(left, mark);
      if (left.type.kind !== "int" || right.type.kind !== "int") this.fail(node, "shifts need integer operands");
      return this.arith(op as ts.BinaryOperator, left, right, node);
    }
    if (op === K.GreaterThanGreaterThanGreaterThanToken) this.fail(node.operatorToken, ">>> does not exist for bigint; use >>");
    const isBit = op === K.AmpersandToken || op === K.BarToken || op === K.CaretToken;
    const isArith = op === K.PlusToken || op === K.MinusToken || op === K.AsteriskToken || op === K.SlashToken || op === K.PercentToken || isBit;
    if (!isEq && !isCmp && !isArith) this.fail(node.operatorToken, `operator ${node.operatorToken.getText()} is not supported`);

    // Lower the non-literal side first so a literal on the other side takes its type.
    const leftIsLit = ts.isBigIntLiteral(node.left) || (ts.isPrefixUnaryExpression(node.left) && ts.isBigIntLiteral(node.left.operand));
    let left: Value, right: Value;
    if (leftIsLit) {
      right = this.expr(node.right, isArith ? hint : undefined);
      left = this.expr(node.left, right.type.kind === "int" ? right.type : hint);
    } else {
      left = this.expr(node.left, isArith ? hint : undefined);
      const mark = this.lines.length;
      right = this.expr(
        node.right,
        left.type.kind === "int" ? left.type : left.type.kind === "option" && left.type.inner.kind === "int" ? left.type.inner : undefined,
      );
      left = this.settle(left, mark);
    }
    // Option equality follows JS: null equals null, and an empty option equals no value.
    if (isEq && (left.type.kind === "option" || right.type.kind === "option")) {
      const neg = op === K.ExclamationEqualsEqualsToken || op === K.ExclamationEqualsToken;
      const opt = (left.type.kind === "option" ? left.type : right.type) as ValueType & { kind: "option" };
      const inner = opt.inner;
      const valueEq = (a: string, b: string) =>
        inner.kind === "pubkey" ? `ts_key_eq(&${a}, &${b})` : inner.kind === "bool" ? `((${a} != 0) == (${b} != 0))` : `(${a} == ${b})`;
      const hold = (v: Value, nodeOf: ts.Node) => {
        const t = this.tmp("oq");
        if (v.type.kind === "option") {
          if (!sameType(v.type, opt)) this.fail(nodeOf, `operands have different types: ${typeName(left.type)} and ${typeName(right.type)}`);
          this.line(`${optC(inner)} ${t} = ${v.c};`);
          return { opt: true, c: t };
        }
        const x = this.expect(v, inner, nodeOf);
        this.line(inner.kind === "pubkey" ? `SolPubkey ${t} = *(${x.c});` : `${scalarStorageC(inner)} ${t} = (${scalarStorageC(inner)})(${x.c});`);
        return { opt: false, c: t };
      };
      const l = hold(left, node.left);
      const r = hold(right, node.right);
      let c: string;
      if (l.opt && r.opt) c = `(${l.c}.some == ${r.c}.some && (!${l.c}.some || ${valueEq(`${l.c}.v`, `${r.c}.v`)}))`;
      else if (l.opt) c = `(${l.c}.some && ${valueEq(`${l.c}.v`, r.c)})`;
      else c = `(${r.c}.some && ${valueEq(l.c, `${r.c}.v`)})`;
      return { c: neg ? `(!${c})` : c, type: BOOL };
    }
    // Narrowed options compute by value.
    if (left.type.kind === "option") left = this.unwrap(left, node.left);
    if (right.type.kind === "option") right = this.unwrap(right, node.right);
    if (left.literal !== undefined && right.literal !== undefined) {
      const t = hint?.kind === "int" ? hint : U64;
      left = this.literal(left.literal, t, node.left);
      right = this.literal(right.literal, t, node.right);
    } else if (left.literal !== undefined) left = this.expect(left, right.type, node.left);
    else if (right.literal !== undefined) right = this.expect(right, left.type, node.right);
    if (!sameType(left.type, right.type))
      this.fail(node, `operands have different types: ${typeName(left.type)} and ${typeName(right.type)}; convert with u64(...) etc.`);

    if (isEq) {
      const neg = op === K.ExclamationEqualsEqualsToken || op === K.ExclamationEqualsToken;
      const c =
        left.type.kind === "pubkey"
          ? `ts_key_eq(${left.c}, ${right.c})`
          : left.type.kind === "string"
            ? `ts_str_eq(${left.c}, ${right.c})`
            : `(${left.c} == ${right.c})`;
      return { c: neg ? `(!${c})` : c, type: BOOL };
    }
    if (left.type.kind !== "int") this.fail(node, `${node.operatorToken.getText()} needs integer operands`);
    if (isCmp) return { c: `(${left.c} ${node.operatorToken.getText()} ${right.c})`, type: BOOL };
    return this.arith(op as ts.BinaryOperator, left, right, node);
  }

  /** Checked integer arithmetic into a fresh temporary. */
  protected arith(op: ts.BinaryOperator, left: Value, right: Value, node: ts.Node): Value {
    if (left.type.kind !== "int") this.fail(node, "arithmetic needs integer operands");
    const type = left.type;
    const ct = INT_INFO[type.name].c;
    const t = this.tmp();
    const K = ts.SyntaxKind;
    this.line(`${ct} ${t};`);
    const overflow = `TS_FAIL(TS_ERR_OVERFLOW, "TypeSOL: arithmetic overflow")`;
    switch (op) {
      case K.PlusToken:
        // u64 through the runtime helpers: one compare instead of a materialized carry flag on SBF.
        this.line(`if (${type.name === "u64" ? "ts_add_overflow_u64" : "__builtin_add_overflow"}(${left.c}, ${right.c}, &${t})) ${overflow};`);
        break;
      case K.MinusToken:
        this.line(`if (${type.name === "u64" ? "ts_sub_overflow_u64" : "__builtin_sub_overflow"}(${left.c}, ${right.c}, &${t})) ${overflow};`);
        break;
      case K.AsteriskToken:
        // u64: skips the 128-bit __multi3 call when both factors fit in 32 bits (see ts_mul_overflow_u64).
        this.line(`if (${type.name === "u64" ? "ts_mul_overflow_u64" : "__builtin_mul_overflow"}(${left.c}, ${right.c}, &${t})) ${overflow};`);
        break;
      case K.SlashToken:
      case K.PercentToken: {
        this.line(`if (${right.c} == 0) TS_FAIL(TS_ERR_DIV_ZERO, "TypeSOL: division by zero");`);
        if (INT_INFO[type.name].signed) this.line(`if (${left.c} == ${intLiteral(INT_INFO[type.name].min, type.name)} && ${right.c} == -1) ${overflow};`);
        this.line(`${t} = ${left.c} ${op === K.SlashToken ? "/" : "%"} ${right.c};`);
        break;
      }
      case K.AmpersandToken:
      case K.BarToken:
      case K.CaretToken:
        this.line(`${t} = (${ct})(${left.c} ${op === K.AmpersandToken ? "&" : op === K.BarToken ? "|" : "^"} ${right.c});`);
        break;
      case K.LessThanLessThanToken:
      case K.GreaterThanGreaterThanToken: {
        // Checked like the other operators: the amount must be below the width, and `<<` may not lose bits
        // (in JS the bigint would just grow). `>>` on signed types is arithmetic, as in JS.
        if (right.type.kind !== "int") this.fail(node, "shift amounts must be integers");
        const bits = INT_INFO[type.name].bytes * 8;
        const sh = this.tmp("sh");
        const rinfo = INT_INFO[right.type.name];
        this.line(`if (${rinfo.signed ? `${right.c} < 0 || ` : ""}${right.c} >= ${bits}) TS_FAIL(TS_ERR_OVERFLOW, "TypeSOL: shift amount out of range");`);
        this.line(`uint64_t ${sh} = (uint64_t)(${right.c});`);
        if (op === K.GreaterThanGreaterThanToken) this.line(`${t} = (${ct})(${left.c} >> ${sh});`);
        else {
          this.line(`${t} = (${ct})((${unsignedC(type.name)})${left.c} << ${sh});`);
          this.line(`if ((${ct})(${t} >> ${sh}) != ${left.c}) ${overflow};`);
        }
        break;
      }
      default:
        this.fail(node, "unsupported arithmetic operator");
    }
    return { c: t, type };
  }

  protected cast(arg: ts.Expression, to: ScalarType & { kind: "int" }): Value {
    const v = this.expr(arg);
    if (v.literal !== undefined) return this.literal(v.literal, to, arg);
    if (v.type.kind !== "int") this.fail(arg, `${to.name}() needs an integer`);
    if (v.type.name === to.name) return v;
    const from = INT_INFO[v.type.name];
    const target = INT_INFO[to.name];
    const conds: string[] = [];
    if (from.min < target.min) conds.push(`${v.c} < ${intLiteral(target.min, v.type.name)}`);
    if (from.max > target.max) conds.push(`${v.c} > ${intLiteral(target.max, v.type.name)}`);
    const t = this.tmp();
    if (conds.length) this.line(`if (${conds.join(" || ")}) TS_FAIL(TS_ERR_CAST, "TypeSOL: value does not fit in ${to.name}");`);
    this.line(`${target.c} ${t} = (${target.c})${v.c};`);
    return { c: t, type: to };
  }
}
