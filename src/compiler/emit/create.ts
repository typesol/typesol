import ts from "typescript";
import { heapVecOf } from "../analyze.js";
import { borshMinSize } from "./borsh.js";
import { type AccountParam, type ScalarType, type StructDef, type ValueType, isWritable } from "../model.js";
import { U64, U8, BOOL, PUBKEY, type Value, scalarStorageC, optC, emptySizeC } from "./shared.js";
import { CpiCoreEmitter } from "./cpi-core.js";

/** Creating accounts: `create` / `createIfNeeded` of program accounts, mints, token accounts and ATAs (with Token-2022 mint extensions), System transfers and createAccount. */
export abstract class CreateEmitter extends CpiCoreEmitter {
  protected create(node: ts.CallExpression, target: AccountParam, topLevel: boolean, ifNeeded = false): Value {
    const call = `${target.name}.${ifNeeded ? "createIfNeeded" : "create"}`;
    if (!topLevel) this.fail(node, `${call}(...) must be a top-level statement of the instruction`);
    if (this.created.has(target.name)) this.fail(node, `${target.name} is already created`);
    if (node.arguments.length !== 2 && node.arguments.length !== 3) this.fail(node, `${call}(payer, seeds | null, space?) takes two or three arguments`);
    const payer = this.accountParam(node.arguments[0], "the payer");
    if (payer.kind.kind !== "signer" || !payer.kind.mut) this.fail(node.arguments[0], "the payer must be a Mut<Signer>");
    const s = (target.kind as { struct: StructDef }).struct;
    const keypair = node.arguments[1]!.kind === ts.SyntaxKind.NullKeyword;
    if (keypair && ifNeeded) this.fail(node.arguments[1]!, "createIfNeeded takes seeds: a keypair account cannot be checked to be the one meant");
    const seeds = keypair ? undefined : this.seeds(node.arguments[1]!, 1);
    if (seeds) this.recordPda(target, seeds.idl);
    const b = this.tmp("bump");
    // The account's size: the struct's (8 + its fixed size, Anchor's InitSpace for @layout borsh), or Anchor's
    // `space = …` when given, which must hold the struct.
    // A @layout borsh struct with a Vec<T> has no fixed size: like Anchor's `init`, it takes `space`, at least its
    // smallest Borsh form.
    const unbounded = !!heapVecOf(s);
    const need = unbounded ? `${8 + borshMinSize(s, this.model)}` : s.layout === "borsh" ? `8 + sizeof(TSS_${s.name})` : `8 + ${emptySizeC(s)}`;
    let space = need;
    const spaceArg = node.arguments[2];
    if (unbounded && !spaceArg)
      this.fail(node, `${s.name} holds a Vec<T>, so it has no fixed size: pass the account's space, create(payer, seeds, space) (Anchor's space = …)`);
    if (spaceArg) {
      if (s.vec) this.fail(spaceArg, `${s.name} has a growable Vec: its size follows the Vec's length, so it takes no space argument`);
      const raw = this.expr(spaceArg);
      const v = this.expect(raw, U64, spaceArg);
      const min = unbounded ? 8 + borshMinSize(s, this.model) : 8 + this.fieldBytes({ kind: "struct", name: s.name });
      if (raw.literal !== undefined && raw.literal < BigInt(min)) this.fail(spaceArg, `${s.name} needs at least ${min} bytes (8 + its size)`);
      space = this.tmp("space");
      this.line(`uint64_t ${space} = ${v.c};`);
      this.line(
        `if (${space} < ${need} || ${space} > 10240) TS_FAIL(TS_ERR_ACCOUNT_TOO_SMALL, "TypeSOL: space must hold the account and be at most 10240 bytes");`,
      );
    }
    this.line(`uint8_t ${b};`);
    const done = () => {
      this.created.add(target.name);
      this.pendingInit.delete(target.name);
      this.bumps.set(target.name, b);
    };
    if (!seeds) {
      // A new keypair account that signs the transaction (Anchor's `init` without seeds).
      target.signsInit = true;
      this.line(`TS_TRY(ts_create_owned(params, a_${payer.name}, a_${target.name}, NULL, 0, params->program_id, ${space}, &${b}));`);
      this.line(`a_${target.name}->data_len = ${space};`);
      this.line(`ts_memcpy(a_${target.name}->data, TS_DISC_${s.name}, 8);`);
      done();
      return { c: b, type: U8 };
    }
    if (ifNeeded) {
      // Returns whether it was created now; an existing account must be this PDA, ours, and a ${s.name}.
      const created = this.tmp("created");
      this.line(`bool ${created};`);
      this.line(
        `TS_TRY(ts_create_pda_if_needed(params, a_${payer.name}, a_${target.name}, ${seeds.name}, ${seeds.count}, TS_DISC_${s.name}, ${space}, 8 + ${s.layout === "borsh" ? borshMinSize(s, this.model) : `sizeof(TSS_${s.name})`}, &${b}, &${created}));`,
      );
      // An existing @layout borsh account is unpacked now (a new one starts from the zeroed struct).
      if (s.layout === "borsh")
        this.line(`if (!${created}) TS_TRY(ts_unpack_${s.name}(a_${target.name}->data + 8, a_${target.name}->data_len - 8, d_${target.name}, NULL));`);
      done();
      return { c: created, type: BOOL };
    }
    this.line(`TS_TRY(ts_create_pda(params, a_${payer.name}, a_${target.name}, ${seeds.name}, ${seeds.count}, TS_DISC_${s.name}, ${space}, &${b}));`);
    done();
    return { c: b, type: U8 };
  }

  /**
   * `vault.create(payer, seeds | null, mint, authority)` on `Init<TokenAccount>` and `mint.create(payer, seeds | null,
   * decimals, authority, freezeAuthority | null)` on `Init<Mint>` (Anchor's `init` with `token::` / `mint::`
   * constraints): a PDA of this program (or, with `null`, a new keypair account that signs), created owned by the
   * instruction's token program and initialized. `createIfNeeded` on `InitIfNeeded<…>` does that unless the account
   * exists, and then checks it is that PDA, owned by the token program, and has that mint and owner / those
   * authorities and decimals (Anchor's init_if_needed checks). create returns the bump (0 for a keypair),
   * createIfNeeded whether it created the account.
   */
  protected createToken(node: ts.CallExpression, target: AccountParam, topLevel: boolean): Value {
    const isMint = target.kind.kind === "mint";
    const ifNeeded = (target.kind as { init?: string }).init === "ifNeeded";
    const call = `${target.name}.${ifNeeded ? "createIfNeeded" : "create"}`;
    const usage = isMint
      ? `${call}(payer, seeds | null, decimals, mintAuthority, freezeAuthority | null, extensions?, tokenProgram?)`
      : `${call}(payer, seeds | null, mint, authority, tokenProgram?)`;
    if (!topLevel) this.fail(node, `${call}(...) must be a top-level statement of the instruction`);
    if (this.created.has(target.name)) this.fail(node, `${target.name} is already created`);
    const a = node.arguments;
    if (!isMint && a.length === 1)
      this.fail(node, `${call}(payer) creates an associated token account: wrap it in Ata<…, "owner", "mint">; or call ${usage.slice(call.length)}`);
    // A mint may list its Token-2022 extensions next (Anchor's `extensions::…`), as an object literal.
    const bare = (e: ts.Expression | undefined): ts.Expression | undefined =>
      e && (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression(e)) ? bare(e.expression) : e;
    const ext5 = bare(a[5]);
    const extArg = isMint && ext5 && ts.isObjectLiteralExpression(ext5) ? ext5 : undefined;
    const fixedArgs = isMint ? (extArg ? 6 : 5) : 4;
    if (a.length !== fixedArgs && a.length !== fixedArgs + 1) this.fail(node, usage);
    const payer = this.accountParam(a[0]!, "the payer");
    if (payer.kind.kind !== "signer" || !payer.kind.mut) this.fail(a[0]!, "the payer must be a Mut<Signer>");
    // The token program: named as the last argument, or the instruction's only token program parameter.
    let programs = this.ix!.accounts.filter((p) => p.kind.kind === "tokenProgram");
    if (a[fixedArgs]) {
      const named = this.accountParam(a[fixedArgs]!, "the token program");
      if (named.kind.kind !== "tokenProgram") this.fail(a[fixedArgs]!, "pass a TokenProgram, Token2022Program or TokenInterface parameter");
      programs = [named];
    }
    if (programs.length !== 1)
      this.fail(node, `${call}(...) needs one token program: pass it as the last argument, or have exactly one token program parameter`);
    if (programs[0]!.optional) this.fail(programs[0]!.node, `${call}(...) needs "${programs[0]!.name}": it cannot be optional`);
    if (!this.ix!.accounts.some((p) => p.kind.kind === "system" && !p.optional)) this.fail(node, `${call}(...) needs a SystemProgram parameter`);
    const tp = `a_${programs[0]!.name}`;
    const acct = `a_${target.name}`;
    // Seeds, then the values, in source order.
    let seeds = { name: "NULL", count: 0 as number | string };
    if (a[1]!.kind !== ts.SyntaxKind.NullKeyword) {
      const s = this.seeds(a[1]!, 1);
      this.recordPda(target, s.idl);
      seeds = s;
    } else target.signsInit = true;
    const vals: Value[] = [];
    const take = (n: ts.Expression, t: ValueType) => {
      const mark = this.lines.length;
      // The account's own address is known before it exists (`vault.create(payer, seeds, mint, vault.key)`).
      const own = ts.isPropertyAccessExpression(n) && n.name.text === "key" && ts.isIdentifier(n.expression) && n.expression.text === target.name;
      const v = own ? { c: `(&${acct}->key)`, type: PUBKEY } : this.expect(this.expr(n, t), t, n);
      for (let j = 0; j < vals.length; j++) vals[j] = this.settle(vals[j]!, mark);
      vals.push(v);
    };
    let mint: AccountParam | undefined;
    const extLines: string[] = [];
    const extChecks: string[] = [];
    let mintSpace = "TS_MINT_LEN";
    if (isMint) {
      take(a[2]!, U8);
      take(a[3]!, PUBKEY);
      if (a[4]!.kind !== ts.SyntaxKind.NullKeyword) take(a[4]!, PUBKEY);
      if (extArg) {
        if (programs[0]!.kind.kind === "tokenProgram" && programs[0]!.kind.flavor === "token")
          this.fail(extArg, "mint extensions are Token-2022's; use Token2022Program or TokenInterface");
        const ext = this.mintExtensions(extArg, tp, acct, ifNeeded);
        mintSpace = String(ext.space);
        extLines.push(...ext.lines);
        extChecks.push(...ext.checks);
      }
    } else {
      mint = this.accountParam(a[2]!, "the mint");
      if (mint.kind.kind !== "mint") this.fail(a[2]!, "pass the Mint parameter the account will hold");
      take(a[3]!, PUBKEY);
    }
    const b = this.tmp("bump");
    this.line(`uint8_t ${b};`);
    const created = this.tmp("created");
    const createLines: string[] = [];
    if (isMint) {
      const [decimals, authority, freeze] = vals;
      createLines.push(
        `TS_TRY(ts_create_owned(params, a_${payer.name}, ${acct}, ${seeds.name}, ${seeds.count}, &${tp}->key, ${mintSpace}, &${b}));`,
        ...extLines,
        `TS_TRY(ts_token_init_mint(params, ${tp}, ${acct}, (uint8_t)(${decimals!.c}), ${authority!.c}, ${freeze ? freeze.c : "NULL"}));`,
      );
      if (ifNeeded) {
        this.line(`bool ${created} = ts_key_eq(&${acct}->owner, &TS_SYSTEM_PROGRAM_ID);`);
        this.line(`if (${created}) {`);
        for (const l of createLines) this.line(`  ${l}`);
        this.line(`} else {`);
        this.line(`  TS_TRY(ts_token_existing(params, ${acct}, ${tp}, ${seeds.name}, ${seeds.count}, &${b}));`);
        this.line(`  TS_TRY(ts_check_mint(${acct}));`);
        this.line(`  TS_TRY(ts_check_mint_is(${acct}, (uint8_t)(${decimals!.c}), ${authority!.c}, ${freeze ? freeze.c : "NULL"}));`);
        for (const l of extChecks) this.line(`  ${l}`);
        this.line(`}`);
      } else for (const l of createLines) this.line(l);
    } else {
      const [authority] = vals;
      const space = this.tmp("space");
      createLines.push(
        `uint64_t ${space};`,
        `TS_TRY(ts_token_account_space(params, ${tp}, a_${mint!.name}, &${space}));`,
        `TS_TRY(ts_create_owned(params, a_${payer.name}, ${acct}, ${seeds.name}, ${seeds.count}, &${tp}->key, ${space}, &${b}));`,
        `TS_TRY(ts_token_init_account(params, ${tp}, ${acct}, a_${mint!.name}, ${authority!.c}));`,
      );
      if (ifNeeded) {
        this.line(`bool ${created} = ts_key_eq(&${acct}->owner, &TS_SYSTEM_PROGRAM_ID);`);
        this.line(`if (${created}) {`);
        for (const l of createLines) this.line(`  ${l}`);
        this.line(`} else {`);
        this.line(`  TS_TRY(ts_token_existing(params, ${acct}, ${tp}, ${seeds.name}, ${seeds.count}, &${b}));`);
        this.line(`  TS_TRY(ts_check_token_account(${acct}));`);
        this.line(
          `  if (!ts_key_eq(ts_token_mint(${acct}), &a_${mint!.name}->key)) TS_FAIL(TS_ERR_TOKEN_MINT, "TypeSOL: ${target.name} is not a token account of ${mint!.name}");`,
        );
        this.line(`  if (!ts_key_eq(ts_token_owner(${acct}), ${authority!.c})) TS_FAIL(TS_ERR_TOKEN_OWNER, "TypeSOL: ${target.name} has another owner");`);
        this.line(`}`);
      } else for (const l of createLines) this.line(l);
    }
    this.created.add(target.name);
    this.pendingInit.delete(target.name);
    this.bumps.set(target.name, b);
    return ifNeeded ? { c: created, type: BOOL } : { c: b, type: U8 };
  }

  /**
   * The extensions in `mint.create(…, { … })` (Anchor's `extensions::…` constraints): their values are evaluated now,
   * in source order; the returned lines (each extension's Token-2022 initializer, mint writable, before
   * InitializeMint2) run after the account is created, sized for exactly these extensions.
   */
  protected mintExtensions(lit: ts.ObjectLiteralExpression, tp: string, acct: string, ifNeeded = false): { space: number; lines: string[]; checks: string[] } {
    const optKey: ValueType = { kind: "option", inner: PUBKEY };
    this.model.options.set("pubkey", PUBKEY);
    // name: [extension type length, initializer tag, the fields an object value takes ([] for a plain value)]
    const KINDS: Record<string, { len: number; fields: string[] }> = {
      transferFee: { len: 108, fields: ["configAuthority", "withdrawAuthority", "basisPoints", "maximumFee"] },
      closeAuthority: { len: 32, fields: [] },
      defaultAccountState: { len: 1, fields: [] },
      nonTransferable: { len: 0, fields: [] },
      interestBearing: { len: 52, fields: ["rateAuthority", "rate"] },
      permanentDelegate: { len: 32, fields: [] },
      transferHook: { len: 64, fields: ["authority", "programId"] },
      metadataPointer: { len: 64, fields: ["authority", "metadataAddress"] },
      groupPointer: { len: 64, fields: ["authority", "groupAddress"] },
      groupMemberPointer: { len: 64, fields: ["authority", "memberAddress"] },
    };
    const given = new Map<string, ts.Expression>();
    for (const p of lit.properties) {
      const value = ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : undefined;
      if (!value || !p.name || !ts.isIdentifier(p.name)) this.fail(p, "write the extensions as `name: value` entries");
      if (!KINDS[p.name.text]) this.fail(p.name, `mint extensions: ${Object.keys(KINDS).join(", ")}`);
      given.set(p.name.text, value);
    }
    const U16: ValueType = { kind: "int", name: "u16" };
    const I16: ValueType = { kind: "int", name: "i16" };
    // Values in source order, held in temporaries; the CPIs come later.
    const held = new Map<string, Map<string, string>>();
    const keyTmp = (e: ts.Expression, nonZero: boolean) => {
      // OptionalNonZeroPubkey (32 bytes, zero for none) or COption (a tag byte, then 32).
      const v = this.expect(this.expr(e, optKey), optKey, e);
      const t = this.tmp("xk");
      this.line(`${optC(PUBKEY)} ${t} = ${v.c};`);
      if (!nonZero) return t;
      const z = this.tmp("xz");
      this.line(`SolPubkey ${z};`);
      this.line(`if (${t}.some) ${z} = ${t}.v; else ts_memzero(&${z}, 32);`);
      return z;
    };
    const scalarTmp = (e: ts.Expression, t: ValueType) => {
      const v = this.expect(this.expr(e, t), t, e);
      const n = this.tmp("xv");
      this.line(`${scalarStorageC(t as ScalarType)} ${n} = ${v.c};`);
      return n;
    };
    for (const [name, e] of given) {
      const k = KINDS[name]!;
      const vals = new Map<string, string>();
      if (k.fields.length) {
        if (!ts.isObjectLiteralExpression(e)) this.fail(e, `${name}: { ${k.fields.join(", ")} }`);
        const props = new Map<string, ts.Expression>();
        for (const p of e.properties) {
          const value = ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : undefined;
          if (!value || !p.name || !ts.isIdentifier(p.name) || !k.fields.includes(p.name.text)) this.fail(p, `${name}: { ${k.fields.join(", ")} }`);
          props.set(p.name.text, value);
        }
        for (const f of k.fields) if (!props.has(f)) this.fail(e, `${name} needs ${f}`);
        for (const [f, v] of props) {
          if (f === "basisPoints") {
            const t = scalarTmp(v, U16);
            this.line(`if (${t} > 10000) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: transfer fee above 10000 basis points");`);
            vals.set(f, t);
          } else if (f === "maximumFee") vals.set(f, scalarTmp(v, U64));
          else if (f === "rate") vals.set(f, scalarTmp(v, I16));
          else vals.set(f, keyTmp(v, name !== "transferFee"));
        }
      } else if (name === "closeAuthority") vals.set("v", keyTmp(e, false));
      else if (name === "permanentDelegate") {
        const v = this.expect(this.expr(e, PUBKEY), PUBKEY, e);
        const t = this.tmp("xk");
        this.line(`SolPubkey ${t} = *(${v.c});`);
        vals.set("v", t);
      } else if (name === "defaultAccountState") {
        const v = this.expect(this.expr(e, BOOL), BOOL, e);
        const t = this.tmp("xs");
        this.line(`uint8_t ${t} = (${v.c}) ? 2 : 1;`); // frozen: AccountState::Frozen, else Initialized
        vals.set("v", t);
      } else if (!(e.kind === ts.SyntaxKind.TrueKeyword)) this.fail(e, "nonTransferable: true");
      held.set(name, vals);
    }
    // Each initializer: its bytes, then a CPI with the mint as the only (writable) account.
    const lines: string[] = [];
    const cpi = (bytes: [string, number][]) => {
      const total = bytes.reduce((n, [, k]) => n + k, 0);
      const buf = this.tmp("xd");
      lines.push(`{ uint8_t ${buf}[${total}]; uint64_t at = 0;`);
      for (const [src, n] of bytes) lines.push(`  ts_memcpy(${buf} + at, ${src}, ${n}); at += ${n};`);
      lines.push(`  SolAccountMeta m[1] = {{&${acct}->key, true, false}};`, `  TS_TRY(ts_cpi(params, ${tp}, ${buf}, at, m, 1, NULL, 0)); }`);
    };
    const tag = (n: number) => `(const uint8_t[]){${n}}`;
    const coption = (t: string): [string, number][] => [
      [`(const uint8_t[]){${t}.some ? 1 : 0}`, 1],
      [`&${t}.v`, 32],
    ];
    let space = 0;
    for (const name of Object.keys(KINDS)) {
      const v = held.get(name);
      if (!v) continue;
      space += 4 + KINDS[name]!.len;
      switch (name) {
        case "transferFee":
          cpi([
            [tag(26), 1],
            [tag(0), 1],
            ...coption(v.get("configAuthority")!),
            ...coption(v.get("withdrawAuthority")!),
            [`&${v.get("basisPoints")}`, 2],
            [`&${v.get("maximumFee")}`, 8],
          ]);
          break;
        case "closeAuthority":
          cpi([[tag(25), 1], ...coption(v.get("v")!)]);
          break;
        case "defaultAccountState":
          cpi([
            [tag(28), 1],
            [tag(0), 1],
            [`&${v.get("v")}`, 1],
          ]);
          break;
        case "nonTransferable":
          cpi([[tag(32), 1]]);
          break;
        case "interestBearing":
          cpi([
            [tag(33), 1],
            [tag(0), 1],
            [`&${v.get("rateAuthority")}`, 32],
            [`&${v.get("rate")}`, 2],
          ]);
          break;
        case "permanentDelegate":
          cpi([
            [tag(35), 1],
            [`&${v.get("v")}`, 32],
          ]);
          break;
        default: {
          const t = { transferHook: 36, metadataPointer: 39, groupPointer: 40, groupMemberPointer: 41 }[name]!;
          const [f1, f2] = KINDS[name]!.fields;
          cpi([
            [tag(t), 1],
            [tag(0), 1],
            [`&${v.get(f1!)}`, 32],
            [`&${v.get(f2!)}`, 32],
          ]);
        }
      }
    }
    // An existing mint (createIfNeeded) is checked as Anchor's `extensions::…` constraints check it: the extension must
    // be there (its Anchor code) and each key must match (the next codes). Anchor has constraints for these six only.
    const CHECKS: Record<string, { type: number; code: number; fields: [string, number][] }> = {
      groupPointer: {
        type: 20,
        code: 2024,
        fields: [
          ["authority", 0],
          ["groupAddress", 32],
        ],
      },
      groupMemberPointer: {
        type: 21,
        code: 2027,
        fields: [
          ["authority", 0],
          ["memberAddress", 32],
        ],
      },
      metadataPointer: {
        type: 18,
        code: 2030,
        fields: [
          ["authority", 0],
          ["metadataAddress", 32],
        ],
      },
      closeAuthority: { type: 3, code: 2033, fields: [["v", 0]] },
      permanentDelegate: { type: 12, code: 2035, fields: [["v", 0]] },
      transferHook: {
        type: 14,
        code: 2037,
        fields: [
          ["authority", 0],
          ["programId", 32],
        ],
      },
    };
    const checks: string[] = [];
    if (ifNeeded)
      for (const [name, v] of held) {
        const c = CHECKS[name];
        if (!c) this.fail(lit, `${name} cannot be checked on an existing mint (Anchor has no constraint for it): create the mint with create(…)`);
        checks.push(`{ uint64_t eo, el; if (!ts_t22_ext(${acct}, ${c.type}, &eo, &el)) TS_FAIL(${c.code}, "TypeSOL: the mint has no ${name} extension"); }`);
        c.fields.forEach(([f, at], i) => {
          const held = v.get(f)!;
          // The value given: a nonzero-or-zero key, a COption (close authority) or a plain key (permanent delegate).
          const want = name === "closeAuthority" ? `(${held}.some ? ${held}.v : (SolPubkey){0})` : held;
          checks.push(
            `{ SolPubkey k, w = ${want}; if (!ts_t22_key(${acct}, ${c.type}, ${at}, &k)) ts_memzero(&k, 32); if (!ts_key_eq(&k, &w)) TS_FAIL(${c.code + 1 + i}, "TypeSOL: the mint's ${name} ${f === "v" ? "key" : f} differs"); }`,
          );
        });
      }
    // Base account (165, the mint padded to an account's size), the account type byte, then each TLV entry.
    return { space: 165 + 1 + space, lines, checks };
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
    if (node.arguments.length !== 1 && node.arguments.length !== 2)
      this.fail(node, `${call}(payer, tokenProgram?) takes the payer and, with several token programs, the one to use`);
    const payer = this.accountParam(node.arguments[0], "the payer");
    if (payer.kind.kind !== "signer" || !payer.kind.mut) this.fail(node.arguments[0], "the payer must be a Mut<Signer>");
    const need = (kind: string, what: string) => {
      const p = this.ix!.accounts.find((o) => o.kind.kind === kind);
      if (!p) this.fail(node, `${call}(...) needs ${what} parameter`);
      if (p.optional) this.fail(p.node, `${call}(...) needs "${p.name}": it cannot be optional`);
      return p;
    };
    const ataProgram = need("ataProgram", "an AssociatedTokenProgram");
    const system = need("system", "a SystemProgram");
    // The address is derived under the token program: the one passed (Anchor's associated_token::token_program), or the
    // instruction's only one.
    let tokenProgram: AccountParam;
    if (node.arguments[1]) {
      tokenProgram = this.accountParam(node.arguments[1], "the token program");
      if (tokenProgram.kind.kind !== "tokenProgram") this.fail(node.arguments[1], "pass a TokenProgram, Token2022Program or TokenInterface parameter");
      if (tokenProgram.optional) this.fail(node.arguments[1], `${call}(...) needs "${tokenProgram.name}": it cannot be optional`);
    } else {
      tokenProgram = need("tokenProgram", "a token program (TokenProgram, Token2022Program or TokenInterface)");
      const tokenPrograms = this.ix!.accounts.filter((o) => o.kind.kind === "tokenProgram");
      if (tokenPrograms.length > 1)
        this.fail(
          node,
          `${call}(...) needs to know the token program: pass it, ${call}(payer, ${tokenPrograms[0]!.name}) (found ${tokenPrograms.map((o) => o.name).join(", ")})`,
        );
    }
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

  /** systemProgram.allocate(account, space, signerSeeds?) / systemProgram.assign(account, owner, signerSeeds?). */
  protected allocateOrAssign(node: ts.CallExpression, system: AccountParam, method: "allocate" | "assign"): undefined {
    const a = node.arguments;
    if (a.length !== 2 && a.length !== 3) this.fail(node, `${method}(account, ${method === "allocate" ? "space" : "owner"}, signerSeeds?)`);
    const acct = this.accountParam(a[0], "the account");
    if (!isWritable(acct.kind)) this.fail(a[0], `the account must be writable (Mut<Signer> or Mut<AccountInfo>)`);
    if (acct.kind.kind !== "signer" && a.length !== 3) this.fail(a[0], "the account must sign: a Mut<Signer> keypair, or pass signerSeeds for a PDA");
    const { buf, len, put, finish } = this.byteBuffer("sys", 36, "TS_ERR_INSTRUCTION_DATA", "system instruction");
    const tag = this.tmp("tag");
    this.line(`uint32_t ${tag} = ${method === "allocate" ? 8 : 1}; /* ${method === "allocate" ? "Allocate" : "Assign"} */`);
    put(`&${tag}`, "4", 4);
    if (method === "allocate") this.serialize(this.expect(this.expr(a[1], U64), U64, a[1]), a[1], put);
    else this.serialize(this.expect(this.expr(a[1], PUBKEY), PUBKEY, a[1]), a[1], put);
    finish(node);
    const seeds = a.length === 3 ? this.signingSeeds(a[2]) : { name: "NULL", count: 0 };
    this.cpi(`a_${system.name}`, [[`a_${acct.name}`, true, true]], buf, len, seeds);
    return undefined;
  }
}
