import ts from "typescript";
import { discriminator, snakeCase } from "../analyze.js";
import { type FieldType, type StructDef, type ValueType, isScalar, isWritable, sameType, typeName } from "../model.js";
import { MAX_ACCOUNTS, MAX_CPI_DATA, MAX_EVENT, PUBKEY, STRING, type Value, cBytes, valueC, fixedVecC, vecCount } from "./shared.js";
import { MetaplexEmitter } from "./metaplex.js";

/** Generic CPIs (`invoke`, `invokeInstruction`) and events (`emit`, `emitCpi`). */
export abstract class CpiEmitter extends MetaplexEmitter {
  protected invoke(node: ts.CallExpression): undefined {
    const a = node.arguments;
    if (a.length !== 3 && a.length !== 4) this.fail(node, "invoke(program, accounts, data, signerSeeds?) takes 3 or 4 arguments");
    // The program: a declared parameter, or a remaining account (then only `executable` is checked).
    let programKey: string;
    const programHandle = this.handle(a[0]);
    if (programHandle) {
      this.line(`TS_TRY(ts_check_executable(${programHandle}));`);
      programKey = `&${programHandle}->key`;
    } else {
      const program = this.accountParam(a[0], "invoke's program");
      if (program.kind.kind !== "program" && program.kind.kind !== "system" && program.kind.kind !== "tokenProgram")
        this.fail(a[0], 'invoke\'s program must be a Program<"address">, UncheckedProgram, SystemProgram, token program or remaining account');
      programKey = `&a_${program.name}->key`;
    }
    const hasSeeds = a.length === 4;

    // Accounts: readonly(x) / writable(x) / readonlySigner(x) / writableSigner(x), and the remaining accounts spread in:
    // `...remainingAccounts()` (each with the flags it was passed with, Rust's `extend_from_slice`) or
    // `...readonly(rest)` / `...writable(rest)` (all with that role).
    if (!ts.isArrayLiteralExpression(a[1])) this.fail(a[1], "accounts must be an array literal");
    const metas: string[] = [];
    // Entries after the first spread are appended at runtime, in order.
    type Spread = { kind: "spread"; mode: "asPassed" | "readonly" | "writable"; from: string; to: string };
    const parts: ({ kind: "meta"; c: string } | Spread)[] = [];
    for (const el of a[1].elements) {
      if (ts.isSpreadElement(el)) {
        if (!this.ix) this.fail(el, "remainingAccounts() is only available in instructions");
        const inner = el.expression;
        const fnName = ts.isCallExpression(inner) ? this.exportName(inner.expression) : undefined;
        const wrapped = ts.isCallExpression(inner) && (fnName === "readonly" || fnName === "writable") && inner.arguments.length === 1;
        const range = this.remainingRange(wrapped ? inner.arguments[0]! : inner);
        if (!range) this.fail(el, "spread the remaining accounts: ...remainingAccounts(), ...readonly(rest), ...writable(rest) or rest.slice(a, b)");
        parts.push({ kind: "spread", mode: wrapped ? (fnName as "readonly" | "writable") : "asPassed", ...range });
        continue;
      }
      const fn = ts.isCallExpression(el) ? this.exportName(el.expression) : undefined;
      if (!ts.isCallExpression(el) || !fn || !["readonly", "writable", "readonlySigner", "writableSigner"].includes(fn) || el.arguments.length !== 1)
        this.fail(el, "each account must be readonly(x), writable(x), readonlySigner(x) or writableSigner(x)");
      const isW = fn === "writable" || fn === "writableSigner";
      const isS = fn === "readonlySigner" || fn === "writableSigner";
      const h = this.handle(el.arguments[0]);
      if (h) {
        // Remaining accounts: the flags are only known at runtime.
        if (isW) this.line(`TS_TRY(ts_check_writable(${h}));`);
        if (isS && !hasSeeds) this.line(`TS_TRY(ts_check_signer(${h}));`);
        metas.push(`{&${h}->key, ${isW}, ${isS}}`);
        parts.push({ kind: "meta", c: metas[metas.length - 1]! });
        continue;
      }
      const acct = this.accountParam(el.arguments[0], `${fn}()'s argument`);
      if (isW && !isWritable(acct.kind)) this.fail(el, `"${acct.name}" is not writable here; declare it Mut<...>`);
      if (isS && acct.kind.kind !== "signer" && !hasSeeds)
        this.fail(el, `"${acct.name}" did not sign; pass signerSeeds to sign for a PDA, or declare it Signer`);
      metas.push(`{&a_${acct.name}->key, ${isW}, ${isS}}`);
      parts.push({ kind: "meta", c: metas[metas.length - 1]! });
    }

    // The CPI's account list is built in a buffer with room for one entry per instruction account.
    if (metas.length > MAX_ACCOUNTS) this.fail(a[1], `invoke takes at most ${MAX_ACCOUNTS} accounts`);

    // Data: integers (LE at their width), booleans, Pubkeys, strings (Borsh), sighash("name"), hex("..")
    if (!ts.isArrayLiteralExpression(a[2])) this.fail(a[2], "data must be an array literal");
    const { buf, len, put, finish } = this.byteBuffer("data", MAX_CPI_DATA, "TS_ERR_INSTRUCTION_DATA", "CPI data");
    for (const el of a[2].elements) {
      const fn = ts.isCallExpression(el) ? this.exportName(el.expression) : undefined;
      if (ts.isCallExpression(el) && (fn === "sighash" || fn === "hex")) {
        const lit = el.arguments[0];
        if (el.arguments.length !== 1 || !ts.isStringLiteral(lit)) this.fail(el, `${fn}() takes one string literal`);
        let bytes: number[];
        if (fn === "sighash") bytes = discriminator(`global:${snakeCase(lit.text)}`);
        else {
          if (!/^([0-9a-fA-F]{2})*$/.test(lit.text)) this.fail(lit, "hex() needs an even number of hex digits");
          bytes = [...Buffer.from(lit.text, "hex")];
        }
        if (!bytes.length) continue;
        const name = this.tmp("bytes");
        this.line(`static const uint8_t ${name}[${bytes.length}] = ${cBytes(bytes)};`);
        put(name, String(bytes.length), bytes.length);
        continue;
      }
      // Structs and arrays go as their (Borsh-identical) fixed layout, data enums as Borsh enums,
      // Vec arguments as u32 length + elements.
      const kind = this.peekKind(el);
      if (kind === "struct" || kind === "array") {
        const r = this.ref(el)!;
        const n = this.fieldBytes(r.type);
        put(`&${r.lv}`, String(n), n);
        continue;
      }
      if (kind === "dataEnum") {
        this.serializeDataEnum(el, (this.ref(el)!.type as { name: string }).name, put);
        continue;
      }
      const vec = ts.isIdentifier(el) ? this.lookup(el.text) : undefined;
      if (vec?.type.kind === "vecArg" && vec.type.elem.kind === "string") {
        // Borsh Vec<String> again: the count, then each string's length and bytes.
        const n = this.tmp("vlen");
        const i = this.tmp("vi");
        const sl = this.tmp("slen");
        this.line(`uint32_t ${n} = ${vec.c}.len;`);
        put(`&${n}`, "4", 4);
        this.line(`for (uint32_t ${i} = 0; ${i} < ${n}; ${i}++) {`);
        this.line(`uint32_t ${sl} = (uint32_t)((const TS_Str *)${vec.c}.ptr)[${i}].len;`);
        put(`&${sl}`, "4");
        put(`((const TS_Str *)${vec.c}.ptr)[${i}].ptr`, `${sl}`);
        this.line(`}`);
        continue;
      }
      if (vec?.type.kind === "vecArg") {
        const n = this.tmp("vlen");
        this.line(`uint32_t ${n} = ${vec.c}.len;`);
        put(`&${n}`, "4", 4);
        put(`${vec.c}.ptr`, `(uint64_t)${n} * ${this.fieldBytes(vec.type.elem)}`);
        continue;
      }
      this.serialize(this.expr(el), el, put);
    }
    finish(a[2]);

    const seeds = hasSeeds ? this.signingSeeds(a[3]) : { name: "NULL", count: 0 };
    const metasName = this.tmp("metas");
    let count: string = String(metas.length);
    if (parts.some((p) => p.kind === "spread")) {
      // Room for every account of the instruction (ts_invoke's scratch holds TS_MAX_ACCOUNTS records).
      const n = this.ix!.accounts.length;
      const cnt = this.tmp("nmetas");
      this.line(`SolAccountMeta ${metasName}[TS_MAX_ACCOUNTS];`);
      this.line(`uint64_t ${cnt} = 0;`);
      const spreads = parts.filter((p): p is Spread => p.kind === "spread");
      const total = [String(metas.length), ...spreads.map((p) => `(${p.to} - ${p.from})`)].join(" + ");
      this.line(`if (${total} > TS_MAX_ACCOUNTS) TS_FAIL(TS_ERR_TOO_MANY_ACCOUNTS, "TypeSOL: the CPI lists more than ${MAX_ACCOUNTS} accounts");`);
      for (const p of parts) {
        if (p.kind === "meta") {
          this.line(`${metasName}[${cnt}++] = (SolAccountMeta)${p.c};`);
          continue;
        }
        const i = this.tmp("ri");
        const r = this.tmp("racct");
        this.line(`for (uint64_t ${i} = ${n} + ${p.from}; ${i} < ${n} + ${p.to}; ${i}++) {`);
        this.line(`  TsAccount *${r} = params->ka[${i}];`);
        if (p.mode === "writable") this.line(`  TS_TRY(ts_check_writable(${r}));`);
        const w = p.mode === "asPassed" ? `${r}->is_writable` : p.mode === "writable" ? "1" : "0";
        const sg = p.mode === "asPassed" ? `${r}->is_signer` : "0";
        this.line(`  ${metasName}[${cnt}++] = (SolAccountMeta){&${r}->key, ${w}, ${sg}};`);
        this.line(`}`);
      }
      count = cnt;
    } else this.line(`SolAccountMeta ${metasName}[${Math.max(metas.length, 1)}] = {${metas.join(", ")}};`);
    const ixName = this.tmp("cpi");
    this.line(`SolInstruction ${ixName} = {${programKey}, ${metasName}, ${count}, ${buf}, ${len}};`);
    if (hasSeeds) {
      const signer = this.tmp("signer");
      this.line(`SolSignerSeeds ${signer} = {${seeds.name}, ${seeds.count}};`);
      // No seeds (e.g. signer([]) passed to a helper) means no PDA signature at all.
      this.line(
        `TS_TRY(ts_invoke(params, &${ixName}, &${signer}, ${typeof seeds.count === "number" ? (seeds.count > 0 ? 1 : 0) : `${seeds.count} > 0 ? 1 : 0`}));`,
      );
    } else this.line(`TS_TRY(ts_invoke(params, &${ixName}, NULL, 0));`);
    return undefined;
  }

  /**
   * `invokeInstruction(programId, metas, data, infos, signerSeeds?)`: a CPI decided at run time (Rust's
   * `invoke_signed(&Instruction { program_id, accounts, data }, infos, seeds)`), e.g. one stored in account data. Each
   * meta is a struct with `pubkey`, `isSigner` and `isWritable`; `data` a list of u8; every account in `infos` (the
   * remaining accounts, or a slice of them) goes to the runtime, which finds each meta's account there by key (an
   * account missing there fails the CPI, as under Rust) and checks the privileges: a meta may only be a signer or
   * writable as the transaction passed it, or a PDA of this program that `signerSeeds` sign for.
   */
  protected invokeInstruction(node: ts.CallExpression): undefined {
    const a = node.arguments;
    if (!this.ix) this.fail(node, "invokeInstruction is only available in instructions (it passes remaining accounts)");
    if (a.length !== 4 && a.length !== 5) this.fail(node, "invokeInstruction(programId, accounts, data, infos, signerSeeds?) takes 4 or 5 arguments");
    const program = this.expect(this.expr(a[0]!, PUBKEY), PUBKEY, a[0]!);
    const programKey = this.tmp("dprog");
    this.line(`SolPubkey ${programKey} = *(${program.c});`);
    const list = (e: ts.Expression, what: string): { items: string; count: string; elem: FieldType } => {
      const l = ts.isIdentifier(e) ? this.lookup(e.text) : undefined;
      if (l?.type.kind === "vecArg") return { items: `${l.c}.ptr`, count: `((uint64_t)${l.c}.len)`, elem: l.type.elem };
      const r = this.ref(e);
      if (r?.vec && r.type.kind === "vec") return { items: `${r.vec.items}`, count: vecCount(r.vec), elem: r.type.elem };
      this.fail(e, `${what}: a Vec or FixedVec (account data, an argument or a local list)`);
    };
    const metas = list(a[1]!, "the accounts");
    const elem = metas.elem;
    const st = elem.kind === "struct" ? this.model.structs.get(elem.name) : undefined;
    const field = (name: string, kind: "pubkey" | "bool") => st?.fields.find((f) => f.name === name && f.type.kind === kind);
    if (!st || !field("pubkey", "pubkey") || !field("isSigner", "bool") || !field("isWritable", "bool"))
      this.fail(a[1]!, "each account is a struct with pubkey: Pubkey, isSigner: boolean and isWritable: boolean");
    const data = list(a[2]!, "the data");
    if (data.elem.kind !== "int" || data.elem.name !== "u8") this.fail(a[2]!, "the data is a list of u8");
    const range = this.remainingRange(a[3]!) ?? this.fail(a[3]!, "pass the accounts the CPI may use: remainingAccounts() or rest.slice(a, b)");
    const seeds = a.length === 5 ? this.signingSeeds(a[4]!) : undefined;

    const n = this.tmp("dn");
    const m = this.tmp("dmetas");
    const i = this.tmp("di");
    const k = this.tmp("dk");
    this.line(`uint64_t ${n} = ${metas.count};`);
    this.line(`SolAccountMeta *${m} = NULL;`);
    this.line(`TS_TRY(ts_alloc(${n} * sizeof(SolAccountMeta) + 1, (uint8_t **)&${m}));`);
    this.line(`for (uint64_t ${i} = 0; ${i} < ${n}; ${i}++) {`);
    this.line(`  const TSS_${st.name} *e = &((const TSS_${st.name} *)${metas.items})[${i}];`);
    this.line(`  ${m}[${i}] = (SolAccountMeta){(SolPubkey *)&e->pubkey, e->isWritable != 0, e->isSigner != 0};`);
    this.line(`}`);
    // Every account offered goes along as an AccountInfo (ts_invoke's scratch holds TS_MAX_ACCOUNTS of them).
    const base = this.ix.accounts.length;
    this.line(`uint64_t ${k} = 0;`);
    this.line(`for (uint64_t ${i}b = ${base} + ${range.from}; ${i}b < ${base} + ${range.to}; ${i}b++) ts_info(params->ka[${i}b], &params->infos[${k}++]);`);
    const ixName = this.tmp("cpi");
    this.line(`SolInstruction ${ixName} = {&${programKey}, ${m}, ${n}, (uint8_t *)${data.items}, ${data.count}};`);
    if (seeds) {
      const signer = this.tmp("signer");
      this.line(`SolSignerSeeds ${signer} = {${seeds.name}, ${seeds.count}};`);
      this.line(
        `TS_TRY(sol_invoke_signed(&${ixName}, params->infos, ${k}, &${signer}, ${typeof seeds.count === "number" ? (seeds.count > 0 ? 1 : 0) : `${seeds.count} > 0 ? 1 : 0`}));`,
      );
    } else this.line(`TS_TRY(sol_invoke_signed(&${ixName}, params->infos, ${k}, NULL, 0));`);
    return undefined;
  }

  protected emitEvent(node: ts.CallExpression, cpi?: { authority: string; program: string }): undefined {
    const targ = node.typeArguments?.[0];
    const s = targ && ts.isTypeReferenceNode(targ) && ts.isIdentifier(targ.typeName) ? this.model.structs.get(targ.typeName.text) : undefined;
    if (!s) this.fail(node, "emit needs an explicit event type: emit<MyEvent>({ ... })");
    const obj = node.arguments[0];
    if (node.arguments.length !== (cpi ? 3 : 1) || !ts.isObjectLiteralExpression(obj))
      this.fail(node, "emit<T>({ field: value, ... }) takes one object literal");
    if (s.layout === "borsh") return this.emitBorshEvent(node, s, obj, cpi);
    const given = new Map<string, ts.Expression>();
    for (const p of obj.properties) {
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) given.set(p.name.text, p.initializer);
      else if (ts.isShorthandPropertyAssignment(p)) given.set(p.name.text, p.name);
      else this.fail(p, "use plain `field: value` entries");
    }
    for (const k of given.keys()) if (!s.fields.some((f) => f.name === k)) this.fail(obj, `${s.name} has no field "${k}"`);
    // In events an Option is Borsh (variable); in account data it is fixed. One struct cannot be both.
    // Structs nested in an event are copied in their fixed layout; one that is also emitted on its own describes its
    // Options/enums as Borsh in the IDL. A struct cannot be both.
    const borshy = (name: string) => this.model.structs.get(name)?.fields.some((f) => f.type.kind === "option" || f.type.kind === "dataEnum") ?? false;
    const nested = this.nestedStructs(s.name);
    for (const n of nested)
      if (borshy(n) && (this.model.events.has(n) || n === s.name))
        this.fail(node, `${n} has Option or enum fields and is both an event and nested in event ${s.name}; declare a separate struct for one of them`);
    for (const e of this.model.events)
      if (borshy(s.name) && this.nestedStructs(e).has(s.name))
        this.fail(node, `${s.name} has Option or enum fields and is nested in event ${e}; declare a separate event struct`);
    if (s.fields.some((f) => f.type.kind === "option" || f.type.kind === "dataEnum") && this.fixedLayoutStructs().has(s.name))
      this.fail(
        node,
        `${s.name} has Option or enum fields and is account data or an argument (fixed layout there, Borsh in events); declare a separate event struct`,
      );
    this.model.events.add(s.name);

    // Evaluate the fields in source order (as JS does) into temporaries, then serialize them in declaration order.
    type Put = (src: string, n: string, bytes?: number) => void;
    const staged = new Map<string, (put: Put) => void>();
    for (const f of s.fields) if (!given.has(f.name)) this.fail(obj, `missing field "${f.name}" of ${s.name}`);
    for (const [name, e] of given) {
      const f = s.fields.find((x) => x.name === name)!;
      if (f.type.kind === "vec" && f.type.cap !== undefined) {
        // A FixedVec keeps its fixed layout, as in account data: u32 length, then room for N elements.
        const ft = f.type;
        const t = this.tmp("evv");
        this.line(`${fixedVecC(ft)} ${t};`);
        this.line(`ts_memzero(&${t}, sizeof(${t}));`);
        this.writeAggregate({ lv: t, type: ft, writable: true }, e);
        const n = this.fieldBytes(ft);
        staged.set(name, (put) => put(`&${t}`, String(n), n));
        continue;
      }
      if (f.type.kind === "vec") {
        // A Vec is Borsh: u32 length, then the elements, read from a Vec argument or account data when emitted.
        const l = ts.isIdentifier(e) ? this.lookup(e.text) : undefined;
        const r = l?.type.kind === "vecArg" ? undefined : this.ref(e);
        const elemSize = this.fieldBytes(f.type.elem);
        if (l?.type.kind === "vecArg") {
          if (!sameType(l.type.elem, f.type.elem)) this.fail(e, `expected a ${typeName(f.type)}`);
          const c = l.c;
          staged.set(name, (put) => {
            const n = this.tmp("vl");
            this.line(`uint32_t ${n} = (uint32_t)${c}.len;`);
            put(`&${n}`, "4");
            put(`(const uint8_t *)${c}.ptr`, `(uint64_t)${n} * ${elemSize}`);
          });
        } else if (r?.vec && r.type.kind === "vec" && sameType(r.type.elem, f.type.elem)) {
          const info = r.vec;
          staged.set(name, (put) => {
            const n = this.tmp("vl");
            this.line(`uint32_t ${n} = (uint32_t)${vecCount(info)};`);
            put(`&${n}`, "4");
            put(`(const uint8_t *)${info.items}`, `(uint64_t)${n} * ${elemSize}`);
          });
        } else this.fail(e, `expected a ${typeName(f.type)}: a Vec argument or a list in account data`);
        continue;
      }
      if (f.type.kind === "option" && f.type.inner.kind === "struct") this.fail(obj, "Option<struct> fields are not supported in events yet");
      const vt = f.type.kind === "string" ? STRING : f.type.kind === "option" || isScalar(f.type) ? (f.type as ValueType) : undefined;
      const t = this.tmp("evf");
      if (f.type.kind === "dataEnum") {
        const enumName = f.type.name;
        const src = this.ref(e);
        if (!src || src.type.kind !== "dataEnum" || src.type.name !== enumName) this.fail(e, `expected a ${enumName}`);
        this.line(`TSE_${enumName} ${t};`);
        this.line(`ts_memcpy(&${t}, &${src.lv}, sizeof(${t}));`);
        staged.set(name, (put) => this.serializeDataEnumLv(t, enumName, put));
      } else if (vt) {
        const v = this.ownedString(this.expect(this.expr(e, vt), vt, e));
        if (vt.kind === "pubkey") this.line(`SolPubkey ${t} = *(${v.c});`);
        else this.line(`${valueC(vt)} ${t} = ${v.c};`);
        const held: Value = { c: vt.kind === "pubkey" ? `(&${t})` : t, type: vt };
        staged.set(name, (put) => this.serialize(held, e, put));
      } else if (f.type.kind === "fstring") {
        // Event FixedString keeps its fixed layout: u32 length + capacity bytes.
        const cap = f.type.cap;
        const v = this.expect(this.expr(e, STRING), STRING, e);
        this.line(`TS_FStr${cap} ${t};`);
        this.line(`TS_TRY(ts_fstr_set((uint8_t *)&${t}, ${cap}, ${v.c}));`);
        staged.set(name, (put) => put(`&${t}`, String(4 + cap), 4 + cap));
      } else {
        const src = this.ref(e);
        if (!src || !sameType(src.type, f.type)) this.fail(e, `expected a ${typeName(f.type)} from account data`);
        const n = this.fieldBytes(f.type);
        this.line(`uint8_t ${t}[${n}];`);
        this.line(`ts_memcpy(${t}, &${src.lv}, ${n});`);
        staged.set(name, (put) => put(t, String(n), n));
      }
    }
    this.sendEvent(s, obj, cpi, (put) => {
      for (const f of s.fields) staged.get(f.name)!(put);
    });
    return undefined;
  }

  /** emit<T> of a @layout borsh struct: built like account data, then packed as Anchor serializes it. */
  private emitBorshEvent(node: ts.CallExpression, s: StructDef, obj: ts.ObjectLiteralExpression, cpi?: { authority: string; program: string }): undefined {
    this.model.events.add(s.name);
    const t = this.tmp("evs");
    const b = this.tmp("evb");
    const w = this.tmp("evw");
    // One pair of heap buffers per emit site, taken on first use: an emit in a loop does not take new heap each pass.
    this.hoisted.push(`  TSS_${s.name} *${t} = NULL;`, `  uint8_t *${b} = NULL;`);
    this.line(`if (${t} == NULL) TS_TRY(ts_alloc(sizeof(TSS_${s.name}), (uint8_t **)&${t}));`);
    this.writeAggregate({ lv: `(*${t})`, type: { kind: "struct", name: s.name }, writable: true }, obj);
    // Borsh never takes more than the fixed layout (a String/Vec is 4 + used bytes, an Option 1 + payload).
    this.line(`uint64_t ${w} = 0;`);
    this.line(`if (${b} == NULL) TS_TRY(ts_alloc(sizeof(TSS_${s.name}), &${b}));`);
    this.line(`TS_TRY(ts_pack_${s.name}(${t}, ${b}, sizeof(TSS_${s.name}), &${w}));`);
    this.sendEvent(s, node, cpi, (put) => put(b, w));
    return undefined;
  }

  /** Discriminator + `body`, logged (emit) or self-invoked (emitCpi). */
  private sendEvent(
    s: StructDef,
    at: ts.Node,
    cpi: { authority: string; program: string } | undefined,
    body: (put: (src: string, n: string, bytes?: number) => void) => void,
  ) {
    const { buf, len, put, finish } = this.byteBuffer("ev", MAX_EVENT + (cpi ? 8 : 0), "TS_ERR_EVENT_TOO_LARGE", "event");
    if (cpi) put("TS_EVENT_IX_TAG", "8", 8);
    const disc = this.tmp("disc");
    this.line(`static const uint8_t ${disc}[8] = ${cBytes(s.eventDiscriminator)};`);
    put(disc, "8", 8);
    body(put);
    finish(at);
    if (cpi) {
      // Invoke ourselves with the event authority PDA as the only (signing) account; the entrypoint accepts it.
      const m = this.tmp("metas");
      const sd = this.tmp("seeds");
      const ix = this.tmp("cpi");
      const signer = this.tmp("signer");
      this.line(`SolAccountMeta ${m}[1] = {{&a_${cpi.authority}->key, false, true}};`);
      this.line(`SolSignerSeed ${sd}[2] = {{(const uint8_t *)"__event_authority", 17}, {&eb_${cpi.authority}, 1}};`);
      this.line(`SolInstruction ${ix} = {&a_${cpi.program}->key, ${m}, 1, ${buf}, ${len}};`);
      this.line(`SolSignerSeeds ${signer} = {${sd}, 2};`);
      this.line(`TS_TRY(ts_invoke(params, &${ix}, &${signer}, 1));`);
      return;
    }
    const bytes = this.tmp("evbytes");
    this.line(`SolBytes ${bytes} = {${buf}, ${len}};`);
    this.line(`sol_log_data(&${bytes}, 1);`);
  }
}
