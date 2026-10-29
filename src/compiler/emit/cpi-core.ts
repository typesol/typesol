import ts from "typescript";
import { snakeCase } from "../analyze.js";
import { INT_INFO, type AccountParam, type FieldType, type IdlSeed, type IntName, isScalar, scalarSize, typeName } from "../model.js";
import { MAX_ACCOUNTS, MAX_SEEDS, U64, type Value, isStable, cString, scalarStorageC, optC } from "./shared.js";
import { CallEmitter } from "./calls.js";

/** Seeds and signer seeds, the byte buffers and Borsh serialization every CPI builds on, remaining-account ranges. */
export abstract class CpiCoreEmitter extends CallEmitter {
  /**
   * Lower a seeds array literal into a `SolSignerSeed[]` with `extra` spare slots. Also describes
   * the seeds in Anchor IDL terms when every element is a constant, an argument or an account path.
   */
  protected seeds(node: ts.Expression, extra: number): { name: string; count: number; idl: IdlSeed[] | undefined } {
    if (!ts.isArrayLiteralExpression(node)) this.fail(node, "seeds must be an array literal");
    if (node.elements.length > MAX_SEEDS) this.fail(node, `at most ${MAX_SEEDS} seeds`);
    const parts: string[] = [];
    let idl: IdlSeed[] | undefined = [];
    // Without calls or writes among the seeds, nothing can change a seed before the CPI reads it: account fields are
    // then passed in place instead of copied.
    const mutates = (n: ts.Node): boolean =>
      ts.isCallExpression(n) ||
      (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
      ts.isPrefixUnaryExpression(n) ||
      ts.isPostfixUnaryExpression(n) ||
      ts.forEachChild(n, mutates) === true;
    const inPlace = !node.elements.some(mutates);
    const mark = this.lines.length;
    for (const el of node.elements) {
      const desc = this.describeSeed(el);
      if (!desc) idl = undefined;
      else idl?.push(desc);
      if (ts.isStringLiteral(el)) {
        const len = Buffer.byteLength(el.text, "utf8");
        if (len > 32) this.fail(el, "a seed can be at most 32 bytes");
        parts.push(`{(const uint8_t *)${cString(el.text)}, ${len}}`);
        continue;
      }
      // Each seed is copied when it is evaluated, so later seeds (helper calls) cannot change earlier ones.
      const v = this.expr(el);
      if (v.type.kind === "pubkey" && (isStable(v.c) || (inPlace && /^\(&d_\w+(->\w+)+\)$/.test(v.c))))
        parts.push(`{(const uint8_t *)${v.c.startsWith("(") ? v.c : `(${v.c})`}, 32}`);
      else if (v.type.kind === "int" && inPlace && v.literal === undefined && /^d_\w+(->\w+)+$/.test(v.c))
        parts.push(`{(const uint8_t *)&${v.c}, ${INT_INFO[(v.type as { name: IntName }).name].bytes}}`);
      else if (v.type.kind === "pubkey") {
        const t = this.tmp("seed");
        this.line(`SolPubkey ${t} = *(${v.c});`);
        parts.push(`{(const uint8_t *)&${t}, 32}`);
      } else if (v.type.kind === "string") {
        const t = this.tmp("seed");
        this.line(`TS_Str ${t} = ${this.ownedString(v).c};`);
        parts.push(`{${t}.ptr, ${t}.len}`);
      } else if (v.type.kind === "int") {
        const typed = v.literal !== undefined ? this.literal(v.literal, U64, el) : v;
        const info = INT_INFO[(typed.type as { name: IntName }).name];
        const t = this.tmp("seed");
        this.line(`${info.c} ${t} = ${typed.c};`);
        parts.push(`{(const uint8_t *)&${t}, ${info.bytes}}`);
      } else if (v.type.kind === "enum") {
        // A unit enum value is its variant index, one byte (as in Seeds<…> and Borsh).
        const t = this.tmp("seed");
        this.line(`uint8_t ${t} = (uint8_t)(${v.c});`);
        parts.push(`{(const uint8_t *)&${t}, 1}`);
      } else this.fail(el, "seeds can be strings, Pubkeys, integers or unit enum values");
    }
    // The same list again (escrow: the vault transfer, then its close) reuses the array declared for the first, when
    // nothing was copied into temporaries (every entry points at a literal or at the place itself, so the array reads
    // what a new one would), it has no spare slot (callers never write into those arrays) and it is still in scope.
    const key = parts.join(", ");
    const reusable = extra === 0 && parts.length > 0 && this.lines.length === mark;
    const known = reusable ? this.seedArrays.get(key) : undefined;
    if (known && this.scopes.includes(known.scope) && this.lines[known.at]?.trim() === known.text) return { name: known.name, count: parts.length, idl };
    const name = this.tmp("seeds");
    const slots = parts.length + extra;
    this.line(`SolSignerSeed ${name}[${Math.max(slots, 1)}] = {${parts.join(", ")}};`);
    if (reusable) this.seedArrays.set(key, { name, scope: this.scopes[this.scopes.length - 1]!, at: this.lines.length - 1, text: this.lines.at(-1)!.trim() });
    return { name, count: parts.length, idl };
  }

  protected describeSeed(el: ts.Expression): IdlSeed | undefined {
    if (ts.isStringLiteral(el)) return { kind: "const", value: [...Buffer.from(el.text, "utf8")] };
    if (ts.isBigIntLiteral(el)) {
      const value = BigInt(el.text.slice(0, -1).replace(/_/g, ""));
      if (value > INT_INFO.u64.max) this.fail(el, `${value} does not fit in u64`);
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(value);
      return { kind: "const", value: [...b] };
    }
    // Only the argument itself, not a local that shadows its name.
    if (ts.isIdentifier(el) && this.ix?.args.some((a) => a.name === el.text) && this.lookup(el.text) === this.args.get(el.text))
      return { kind: "arg", path: snakeCase(el.text) };
    if (ts.isIdentifier(el) && !this.lookup(el.text)) {
      const k = this.model.constants.get(el.text);
      if (k && typeof k.value === "string") return { kind: "const", value: [...Buffer.from(k.value, "utf8")] };
      if (k && typeof k.value === "object") return { kind: "const", value: k.value.pubkey };
      if (k && typeof k.value === "bigint") {
        // Little-endian two's complement in the constant's width (16 bytes for u128/i128), as the program hashes it.
        const bytes = k.type ? scalarSize(k.type) : 8;
        const v = BigInt.asUintN(bytes * 8, k.value);
        return { kind: "const", value: Array.from({ length: bytes }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn)) };
      }
    }
    if (ts.isPropertyAccessExpression(el) && ts.isIdentifier(el.expression)) {
      const a = this.accounts.get(el.expression.text);
      if (a && el.name.text === "key") return { kind: "account", path: snakeCase(a.name) };
      if (a && (a.kind.kind === "account" || a.kind.kind === "init" || a.kind.kind === "zeroed" || a.kind.kind === "initIfNeeded")) {
        const f = a.kind.struct.fields.find((x) => x.name === el.name.text);
        if (f && isScalar(f.type)) return { kind: "account", path: `${snakeCase(a.name)}.${snakeCase(f.name)}`, account: a.kind.struct.name };
      }
    }
    return undefined;
  }

  protected recordPda(account: AccountParam, idl: IdlSeed[] | undefined): void {
    if (this.ix && idl && !this.ix.pdas.has(account.name)) this.ix.pdas.set(account.name, idl);
  }

  /**
   * Emit a CPI to the program account `program` with these metas (account, writable, signer), and then (`tail`) a range
   * of the remaining accounts, read-only (a Merkle proof).
   */
  protected cpi(
    program: string,
    metas: [string, boolean, boolean][],
    buf: string,
    len: string,
    seeds: { name: string; count: number | string },
    tail?: { from: string; to: string; asPassed?: boolean },
  ) {
    const m = this.tmp("metas");
    const fixed = metas.map(([acc, w, sg]) => `{&${acc}->key, ${w}, ${sg}}`).join(", ");
    if (!tail) {
      this.line(`SolAccountMeta ${m}[${metas.length}] = {${fixed}};`);
      this.line(`TS_TRY(ts_cpi(params, ${program}, ${buf}, ${len}, ${m}, ${metas.length}, ${seeds.name}, ${seeds.count}));`);
      return;
    }
    const n = this.ix!.accounts.length;
    const cnt = this.tmp("nmetas");
    const i = this.tmp("ri");
    this.line(
      `if (${metas.length} + (${tail.to} - ${tail.from}) > TS_MAX_ACCOUNTS) TS_FAIL(TS_ERR_TOO_MANY_ACCOUNTS, "TypeSOL: the CPI lists more than ${MAX_ACCOUNTS} accounts");`,
    );
    this.line(`SolAccountMeta ${m}[TS_MAX_ACCOUNTS] = {${fixed}};`);
    this.line(`uint64_t ${cnt} = ${metas.length};`);
    this.line(
      `for (uint64_t ${i} = ${n} + ${tail.from}; ${i} < ${n} + ${tail.to}; ${i}++) ${m}[${cnt}++] = (SolAccountMeta){&params->ka[${i}]->key, ${tail.asPassed ? `params->ka[${i}]->is_writable` : 0}, 0};`,
    );
    this.line(`TS_TRY(ts_cpi(params, ${program}, ${buf}, ${len}, ${m}, ${cnt}, ${seeds.name}, ${seeds.count}));`);
  }

  protected signerSeeds(node: ts.Expression | undefined, authority: AccountParam, at: ts.Node): { name: string; count: number | string } {
    if (!node) {
      if (authority.kind.kind !== "signer") this.fail(at, "the authority must be a Signer, or pass signerSeeds for a PDA authority");
      return { name: "NULL", count: 0 };
    }
    return this.signingSeeds(node);
  }

  /** Seeds to sign a CPI with: an array literal, or a helper's SignerSeeds parameter. */
  protected signingSeeds(node: ts.Expression): { name: string; count: number | string } {
    if (ts.isIdentifier(node)) {
      const l = this.lookup(node.text);
      if (l?.type.kind === "signerSeeds") return { name: l.c, count: `${l.c}__n` };
    }
    return this.seeds(node, 0);
  }

  /** Object literal properties by name, refusing others. */
  protected literalProps(o: ts.ObjectLiteralExpression, allowed: string[], what: string): Map<string, ts.Expression> {
    const props = new Map<string, ts.Expression>();
    for (const q of o.properties) {
      if (ts.isPropertyAssignment(q) && ts.isIdentifier(q.name)) props.set(q.name.text, q.initializer);
      else if (ts.isShorthandPropertyAssignment(q)) props.set(q.name.text, q.name);
      else this.fail(q, `write ${what}'s fields as name: value`);
    }
    for (const [k, v] of props) if (!allowed.includes(k)) this.fail(v, `${what} has no field ${k} (${allowed.join(", ")})`);
    return props;
  }

  /** `acct.key` of an account parameter, as an expression to serialize. */
  protected keyOf(n: ts.Expression): ts.Expression {
    const f = ts.factory;
    const e = f.createPropertyAccessExpression(n, "key");
    ts.setTextRange(e, n);
    (e as { parent?: ts.Node }).parent = n.parent;
    return e;
  }

  /**
   * `remainingAccounts()` (or a const bound to it): every remaining account; `rest.slice(a, b?)`: indexes a..b of them
   * (both checked against the count, 5104). C expressions for the range, relative to the first remaining account.
   */
  protected remainingRange(node: ts.Expression): { from: string; to: string } | undefined {
    const n = this.ix!.accounts.length;
    const count = `(params->ka_num - ${n})`;
    if (this.isRemaining(node)) return { from: "0", to: count };
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "slice") return undefined;
    if (!this.isRemaining(node.expression.expression)) return undefined;
    if (node.arguments.length < 1 || node.arguments.length > 2) this.fail(node, "slice(start, end?) takes one or two indexes");
    // Both ends may equal the count (an empty slice at the end).
    const from = this.index(node.arguments[0]!, `${count} + 1`);
    const to = node.arguments[1] ? this.index(node.arguments[1], `${count} + 1`) : count;
    this.line(`if (${from} > ${to}) TS_FAIL(TS_ERR_INDEX, "TypeSOL: remaining accounts slice out of range");`);
    return { from, to };
  }

  /**
   * A byte buffer written front to back. Its C declaration is patched in afterwards so it is
   * exactly as large as the fixed content, and only falls back to `max` when strings make it dynamic.
   */
  protected byteBuffer(prefix: string, max: number, errorCode: string, what: string) {
    const buf = this.tmp(prefix);
    const len = this.tmp(`${prefix}len`);
    const declAt = this.lines.length;
    this.line(`/* ${buf} */`);
    this.line(`uint64_t ${len} = 0;`);
    let fixed = 0;
    let dynamic = false;
    const put = (src: string, n: string, bytes?: number) => {
      // Once a variable-size piece was written the offset is only known at runtime: check every later write,
      // fixed-size ones included, so nothing lands past the buffer.
      if (bytes === undefined) dynamic = true;
      else fixed += bytes;
      if (dynamic) this.line(`if (${len} + ${n} > ${max}) TS_FAIL(${errorCode}, "TypeSOL: ${what} too large");`);
      this.line(`ts_memcpy(${buf} + ${len}, ${src}, ${n});`);
      this.line(`${len} += ${n};`);
    };
    const finish = (at: ts.Node) => {
      if (fixed > max) this.fail(at, `${what} is at least ${fixed} bytes; the limit is ${max}`);
      this.lines[declAt] = this.lines[declAt].replace(`/* ${buf} */`, `uint8_t ${buf}[${dynamic ? max : Math.max(fixed, 1)}];`);
    };
    return { buf, len, put, finish };
  }

  /** Append a value's Borsh encoding through `put(srcPointer, byteCount)`. */
  protected serialize(v: Value, node: ts.Node, put: (src: string, n: string, bytes?: number) => void) {
    if (v.isNull) this.fail(node, "a bare null has no type here; pass an Option value (e.g. a local declared `const x: u64 | null = null`)");
    const typed = v.literal !== undefined ? this.literal(v.literal, U64, node) : v;
    if (typed.type.kind === "pubkey") {
      put(`(${typed.c})`, "32", 32);
    } else if (typed.type.kind === "string") {
      const t = this.tmp("s");
      const l = this.tmp("slen");
      this.line(`TS_Str ${t} = ${typed.c};`);
      this.line(`uint32_t ${l} = (uint32_t)${t}.len;`);
      put(`&${l}`, "4", 4);
      put(`${t}.ptr`, `${t}.len`);
    } else if (typed.type.kind === "option") {
      // Borsh Option: tag byte, then the value only when Some (so the size is dynamic).
      const inner = typed.type.inner;
      const t = this.tmp("o");
      this.line(`${optC(inner)} ${t} = ${typed.c};`);
      put(`&${t}.some`, "1", 1);
      put(`&${t}.v`, `(${t}.some ? ${(inner as { kind: string }).kind === "struct" ? this.fieldBytes(inner as unknown as FieldType) : scalarSize(inner)} : 0)`);
    } else if (isScalar(typed.type)) {
      const ct = scalarStorageC(typed.type);
      const bytes = scalarSize(typed.type);
      const t = this.tmp("arg");
      this.line(`${ct} ${t} = (${ct})(${typed.c});`);
      put(`&${t}`, String(bytes), bytes);
    } else this.fail(node, `${typeName(typed.type)} cannot be serialized here`);
  }

  /** Borsh-encode a data-enum place: the tag byte, then the active variant's fields. */
  protected serializeDataEnum(node: ts.Expression, name: string, put: (src: string, n: string, bytes?: number) => void) {
    const src = this.ref(node);
    if (!src || src.type.kind !== "dataEnum" || src.type.name !== name) this.fail(node, `expected a ${name}`);
    this.serializeDataEnumLv(src.lv, name, put);
  }

  protected serializeDataEnumLv(lv: string, name: string, put: (src: string, n: string, bytes?: number) => void) {
    const src = { lv };
    const e = this.model.dataEnums.get(name)!;
    put(`&${src.lv}.tag`, "1", 1);
    this.line(`switch (${src.lv}.tag) {`);
    e.variants.forEach((v, i) => {
      this.line(`case ${i}: {`);
      for (const f of v.fields) {
        const at = `${src.lv}.v.${v.name}.${f.name}`;
        if (f.type.kind === "string") {
          // Borsh String: u32 length, then the bytes.
          const n = this.tmp("sl");
          this.line(`uint32_t ${n} = (uint32_t)${at}.len;`);
          put(`&${n}`, "4");
          put(`${at}.ptr`, `${at}.len`);
          continue;
        }
        if (f.type.kind === "dataEnum" && this.model.dataEnums.get(f.type.name)?.variable) {
          this.serializeDataEnumLv(at, f.type.name, put);
          continue;
        }
        const n = this.fieldBytes(f.type);
        // put() with no static size: the payload differs by variant.
        put(`&${at}`, String(n));
      }
      this.line(`break; }`);
    });
    this.line(`}`);
  }

  /** Structs reachable through the fields of struct `name` (not including itself unless it recurses). */
  protected nestedStructs(name: string): Set<string> {
    const out = new Set<string>();
    const visit = (t: FieldType) => {
      if (t.kind === "struct") {
        if (out.has(t.name)) return;
        out.add(t.name);
        this.model.structs.get(t.name)?.fields.forEach((f) => visit(f.type));
      } else if (t.kind === "array" || t.kind === "vec") visit(t.elem);
      else if (t.kind === "option" && t.inner.kind === "struct") visit(t.inner);
      else if (t.kind === "dataEnum") this.model.dataEnums.get(t.name)?.variants.forEach((v) => v.fields.forEach((f) => visit(f.type)));
    };
    this.model.structs.get(name)?.fields.forEach((f) => visit(f.type));
    return out;
  }

  /** Structs whose IDL description is the fixed layout: account data, arguments, and everything nested in them. */
  protected fixedLayoutStructs(): Set<string> {
    const out = new Set<string>();
    const visit = (t: FieldType) => {
      if (t.kind === "struct") {
        if (out.has(t.name)) return;
        out.add(t.name);
        this.model.structs.get(t.name)?.fields.forEach((f) => visit(f.type));
      } else if (t.kind === "array" || t.kind === "vec") visit(t.elem);
      else if (t.kind === "option" && t.inner.kind === "struct") visit(t.inner);
      else if (t.kind === "dataEnum") this.model.dataEnums.get(t.name)?.variants.forEach((v) => v.fields.forEach((f) => visit(f.type)));
    };
    for (const name of [...this.model.accountStructs, ...this.model.argStructs]) visit({ kind: "struct", name });
    return out;
  }
}
