import ts from "typescript";
import { base58 } from "../../keys.js";
import { calleeName, resolveValueType } from "../analyze.js";
import { INT_INFO, unsignedC, type IntName, type ScalarType, type ValueType, optionKey, sameType, typeName } from "../model.js";
import { U64, U8, I64, BOOL, PUBKEY, STRING, HASH, type Value, cString, intLiteral, scalarStorageC, optC, valueC, vecCount } from "./shared.js";
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

  /**
   * `acct?.field` on an optional account, `x.home?.field` on an Option<struct> place: the field as an Option, empty
   * when the account was left out / the option is empty. (A method call through `?.` is not supported.)
   */
  protected optionalChain(node: ts.PropertyAccessExpression): Value {
    const base = node.expression;
    const optAccount = this.accountAt(base);
    let present: string;
    if (optAccount?.optional) present = `a_${optAccount.name} != NULL`;
    else {
      const r = this.ref(base);
      if (!r || r.type.kind !== "option" || r.type.inner.kind !== "struct")
        this.fail(node, "?. works on optional accounts and Option<struct> values (other values are never null)");
      present = `${r.lv}.some`;
    }
    // The same access without `?.`, lowered where the base is known to be there.
    const f = ts.factory;
    const plain = f.createPropertyAccessExpression(base, node.name);
    ts.setTextRange(plain, node);
    (plain as { parent?: ts.Node }).parent = node.parent;
    const t = this.tmp("oc");
    const declAt = this.lines.length;
    this.line(`/* ${t} */`);
    let inner: ValueType | undefined;
    this.line(`if (${present}) {`);
    this.block(() => {
      const v = this.expr(plain);
      const typed = v.literal !== undefined ? this.literal(v.literal, U64, node) : v;
      if (typed.type.kind === "option") {
        inner = typed.type.inner as ValueType;
        this.line(`ts_memcpy(&${t}, &${typed.c}, sizeof(${t}));`);
        return;
      }
      if (typed.type.kind !== "int" && typed.type.kind !== "bool" && typed.type.kind !== "pubkey" && typed.type.kind !== "enum")
        this.fail(node, `?. gives an Option, so the field must be an integer, boolean, Pubkey or enum, not ${typeName(typed.type)}`);
      inner = typed.type;
      this.line(`${t}.some = 1;`);
      this.line(inner.kind === "pubkey" ? `${t}.v = *(${typed.c});` : `${t}.v = ${typed.c};`);
    });
    this.line(`}`);
    const scalar = inner as ScalarType;
    this.model.options.set(optionKey(scalar), scalar);
    this.lines[declAt] = `${"  ".repeat(this.indent)}${optC(scalar)} ${t};\n${"  ".repeat(this.indent)}ts_memzero(&${t}, sizeof(${t}));`;
    return { c: t, type: { kind: "option", inner: scalar } as ValueType };
  }

  protected literal(value: bigint, type: ValueType, node: ts.Node): Value {
    if (type.kind !== "int") this.fail(node, `expected ${typeName(type)}, got an integer literal`);
    const info = INT_INFO[type.name];
    if (value < info.min || value > info.max) this.fail(node, `${value} does not fit in ${type.name}`);
    return { c: intLiteral(value, type.name), type };
  }

  protected expr(node: ts.Expression, hint?: ValueType): Value {
    if (ts.isParenthesizedExpression(node)) return this.expr(node.expression, hint);
    // `x as T`: an annotation the value must already match (no conversion: use u8(x) etc. for that). Inside a
    // generic helper it names the instance's type: `return (a + b) as T`.
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
      if (ts.isAsExpression(node) && ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName) && node.type.typeName.text === "const")
        return this.expr(node.expression, hint);
      const t = resolveValueType(node.type, this.scope);
      if (!t || t.kind === "vecArg" || t.kind === "dataEnumArg")
        this.fail(node.type, "`as` names an integer, boolean, Pubkey, enum, option or string type the value already has");
      const v = this.expr(node.expression, t);
      // Not a conversion: `x as u64 | null` does not make an Option of a u64.
      if (v.literal === undefined && !v.isNull && !sameType(v.type, t))
        this.fail(node, `this is a ${typeName(v.type)}, not a ${typeName(t)}: \`as\` does not convert (use u64(x) and the like for integers)`);
      return this.expect(v, t, node.expression);
    }
    // `x!` on an Option: its value, aborting with 5108 when it is empty (JS would carry the null on).
    if (ts.isNonNullExpression(node)) {
      const v = this.expr(node.expression, hint && hint.kind !== "option" ? ({ kind: "option", inner: hint } as ValueType) : hint);
      if (v.type.kind !== "option") this.fail(node, "! works on Option values and optional accounts (acct!.field); check other values with `x !== null`");
      return this.unwrap(v, node);
    }
    if (ts.isPropertyAccessExpression(node) && node.questionDotToken) return this.optionalChain(node);
    const unbanged = this.withoutBang(node);
    if (unbanged) return this.expr(unbanged, hint);
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
      // `a${x}b${y}c`: one join on the heap (or a literal when every piece is known at compile time).
      const pieces = this.templatePieces(node);
      if (pieces.only !== undefined) return { c: pieces.only, type: STRING };
      if (pieces.text !== undefined)
        return { c: `ts_str((const uint8_t *)${cString(pieces.text)}, ${Buffer.byteLength(pieces.text, "utf8")})`, type: STRING, stringLiteral: pieces.text };
      const t = this.tmp("tpl");
      this.line(`TS_Str ${t};`);
      this.line(`TS_TRY(ts_str_join(${pieces.arr}, ${pieces.n}, &${t}));`);
      return { c: t, type: STRING };
    }
    if (node.kind === ts.SyntaxKind.NullKeyword) return { c: "", type: BOOL, isNull: true };
    if (node.kind === ts.SyntaxKind.TrueKeyword) return { c: "true", type: BOOL };
    if (node.kind === ts.SyntaxKind.FalseKeyword) return { c: "false", type: BOOL };
    if (ts.isIdentifier(node)) {
      const l = this.lookup(node.text);
      if (l) {
        if (l.closure)
          this.fail(
            node,
            `"${node.text}" is a function: call it (${node.text}(…)), bind it with const, or pass it to a helper or list method; it cannot be stored or returned as a value`,
          );
        if (l.type.kind === "array") this.fail(node, `"${node.text}" is an array; use .get(i)`);
        if (l.type.kind === "vec") this.fail(node, `"${node.text}" is a list; use .get(i) and .length`);
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
      if (this.isGroup(node.text)) this.fail(node, `"${node.text}" is a group of accounts; use one of its fields (${node.text}.…)`);
      if (calleeName(node, this.model.helperDecls, this.checker) || this.model.helpers.has(node.text))
        this.fail(
          node,
          `"${node.text}" is a function: call it (${node.text}(…)), bind it with const, or pass it to a helper or list method; it cannot be stored or returned as a value`,
        );
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
      const sysvar = this.instructionsParam(node.expression);
      if (sysvar) {
        this.assertUsable(sysvar, node.expression);
        const t = this.tmp("ixn");
        this.line(`uint64_t ${t};`);
        this.line(`TS_TRY(ts_ix_count(a_${sysvar.name}, &${t}));`);
        return { c: t, type: U64 };
      }
      // The number of elements a map / filter chain gives: counted, nothing stored.
      if (this.isPipeline(node.expression)) {
        const n = this.tmp("count");
        this.line(`uint64_t ${n} = 0;`);
        this.eachElement(node.expression, node, { index: `__ln${this.temp++}`, ci: this.tmp("ln_i") }, () => this.line(`${n}++;`));
        return { c: n, type: U64 };
      }
      const arr = this.ref(node.expression);
      if (arr?.type.kind === "array") return { c: `${arr.type.len}ULL`, type: U64 };
      if (arr?.type.kind === "vec") return { c: vecCount(arr.vec!), type: U64 };
      if (ts.isIdentifier(node.expression)) {
        const l = this.lookup(node.expression.text);
        if (l?.type.kind === "vecArg") return { c: `((uint64_t)${l.c}.len)`, type: U64 };
      }
      this.fail(node, "use byteLength(s) for strings; .length is available on arrays, Vecs and remainingAccounts()");
    }
    if (this.isTxIx(node.expression)) {
      const ix = this.expr(node.expression);
      if (field === "programId") return { c: `(${ix.c}.program_id)`, type: PUBKEY };
      if (field === "accountsLength") return { c: `((uint64_t)${ix.c}.num_accounts)`, type: U64 };
      if (field === "dataLength") return { c: `((uint64_t)${ix.c}.data_len)`, type: U64 };
      this.fail(node.name, `a TransactionInstruction has programId, accountsLength and dataLength, not ${field}`);
    }
    const h = this.handle(node.expression);
    if (h) {
      switch (field) {
        case "key":
          return { c: `&${h}->key`, type: PUBKEY };
        case "owner":
          return { c: `&${h}->owner`, type: PUBKEY };
        case "lamports":
          return { c: `${h}->lamports`, type: U64 };
        case "dataLen":
          return { c: `${h}->data_len`, type: U64 };
        case "isSigner":
          return { c: `${h}->is_signer`, type: BOOL };
        case "isWritable":
          return { c: `${h}->is_writable`, type: BOOL };
      }
      this.fail(node.name, `remaining accounts expose key, owner, lamports, dataLen, isSigner and isWritable, not ${field}`);
    }
    if (this.accountAt(node)) this.fail(node, `"${node.getText()}" is an account; use ${node.getText()}.key for its address`);
    if (ts.isIdentifier(node.expression) || this.accountAt(node.expression)) {
      const a = this.accountAt(node.expression);
      if (a) {
        const v = `a_${a.name}`;
        // The address is known before an Init account is created (Anchor seeds use `mint.key()` that way).
        if (field === "key" && !a.optional) return { c: `&${v}->key`, type: PUBKEY };
        this.assertUsable(a, node);
        if (field === "key") return { c: `&${v}->key`, type: PUBKEY };
        if (field === "lamports") return { c: `${v}->lamports`, type: U64 };
        if (field === "dataLen") return { c: `${v}->data_len`, type: U64 };
        if (field === "pdaBump") {
          const b = this.bumps.get(a.name);
          if (!b) this.fail(node, `pdaBump is available on Seeds<…> accounts and on Init/InitIfNeeded accounts after create()/createIfNeeded()`);
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
          if (field === "tokenProgram") return { c: `&${v}->owner`, type: PUBKEY };
        }
        if (k.kind === "slotHashes") {
          // u64 count, then (u64 slot, 32-byte hash) entries, newest first; the entry check ran at entry.
          if (field === "count") return { c: `ts_read_le(${v}->data, 8)`, type: U64 };
          if (field === "latestSlot") return { c: `ts_read_le(${v}->data + 8, 8)`, type: U64 };
          if (field === "latestHash") return { c: `((const SolPubkey *)(${v}->data + 16))`, type: HASH };
          this.fail(node.name, "SlotHashesSysvar has count, latestSlot and latestHash");
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
          if (field === "tokenProgram") return { c: `&${v}->owner`, type: PUBKEY };
        }
        // Struct accounts are always ours; their own fields (an `owner` field is common) take these names.
        if (k.kind === "info" || k.kind === "signer" || k.kind === "program") {
          if (field === "owner") return { c: `&${v}->owner`, type: PUBKEY };
          if (field === "executable") return { c: `${v}->executable`, type: BOOL };
        }
        const r = this.ref(node);
        if (r) return this.readStorage(r, node);
        this.fail(node.name, `"${field}" is not available on ${a.name}`);
      }
      if (!ts.isIdentifier(node.expression)) this.fail(node, "unreachable: an account group's field");
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
  /**
   * A template literal's pieces in order, text known at compile time folded in: all text (`text`), or a C array of
   * TS_Str (`arr`, `n` entries). When a later piece runs statements, earlier pieces that view account text are copied
   * first, as JS reads them then.
   */
  protected templatePieces(
    node: ts.TemplateExpression,
  ):
    | { text: string; arr?: undefined; n?: undefined; only?: undefined }
    | { text?: undefined; arr: string; n: number; only?: undefined }
    | { only: string; text?: undefined } {
    const parts: { c?: string; text?: string; converted?: boolean }[] = [];
    const lit = (text: string) => {
      if (!text) return;
      const last = parts.at(-1);
      if (last?.text !== undefined) last.text += text;
      else parts.push({ text });
    };
    lit(node.head.text);
    for (const span of node.templateSpans) {
      const known = this.constantText(span.expression);
      if (known !== undefined) lit(known);
      else {
        const mark = this.lines.length;
        const converted = { yes: false };
        const c = this.toText(span.expression, converted);
        for (const p of parts) if (p.c !== undefined) p.c = this.settle({ c: p.c, type: STRING }, mark).c;
        parts.push({ c, converted: converted.yes });
      }
      lit(span.literal.text);
    }
    if (parts.every((p) => p.text !== undefined)) return { text: parts.map((p) => p.text).join("") };
    // `${n}` alone: the text a conversion just made (or a constant one) is already a string of its own; no join.
    if (parts.length === 1 && parts[0]!.converted) return { only: parts[0]!.c! };
    const strOf = (text: string) => `ts_str((const uint8_t *)${cString(text)}, ${Buffer.byteLength(text, "utf8")})`;
    const arr = this.tmp("parts");
    this.line(`TS_Str ${arr}[${parts.length}] = {${parts.map((p) => (p.text !== undefined ? strOf(p.text) : p.c)).join(", ")}};`);
    return { arr, n: parts.length };
  }

  /**
   * The text of `${e}` when it is known at compile time: a string literal or constant, a non-negative integer
   * literal, a boolean literal, or a Pubkey constant (its base58). Undefined otherwise.
   */
  protected constantText(e: ts.Expression): string | undefined {
    if (ts.isParenthesizedExpression(e)) return this.constantText(e.expression);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (e.kind === ts.SyntaxKind.TrueKeyword) return "true";
    if (e.kind === ts.SyntaxKind.FalseKeyword) return "false";
    if (ts.isBigIntLiteral(e)) return BigInt(e.text.slice(0, -1).replace(/_/g, "")).toString();
    if (ts.isIdentifier(e) && !this.lookup(e.text)) {
      const k = this.model.constants.get(e.text);
      if (k && typeof k.value === "string") return k.value;
      if (k && typeof k.value === "object") return base58(Uint8Array.from(k.value.pubkey));
    }
    return undefined;
  }

  /** `${node}`'s text; `converted.yes` when it was made from a non-string value (new text, not a view of other text). */
  protected toText(node: ts.Expression, converted?: { yes: boolean }): string {
    const v = this.expr(node);
    if (v.type.kind === "string") return v.c;
    if (converted) converted.yes = true;
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
    if (typed.type.kind === "pubkey") {
      // A Pubkey (or Hash) as base58, as Rust's `{}` prints it.
      const t = this.tmp("b58");
      this.line(`TS_Str ${t};`);
      this.line(`TS_TRY(ts_base58_32((const uint8_t *)(${typed.c}), &${t}));`);
      return t;
    }
    this.fail(node, `only strings, integers, booleans and Pubkeys can be joined into text, not ${typeName(typed.type)}`);
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
      const probe = this.probe(() => this.expr(node.whenFalse));
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

  /**
   * `a ?? b` on an Option: a's value when it has one, else b, which runs only then (as in JS). The result is an
   * Option itself when b can be null.
   */
  protected nullish(node: ts.BinaryExpression, hint?: ValueType): Value {
    const left = this.expr(node.left, hint?.kind === "option" ? hint : hint ? ({ kind: "option", inner: hint } as ValueType) : undefined);
    if (left.isNull) return this.expect(this.expr(node.right, hint), hint, node.right);
    if (left.type.kind !== "option") return left; // never null: JS never evaluates b
    const inner = left.type.inner;
    if ((inner as { kind: string }).kind === "struct") this.fail(node, "?? works on Options of integers, booleans and Pubkeys");
    const nullable = (t: ts.Type): boolean => !!(t.flags & ts.TypeFlags.Null) || (t.isUnion() && t.types.some(nullable));
    const type: ValueType = hint ?? (nullable(this.checker.getTypeAtLocation(node)) ? left.type : inner);
    const lo = this.tmp("opt");
    this.line(`${optC(inner)} ${lo} = ${left.c};`);
    const t = this.tmp("nn");
    this.line(`${type.kind === "pubkey" ? "SolPubkey" : valueC(type)} ${t};`);
    const set = (v: Value) => this.line(v.type.kind === "pubkey" ? `${t} = *(${v.c});` : `${t} = ${v.c};`);
    this.line(`if (${lo}.some) {`);
    this.block(() => {
      const some: Value =
        inner.kind === "pubkey"
          ? { c: `(&${lo}.v)`, type: inner }
          : inner.kind === "bool"
            ? { c: `(${lo}.v != 0)`, type: inner }
            : { c: `${lo}.v`, type: inner };
      set(this.expect(some, type, node.left));
    });
    this.line(`} else {`);
    this.block(() => set(this.expect(this.expr(node.right, type), type, node.right)));
    this.line(`}`);
    return type.kind === "pubkey" ? { c: `(&${t})`, type } : { c: t, type };
  }

  /**
   * `a ** b` on integers, every multiplication checked (5100 on overflow, like `*`). A literal exponent unrolls by
   * squaring at compile time; otherwise a square-and-multiply loop runs, squaring only while bits remain (a square
   * that overflows then would make the result overflow too). A negative exponent aborts, as JS throws a RangeError.
   */
  protected power(node: ts.BinaryExpression, hint?: ValueType): Value {
    let base = this.expr(node.left, hint?.kind === "int" ? hint : undefined);
    const mark = this.lines.length;
    const exp = this.expr(node.right);
    // JS reads the base first: if the exponent ran statements (a helper that changes it), use the value read before.
    base = this.settle(base, mark);
    if (base.literal !== undefined) base = this.literal(base.literal, hint?.kind === "int" ? hint : U64, node.left);
    if (base.type.kind !== "int") this.fail(node.left, "** needs an integer base");
    const type = base.type;
    const ct = INT_INFO[type.name].c;
    const K = ts.SyntaxKind;
    if (exp.literal !== undefined) {
      if (exp.literal < 0n) this.fail(node.right, "the exponent of ** cannot be negative");
      if (exp.literal > 255n)
        this.fail(node.right, "the exponent of ** must be at most 255 when it is a literal (larger ones always overflow unless the base is 0 or 1)");
      const n = exp.literal;
      if (n === 0n) return this.literal(1n, type, node);
      // Bits from high to low: square, then multiply by the base when the bit is set.
      const b = this.tmp("pb");
      this.line(`${ct} ${b} = ${base.c};`);
      let acc: Value = { c: b, type };
      const bits = n.toString(2);
      for (const bit of bits.slice(1)) {
        acc = this.arith(K.AsteriskToken, acc, acc, node);
        if (bit === "1") acc = this.arith(K.AsteriskToken, acc, { c: b, type }, node);
      }
      return acc;
    }
    if (exp.type.kind !== "int") this.fail(node.right, "the exponent of ** must be an integer");
    const r = this.tmp("pr");
    const sq = this.tmp("ps");
    const e = this.tmp("pe");
    this.line(`${ct} ${r} = 1;`);
    this.line(`${ct} ${sq} = ${base.c};`);
    if (INT_INFO[exp.type.name].signed) this.line(`if (${exp.c} < 0) TS_FAIL(TS_ERR_OVERFLOW, "TypeSOL: negative exponent");`);
    this.line(
      `${INT_INFO[exp.type.name].bytes === 16 ? "unsigned __int128" : "uint64_t"} ${e} = (${INT_INFO[exp.type.name].bytes === 16 ? "unsigned __int128" : "uint64_t"})(${exp.c});`,
    );
    this.line(`while (${e}) {`);
    this.block(() => {
      this.line(`if (${e} & 1) {`);
      this.block(() => this.line(`${r} = ${this.arith(K.AsteriskToken, { c: r, type }, { c: sq, type }, node).c};`));
      this.line(`}`);
      this.line(`${e} >>= 1;`);
      this.line(`if (${e}) {`);
      this.block(() => this.line(`${sq} = ${this.arith(K.AsteriskToken, { c: sq, type }, { c: sq, type }, node).c};`));
      this.line(`}`);
    });
    this.line(`}`);
    return { c: r, type };
  }

  protected binary(node: ts.BinaryExpression, hint?: ValueType): Value {
    const op = node.operatorToken.kind;
    const K = ts.SyntaxKind;
    if (op === K.AsteriskAsteriskToken) return this.power(node, hint);
    if (op === K.QuestionQuestionToken) return this.nullish(node, hint);
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
      const optionalAccount = this.accountAt(other);
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
        // u128: the native 64-bit multiply when both factors fit in 64 bits (see ts_mul_overflow_u128).
        this.line(
          `if (${type.name === "u64" ? "ts_mul_overflow_u64" : type.name === "u128" ? "ts_mul_overflow_u128" : "__builtin_mul_overflow"}(${left.c}, ${right.c}, &${t})) ${overflow};`,
        );
        break;
      case K.SlashToken:
      case K.PercentToken: {
        this.line(`if (${right.c} == 0) TS_FAIL(TS_ERR_DIV_ZERO, "TypeSOL: division by zero");`);
        if (INT_INFO[type.name].signed) this.line(`if (${left.c} == ${intLiteral(INT_INFO[type.name].min, type.name)} && ${right.c} == -1) ${overflow};`);
        if (type.name === "u128") this.line(`${t} = ${op === K.SlashToken ? "ts_div_u128" : "ts_rem_u128"}(${left.c}, ${right.c});`);
        else this.line(`${t} = ${left.c} ${op === K.SlashToken ? "/" : "%"} ${right.c};`);
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
