import ts from "typescript";
import { discriminator, snakeCase } from "../analyze.js";
import {
  INT_INFO,
  type AccountParam,
  type FieldType,
  type IdlSeed,
  type IntName,
  type StructDef,
  type ValueType,
  isScalar,
  isWritable,
  sameType,
  scalarSize,
  typeName,
} from "../model.js";
import {
  MAX_ACCOUNTS,
  MAX_SEEDS,
  MAX_CPI_DATA,
  MAX_EVENT,
  U64,
  U8,
  BOOL,
  PUBKEY,
  STRING,
  type Value,
  cBytes,
  isStable,
  cString,
  scalarStorageC,
  optC,
  valueC,
} from "./shared.js";
import { CallEmitter } from "./calls.js";

/**
 * Other programs: PDAs and seeds, account creation, System/Token/ATA/Metaplex CPIs, generic invoke, Borsh
 * serialization and events.
 */
export abstract class CpiEmitter extends CallEmitter {
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
      } else this.fail(el, "seeds can be strings, Pubkeys or integers");
    }
    const name = this.tmp("seeds");
    const slots = parts.length + extra;
    this.line(`SolSignerSeed ${name}[${Math.max(slots, 1)}] = {${parts.join(", ")}};`);
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

  protected create(node: ts.CallExpression, target: AccountParam, topLevel: boolean, ifNeeded = false): Value {
    if (!topLevel) this.fail(node, `${target.name}.${ifNeeded ? "createIfNeeded" : "create"}(...) must be a top-level statement of the instruction`);
    if (this.created.has(target.name)) this.fail(node, `${target.name} is already created`);
    if (node.arguments.length !== 2) this.fail(node, "create(payer, seeds) takes two arguments");
    const payer = this.accountParam(node.arguments[0], "the payer");
    if (payer.kind.kind !== "signer" || !payer.kind.mut) this.fail(node.arguments[0], "the payer must be a Mut<Signer>");
    const seeds = this.seeds(node.arguments[1], 1);
    this.recordPda(target, seeds.idl);
    const s = (target.kind as { struct: StructDef }).struct;
    const b = this.tmp("bump");
    this.line(`uint8_t ${b};`);
    if (ifNeeded) {
      // Returns whether it was created now; an existing account must be this PDA, ours, and a ${s.name}.
      const created = this.tmp("created");
      this.line(`bool ${created};`);
      this.line(
        `TS_TRY(ts_create_pda_if_needed(params, a_${payer.name}, a_${target.name}, ${seeds.name}, ${seeds.count}, TS_DISC_${s.name}, 8 + sizeof(TSS_${s.name}), &${b}, &${created}));`,
      );
      this.created.add(target.name);
      this.pendingInit.delete(target.name);
      this.bumps.set(target.name, b);
      return { c: created, type: BOOL };
    }
    this.line(
      `TS_TRY(ts_create_pda(params, a_${payer.name}, a_${target.name}, ${seeds.name}, ${seeds.count}, TS_DISC_${s.name}, 8 + sizeof(TSS_${s.name}), &${b}));`,
    );
    this.created.add(target.name);
    this.pendingInit.delete(target.name);
    this.bumps.set(target.name, b);
    return { c: b, type: U8 };
  }

  /**
   * `ata.create(payer)` / `ata.createIfNeeded(payer)` on `Ata<Init|InitIfNeeded<TokenAccount>, "owner", "mint">`
   * (Anchor's `init` / `init_if_needed` with `associated_token::…`). create always calls the ATA program's Create, which
   * fails if the account exists. createIfNeeded calls it only when the account is still a System account (Anchor's
   * test) and otherwise checks that the existing account is that ATA. Either way the account is then checked as an
   * initialized token account of that mint and owner, and is a TokenAccount from here on.
   */
  protected createAta(node: ts.CallExpression, target: AccountParam, topLevel: boolean): Value | undefined {
    const ifNeeded = (target.kind as { init?: string }).init === "ifNeeded";
    const call = `${target.name}.${ifNeeded ? "createIfNeeded" : "create"}`;
    if (!topLevel) this.fail(node, `${call}(...) must be a top-level statement of the instruction`);
    if (this.created.has(target.name)) this.fail(node, `${target.name} is already created`);
    if (node.arguments.length !== 1) this.fail(node, `${call}(payer) takes the payer`);
    const payer = this.accountParam(node.arguments[0], "the payer");
    if (payer.kind.kind !== "signer" || !payer.kind.mut) this.fail(node.arguments[0], "the payer must be a Mut<Signer>");
    const need = (kind: string, what: string) => {
      const p = this.ix!.accounts.find((o) => o.kind.kind === kind);
      if (!p) this.fail(node, `${call}(...) needs ${what} parameter`);
      return p;
    };
    const ataProgram = need("ataProgram", "an AssociatedTokenProgram");
    const system = need("system", "a SystemProgram");
    const tokenProgram = need("tokenProgram", "a token program (TokenProgram, Token2022Program or TokenInterface)");
    const { owner, mint } = target.constraints.ata!;
    const a = `a_${target.name}`;
    const create = `TS_TRY(ts_ata_create(params, a_${ataProgram.name}, a_${payer.name}, ${a}, a_${owner}, a_${mint}, a_${system.name}, a_${tokenProgram.name}, false));`;
    let result: Value | undefined;
    if (ifNeeded) {
      const created = this.tmp("created");
      this.line(`bool ${created} = ts_key_eq(&${a}->owner, &TS_SYSTEM_PROGRAM_ID);`);
      this.line(`if (${created}) {`);
      this.line(`  ${create}`);
      this.line(`} else {`);
      this.line(`  SolPubkey ata_${target.name};`);
      this.line(`  TS_TRY(ts_ata_address(&a_${owner}->key, &a_${mint}->key, &a_${tokenProgram.name}->key, &ata_${target.name}));`);
      this.line(
        `  if (!ts_key_eq(&ata_${target.name}, &${a}->key)) TS_FAIL(TS_ERR_ASSOCIATED, "TypeSOL: ${target.name} is not the associated token account of ${owner} and ${mint}");`,
      );
      this.line(`}`);
      result = { c: created, type: BOOL };
    } else this.line(create);
    this.line(`TS_TRY(ts_check_token_account(${a}));`);
    this.line(`if (!ts_key_eq(ts_token_mint(${a}), &a_${mint}->key)) TS_FAIL(TS_ERR_TOKEN_MINT, "TypeSOL: ${target.name} is not a token account of ${mint}");`);
    this.line(`if (!ts_key_eq(ts_token_owner(${a}), &a_${owner}->key)) TS_FAIL(TS_ERR_TOKEN_OWNER, "TypeSOL: ${target.name} is not owned by ${owner}");`);
    this.created.add(target.name);
    this.pendingInit.delete(target.name);
    return result;
  }

  protected systemTransfer(node: ts.CallExpression): undefined {
    if (node.arguments.length !== 3) this.fail(node, "transfer(from, to, lamports) takes three arguments");
    const [fromN, toN, amtN] = node.arguments;
    const from = this.accountParam(fromN, "transfer's source");
    if (from.kind.kind !== "signer" || !from.kind.mut) this.fail(fromN, "the source must be a Mut<Signer>");
    const to = this.accountParam(toN, "transfer's destination");
    if (!isWritable(to.kind)) this.fail(toN, "the destination must be writable (Mut<...>)");
    const amt = this.expect(this.expr(amtN, U64), U64, amtN);
    this.line(`TS_TRY(ts_system_transfer(params, a_${from.name}, a_${to.name}, ${amt.c}));`);
    return undefined;
  }

  /** systemProgram.createAccount(payer, account, lamports, space, owner, signerSeeds?) */
  protected createAccount(node: ts.CallExpression, system: AccountParam): undefined {
    const a = node.arguments;
    if (a.length !== 5 && a.length !== 6) this.fail(node, "createAccount(payer, account, lamports, space, owner, signerSeeds?)");
    const payer = this.accountParam(a[0], "the payer");
    if (payer.kind.kind !== "signer" || !payer.kind.mut) this.fail(a[0], "the payer must be a Mut<Signer>");
    const acct = this.accountParam(a[1], "the new account");
    if (!isWritable(acct.kind)) this.fail(a[1], "the new account must be writable (Mut<Signer> or Mut<AccountInfo>)");
    if (acct.kind.kind !== "signer" && a.length !== 6) this.fail(a[1], "the new account must sign: a Mut<Signer> keypair, or pass signerSeeds for a PDA");
    const { buf, len, put, finish } = this.byteBuffer("sys", 52, "TS_ERR_INSTRUCTION_DATA", "system instruction");
    const tag = this.tmp("tag");
    this.line(`uint32_t ${tag} = 0; /* CreateAccount */`);
    put(`&${tag}`, "4", 4);
    this.serialize(this.expect(this.expr(a[2], U64), U64, a[2]), a[2], put);
    this.serialize(this.expect(this.expr(a[3], U64), U64, a[3]), a[3], put);
    this.serialize(this.expect(this.expr(a[4], PUBKEY), PUBKEY, a[4]), a[4], put);
    finish(node);
    const seeds = a.length === 6 ? this.signingSeeds(a[5]) : { name: "NULL", count: 0 };
    this.cpi(
      `a_${system.name}`,
      [
        [`a_${payer.name}`, true, true],
        [`a_${acct.name}`, true, true],
      ],
      buf,
      len,
      seeds,
    );
    return undefined;
  }

  /** Emit a CPI to the program account `program` with these metas (account, writable, signer). */
  protected cpi(program: string, metas: [string, boolean, boolean][], buf: string, len: string, seeds: { name: string; count: number | string }) {
    const m = this.tmp("metas");
    this.line(`SolAccountMeta ${m}[${metas.length}] = {${metas.map(([acc, w, sg]) => `{&${acc}->key, ${w}, ${sg}}`).join(", ")}};`);
    this.line(`TS_TRY(ts_cpi(params, ${program}, ${buf}, ${len}, ${m}, ${metas.length}, ${seeds.name}, ${seeds.count}));`);
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

  protected tokenOp(node: ts.CallExpression, program: AccountParam, method: string): undefined {
    const a = node.arguments;
    const p = `a_${program.name}`;
    const want = (n: ts.Expression, kind: "token" | "mint", mut: boolean, what: string) => {
      const acct = this.accountParam(n, what);
      if (acct.kind.kind !== kind || (mut && !(acct.kind as { mut: boolean }).mut))
        this.fail(n, `${what} must be a ${mut ? "Mut<" : ""}${kind === "token" ? "TokenAccount" : "Mint"}${mut ? ">" : ""}`);
      return acct;
    };
    const arity = (fixed: number) => {
      if (a.length !== fixed && a.length !== fixed + 1) this.fail(node, `${method} takes ${fixed} arguments plus optional signerSeeds`);
    };
    const amount = (n: ts.Expression) => this.expect(this.expr(n, U64), U64, n).c;
    switch (method) {
      case "transfer": {
        arity(4);
        const from = want(a[0], "token", true, "the source");
        const to = want(a[1], "token", true, "the destination");
        const auth = this.accountParam(a[2], "the authority");
        const amt = amount(a[3]);
        const s = this.signerSeeds(a[4], auth, a[2]);
        this.line(`TS_TRY(ts_token_transfer(params, ${p}, a_${from.name}, a_${to.name}, a_${auth.name}, ${amt}, ${s.name}, ${s.count}));`);
        return undefined;
      }
      case "transferChecked": {
        arity(5);
        const from = want(a[0], "token", true, "the source");
        const mint = want(a[1], "mint", false, "the mint");
        const to = want(a[2], "token", true, "the destination");
        const auth = this.accountParam(a[3], "the authority");
        const amt = amount(a[4]);
        const s = this.signerSeeds(a[5], auth, a[3]);
        this.line(
          `TS_TRY(ts_token_transfer_checked(params, ${p}, a_${from.name}, a_${mint.name}, a_${to.name}, a_${auth.name}, ${amt}, ${s.name}, ${s.count}));`,
        );
        return undefined;
      }
      case "mintTo": {
        arity(4);
        const mint = want(a[0], "mint", true, "the mint");
        const to = want(a[1], "token", true, "the destination");
        const auth = this.accountParam(a[2], "the mint authority");
        const amt = amount(a[3]);
        const s = this.signerSeeds(a[4], auth, a[2]);
        this.line(`TS_TRY(ts_token_mint_to(params, ${p}, a_${mint.name}, a_${to.name}, a_${auth.name}, ${amt}, ${s.name}, ${s.count}));`);
        return undefined;
      }
      case "burn": {
        arity(4);
        const from = want(a[0], "token", true, "the burned account");
        const mint = want(a[1], "mint", true, "the mint");
        const auth = this.accountParam(a[2], "the authority");
        const amt = amount(a[3]);
        const s = this.signerSeeds(a[4], auth, a[2]);
        this.line(`TS_TRY(ts_token_burn(params, ${p}, a_${from.name}, a_${mint.name}, a_${auth.name}, ${amt}, ${s.name}, ${s.count}));`);
        return undefined;
      }
      case "initializeMetadata": {
        if (program.kind.kind === "tokenProgram" && program.kind.flavor === "token")
          this.fail(node, "metadata lives in Token-2022 mints; use Token2022Program or TokenInterface");
        if (a.length !== 6 && a.length !== 7) this.fail(node, "initializeMetadata(mint, updateAuthority, mintAuthority, name, symbol, uri, signerSeeds?)");
        const mint = want(a[0], "mint", true, "the mint");
        const ua = this.accountParam(a[1], "the update authority");
        const ma = this.accountParam(a[2], "the mint authority");
        const [nm, sym, uri] = [a[3], a[4], a[5]].map((n) => this.expect(this.expr(n, STRING), STRING, n).c);
        const s = this.signerSeeds(a[6], ma, a[2]);
        this.line(`TS_TRY(ts_t22_init_metadata(params, ${p}, a_${mint.name}, a_${ua.name}, a_${ma.name}, ${nm}, ${sym}, ${uri}, ${s.name}, ${s.count}));`);
        return undefined;
      }
      case "closeAccount": {
        arity(3);
        const acct = want(a[0], "token", true, "the closed account");
        const dest = this.accountParam(a[1], "the destination");
        if (!isWritable(dest.kind)) this.fail(a[1], "the destination must be writable (Mut<...>)");
        const auth = this.accountParam(a[2], "the authority");
        const s = this.signerSeeds(a[3], auth, a[2]);
        this.line(`TS_TRY(ts_token_close(params, ${p}, a_${acct.name}, a_${dest.name}, a_${auth.name}, ${s.name}, ${s.count}));`);
        return undefined;
      }
    }
    // The remaining SPL Token instructions share one shape: a tag, a few fixed fields, and fixed account metas.
    const anyAcct = (n: ts.Expression, what: string, mut: boolean) => {
      const acct = this.accountParam(n, what);
      if (mut && !isWritable(acct.kind)) this.fail(n, `${what} must be writable (Mut<...>)`);
      return acct;
    };
    type Put = (src: string, n: string, bytes?: number) => void;
    const simple = (
      tag: number,
      fields: ((put: Put) => void)[],
      metas: [AccountParam, boolean, boolean][],
      seeds: { name: string; count: number | string },
    ) => {
      const { buf, len, put, finish } = this.byteBuffer("tok", 128, "TS_ERR_INSTRUCTION_DATA", "token instruction");
      const t = this.tmp("tag");
      this.line(`uint8_t ${t} = ${tag};`);
      put(`&${t}`, "1", 1);
      for (const f of fields) f(put);
      finish(node);
      this.cpi(
        p,
        metas.map(([acc, w, sg]) => [`a_${acc.name}`, w, sg]),
        buf,
        len,
        seeds,
      );
    };
    const value = (n: ts.Expression, t: ValueType) => (put: Put) => this.serialize(this.expect(this.expr(n, t), t, n), n, put);
    const optKey: ValueType = { kind: "option", inner: PUBKEY };
    switch (method) {
      case "approve": {
        arity(4);
        const src = want(a[0], "token", true, "the source");
        const delegate = this.accountParam(a[1], "the delegate");
        const owner = this.accountParam(a[2], "the owner");
        const s = this.signerSeeds(a[4], owner, a[2]);
        const amt = value(a[3], U64);
        simple(
          4,
          [amt],
          [
            [src, true, false],
            [delegate, false, false],
            [owner, false, true],
          ],
          s,
        );
        return undefined;
      }
      case "revoke": {
        arity(2);
        const src = want(a[0], "token", true, "the source");
        const owner = this.accountParam(a[1], "the owner");
        simple(
          5,
          [],
          [
            [src, true, false],
            [owner, false, true],
          ],
          this.signerSeeds(a[2], owner, a[1]),
        );
        return undefined;
      }
      case "setAuthority": {
        arity(4);
        const target = anyAcct(a[0], "the mint or token account", true);
        const current = this.accountParam(a[1], "the current authority");
        this.model.options.set("pubkey", PUBKEY);
        const s = this.signerSeeds(a[4], current, a[1]);
        simple(
          6,
          [value(a[2], U8), value(a[3], optKey)],
          [
            [target, true, false],
            [current, false, true],
          ],
          s,
        );
        return undefined;
      }
      case "freezeAccount":
      case "thawAccount": {
        arity(3);
        const acct = want(a[0], "token", true, "the token account");
        const mint = this.accountParam(a[1], "the mint");
        const auth = this.accountParam(a[2], "the freeze authority");
        simple(
          method === "freezeAccount" ? 10 : 11,
          [],
          [
            [acct, true, false],
            [mint, false, false],
            [auth, false, true],
          ],
          this.signerSeeds(a[3], auth, a[2]),
        );
        return undefined;
      }
      case "syncNative": {
        if (a.length !== 1) this.fail(node, "syncNative(account) takes the wrapped-SOL token account");
        const acct = anyAcct(a[0], "the token account", true);
        simple(17, [], [[acct, true, false]], { name: "NULL", count: 0 });
        return undefined;
      }
      case "initializeMint2": {
        if (a.length !== 4) this.fail(node, "initializeMint2(mint, decimals, mintAuthority, freezeAuthority | null)");
        const mint = anyAcct(a[0], "the mint", true);
        this.model.options.set("pubkey", PUBKEY);
        simple(20, [value(a[1], U8), value(a[2], PUBKEY), value(a[3], optKey)], [[mint, true, false]], { name: "NULL", count: 0 });
        return undefined;
      }
      case "initializeAccount3": {
        if (a.length !== 3) this.fail(node, "initializeAccount3(account, mint, owner)");
        const acct = anyAcct(a[0], "the token account", true);
        const mint = this.accountParam(a[1], "the mint");
        simple(
          18,
          [value(a[2], PUBKEY)],
          [
            [acct, true, false],
            [mint, false, false],
          ],
          { name: "NULL", count: 0 },
        );
        return undefined;
      }
    }
    this.fail(
      node.expression,
      `token programs support transfer, transferChecked, mintTo, burn, closeAccount, approve, revoke, setAuthority, freezeAccount, thawAccount, syncNative, initializeMint2, initializeAccount3 and initializeMetadata, not ${method}`,
    );
  }

  protected ataOp(node: ts.CallExpression, program: AccountParam, method: string): undefined {
    if (method !== "create" && method !== "createIdempotent") this.fail(node.expression, "the Associated Token program supports create and createIdempotent");
    const a = node.arguments;
    if (a.length !== 6) this.fail(node, `${method}(payer, ata, owner, mint, systemProgram, tokenProgram) takes six accounts`);
    const payer = this.accountParam(a[0], "the payer");
    if (payer.kind.kind !== "signer" || !payer.kind.mut) this.fail(a[0], "the payer must be a Mut<Signer>");
    const ata = this.accountParam(a[1], "the token account");
    if (!isWritable(ata.kind)) this.fail(a[1], "the token account must be Mut<AccountInfo>");
    const [owner, mint, sys, tp] = [a[2], a[3], a[4], a[5]].map((n, i) =>
      this.accountParam(n, ["the owner", "the mint", "the system program", "the token program"][i]),
    );
    if (sys.kind.kind !== "system") this.fail(a[4], "pass the SystemProgram parameter");
    if (tp.kind.kind !== "tokenProgram") this.fail(a[5], "pass a token program parameter");
    this.line(
      `TS_TRY(ts_ata_create(params, a_${program.name}, a_${payer.name}, a_${ata.name}, a_${owner.name}, a_${mint.name}, a_${sys.name}, a_${tp.name}, ${method === "createIdempotent"}));`,
    );
    return undefined;
  }

  protected metadataOp(node: ts.CallExpression, program: AccountParam, method: string): undefined {
    if (method !== "createV3") this.fail(node.expression, "the Token Metadata program supports createV3");
    const a = node.arguments;
    if (a.length !== 11 && a.length !== 12)
      this.fail(
        node,
        "createV3(metadata, mint, mintAuthority, payer, updateAuthority, systemProgram, name, symbol, uri, sellerFeeBasisPoints, isMutable, signerSeeds?)",
      );
    const [metadata, mint, mintAuth, payer, updateAuth, sys] = a.slice(0, 6).map((n, i) => this.accountParam(n, `account #${i + 1}`));
    if (!isWritable(metadata.kind)) this.fail(a[0], "the metadata account must be Mut<AccountInfo>");
    if (payer.kind.kind !== "signer" || !payer.kind.mut) this.fail(a[3], "the payer must be a Mut<Signer>");
    if (sys.kind.kind !== "system") this.fail(a[5], "pass the SystemProgram parameter");
    const [name, symbol, uri] = a.slice(6, 9).map((n) => this.expect(this.expr(n, STRING), STRING, n).c);
    const fee = this.expect(this.expr(a[9], { kind: "int", name: "u16" }), { kind: "int", name: "u16" }, a[9]);
    const mutable = this.expect(this.expr(a[10], BOOL), BOOL, a[10]);
    const seeds = this.signerSeeds(a[11], mintAuth, a[2]);
    this.line(
      `TS_TRY(ts_mpl_create_v3(params, a_${program.name}, a_${metadata.name}, a_${mint.name}, a_${mintAuth.name}, a_${payer.name}, a_${updateAuth.name}, a_${sys.name}, ${name}, ${symbol}, ${uri}, ${fee.c}, ${mutable.c}, ${seeds.name}, ${seeds.count}));`,
    );
    return undefined;
  }

  /**
   * One account of a Metaplex CPI: an account parameter, or `null` for an optional account left out
   * (Metaplex programs take their own id in its place).
   */
  protected mplMeta(n: ts.Expression, program: AccountParam, what: string, writable: boolean, signer: boolean): [string, boolean, boolean] {
    if (n.kind === ts.SyntaxKind.NullKeyword) return [`a_${program.name}`, false, false];
    const acct = this.accountParam(n, what);
    if (writable && !isWritable(acct.kind)) this.fail(n, `${what} must be writable (Mut<...>)`);
    return [`a_${acct.name}`, writable, signer];
  }

  /** Borsh fields into a fresh buffer: raw bytes ("u8:N" style) or lowered values. */
  protected mplData(at: ts.Node, max: number, fields: ({ bytes: number[] } | { value: ts.Expression; type: ValueType })[]) {
    const { buf, len, put, finish } = this.byteBuffer("mpl", max, "TS_ERR_INSTRUCTION_DATA", "Metaplex instruction");
    for (const f of fields) {
      if ("bytes" in f) {
        const name = this.tmp("bytes");
        this.line(`static const uint8_t ${name}[${f.bytes.length}] = ${cBytes(f.bytes)};`);
        put(name, String(f.bytes.length), f.bytes.length);
      } else this.serialize(this.expect(this.expr(f.value, f.type), f.type, f.value), f.value, put);
    }
    finish(at);
    return { buf, len };
  }

  /** Metaplex Core: createAsset, createCollection, transferAsset, burnAsset (no plugins). */
  protected coreOp(node: ts.CallExpression, core: AccountParam, method: string): undefined {
    const a = node.arguments;
    const p = `a_${core.name}`;
    const seedsAt = (i: number) => (a[i] ? this.signingSeeds(a[i]) : { name: "NULL", count: 0 });
    const str = (n: ts.Expression) => ({ value: n, type: STRING });
    switch (method) {
      case "createAsset": {
        // CreateV1: asset, collection, authority, payer, owner, updateAuthority, systemProgram, logWrapper.
        if (a.length !== 8 && a.length !== 9)
          this.fail(node, "createAsset(asset, collection | null, authority | null, payer, owner | null, systemProgram, name, uri, signerSeeds?)");
        const metas = [
          this.mplMeta(a[0], core, "the asset", true, true),
          this.mplMeta(a[1], core, "the collection", true, false),
          this.mplMeta(a[2], core, "the collection authority", false, true),
          this.mplMeta(a[3], core, "the payer", true, true),
          this.mplMeta(a[4], core, "the owner", false, false),
          [p, false, false] as [string, boolean, boolean], // update authority: the collection's, or the payer by default
          this.mplMeta(a[5], core, "the system program", false, false),
          [p, false, false] as [string, boolean, boolean],
        ];
        const data = this.mplData(node, 1024, [{ bytes: [0, 0] }, str(a[6]), str(a[7]), { bytes: [0] }]);
        this.cpi(p, metas, data.buf, data.len, seedsAt(8));
        return undefined;
      }
      case "createCollection": {
        // CreateCollectionV1: collection, updateAuthority, payer, systemProgram.
        if (a.length !== 6 && a.length !== 7)
          this.fail(node, "createCollection(collection, updateAuthority | null, payer, systemProgram, name, uri, signerSeeds?)");
        const metas = [
          this.mplMeta(a[0], core, "the collection", true, true),
          this.mplMeta(a[1], core, "the update authority", false, false),
          this.mplMeta(a[2], core, "the payer", true, true),
          this.mplMeta(a[3], core, "the system program", false, false),
        ];
        const data = this.mplData(node, 1024, [{ bytes: [1] }, str(a[4]), str(a[5]), { bytes: [0] }]);
        this.cpi(p, metas, data.buf, data.len, seedsAt(6));
        return undefined;
      }
      case "transferAsset": {
        // TransferV1: asset, collection, payer, authority, newOwner, systemProgram, logWrapper.
        if (a.length !== 5 && a.length !== 6) this.fail(node, "transferAsset(asset, collection | null, payer, authority | null, newOwner, signerSeeds?)");
        const metas = [
          this.mplMeta(a[0], core, "the asset", true, false),
          this.mplMeta(a[1], core, "the collection", false, false),
          this.mplMeta(a[2], core, "the payer", true, true),
          this.mplMeta(a[3], core, "the authority", false, true),
          this.mplMeta(a[4], core, "the new owner", false, false),
          [p, false, false] as [string, boolean, boolean],
          [p, false, false] as [string, boolean, boolean],
        ];
        const data = this.mplData(node, 8, [{ bytes: [14, 0] }]);
        this.cpi(p, metas, data.buf, data.len, seedsAt(5));
        return undefined;
      }
      case "burnAsset": {
        // BurnV1: asset, collection, payer, authority, systemProgram, logWrapper.
        if (a.length !== 4 && a.length !== 5) this.fail(node, "burnAsset(asset, collection | null, payer, authority | null, signerSeeds?)");
        const metas = [
          this.mplMeta(a[0], core, "the asset", true, false),
          this.mplMeta(a[1], core, "the collection", true, false),
          this.mplMeta(a[2], core, "the payer", true, true),
          this.mplMeta(a[3], core, "the authority", false, true),
          [p, false, false] as [string, boolean, boolean],
          [p, false, false] as [string, boolean, boolean],
        ];
        const data = this.mplData(node, 8, [{ bytes: [12, 0] }]);
        this.cpi(p, metas, data.buf, data.len, seedsAt(4));
        return undefined;
      }
    }
    this.fail(node.expression, `Metaplex Core supports createAsset, createCollection, transferAsset and burnAsset, not ${method}`);
  }

  /** Bubblegum (compressed NFTs on SPL account compression): createTree, mint (MintV1, no collection, no creators). */
  protected bubblegumOp(node: ts.CallExpression, bg: AccountParam, method: string): undefined {
    const a = node.arguments;
    const p = `a_${bg.name}`;
    const seedsAt = (i: number) => (a[i] ? this.signingSeeds(a[i]) : { name: "NULL", count: 0 });
    const acct = (i: number, what: string, w: boolean, s: boolean) => this.mplMeta(a[i], bg, what, w, s);
    switch (method) {
      case "createTree": {
        // CreateTreeConfig: treeConfig, merkleTree, payer, treeCreator, logWrapper, compressionProgram, systemProgram.
        if (a.length !== 10 && a.length !== 11)
          this.fail(
            node,
            "createTree(treeConfig, merkleTree, payer, treeCreator, logWrapper, compressionProgram, systemProgram, maxDepth, maxBufferSize, isPublic, signerSeeds?)",
          );
        const metas = [
          acct(0, "the tree config", true, false),
          acct(1, "the merkle tree", true, false),
          acct(2, "the payer", true, true),
          acct(3, "the tree creator", false, true),
          acct(4, "the log wrapper", false, false),
          acct(5, "the compression program", false, false),
          acct(6, "the system program", false, false),
        ];
        const U32: ValueType = { kind: "int", name: "u32" };
        const data = this.mplData(node, 32, [
          { bytes: [165, 83, 136, 142, 89, 202, 47, 220] },
          { value: a[7], type: U32 },
          { value: a[8], type: U32 },
          { bytes: [1] }, // public: Some(bool)
          { value: a[9], type: BOOL },
        ]);
        this.cpi(p, metas, data.buf, data.len, seedsAt(10));
        return undefined;
      }
      case "mint": {
        // MintV1: treeConfig, leafOwner, leafDelegate, merkleTree, payer, treeCreatorOrDelegate, logWrapper,
        // compressionProgram, systemProgram; MetadataArgs with no collection, uses or creators.
        if (a.length !== 13 && a.length !== 14)
          this.fail(
            node,
            "mint(treeConfig, leafOwner, leafDelegate, merkleTree, payer, treeDelegate, logWrapper, compressionProgram, systemProgram, name, symbol, uri, sellerFeeBasisPoints, signerSeeds?)",
          );
        const metas = [
          acct(0, "the tree config", true, false),
          acct(1, "the leaf owner", false, false),
          acct(2, "the leaf delegate", false, false),
          acct(3, "the merkle tree", true, false),
          acct(4, "the payer", false, true),
          acct(5, "the tree delegate", false, true),
          acct(6, "the log wrapper", false, false),
          acct(7, "the compression program", false, false),
          acct(8, "the system program", false, false),
        ];
        const data = this.mplData(node, 1024, [
          { bytes: [145, 98, 192, 118, 184, 147, 118, 104] },
          { value: a[9], type: STRING },
          { value: a[10], type: STRING },
          { value: a[11], type: STRING },
          { value: a[12], type: { kind: "int", name: "u16" } },
          // primarySaleHappened false, isMutable true, editionNonce None, tokenStandard Some(NonFungible),
          // collection None, uses None, tokenProgramVersion Original, creators [].
          { bytes: [0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0] },
        ]);
        this.cpi(p, metas, data.buf, data.len, seedsAt(13));
        return undefined;
      }
    }
    this.fail(node.expression, `Bubblegum supports createTree and mint, not ${method}`);
  }

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
    const parts: ({ kind: "meta"; c: string } | { kind: "spread"; mode: "asPassed" | "readonly" | "writable" })[] = [];
    for (const el of a[1].elements) {
      if (ts.isSpreadElement(el)) {
        const inner = el.expression;
        const fnName = ts.isCallExpression(inner) ? this.exportName(inner.expression) : undefined;
        if (this.isRemaining(inner)) parts.push({ kind: "spread", mode: "asPassed" });
        else if (ts.isCallExpression(inner) && (fnName === "readonly" || fnName === "writable") && inner.arguments.length === 1 && this.isRemaining(inner.arguments[0]!))
          parts.push({ kind: "spread", mode: fnName });
        else this.fail(el, "spread the remaining accounts: ...remainingAccounts(), ...readonly(rest) or ...writable(rest)");
        if (!this.ix) this.fail(el, "remainingAccounts() is only available in instructions");
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
      const rest = `(params->ka_num - ${n})`;
      const fixed = metas.length;
      const spreads = parts.filter((p) => p.kind === "spread").length;
      this.line(
        `if (${fixed} + ${spreads} * ${rest} > TS_MAX_ACCOUNTS) TS_FAIL(TS_ERR_TOO_MANY_ACCOUNTS, "TypeSOL: the CPI lists more than ${MAX_ACCOUNTS} accounts");`,
      );
      for (const p of parts) {
        if (p.kind === "meta") {
          this.line(`${metasName}[${cnt}++] = (SolAccountMeta)${p.c};`);
          continue;
        }
        const i = this.tmp("ri");
        const r = this.tmp("racct");
        this.line(`for (uint64_t ${i} = ${n}; ${i} < params->ka_num; ${i}++) {`);
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
        const n = this.fieldBytes(f.type);
        // put() with no static size: the payload differs by variant.
        put(`&${src.lv}.v.${v.name}.${f.name}`, String(n));
      }
      this.line(`break; }`);
    });
    this.line(`}`);
  }

  protected emitEvent(node: ts.CallExpression, cpi?: { authority: string; program: string }): undefined {
    const targ = node.typeArguments?.[0];
    const s = targ && ts.isTypeReferenceNode(targ) && ts.isIdentifier(targ.typeName) ? this.model.structs.get(targ.typeName.text) : undefined;
    if (!s) this.fail(node, "emit needs an explicit event type: emit<MyEvent>({ ... })");
    const obj = node.arguments[0];
    if (node.arguments.length !== (cpi ? 3 : 1) || !ts.isObjectLiteralExpression(obj))
      this.fail(node, "emit<T>({ field: value, ... }) takes one object literal");
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
      if (f.type.kind === "vec") this.fail(obj, "Vec fields are not supported in events yet");
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
    const { buf, len, put, finish } = this.byteBuffer("ev", MAX_EVENT + (cpi ? 8 : 0), "TS_ERR_EVENT_TOO_LARGE", "event");
    if (cpi) put("TS_EVENT_IX_TAG", "8", 8);
    const disc = this.tmp("disc");
    this.line(`static const uint8_t ${disc}[8] = ${cBytes(s.eventDiscriminator)};`);
    put(disc, "8", 8);
    for (const f of s.fields) staged.get(f.name)!(put);
    finish(obj);
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
      return undefined;
    }
    const bytes = this.tmp("evbytes");
    this.line(`SolBytes ${bytes} = {${buf}, ${len}};`);
    this.line(`sol_log_data(&${bytes}, 1);`);
    return undefined;
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
