import ts from "typescript";
import { discriminator, snakeCase } from "../analyze.js";
import { borshMinSize } from "./borsh.js";
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

/** One piece of a Metaplex instruction's Borsh data: fixed bytes, or a value lowered and serialized in source order. */
type MplField = { bytes: number[] } | { value: ts.Expression; type: ValueType };

/** Metaplex Core's Plugin / PluginType enums, in order (MasterEdition, VerifiedCreators and Autograph values are refused). */
const CORE_PLUGINS = [
  "Royalties",
  "FreezeDelegate",
  "BurnDelegate",
  "TransferDelegate",
  "UpdateDelegate",
  "PermanentFreezeDelegate",
  "Attributes",
  "PermanentTransferDelegate",
  "PermanentBurnDelegate",
  "Edition",
  "MasterEdition",
  "AddBlocker",
  "ImmutableMetadata",
  "VerifiedCreators",
  "Autograph",
  "BubblegumV2",
] as const;
const CORE_PLUGIN_FIELDS: Record<string, string[]> = {
  Royalties: ["basisPoints", "creators"],
  FreezeDelegate: ["frozen"],
  PermanentFreezeDelegate: ["frozen"],
  UpdateDelegate: ["additionalDelegates"],
  Attributes: ["attributes"],
  Edition: ["number"],
};

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
      } else if (v.type.kind === "enum") {
        // A unit enum value is its variant index, one byte (as in Seeds<…> and Borsh).
        const t = this.tmp("seed");
        this.line(`uint8_t ${t} = (uint8_t)(${v.c});`);
        parts.push(`{(const uint8_t *)&${t}, 1}`);
      } else this.fail(el, "seeds can be strings, Pubkeys, integers or unit enum values");
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
        `TS_TRY(ts_create_pda_if_needed(params, a_${payer.name}, a_${target.name}, ${seeds.name}, ${seeds.count}, TS_DISC_${s.name}, 8 + sizeof(TSS_${s.name}), 8 + ${s.layout === "borsh" ? borshMinSize(s, this.model) : `sizeof(TSS_${s.name})`}, &${b}, &${created}));`,
      );
      // An existing @layout borsh account is unpacked now (a new one starts from the zeroed struct).
      if (s.layout === "borsh")
        this.line(`if (!${created}) TS_TRY(ts_unpack_${s.name}(a_${target.name}->data + 8, a_${target.name}->data_len - 8, d_${target.name}));`);
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
    const usage = isMint ? `${call}(payer, seeds | null, decimals, mintAuthority, freezeAuthority | null)` : `${call}(payer, seeds | null, mint, authority)`;
    if (!topLevel) this.fail(node, `${call}(...) must be a top-level statement of the instruction`);
    if (this.created.has(target.name)) this.fail(node, `${target.name} is already created`);
    const a = node.arguments;
    if (!isMint && a.length === 1)
      this.fail(node, `${call}(payer) creates an associated token account: wrap it in Ata<…, "owner", "mint">; or call ${usage.slice(call.length)}`);
    if (a.length !== (isMint ? 5 : 4)) this.fail(node, usage);
    const payer = this.accountParam(a[0]!, "the payer");
    if (payer.kind.kind !== "signer" || !payer.kind.mut) this.fail(a[0]!, "the payer must be a Mut<Signer>");
    const programs = this.ix!.accounts.filter((p) => p.kind.kind === "tokenProgram");
    if (programs.length !== 1) this.fail(node, `${call}(...) needs exactly one token program parameter (TokenProgram, Token2022Program or TokenInterface)`);
    if (!this.ix!.accounts.some((p) => p.kind.kind === "system")) this.fail(node, `${call}(...) needs a SystemProgram parameter`);
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
    if (isMint) {
      take(a[2]!, U8);
      take(a[3]!, PUBKEY);
      if (a[4]!.kind !== ts.SyntaxKind.NullKeyword) take(a[4]!, PUBKEY);
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
        `TS_TRY(ts_create_owned(params, a_${payer.name}, ${acct}, ${seeds.name}, ${seeds.count}, &${tp}->key, TS_MINT_LEN, &${b}));`,
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
      if (p.optional) this.fail(p.node, `${call}(...) needs "${p.name}": it cannot be optional`);
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
    tail?: { from: string; to: string },
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
    this.line(`for (uint64_t ${i} = ${n} + ${tail.from}; ${i} < ${n} + ${tail.to}; ${i}++) ${m}[${cnt}++] = (SolAccountMeta){&params->ka[${i}]->key, 0, 0};`);
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
    const U16: ValueType = { kind: "int", name: "u16" };
    const I16: ValueType = { kind: "int", name: "i16" };
    const byte = (k: number) => (put: Put) => {
      const t = this.tmp("b");
      this.line(`uint8_t ${t} = ${k};`);
      put(`&${t}`, "1", 1);
    };
    /** Token-2022's OptionalNonZeroPubkey: 32 bytes, all zero for none. */
    const nonZeroKey = (n: ts.Expression) => (put: Put) => {
      this.model.options.set("pubkey", PUBKEY);
      const v = this.expect(this.expr(n, optKey), optKey, n);
      const t = this.tmp("nzk");
      this.line(`SolPubkey ${t};`);
      this.line(`{ ${optC(PUBKEY)} o = ${v.c}; if (o.some) ${t} = o.v; else ts_memzero(&${t}, 32); }`);
      put(`&${t}`, "32", 32);
    };
    const token2022Only = () => {
      if (program.kind.kind === "tokenProgram" && program.kind.flavor === "token")
        this.fail(node, `${method} is a Token-2022 extension; use Token2022Program or TokenInterface`);
    };
    const mintOnly = (n: number, usage: string) => {
      token2022Only();
      if (a.length !== n) this.fail(node, usage);
      return anyAcct(a[0], "the mint", true);
    };
    const none = { name: "NULL", count: 0 };
    switch (method) {
      case "initializeTransferFeeConfig": {
        const mint = mintOnly(5, "initializeTransferFeeConfig(mint, configAuthority | null, withdrawAuthority | null, basisPoints, maximumFee)");
        this.model.options.set("pubkey", PUBKEY);
        // Arguments in source order, as JS evaluates them: the basis points are checked when they are read.
        const bps = (put: Put) => {
          const v = this.expect(this.expr(a[3], U16), U16, a[3]);
          this.line(`if (${v.c} > 10000) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: transfer fee above 10000 basis points");`);
          this.serialize(v, a[3], put);
        };
        simple(26, [byte(0), value(a[1], optKey), value(a[2], optKey), bps, value(a[4], U64)], [[mint, true, false]], none);
        return undefined;
      }
      case "initializeMintCloseAuthority": {
        const mint = mintOnly(2, "initializeMintCloseAuthority(mint, closeAuthority | null)");
        this.model.options.set("pubkey", PUBKEY);
        simple(25, [value(a[1], optKey)], [[mint, true, false]], none);
        return undefined;
      }
      case "initializeNonTransferableMint": {
        const mint = mintOnly(1, "initializeNonTransferableMint(mint)");
        simple(32, [], [[mint, true, false]], none);
        return undefined;
      }
      case "initializePermanentDelegate": {
        const mint = mintOnly(2, "initializePermanentDelegate(mint, delegate)");
        simple(35, [value(a[1], PUBKEY)], [[mint, true, false]], none);
        return undefined;
      }
      case "initializeDefaultAccountState": {
        const mint = mintOnly(2, "initializeDefaultAccountState(mint, frozen)");
        const frozen = this.expect(this.expr(a[1], BOOL), BOOL, a[1]);
        const st = this.tmp("st");
        this.line(`uint8_t ${st} = (${frozen.c}) ? 2 : 1;`); // AccountState::Frozen / Initialized
        simple(28, [byte(0), (put) => put(`&${st}`, "1", 1)], [[mint, true, false]], none);
        return undefined;
      }
      case "initializeMetadataPointer":
      case "initializeGroupPointer":
      case "initializeGroupMemberPointer":
      case "initializeTransferHook": {
        const tag = { initializeMetadataPointer: 39, initializeGroupPointer: 40, initializeGroupMemberPointer: 41, initializeTransferHook: 36 }[method];
        const second = {
          initializeMetadataPointer: "metadataAddress",
          initializeGroupPointer: "groupAddress",
          initializeGroupMemberPointer: "memberAddress",
          initializeTransferHook: "programId",
        }[method];
        const mint = mintOnly(3, `${method}(mint, authority | null, ${second} | null)`);
        simple(tag, [byte(0), nonZeroKey(a[1]), nonZeroKey(a[2])], [[mint, true, false]], none);
        return undefined;
      }
      case "initializeInterestBearingMint": {
        const mint = mintOnly(3, "initializeInterestBearingMint(mint, rateAuthority | null, rate)");
        simple(33, [byte(0), nonZeroKey(a[1]), value(a[2], I16)], [[mint, true, false]], none);
        return undefined;
      }
      case "initializeImmutableOwner": {
        token2022Only();
        if (a.length !== 1) this.fail(node, "initializeImmutableOwner(account)");
        const acct = anyAcct(a[0], "the token account", true);
        simple(22, [], [[acct, true, false]], none);
        return undefined;
      }
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
      `token programs support transfer, transferChecked, mintTo, burn, closeAccount, approve, revoke, setAuthority, freezeAccount, thawAccount, syncNative, initializeMint2, initializeAccount3, initializeMetadata and the Token-2022 extension initializers (initializeTransferFeeConfig, initializeMintCloseAuthority, initializeNonTransferableMint, initializePermanentDelegate, initializeDefaultAccountState, initializeMetadataPointer, initializeGroupPointer, initializeGroupMemberPointer, initializeTransferHook, initializeInterestBearingMint, initializeImmutableOwner), not ${method}`,
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
    if (method === "createMasterEditionV3" || method === "verifyCollection") return this.metadataCollectionOp(node, program, method);
    if (method !== "createV3")
      this.fail(node.expression, `the Token Metadata program supports createV3, createMasterEditionV3 and verifyCollection, not ${method}`);
    const a = node.arguments;
    const usage =
      "createV3(metadata, mint, mintAuthority, payer, updateAuthority, systemProgram, name, symbol, uri, sellerFeeBasisPoints, isMutable, { creators?, collection?, isCollection? }?, signerSeeds?)";
    // An object literal after isMutable carries the optional creators / collection; signerSeeds stays last.
    const extras = a[11] && ts.isObjectLiteralExpression(a[11]) ? a[11] : undefined;
    const seedsArg = extras ? a[12] : a[11];
    if (a.length < 11 || a.length > (extras ? 13 : 12)) this.fail(node, usage);
    const [metadata, mint, mintAuth, payer, updateAuth, sys] = a.slice(0, 6).map((n, i) => this.accountParam(n, `account #${i + 1}`));
    if (!isWritable(metadata.kind)) this.fail(a[0], "the metadata account must be Mut<AccountInfo>");
    if (payer.kind.kind !== "signer" || !payer.kind.mut) this.fail(a[3], "the payer must be a Mut<Signer>");
    if (sys.kind.kind !== "system") this.fail(a[5], "pass the SystemProgram parameter");
    // Arguments in source order, as JS evaluates them: a later one that runs statements (a helper changing account
    // text) must not change what an earlier one read.
    const vals: Value[] = [];
    const inOrder = (n: ts.Expression, t: ValueType) => {
      const mark = this.lines.length;
      const v = this.expect(this.expr(n, t), t, n);
      for (let j = 0; j < vals.length; j++) vals[j] = this.settle(vals[j], mark);
      vals.push(v);
      return vals.length - 1;
    };
    const slots = [...a.slice(6, 9).map((n) => inOrder(n, STRING)), inOrder(a[9], { kind: "int", name: "u16" }), inOrder(a[10], BOOL)];
    const settleAll = (mark: number) => {
      for (let j = 0; j < vals.length; j++) vals[j] = this.settle(vals[j], mark);
    };
    const extrasMark = this.lines.length;
    let creators = "NULL";
    let ncreators = "-1";
    let collection = "NULL";
    let sized = "false";
    if (extras) {
      for (const p of extras.properties) {
        if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) this.fail(p, "use creators: [...], collection: key and isCollection: boolean");
        if (p.name.text === "creators") {
          if (!ts.isArrayLiteralExpression(p.initializer)) this.fail(p.initializer, "creators: [{ address, verified, share }, …] (an array literal)");
          const list = p.initializer.elements;
          if (list.length < 1 || list.length > 5) this.fail(p.initializer, "Metaplex takes 1 to 5 creators");
          const buf = this.tmp("creators");
          this.line(`uint8_t ${buf}[${34 * list.length}];`);
          let shares = 0n;
          let constant = true;
          list.forEach((el, i) => {
            if (!ts.isObjectLiteralExpression(el)) this.fail(el, "a creator is { address, verified, share }");
            const field = (k: string) => {
              const q = el.properties.find((x) => ts.isPropertyAssignment(x) && ts.isIdentifier(x.name) && x.name.text === k) as
                ts.PropertyAssignment | undefined;
              const sh = el.properties.find((x) => ts.isShorthandPropertyAssignment(x) && x.name.text === k) as ts.ShorthandPropertyAssignment | undefined;
              if (!q && !sh) this.fail(el, `a creator needs ${k}`);
              return q ? q.initializer : sh!.name;
            };
            const at = 34 * i;
            const key = this.expect(this.expr(field("address"), PUBKEY), PUBKEY, el);
            this.line(`ts_memcpy(${buf} + ${at}, ${key.c}, 32);`);
            const verified = this.expect(this.expr(field("verified"), BOOL), BOOL, el);
            this.line(`${buf}[${at + 32}] = (${verified.c}) ? 1 : 0;`);
            const shareNode = field("share");
            if (ts.isBigIntLiteral(shareNode)) shares += BigInt(shareNode.text.slice(0, -1));
            else constant = false;
            const share = this.expect(this.expr(shareNode, U8), U8, el);
            this.line(`${buf}[${at + 33}] = (uint8_t)(${share.c});`);
          });
          if (constant && shares !== 100n) this.fail(p.initializer, `creator shares add up to ${shares}; Metaplex requires 100`);
          creators = buf;
          ncreators = String(list.length);
        } else if (p.name.text === "collection") {
          const key = this.expect(this.expr(p.initializer, PUBKEY), PUBKEY, p.initializer);
          const t = this.tmp("coll");
          this.line(`SolPubkey ${t} = *(${key.c});`);
          collection = `&${t}`;
        } else if (p.name.text === "isCollection") {
          const v = this.expect(this.expr(p.initializer, BOOL), BOOL, p.initializer);
          const t = this.tmp("sized");
          this.line(`bool ${t} = ${v.c};`);
          sized = t;
        } else this.fail(p.name, `createV3 extras are creators, collection and isCollection, not ${p.name.text}`);
      }
    }
    const seeds = this.signerSeeds(seedsArg, mintAuth, a[2]);
    settleAll(extrasMark);
    const [name, symbol, uri, fee, mutable] = slots.map((i) => vals[i]);
    this.line(
      `TS_TRY(ts_mpl_create_v3(params, a_${program.name}, a_${metadata.name}, a_${mint.name}, a_${mintAuth.name}, a_${payer.name}, a_${updateAuth.name}, a_${sys.name}, ${name.c}, ${symbol.c}, ${uri.c}, ${fee.c}, ${mutable.c}, ${creators}, ${ncreators}, ${collection}, ${sized}, ${seeds.name}, ${seeds.count}));`,
    );
    return undefined;
  }

  /** CreateMasterEditionV3 (17) and Verify (52) with VerificationArgs::CollectionV1. */
  protected metadataCollectionOp(node: ts.CallExpression, program: AccountParam, method: string): undefined {
    const a = node.arguments;
    const p = `a_${program.name}`;
    const seedsAt = (i: number) => (a[i] ? this.signingSeeds(a[i]) : { name: "NULL", count: 0 });
    const acct = (i: number, what: string, w: boolean, s: boolean) => {
      if (a[i]!.kind === ts.SyntaxKind.NullKeyword) this.fail(a[i]!, `pass ${what}`);
      return this.mplMeta(a[i]!, program, what, w, s);
    };
    if (method === "createMasterEditionV3") {
      if (a.length !== 9 && a.length !== 10)
        this.fail(
          node,
          "createMasterEditionV3(edition, mint, updateAuthority, mintAuthority, payer, metadata, tokenProgram, systemProgram, maxSupply | null, signerSeeds?)",
        );
      const metas = [
        acct(0, "the edition", true, false),
        acct(1, "the mint", true, false),
        acct(2, "the update authority", false, true),
        acct(3, "the mint authority", false, true),
        acct(4, "the payer", true, true),
        acct(5, "the metadata", true, false),
        acct(6, "the token program", false, false),
        acct(7, "the system program", false, false),
      ];
      // max_supply: Option<u64>; Some(0) makes a one of one, None allows unlimited prints.
      const data = this.mplData(
        node,
        16,
        a[8]!.kind === ts.SyntaxKind.NullKeyword ? [{ bytes: [17, 0] }] : [{ bytes: [17, 1] }, { value: a[8]!, type: { kind: "int", name: "u64" } }],
      );
      this.cpi(p, metas, data.buf, data.len, seedsAt(9));
      return undefined;
    }
    // Verify: authority, delegate record (absent: the program id), metadata, collection mint, collection metadata,
    // collection master edition, system program, instructions sysvar.
    if (a.length !== 7 && a.length !== 8)
      this.fail(
        node,
        "verifyCollection(authority, metadata, collectionMint, collectionMetadata, collectionMasterEdition, systemProgram, instructionsSysvar, signerSeeds?)",
      );
    const metas = [
      acct(0, "the collection authority", false, true),
      [p, false, false] as [string, boolean, boolean],
      acct(1, "the metadata", true, false),
      acct(2, "the collection mint", false, false),
      acct(3, "the collection metadata", true, false),
      acct(4, "the collection master edition", false, false),
      acct(5, "the system program", false, false),
      acct(6, "the instructions sysvar", false, false),
    ];
    const data = this.mplData(node, 8, [{ bytes: [52, 1] }]);
    this.cpi(p, metas, data.buf, data.len, seedsAt(7));
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
  protected mplData(at: ts.Node, max: number, fields: MplField[]) {
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

  /**
   * Borsh of one Metaplex Core plugin literal (`{ kind: "FreezeDelegate", frozen: true, authority?: … }`): the Plugin
   * enum, then (`withAuthority`) the Option<PluginAuthority> that CreateV1's PluginAuthorityPair and AddPluginV1 take.
   */
  protected corePlugin(n: ts.Expression, withAuthority: boolean): MplField[] {
    if (!ts.isObjectLiteralExpression(n)) this.fail(n, 'a Core plugin is an object literal: { kind: "FreezeDelegate", frozen: false }');
    const props = new Map<string, ts.Expression>();
    for (const q of n.properties) {
      if (ts.isPropertyAssignment(q) && ts.isIdentifier(q.name)) props.set(q.name.text, q.initializer);
      else if (ts.isShorthandPropertyAssignment(q)) props.set(q.name.text, q.name);
      else this.fail(q, "write plugin fields as name: value");
    }
    const kindNode = props.get("kind");
    if (!kindNode || !ts.isStringLiteral(kindNode)) this.fail(n, 'a Core plugin needs kind: "Royalties" | "FreezeDelegate" | …');
    const kind = kindNode.text;
    const index = CORE_PLUGINS.indexOf(kind as never);
    if (index < 0) this.fail(kindNode, `Core plugins are ${CORE_PLUGINS.join(", ")}`);
    if (kind === "MasterEdition" || kind === "VerifiedCreators" || kind === "Autograph")
      this.fail(kindNode, `the ${kind} plugin is not supported yet (removePlugin can remove one)`);
    const known = new Set(["kind", "authority", ...(CORE_PLUGIN_FIELDS[kind] ?? [])]);
    for (const [k, v] of props) if (!known.has(k)) this.fail(v, `${kind} has no field ${k}`);
    const need = (k: string) => props.get(k) ?? this.fail(n, `${kind} needs ${k}`);
    const list = (k: string, max: number) => {
      const e = need(k);
      if (!ts.isArrayLiteralExpression(e)) this.fail(e, `${k} is an array literal`);
      if (e.elements.length > max) this.fail(e, `at most ${max} entries in ${k}`);
      return e.elements;
    };
    const u32 = (x: number) => [x & 0xff, (x >> 8) & 0xff, (x >> 16) & 0xff, x >>> 24];
    const fields: MplField[] = [{ bytes: [index] }];
    switch (kind) {
      case "Royalties": {
        const bps = need("basisPoints");
        if (ts.isBigIntLiteral(bps) && BigInt(bps.text.slice(0, -1)) > 10000n) this.fail(bps, "basisPoints is at most 10000 (100%)");
        fields.push({ value: bps, type: { kind: "int", name: "u16" } });
        const creators = list("creators", 5);
        fields.push({ bytes: u32(creators.length) });
        let sum = 0n;
        let constant = true;
        for (const c of creators) {
          if (!ts.isObjectLiteralExpression(c)) this.fail(c, "a creator is { address, percentage }");
          const get = (k: string) => {
            const q = c.properties.find(
              (x) => (ts.isPropertyAssignment(x) || ts.isShorthandPropertyAssignment(x)) && ts.isIdentifier(x.name) && x.name.text === k,
            );
            if (!q) this.fail(c, `a creator needs ${k}`);
            return ts.isPropertyAssignment(q) ? q.initializer : (q as ts.ShorthandPropertyAssignment).name;
          };
          const pct = get("percentage");
          if (ts.isBigIntLiteral(pct)) sum += BigInt(pct.text.slice(0, -1));
          else constant = false;
          fields.push({ value: get("address"), type: PUBKEY }, { value: pct, type: U8 });
        }
        if (constant && creators.length && sum !== 100n) this.fail(need("creators"), `creator percentages add up to ${sum}; Core requires 100`);
        fields.push({ bytes: [0] }); // rule_set: RuleSet::None
        break;
      }
      case "FreezeDelegate":
      case "PermanentFreezeDelegate":
        fields.push({ value: need("frozen"), type: BOOL });
        break;
      case "UpdateDelegate": {
        const keys = props.has("additionalDelegates") ? list("additionalDelegates", 8) : [];
        fields.push({ bytes: u32(keys.length) }, ...keys.map((k) => ({ value: k, type: PUBKEY })));
        break;
      }
      case "Attributes": {
        const attrs = list("attributes", 32);
        fields.push({ bytes: u32(attrs.length) });
        for (const at of attrs) {
          if (!ts.isObjectLiteralExpression(at)) this.fail(at, "an attribute is { key, value }");
          for (const k of ["key", "value"]) {
            const q = at.properties.find(
              (x) => (ts.isPropertyAssignment(x) || ts.isShorthandPropertyAssignment(x)) && ts.isIdentifier(x.name) && x.name.text === k,
            );
            if (!q) this.fail(at, `an attribute needs ${k}`);
            fields.push({ value: ts.isPropertyAssignment(q) ? q.initializer : (q as ts.ShorthandPropertyAssignment).name, type: STRING });
          }
        }
        break;
      }
      case "Edition":
        fields.push({ value: need("number"), type: { kind: "int", name: "u32" } });
        break;
    }
    const auth = props.get("authority");
    if (!withAuthority) {
      if (auth) this.fail(auth, "a plugin's authority is set when it is added; change it with Core's approve / revoke");
      return fields;
    }
    if (!auth)
      fields.push({ bytes: [0] }); // the plugin type's default authority
    else if (ts.isStringLiteral(auth)) {
      const i = ["none", "owner", "updateAuthority"].indexOf(auth.text);
      if (i < 0) this.fail(auth, 'authority is "none", "owner", "updateAuthority" or a Pubkey');
      fields.push({ bytes: [1, i] });
    } else fields.push({ bytes: [1, 3] }, { value: auth, type: PUBKEY });
    return fields;
  }

  /** CreateV1 / CreateCollectionV1 plugins: Option<Vec<PluginAuthorityPair>>. */
  protected corePluginList(n: ts.Expression | undefined): MplField[] {
    if (!n) return [{ bytes: [0] }];
    const els = (n as ts.ArrayLiteralExpression).elements;
    if (els.length > 16) this.fail(n, "at most 16 plugins");
    const kinds = els.map((e) =>
      ts.isObjectLiteralExpression(e) ? e.properties.find((q) => q.name && ts.isIdentifier(q.name) && q.name.text === "kind") : undefined,
    );
    const seen = new Set<string>();
    kinds.forEach((k, i) => {
      const lit = k && ts.isPropertyAssignment(k) && ts.isStringLiteral(k.initializer) ? k.initializer.text : undefined;
      if (lit && seen.has(lit)) this.fail(els[i], `${lit} is listed twice; an asset has one plugin of each kind`);
      if (lit) seen.add(lit);
    });
    return [{ bytes: [1, els.length & 0xff, 0, 0, 0] }, ...els.flatMap((e) => this.corePlugin(e, true))];
  }

  /** Metaplex Core: assets and collections (with plugins), plugins added, updated and removed, transfer and burn. */
  protected coreOp(node: ts.CallExpression, core: AccountParam, method: string): undefined {
    const a = node.arguments;
    const p = `a_${core.name}`;
    const seedsAt = (i: number) => (a[i] ? this.signingSeeds(a[i]) : { name: "NULL", count: 0 });
    const str = (n: ts.Expression) => ({ value: n, type: STRING });
    // An array literal of object literals after the uri is the plugin list; the signer seeds come after it.
    const isPlugins = (n: ts.Expression | undefined) =>
      !!n && ts.isArrayLiteralExpression(n) && (n.elements.length === 0 || n.elements.every((e) => ts.isObjectLiteralExpression(e)));
    const self: [string, boolean, boolean] = [p, false, false];
    switch (method) {
      case "createAsset": {
        // CreateV1: asset, collection, authority, payer, owner, updateAuthority, systemProgram, logWrapper.
        const plugins = isPlugins(a[8]) ? a[8] : undefined;
        if (a.length < 8 || a.length > (plugins ? 10 : 9))
          this.fail(node, "createAsset(asset, collection | null, authority | null, payer, owner | null, systemProgram, name, uri, plugins?, signerSeeds?)");
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
        const data = this.mplData(node, 2048, [{ bytes: [0, 0] }, str(a[6]), str(a[7]), ...this.corePluginList(plugins)]);
        this.cpi(p, metas, data.buf, data.len, seedsAt(plugins ? 9 : 8));
        return undefined;
      }
      case "createCollection": {
        // CreateCollectionV1: collection, updateAuthority, payer, systemProgram.
        const plugins = isPlugins(a[6]) ? a[6] : undefined;
        if (a.length < 6 || a.length > (plugins ? 8 : 7))
          this.fail(node, "createCollection(collection, updateAuthority | null, payer, systemProgram, name, uri, plugins?, signerSeeds?)");
        const metas = [
          this.mplMeta(a[0], core, "the collection", true, true),
          this.mplMeta(a[1], core, "the update authority", false, false),
          this.mplMeta(a[2], core, "the payer", true, true),
          this.mplMeta(a[3], core, "the system program", false, false),
        ];
        const data = this.mplData(node, 2048, [{ bytes: [1] }, str(a[4]), str(a[5]), ...this.corePluginList(plugins)]);
        this.cpi(p, metas, data.buf, data.len, seedsAt(plugins ? 7 : 6));
        return undefined;
      }
      case "addPlugin":
      case "updatePlugin":
      case "removePlugin": {
        // Add/Remove/UpdatePluginV1: asset, collection, payer, authority, systemProgram, logWrapper.
        const last = method === "removePlugin" ? "kind" : "plugin";
        if (a.length !== 6 && a.length !== 7)
          this.fail(node, `${method}(asset, collection | null, payer, authority | null, systemProgram, ${last}, signerSeeds?)`);
        const metas = [
          this.mplMeta(a[0], core, "the asset", true, false),
          this.mplMeta(a[1], core, "the collection", true, false),
          this.mplMeta(a[2], core, "the payer", true, true),
          this.mplMeta(a[3], core, "the authority", false, true),
          this.mplMeta(a[4], core, "the system program", false, false),
          self,
        ];
        const body = method === "removePlugin" ? [this.corePluginType(a[5])] : this.corePlugin(a[5], method === "addPlugin");
        const data = this.mplData(node, 2048, [{ bytes: [{ addPlugin: 2, removePlugin: 4, updatePlugin: 6 }[method]] }, ...body]);
        this.cpi(p, metas, data.buf, data.len, seedsAt(6));
        return undefined;
      }
      case "addCollectionPlugin":
      case "updateCollectionPlugin":
      case "removeCollectionPlugin": {
        // Add/Remove/UpdateCollectionPluginV1: collection, payer, authority, systemProgram, logWrapper.
        const last = method === "removeCollectionPlugin" ? "kind" : "plugin";
        if (a.length !== 5 && a.length !== 6) this.fail(node, `${method}(collection, payer, authority | null, systemProgram, ${last}, signerSeeds?)`);
        const metas = [
          this.mplMeta(a[0], core, "the collection", true, false),
          this.mplMeta(a[1], core, "the payer", true, true),
          this.mplMeta(a[2], core, "the authority", false, true),
          this.mplMeta(a[3], core, "the system program", false, false),
          self,
        ];
        const body = method === "removeCollectionPlugin" ? [this.corePluginType(a[4])] : this.corePlugin(a[4], method === "addCollectionPlugin");
        const data = this.mplData(node, 2048, [{ bytes: [{ addCollectionPlugin: 3, removeCollectionPlugin: 5, updateCollectionPlugin: 7 }[method]] }, ...body]);
        this.cpi(p, metas, data.buf, data.len, seedsAt(5));
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
    this.fail(
      node.expression,
      `Metaplex Core supports createAsset, createCollection, addPlugin, updatePlugin, removePlugin (and the Collection forms), transferAsset and burnAsset, not ${method}`,
    );
  }

  /** PluginType (u8) from a kind string literal: removePlugin(…, "FreezeDelegate"). */
  protected corePluginType(n: ts.Expression): MplField {
    if (!ts.isStringLiteral(n)) this.fail(n, 'name the plugin kind as a string literal: "FreezeDelegate"');
    const i = CORE_PLUGINS.indexOf(n.text as never);
    if (i < 0) this.fail(n, `Core plugins are ${CORE_PLUGINS.join(", ")}`);
    return { bytes: [i] };
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
    return this.bubblegumV2(node, bg, method);
  }

  /** Bubblegum V2 (trees on mpl-account-compression with mpl-noop; optional Metaplex Core collections). */
  protected bubblegumV2(node: ts.CallExpression, bg: AccountParam, method: string): undefined {
    const a = node.arguments;
    const p = `a_${bg.name}`;
    const acct = (i: number, what: string, w: boolean, s: boolean) => this.mplMeta(a[i]!, bg, what, w, s);
    const seedsAt = (i: number) => (a[i] ? this.signingSeeds(a[i]) : { name: "NULL", count: 0 });
    const U32: ValueType = { kind: "int", name: "u32" };
    const U64v: ValueType = { kind: "int", name: "u64" };
    const HASH: ValueType = { kind: "pubkey", hash: true };
    // The leaf a transfer or burn replaces: { root, dataHash, creatorHash, assetDataHash?, flags?, nonce, index }.
    const leafFields = (n: ts.Expression): MplField[] => {
      if (!ts.isObjectLiteralExpression(n)) this.fail(n, "the leaf is { root, dataHash, creatorHash, assetDataHash?, flags?, nonce, index }");
      const props = new Map<string, ts.Expression>();
      for (const q of n.properties) {
        if (ts.isPropertyAssignment(q) && ts.isIdentifier(q.name)) props.set(q.name.text, q.initializer);
        else if (ts.isShorthandPropertyAssignment(q)) props.set(q.name.text, q.name);
        else this.fail(q, "write leaf fields as name: value");
      }
      const known = ["root", "dataHash", "creatorHash", "assetDataHash", "flags", "nonce", "index"];
      for (const [k, v] of props) if (!known.includes(k)) this.fail(v, `the leaf has no field ${k}`);
      const need = (k: string) => props.get(k) ?? this.fail(n, `the leaf needs ${k}`);
      const opt = (k: string, t: ValueType): MplField[] => {
        const v = props.get(k);
        if (!v || v.kind === ts.SyntaxKind.NullKeyword) return [{ bytes: [0] }];
        return [{ bytes: [1] }, { value: v, type: t }];
      };
      return [
        { value: need("root"), type: HASH },
        { value: need("dataHash"), type: HASH },
        { value: need("creatorHash"), type: HASH },
        ...opt("assetDataHash", HASH),
        ...opt("flags", U8),
        { value: need("nonce"), type: U64v },
        { value: need("index"), type: U32 },
      ];
    };
    const proofRange = (n: ts.Expression) => {
      if (!this.ix) this.fail(n, "a Merkle proof comes from remainingAccounts(), so only instructions can pass one");
      return this.remainingRange(n) ?? this.fail(n, "pass the proof as remainingAccounts() or rest.slice(a, b)");
    };
    switch (method) {
      case "createTreeV2": {
        // CreateTreeConfigV2: treeConfig, merkleTree, payer, treeCreator, logWrapper, compressionProgram, systemProgram.
        if (a.length !== 10 && a.length !== 11)
          this.fail(
            node,
            "createTreeV2(treeConfig, merkleTree, payer, treeCreator | null, logWrapper, compressionProgram, systemProgram, maxDepth, maxBufferSize, isPublic, signerSeeds?)",
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
        const data = this.mplData(node, 32, [
          { bytes: [55, 99, 95, 215, 142, 203, 227, 205] },
          { value: a[7]!, type: U32 },
          { value: a[8]!, type: U32 },
          { bytes: [1] },
          { value: a[9]!, type: BOOL },
        ]);
        this.cpi(p, metas, data.buf, data.len, seedsAt(10));
        return undefined;
      }
      case "mintV2": {
        // MintV2: treeConfig, payer, treeCreatorOrDelegate, collectionAuthority, leafOwner, leafDelegate, merkleTree,
        // coreCollection, mplCoreCpiSigner, logWrapper, compressionProgram, mplCoreProgram, systemProgram.
        const usage =
          "mintV2(treeConfig, payer, treeDelegate | null, leafOwner, leafDelegate | null, merkleTree, logWrapper, compressionProgram, mplCoreProgram, systemProgram, { name, symbol, uri, sellerFeeBasisPoints, creators?, isMutable? }, { collection, authority, cpiSigner }?, signerSeeds?)";
        const collection = a[11] && ts.isObjectLiteralExpression(a[11]) ? a[11] : undefined;
        if (a.length < 11 || a.length > (collection ? 13 : 12)) this.fail(node, usage);
        const md = a[10]!;
        if (!ts.isObjectLiteralExpression(md)) this.fail(md, "the metadata is { name, symbol, uri, sellerFeeBasisPoints, creators?, isMutable? }");
        const field = (o: ts.ObjectLiteralExpression, k: string) => {
          const q = o.properties.find(
            (x) => (ts.isPropertyAssignment(x) || ts.isShorthandPropertyAssignment(x)) && ts.isIdentifier(x.name) && x.name.text === k,
          );
          return q ? (ts.isPropertyAssignment(q) ? q.initializer : (q as ts.ShorthandPropertyAssignment).name) : undefined;
        };
        for (const q of md.properties)
          if (!q.name || !ts.isIdentifier(q.name) || !["name", "symbol", "uri", "sellerFeeBasisPoints", "creators", "isMutable"].includes(q.name.text))
            this.fail(q, "the metadata takes name, symbol, uri, sellerFeeBasisPoints, creators and isMutable");
        const coll = collection
          ? (["collection", "authority", "cpiSigner"] as const).map((k) => field(collection, k) ?? this.fail(collection, `the collection needs ${k}`))
          : undefined;
        if (collection)
          for (const q of collection.properties)
            if (!q.name || !ts.isIdentifier(q.name) || !["collection", "authority", "cpiSigner"].includes(q.name.text))
              this.fail(q, "the collection is { collection, authority, cpiSigner }");
        const metas: [string, boolean, boolean][] = [
          acct(0, "the tree config", true, false),
          acct(1, "the payer", true, true),
          acct(2, "the tree delegate", false, true),
          coll ? this.mplMeta(coll[1], bg, "the collection authority", false, true) : [p, false, false],
          acct(3, "the leaf owner", false, false),
          acct(4, "the leaf delegate", false, false),
          acct(5, "the merkle tree", true, false),
          coll ? this.mplMeta(coll[0], bg, "the core collection", true, false) : [p, false, false],
          coll ? this.mplMeta(coll[2], bg, "the mpl-core CPI signer", false, false) : [p, false, false],
          acct(6, "the log wrapper", false, false),
          acct(7, "the compression program", false, false),
          acct(8, "the mpl-core program", false, false),
          acct(9, "the system program", false, false),
        ];
        const need = (k: string) => field(md, k) ?? this.fail(md, `the metadata needs ${k}`);
        const fields: MplField[] = [
          { bytes: [120, 121, 23, 146, 173, 110, 199, 205] },
          { value: need("name"), type: STRING },
          { value: need("symbol"), type: STRING },
          { value: need("uri"), type: STRING },
          { value: need("sellerFeeBasisPoints"), type: { kind: "int", name: "u16" } },
          { bytes: [0] }, // primary_sale_happened
        ];
        const mutable = field(md, "isMutable");
        fields.push(mutable ? { value: mutable, type: BOOL } : { bytes: [1] });
        fields.push({ bytes: [1, 0] }); // token_standard: Some(NonFungible)
        const creators = field(md, "creators");
        if (creators && !ts.isArrayLiteralExpression(creators)) this.fail(creators, "creators: [{ address, verified, share }, …] (an array literal)");
        const list = creators ? (creators as ts.ArrayLiteralExpression).elements : [];
        if (list.length > 5) this.fail(creators!, "Bubblegum takes at most 5 creators");
        fields.push({ bytes: [list.length, 0, 0, 0] });
        let shares = 0n;
        let constant = true;
        for (const el of list) {
          if (!ts.isObjectLiteralExpression(el)) this.fail(el, "a creator is { address, verified, share }");
          const f = (k: string) => field(el, k) ?? this.fail(el, `a creator needs ${k}`);
          const share = f("share");
          if (ts.isBigIntLiteral(share)) shares += BigInt(share.text.slice(0, -1));
          else constant = false;
          fields.push({ value: f("address"), type: PUBKEY }, { value: f("verified"), type: BOOL }, { value: share, type: U8 });
        }
        if (list.length && constant && shares !== 100n) this.fail(creators!, `creator shares add up to ${shares}; Bubblegum requires 100`);
        // collection: Some(the core collection's key) when minting into one.
        if (coll) fields.push({ bytes: [1] }, { value: this.keyOf(coll[0]), type: PUBKEY });
        else fields.push({ bytes: [0] });
        fields.push({ bytes: [0, 0] }); // asset_data, asset_data_schema: None
        const data = this.mplData(node, 1024, fields);
        this.cpi(p, metas, data.buf, data.len, seedsAt(collection ? 12 : 11));
        return undefined;
      }
      case "transferV2": {
        // TransferV2: treeConfig, payer, authority, leafOwner, leafDelegate, newLeafOwner, merkleTree, coreCollection,
        // logWrapper, compressionProgram, systemProgram; the proof follows as remaining accounts.
        if (a.length !== 13 && a.length !== 14)
          this.fail(
            node,
            "transferV2(treeConfig, payer, authority | null, leafOwner, leafDelegate | null, newLeafOwner, merkleTree, coreCollection | null, logWrapper, compressionProgram, systemProgram, leaf, proof, signerSeeds?)",
          );
        const metas = [
          acct(0, "the tree config", true, false),
          acct(1, "the payer", true, true),
          acct(2, "the authority", false, true),
          acct(3, "the leaf owner", false, false),
          acct(4, "the leaf delegate", false, false),
          acct(5, "the new leaf owner", false, false),
          acct(6, "the merkle tree", true, false),
          acct(7, "the core collection", false, false),
          acct(8, "the log wrapper", false, false),
          acct(9, "the compression program", false, false),
          acct(10, "the system program", false, false),
        ];
        const data = this.mplData(node, 160, [{ bytes: [119, 40, 6, 235, 234, 221, 248, 49] }, ...leafFields(a[11]!)]);
        this.cpi(p, metas, data.buf, data.len, seedsAt(13), proofRange(a[12]!));
        return undefined;
      }
      case "burnV2": {
        // BurnV2: treeConfig, payer, authority, leafOwner, leafDelegate, merkleTree, coreCollection, mplCoreCpiSigner,
        // logWrapper, compressionProgram, mplCoreProgram, systemProgram; the proof follows as remaining accounts.
        if (a.length !== 14 && a.length !== 15)
          this.fail(
            node,
            "burnV2(treeConfig, payer, authority | null, leafOwner, leafDelegate | null, merkleTree, coreCollection | null, mplCoreCpiSigner | null, logWrapper, compressionProgram, mplCoreProgram, systemProgram, leaf, proof, signerSeeds?)",
          );
        const metas = [
          acct(0, "the tree config", true, false),
          acct(1, "the payer", true, true),
          acct(2, "the authority", false, true),
          acct(3, "the leaf owner", false, false),
          acct(4, "the leaf delegate", false, false),
          acct(5, "the merkle tree", true, false),
          acct(6, "the core collection", true, false),
          acct(7, "the mpl-core CPI signer", false, false),
          acct(8, "the log wrapper", false, false),
          acct(9, "the compression program", false, false),
          acct(10, "the mpl-core program", false, false),
          acct(11, "the system program", false, false),
        ];
        const data = this.mplData(node, 160, [{ bytes: [115, 210, 34, 240, 232, 143, 183, 16] }, ...leafFields(a[12]!)]);
        this.cpi(p, metas, data.buf, data.len, seedsAt(14), proofRange(a[13]!));
        return undefined;
      }
    }
    this.fail(node.expression, `Bubblegum supports createTree, mint, createTreeV2, mintV2, transferV2 and burnV2, not ${method}`);
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

  protected emitEvent(node: ts.CallExpression, cpi?: { authority: string; program: string }): undefined {
    const targ = node.typeArguments?.[0];
    const s = targ && ts.isTypeReferenceNode(targ) && ts.isIdentifier(targ.typeName) ? this.model.structs.get(targ.typeName.text) : undefined;
    if (!s) this.fail(node, "emit needs an explicit event type: emit<MyEvent>({ ... })");
    if (s.layout === "borsh") this.fail(node, `${s.name} is @layout borsh, an account layout; declare a separate event struct`);
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
