import ts from "typescript";
import { snakeCase } from "../analyze.js";
import { decodeAddress } from "../../keys.js";
import {
  INT_INFO,
  type FieldType,
  type IdlSeed,
  type Instruction,
  type ScalarType,
  type StructDef,
  isScalar,
  isWritable,
  scalarSize,
  typeName,
} from "../model.js";
import { borshIdentical, borshMinSize } from "./borsh.js";
import { MAX_ACCOUNTS, ATA_PROGRAM_BYTES, cBytes, cString, optC, fieldC, storageDecl, helperSignature, emptySizeC, vecLenCheck } from "./shared.js";
import { StatementEmitter } from "./statements.js";

/**
 * One instruction or helper as a C function: the instruction prologue (account checks, constraints and
 * argument decoding), the body, and the epilogue.
 */
export class FunctionEmitter extends StatementEmitter {
  emitHelper(): string {
    const h = this.helper!;
    this.scopes = [new Map()];
    this.line(`(void)params;`);
    for (const p of h.params)
      if (p.account && p.account.kind === "account" && p.account.struct.layout !== "borsh")
        this.line(`TSS_${p.account.struct.name} *d_${p.name} = (TSS_${p.account.struct.name} *)(a_${p.name}->data + 8);`);
    for (const stmt of h.statements) this.reporter.guard(() => this.statement(stmt));
    // A helper with a result must return one; falling off the end would leave it unset.
    const end = h.returns ? `  TS_FAIL(TS_ERR_NO_RETURN, "TypeSOL: ${h.display} ended without returning a value");` : `  return SUCCESS;`;
    return [`${helperSignature(h)} {`, ...this.hoisted, ...this.lines, end, `}`].join("\n");
  }

  emitInstruction(): string {
    const ix = this.ix!;
    const head: string[] = [];
    head.push(`__attribute__((noinline)) static uint64_t ix_${ix.name}(TsParams *params) {`);
    const n = ix.accounts.length;
    if (n > MAX_ACCOUNTS) this.reporter.fail(ix.node, `instructions may take at most ${MAX_ACCOUNTS} accounts`);
    head.push(`  if (params->ka_num < ${n}) TS_FAIL(TS_ERR_NOT_ENOUGH_ACCOUNTS, "TypeSOL: not enough accounts");`);

    for (const a of ix.accounts) {
      const v = `a_${a.name}`;
      head.push(`  TsAccount *${v} = params->ka[${a.index}];`);
      const start = head.length;
      const k = a.kind;
      if (k.kind === "signer") head.push(`  TS_TRY(ts_check_signer(${v}));`);
      if (isWritable(k)) head.push(`  TS_TRY(ts_check_writable(${v}));`);
      // A @layout borsh account only has to hold its smallest Borsh form (unpacking checks the rest).
      if (k.kind === "account")
        head.push(
          `  TS_TRY(ts_check_program_account(${v}, params->program_id, TS_DISC_${k.struct.name}, ${k.struct.layout === "borsh" ? borshMinSize(k.struct, this.model) : emptySizeC(k.struct)}));`,
        );
      // A token account created by this instruction is checked where it is created (create/createIfNeeded).
      if (k.kind === "token" && !k.init) head.push(`  TS_TRY(ts_check_token_account(${v}));`);
      // A mint created by this instruction is checked where it is created.
      if (k.kind === "mint" && !k.init) head.push(`  TS_TRY(ts_check_mint(${v}));`);
      if (k.kind === "info" && k.systemOwned)
        head.push(
          `  if (!ts_key_eq(&${v}->owner, &TS_SYSTEM_PROGRAM_ID)) TS_FAIL(TS_ERR_NOT_SYSTEM_OWNED, "TypeSOL: ${a.name} must be owned by the System Program");`,
        );
      if (k.kind === "system") head.push(`  TS_TRY(ts_check_address(${v}, &TS_SYSTEM_PROGRAM_ID));`);
      if (k.kind === "instructionsSysvar") head.push(`  TS_TRY(ts_check_address(${v}, &TS_INSTRUCTIONS_SYSVAR_ID));`);
      if (k.kind === "eventAuthority") head.push(`  uint8_t eb_${a.name};`, `  TS_TRY(ts_check_event_authority(${v}, params->program_id, &eb_${a.name}));`);
      if (k.kind === "selfProgram")
        head.push(`  if (!ts_key_eq(&${v}->key, params->program_id)) TS_FAIL(TS_ERR_WRONG_PROGRAM, "TypeSOL: expected this program");`);
      if (k.kind === "programData") head.push(`  TS_TRY(ts_check_program_data(${v}, params->program_id));`);
      if (k.kind === "pyth") head.push(`  uint64_t pm_${a.name}; bool pf_${a.name};`, `  TS_TRY(ts_pyth_message(${v}, &pm_${a.name}, &pf_${a.name}));`);
      if (k.kind === "switchboard") head.push(`  TS_TRY(ts_check_switchboard(${v}, ${k.devnet}));`);
      if (k.kind === "ataProgram") head.push(`  TS_TRY(ts_check_address(${v}, &TS_ATA_PROGRAM_ID));`);
      if (k.kind === "metadataProgram") head.push(`  TS_TRY(ts_check_address(${v}, &TS_MPL_METADATA_ID));`);
      if (k.kind === "coreProgram") head.push(`  TS_TRY(ts_check_address(${v}, &TS_MPL_CORE_ID));`);
      if (k.kind === "bubblegumProgram") head.push(`  TS_TRY(ts_check_address(${v}, &TS_BUBBLEGUM_ID));`);
      if (k.kind === "tokenProgram") {
        if (k.flavor === "token") head.push(`  TS_TRY(ts_check_address(${v}, &TS_TOKEN_PROGRAM_ID));`);
        else if (k.flavor === "token2022") head.push(`  TS_TRY(ts_check_address(${v}, &TS_TOKEN_2022_PROGRAM_ID));`);
        else head.push(`  TS_TRY(ts_check_token_program(${v}));`);
      }
      if (k.kind === "program") {
        if (k.address) {
          head.push(`  static const SolPubkey ${v}__expected = {${cBytes(k.address.bytes)}};`);
          head.push(`  TS_TRY(ts_check_address(${v}, &${v}__expected));`);
        }
        head.push(`  TS_TRY(ts_check_executable(${v}));`);
      }
      if (k.kind === "zeroed") head.push(`  TS_TRY(ts_init_zeroed(${v}, params->program_id, TS_DISC_${k.struct.name}, sizeof(TSS_${k.struct.name})));`);
      if (k.kind === "initIfNeeded" && k.struct.vec) this.reporter.fail(a.node, "InitIfNeeded accounts cannot end in a Vec yet");
      if ((k.kind === "account" || k.kind === "init" || k.kind === "initIfNeeded") && k.struct.layout === "borsh") {
        // Worked on as its fixed-layout struct on the heap, packed back when the instruction returns. The heap is zero at
        // entry and these are its first allocations (before the body uses it), so a string's padding and a list's
        // unused slots start as zero: ts_unpack_* only writes what the Borsh bytes hold.
        const S = k.struct.name;
        head.push(`  TSS_${S} *d_${a.name} = NULL;`, `  TS_TRY(ts_alloc(sizeof(TSS_${S}), (uint8_t **)&d_${a.name}));`);
        if (k.kind === "account") head.push(`  TS_TRY(ts_unpack_${S}(${v}->data + 8, ${v}->data_len - 8, d_${a.name}, NULL));`);
      } else if (k.kind === "account" || k.kind === "init" || k.kind === "zeroed" || k.kind === "initIfNeeded") {
        head.push(`  TSS_${k.struct.name} *d_${a.name} = (TSS_${k.struct.name} *)(${v}->data + 8);`);
        if (k.struct.vec) {
          head.push(`  uint64_t entry_${a.name} = ${v}->data_len;`, `  (void)entry_${a.name};`);
          if (k.kind === "account") head.push(...vecLenCheck(k.struct, v, `d_${a.name}`));
        }
      }
      // realloc(x, …) needs the size the account had when the instruction started (the 10 KiB growth limit).
      const reallocated = (() => {
        let found = false;
        const visit = (nd: ts.Node) => {
          if (
            ts.isCallExpression(nd) &&
            this.exportName(nd.expression) === "realloc" &&
            nd.arguments[0] &&
            ts.isIdentifier(nd.arguments[0]) &&
            nd.arguments[0].text === a.name
          )
            found = true;
          ts.forEachChild(nd, visit);
        };
        visit(ix.node.body!);
        return found;
      })();
      if (reallocated && !((k.kind === "account" || k.kind === "init" || k.kind === "zeroed" || k.kind === "initIfNeeded") && k.struct.vec))
        head.push(`  uint64_t entry_${a.name} = ${v}->data_len;`, `  (void)entry_${a.name};`);
      if (a.optional) {
        // Left out (this program's id in its slot, Anchor's convention): NULL, and none of its checks run.
        const lines = head.splice(start);
        head.push(`  if (ts_key_eq(&${v}->key, params->program_id)) ${v} = NULL;`);
        const inside: string[] = [];
        for (const l of lines) {
          const m = /^  ((?:TSS_\w+ \*d_\w+)|(?:uint64_t entry_\w+)) = (.*);$/.exec(l);
          if (m) {
            head.push(`  ${m[1]} = ${m[1].includes("*") ? "NULL" : "0"};`);
            inside.push(`    ${m[1].split(/[ *]+/).pop()} = ${m[2]};`);
          } else if (l.startsWith("  (void)")) head.push(l);
          else inside.push(`  ${l}`);
        }
        if (inside.length) head.push(`  if (${v} != NULL) {`, ...inside, `  }`);
      }
    }

    // Writable accounts must be distinct: aliasing two mutable views of one account is the classic drain.
    // The loader passes each account once and marks repeats as duplicates, which share its record (ts_deserialize),
    // so two parameters name the same account exactly when their pointers are equal.
    const writable = ix.accounts.filter((a) => isWritable(a.kind));
    const pairs: string[] = [];
    for (let i = 0; i < writable.length; i++)
      for (let j = i + 1; j < writable.length; j++) {
        const present = [writable[i], writable[j]]
          .filter((a) => a.optional)
          .map((a) => `a_${a.name} && `)
          .join("");
        pairs.push(
          `if (${present}a_${writable[i].name} == a_${writable[j].name}) TS_FAIL(TS_ERR_DUPLICATE_MUT, "TypeSOL: ${writable[i].name} and ${writable[j].name} must be different accounts");`,
        );
      }
    head.push(...pairs.map((p) => `  ${p}`));

    // Arguments: Borsh, read sequentially (strings make later offsets dynamic).
    if (ix.args.length) head.push(`  uint64_t off = ${ix.discriminator.length};`);
    const need = (bytes: string) =>
      head.push(`  if (params->data_len < off + ${bytes}) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: instruction data too short");`);
    for (const a of ix.args) {
      const at = `params->data + off`;
      if (a.type.kind === "string") {
        need("4");
        head.push(`  uint32_t arg_${a.name}__len = (uint32_t)ts_read_le(${at}, 4);`, `  off += 4;`);
        need(`arg_${a.name}__len`);
        head.push(`  TS_Str arg_${a.name} = ts_str(${at}, arg_${a.name}__len);`, `  off += arg_${a.name}__len;`);
        head.push(
          `  if (!ts_utf8_valid(arg_${a.name}.ptr, arg_${a.name}.len)) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: invalid UTF-8 in a string argument");`,
        );
      } else if (a.type.kind === "pubkey") {
        need("32");
        head.push(`  SolPubkey arg_${a.name};`, `  ts_memcpy(&arg_${a.name}, ${at}, 32);`, `  off += 32;`);
      } else if (a.type.kind === "bool") {
        need("1");
        head.push(`  uint8_t arg_${a.name}__raw = *(${at});`, `  off += 1;`);
        head.push(`  if (arg_${a.name}__raw > 1) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: invalid bool argument");`);
        head.push(`  bool arg_${a.name} = arg_${a.name}__raw == 1;`);
      } else if (a.type.kind === "enum") {
        need("1");
        const n = this.model.enums.get(a.type.name)!.variants.length;
        head.push(`  uint8_t arg_${a.name} = *(${at});`, `  off += 1;`);
        head.push(`  if (arg_${a.name} >= ${n}) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: invalid enum argument");`);
      } else if (a.type.kind === "option") {
        // Borsh Option: one tag byte, then the value only when Some.
        const inner = a.type.inner;
        const size = scalarSize(inner);
        need("1");
        head.push(`  ${optC(inner)} arg_${a.name} = {0};`, `  uint8_t arg_${a.name}__tag = *(${at});`, `  off += 1;`);
        head.push(`  if (arg_${a.name}__tag > 1) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: invalid option argument");`);
        head.push(`  if (arg_${a.name}__tag == 1) {`);
        head.push(`    if (params->data_len < off + ${size}) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: instruction data too short");`);
        head.push(`    arg_${a.name}.some = 1;`, `    ts_memcpy(&arg_${a.name}.v, ${at}, ${size});`, `    off += ${size};`);
        if (inner.kind === "bool" || inner.kind === "enum") {
          const max = inner.kind === "bool" ? 2 : this.model.enums.get(inner.name)!.variants.length;
          head.push(`    if (arg_${a.name}.v >= ${max}) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: invalid option argument");`);
        }
        head.push(`  }`);
      } else if (a.type.kind === "vecArg" && a.type.elem.kind === "string") {
        // Borsh Vec<String>: u32 count, then each string's u32 length and UTF-8 bytes. Kept as views of the
        // instruction data in a heap array of TS_Str (each string at least 4 bytes, so the count is bounded first).
        const v = `arg_${a.name}`;
        const items = `vs_${a.name}`;
        const i = `vi_${a.name}`;
        need("4");
        head.push(`  TS_VecArg ${v};`, `  ${v}.len = (uint32_t)ts_read_le(${at}, 4);`, `  off += 4;`);
        need(`(uint64_t)${v}.len * 4`);
        head.push(
          `  TS_Str *${items};`,
          `  TS_TRY(ts_alloc((uint64_t)${v}.len * sizeof(TS_Str), (uint8_t **)&${items}));`,
          `  for (uint64_t ${i} = 0; ${i} < ${v}.len; ${i}++) {`,
          `    if (params->data_len < off + 4) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: instruction data too short");`,
          `    uint32_t n = (uint32_t)ts_read_le(params->data + off, 4);`,
          `    off += 4;`,
          `    if (params->data_len - off < n) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: instruction data too short");`,
          `    if (!ts_utf8_valid(params->data + off, n)) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: invalid UTF-8 in a string argument");`,
          `    ${items}[${i}] = ts_str(params->data + off, n);`,
          `    off += n;`,
          `  }`,
          `  ${v}.ptr = (const uint8_t *)${items};`,
        );
      } else if (a.type.kind === "vecArg") {
        const elem = a.type.elem;
        const size = this.fieldBytes(elem);
        need("4");
        head.push(`  TS_VecArg arg_${a.name};`, `  arg_${a.name}.len = (uint32_t)ts_read_le(${at}, 4);`, `  off += 4;`);
        if (a.type.cap !== undefined)
          head.push(`  if (arg_${a.name}.len > ${a.type.cap}) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: more elements than the FixedVec argument holds");`);
        need(`(uint64_t)arg_${a.name}.len * ${size}`);
        head.push(`  arg_${a.name}.ptr = ${at};`, `  off += (uint64_t)arg_${a.name}.len * ${size};`);
        // Struct elements are read in place, so check them all now; scalars are checked when read.
        if (!isScalar(elem)) {
          const i = `vi_${a.name}`;
          const checks = this.validation(`((${fieldC(elem)} *)arg_${a.name}.ptr)[${i}]`, elem, "    ");
          if (checks.length) head.push(`  for (uint64_t ${i} = 0; ${i} < arg_${a.name}.len; ${i}++) {`, ...checks, `  }`);
        }
      } else if (a.type.kind === "structRef" && this.model.structs.get(a.type.struct)!.layout === "borsh") {
        // A @layout borsh struct: Borsh-decoded into its fixed-layout struct, as its accounts are.
        const S = a.type.struct;
        const v = `arg_${a.name}`;
        const used = `used_${a.name}`;
        head.push(
          `  TSS_${S} *${v};`,
          `  TS_TRY(ts_alloc(sizeof(TSS_${S}), (uint8_t **)&${v}));`,
          `  uint64_t ${used} = 0;`,
          `  if (ts_unpack_${S}(${at}, params->data_len - off, ${v}, &${used}) != SUCCESS) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: invalid ${S} argument");`,
          `  off += ${used};`,
        );
        // Strings from outside are checked as UTF-8 (account data was checked when it was written).
        for (const f of this.model.structs.get(S)!.fields) {
          const bad = `TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: invalid UTF-8 in a string argument")`;
          if (f.type.kind === "fstring") head.push(`  if (!ts_utf8_valid(${v}->${f.name}.bytes, ${v}->${f.name}.len)) ${bad};`);
          else if (f.type.kind === "vec" && f.type.elem.kind === "fstring")
            head.push(
              `  for (uint64_t i = 0; i < ${v}->${f.name}.len; i++)`,
              `    if (!ts_utf8_valid(${v}->${f.name}.items[i].bytes, ${v}->${f.name}.items[i].len)) ${bad};`,
            );
        }
      } else if (a.type.kind === "structRef" || a.type.kind === "arrayArg") {
        // Fixed layouts are Borsh-identical: copy to the heap, then check bools, enums, options and strings.
        const v = `arg_${a.name}`;
        const decl = a.type.kind === "structRef" ? `TSS_${a.type.struct} *${v}` : storageDecl(a.type.array, `(*${v})`);
        const ft: FieldType = a.type.kind === "structRef" ? { kind: "struct", name: a.type.struct } : a.type.array;
        const size = this.fieldBytes(ft);
        need(String(size));
        head.push(`  ${decl};`, `  TS_TRY(ts_alloc(${size}, (uint8_t **)&${v}));`, `  ts_memcpy(${v}, ${at}, ${size});`, `  off += ${size};`);
        head.push(...this.validation(`(*${v})`, ft, "  "));
      } else if (a.type.kind === "dataEnumArg") {
        // Borsh enum: tag byte, then the variant's fields in order.
        const e = this.model.dataEnums.get(a.type.name)!;
        const v = `arg_${a.name}__v`;
        need("1");
        head.push(`  TSE_${e.name} ${v};`, `  ts_memzero(&${v}, sizeof(${v}));`, `  ${v}.tag = *(${at});`, `  off += 1;`);
        head.push(`  switch (${v}.tag) {`);
        e.variants.forEach((variant, i) => {
          head.push(`  case ${i}: {`);
          for (const f of variant.fields) {
            if (f.type.kind === "string") {
              // Borsh String: u32 length, then UTF-8 bytes, kept as a view of the instruction data.
              const lv = `${v}.v.${variant.name}.${f.name}`;
              head.push(`    if (params->data_len < off + 4) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: instruction data too short");`);
              head.push(`    { uint32_t n = (uint32_t)ts_read_le(params->data + off, 4); off += 4;`);
              head.push(`      if (params->data_len < off + n) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: instruction data too short");`);
              head.push(`      ${lv} = ts_str(params->data + off, n); off += n; }`);
              head.push(`    if (!ts_utf8_valid(${lv}.ptr, ${lv}.len)) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: invalid UTF-8 in a string argument");`);
              continue;
            }
            if (!isScalar(f.type) && borshIdentical(f.type, this.model)) {
              // A struct or array whose Borsh bytes are its fixed layout: copied, then checked (bools, enums).
              const lv = `${v}.v.${variant.name}.${f.name}`;
              const size = this.fieldBytes(f.type);
              head.push(`    if (params->data_len < off + ${size}) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: instruction data too short");`);
              head.push(`    ts_memcpy(&${lv}, params->data + off, ${size});`, `    off += ${size};`);
              head.push(...this.validation(lv, f.type, "    "));
              continue;
            }
            if (!isScalar(f.type))
              this.reporter.fail(
                a.node,
                `${e.name}.${variant.name}.${f.name}: enum arguments carry integers, booleans, Pubkeys, enums, strings and fixed-size structs and arrays of those`,
              );
            const size = scalarSize(f.type as ScalarType);
            head.push(`    if (params->data_len < off + ${size}) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: instruction data too short");`);
            head.push(`    ts_memcpy(&${v}.v.${variant.name}.${f.name}, params->data + off, ${size});`, `    off += ${size};`);
            if (f.type.kind === "bool")
              head.push(`    if (${v}.v.${variant.name}.${f.name} > 1) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: invalid bool argument");`);
            if (f.type.kind === "enum")
              head.push(
                `    if (${v}.v.${variant.name}.${f.name} >= ${this.model.enums.get(f.type.name)!.variants.length}) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: invalid enum argument");`,
              );
          }
          head.push(`    break; }`);
        });
        head.push(`  default: TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: invalid enum argument");`, `  }`);
        head.push(`  TSE_${e.name} *arg_${a.name} = &${v};`);
      } else if (a.type.kind !== "int") {
        this.reporter.fail(a.node, `unsupported argument type ${typeName(a.type)}`);
      } else {
        const info = INT_INFO[a.type.name];
        need(String(info.bytes));
        if (info.bytes === 16) head.push(`  ${info.c} arg_${a.name};`, `  ts_memcpy(&arg_${a.name}, ${at}, 16);`, `  off += 16;`);
        else head.push(`  ${info.c} arg_${a.name} = (${info.c})ts_read_le(${at}, ${info.bytes});`, `  off += ${info.bytes};`);
      }
    }
    if (ix.args.length) head.push(`  (void)off;`);
    head.push(...this.constraintChecks(ix));

    this.scopes = [new Map()];
    // Two back-to-back markers measure what one marker costs, so the profiler can subtract it.
    if (this.profile) for (let i = 0; i < 2; i++) (this.line(`sol_log("ts:~");`), this.line(`sol_log_compute_units();`));
    for (const stmt of ix.node.body!.statements) this.reporter.guard(() => this.statement(stmt, true));
    for (const name of this.pendingInit) {
      const k = this.accounts.get(name)!.kind;
      const a = this.accounts.get(name)!;
      const how =
        k.kind === "token" && a.constraints.ata
          ? `${name}.${k.init === "create" ? "create" : "createIfNeeded"}(payer)`
          : k.kind === "token"
            ? `${name}.${k.init === "create" ? "create" : "createIfNeeded"}(payer, seeds | null, mint, authority)`
            : k.kind === "mint"
              ? `${name}.${k.init === "create" ? "create" : "createIfNeeded"}(payer, seeds | null, decimals, authority, freezeAuthority | null)`
              : `${name}.create(payer, seeds)`;
      this.reporter.error(this.accounts.get(name)!.node, `Init account "${name}" is never created; call ${how}`);
    }

    const end = ix.returns
      ? [`  TS_FAIL(TS_ERR_NO_RETURN, "TypeSOL: ${ix.name} ended without returning a value");`]
      : [...this.epilogue().map((l) => `  ${l}`), `  return SUCCESS;`];
    return [...head, ...this.hoisted, ...this.lines, ...end, `}`].join("\n");
  }

  /** CloseTo<…> accounts are closed when the instruction succeeds, at every return. */
  protected epilogue(): string[] {
    if (!this.ix) return [];
    // @layout borsh accounts go back to their Borsh bytes (unless closed, or never created).
    const packs = this.ix.accounts
      .filter((a) => (a.kind.kind === "account" ? a.kind.mut : a.kind.kind === "init" || a.kind.kind === "initIfNeeded"))
      .filter((a) => (a.kind as { struct: StructDef }).struct.layout === "borsh")
      .map((a) => {
        const v = `a_${a.name}`;
        const S = (a.kind as { struct: StructDef }).struct.name;
        return `if (${a.optional ? `${v} != NULL && ` : ""}${v}->data_len >= 8 && ts_key_eq(&${v}->owner, params->program_id)) TS_TRY(ts_pack_${S}(d_${a.name}, ${v}->data + 8, ${v}->data_len - 8, NULL));`;
      });
    return [
      ...packs,
      ...this.ix.accounts
        .filter((a) => a.constraints.closeTo)
        .map((a) => {
          const line = `TS_TRY(ts_close(a_${a.name}, a_${a.constraints.closeTo}));`;
          const optional = this.optionalIn(line);
          return optional.length ? `if (${optional.map((n) => `a_${n} != NULL`).join(" && ")}) ${line}` : line;
        }),
    ];
  }

  protected constraintChecks(ix: Instruction): string[] {
    const out: string[] = [];
    // Bumps found by Seeds<…> checks, declared ahead of the (possibly optional-guarded) checks for `acct.pdaBump`.
    const bumpDecls: string[] = [];
    for (const a of ix.accounts) {
      const start = out.length;
      const c = a.constraints;
      const k = a.kind.kind;
      if (c.hasOne.length && k !== "account" && k !== "token" && k !== "mint")
        this.reporter.fail(a.node, "HasOne applies to existing accounts (Account<T> / Mut<T>), TokenAccount and Mint");
      for (const entry of c.hasOne) {
        // "field=param" (TokenOf / MintOf) or a field checked against the parameter of the same name (HasOne).
        const [f, p = f] = entry.split("=") as [string, string?];
        if (k === "token")
          out.push(
            f === "mint"
              ? `  if (!ts_key_eq(ts_token_mint(a_${a.name}), &a_${p}->key)) TS_FAIL(TS_ERR_TOKEN_MINT, "TypeSOL: ${a.name} is not a token account of ${p}");`
              : `  if (!ts_key_eq(ts_token_owner(a_${a.name}), &a_${p}->key)) TS_FAIL(TS_ERR_TOKEN_OWNER, "TypeSOL: ${a.name} is not owned by ${p}");`,
          );
        else if (k === "mint") {
          const at = f === "mintAuthority" ? 0 : 46;
          const code = f === "mintAuthority" ? "TS_ERR_MINT_AUTHORITY" : "TS_ERR_FREEZE_AUTHORITY";
          out.push(
            `  if (ts_read_le(a_${a.name}->data + ${at}, 4) != 1 || !ts_key_eq((const SolPubkey *)(a_${a.name}->data + ${at + 4}), &a_${p}->key)) TS_FAIL(${code}, "TypeSOL: ${p} is not the ${f} of ${a.name}");`,
          );
        } else out.push(`  if (!ts_key_eq(&d_${a.name}->${f}, &a_${f}->key)) TS_FAIL(TS_ERR_CONSTRAINT, "TypeSOL: ${a.name}.${f} must be the ${f} account");`);
      }
      if (c.owner) {
        out.push(`  static const SolPubkey co_${a.name} = {${cBytes(c.owner.bytes)}};`);
        out.push(
          `  if (!ts_key_eq(&a_${a.name}->owner, &co_${a.name})) TS_FAIL(TS_ERR_CONSTRAINT_OWNER, "TypeSOL: ${a.name} is not owned by the expected program");`,
        );
      }
      if (c.executable) out.push(`  if (!a_${a.name}->executable) TS_FAIL(TS_ERR_CONSTRAINT_EXECUTABLE, "TypeSOL: ${a.name} must be an executable program");`);
      if (c.address) {
        out.push(`  static const SolPubkey ca_${a.name} = {${cBytes(c.address.bytes)}};`);
        out.push(`  if (!ts_key_eq(&a_${a.name}->key, &ca_${a.name})) TS_FAIL(TS_ERR_ADDRESS, "TypeSOL: ${a.name} is not the expected address");`);
      }
      if (c.ata && a.kind.kind === "token" && a.kind.init) {
        // Created in the body: the ATA program checks the address when it creates it, and createIfNeeded checks an
        // existing one there. Only the IDL entry is recorded here.
        const tp = ix.accounts.find((o) => o.kind.kind === "tokenProgram");
        if (tp && !ix.pdas.has(a.name)) {
          ix.pdas.set(a.name, [
            { kind: "account", path: snakeCase(c.ata.owner) },
            { kind: "account", path: snakeCase(tp.name) },
            { kind: "account", path: snakeCase(c.ata.mint) },
          ]);
          ix.pdaPrograms.set(a.name, { kind: "const", value: ATA_PROGRAM_BYTES });
        }
      } else if (c.ata) {
        // The token program is the account's owner; an AccountInfo not created yet takes the instruction's token program.
        let program = `&a_${a.name}->owner`;
        if (k !== "token") {
          const tp = ix.accounts.find((o) => o.kind.kind === "tokenProgram");
          if (!tp) this.reporter.fail(a.node, "Ata<AccountInfo, …> needs a token program parameter to derive the address");
          program = `&a_${tp.name}->key`;
        }
        out.push(`  { SolPubkey ata_${a.name};`);
        out.push(`    TS_TRY(ts_ata_address(&a_${c.ata.owner}->key, &a_${c.ata.mint}->key, ${program}, &ata_${a.name}));`);
        out.push(
          `    if (!ts_key_eq(&ata_${a.name}, &a_${a.name}->key)) TS_FAIL(TS_ERR_ASSOCIATED, "TypeSOL: ${a.name} is not the associated token account of ${c.ata.owner} and ${c.ata.mint}"); }`,
        );
        // The address alone is not enough: legacy SPL Token lets an ATA's owner be reassigned.
        if (k === "token") {
          out.push(
            `  if (!ts_key_eq(ts_token_mint(a_${a.name}), &a_${c.ata.mint}->key)) TS_FAIL(TS_ERR_TOKEN_MINT, "TypeSOL: ${a.name} is not a token account of ${c.ata.mint}");`,
          );
          out.push(
            `  if (!ts_key_eq(ts_token_owner(a_${a.name}), &a_${c.ata.owner}->key)) TS_FAIL(TS_ERR_TOKEN_OWNER, "TypeSOL: ${a.name} is not owned by ${c.ata.owner}");`,
          );
        }
        const tp = ix.accounts.find((o) => o.kind.kind === "tokenProgram");
        if (tp && !ix.pdas.has(a.name)) {
          ix.pdas.set(a.name, [
            { kind: "account", path: snakeCase(c.ata.owner) },
            { kind: "account", path: snakeCase(tp.name) },
            { kind: "account", path: snakeCase(c.ata.mint) },
          ]);
          ix.pdaPrograms.set(a.name, { kind: "const", value: ATA_PROGRAM_BYTES });
        }
      }
      if (c.closeTo) {
        const dest = ix.accounts.find((o) => o.name === c.closeTo)!;
        if (!isWritable(dest.kind)) this.reporter.fail(a.node, `CloseTo<…, "${c.closeTo}">: ${c.closeTo} must be writable (Mut<…>)`);
      }
      if (c.seeds) {
        const parts: string[] = [];
        const idl: IdlSeed[] = [];
        for (const raw of c.seeds.names) {
          // "@name" refers to an account parameter (its key) or an argument (its bytes); anything else is a literal.
          const ref = raw.startsWith("@") ? raw.slice(1) : undefined;
          const n = ref ?? raw;
          // "@acct.field": a field of a struct account parameter (its data was checked in the head), Anchor's
          // `seeds = [pool.amm.as_ref()]`. The account may be this one (`seeds = [offer.id.to_le_bytes()]`).
          if (ref?.includes(".")) {
            const [owner, field, ...rest] = ref.split(".");
            const o = ix.accounts.find((x) => x.name === owner);
            if (!o || o.kind.kind !== "account" || rest.length)
              this.reporter.fail(a.node, `Seeds: "@${ref}" must name a field of a struct account parameter ("@vault.owner")`);
            const st = o.kind.struct;
            const f = st.fields.find((x) => x.name === field);
            if (!f) this.reporter.fail(a.node, `Seeds: ${st.name} has no field "${field}"`);
            const t = f.type;
            if (t.kind === "pubkey") parts.push(`{(const uint8_t *)&d_${owner}->${field}, 32}`);
            else if (t.kind === "int" || t.kind === "enum") parts.push(`{(const uint8_t *)&d_${owner}->${field}, ${scalarSize(t)}}`);
            else this.reporter.fail(a.node, `Seeds: field "${ref}" of type ${typeName(t)} cannot be a seed (use a Pubkey, an integer or a unit enum)`);
            idl.push({ kind: "account", path: `${snakeCase(owner!)}.${snakeCase(field!)}`, account: st.name });
            continue;
          }
          const acct = ref ? ix.accounts.find((o) => o.name === ref) : undefined;
          const arg = ref ? ix.args.find((o) => o.name === ref) : undefined;
          if (ref && !acct && !arg) this.reporter.fail(a.node, `Seeds: "@${ref}" is neither an account parameter nor an argument`);
          if (acct) {
            parts.push(`{(const uint8_t *)&a_${n}->key, 32}`);
            idl.push({ kind: "account", path: snakeCase(n) });
          } else if (arg) {
            const t = arg.type;
            if (t.kind === "string") parts.push(`{arg_${n}.ptr, arg_${n}.len}`);
            else if (t.kind === "pubkey") parts.push(`{(const uint8_t *)&arg_${n}, 32}`);
            else if (t.kind === "int" || t.kind === "enum") parts.push(`{(const uint8_t *)&arg_${n}, ${scalarSize(t)}}`);
            else this.reporter.fail(a.node, `Seeds: argument "${n}" of type ${typeName(t)} cannot be a seed`);
            idl.push({ kind: "arg", path: snakeCase(n) });
          } else {
            if (Buffer.byteLength(n, "utf8") > 32) this.reporter.fail(a.node, "a seed can be at most 32 bytes");
            parts.push(`{(const uint8_t *)${cString(n)}, ${Buffer.byteLength(n, "utf8")}}`);
            idl.push({ kind: "const", value: [...Buffer.from(n, "utf8")] });
          }
        }
        if (!ix.pdas.has(a.name)) ix.pdas.set(a.name, idl);
        // The deriving program: this one, another account parameter ("@name"), or a fixed address.
        let program = "params->program_id";
        const p = c.seeds.program;
        if (p?.startsWith("@")) {
          const pa = ix.accounts.find((o) => o.name === p.slice(1));
          if (!pa) this.reporter.fail(a.node, `Seeds program: "${p}" is not an account parameter`);
          program = `&a_${pa.name}->key`;
          ix.pdaPrograms.set(a.name, { kind: "account", path: snakeCase(pa.name) });
        } else if (p) {
          const bytes = [...decodeAddress(p)!];
          out.push(`  static const SolPubkey sp_${a.name} = {${cBytes(bytes)}};`);
          program = `&sp_${a.name}`;
          ix.pdaPrograms.set(a.name, { kind: "const", value: bytes });
        }
        const seeds = `cs_${a.name}`;
        out.push(`  SolSignerSeed ${seeds}[${parts.length + 1}] = {${parts.join(", ")}};`);
        if (c.seeds.bump) {
          out.push(`  ${seeds}[${parts.length}] = (SolSignerSeed){&d_${a.name}->${c.seeds.bump}, 1};`);
          out.push(`  TS_TRY(ts_require_pda(a_${a.name}, ${seeds}, ${parts.length + 1}, ${program}));`);
          this.bumps.set(a.name, `d_${a.name}->${c.seeds.bump}`);
        } else {
          bumpDecls.push(`  uint8_t sb_${a.name}; (void)sb_${a.name};`);
          out.push(`  { SolPubkey pda_${a.name};`);
          out.push(
            `    if (ts_find_pda(${seeds}, ${parts.length}, ${program}, &pda_${a.name}, &sb_${a.name}) != SUCCESS || !ts_key_eq(&pda_${a.name}, &a_${a.name}->key)) TS_FAIL(TS_ERR_SEEDS, "TypeSOL: ${a.name} is not the expected PDA"); }`,
          );
          this.bumps.set(a.name, `sb_${a.name}`);
        }
      }
      // Constraints run only when every optional account they mention was passed.
      const lines = out.splice(start);
      const optional = this.optionalIn(lines.join("\n"));
      if (optional.length && lines.length) out.push(`  if (${optional.map((n) => `a_${n} != NULL`).join(" && ")}) {`, ...lines.map((l) => `  ${l}`), `  }`);
      else out.push(...lines);
    }
    return [...bumpDecls, ...out];
  }

  /** Optional account parameters a piece of generated C refers to (a_name / d_name). */
  protected optionalIn(code: string): string[] {
    return (this.ix?.accounts ?? []).filter((a) => a.optional && new RegExp(`\\b[ad]_${a.name}\\b`).test(code)).map((a) => a.name);
  }
}
