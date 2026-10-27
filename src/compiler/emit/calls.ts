import ts from "typescript";
import { resolveScalarType } from "../analyze.js";
import { decodeAddress } from "../../keys.js";
import {
  INT_INFO,
  INT_NAMES,
  type ErrorDef,
  type FieldType,
  type Helper,
  type IntName,
  isScalar,
  isWritable,
  sameType,
  scalarSize,
  typeName,
} from "../model.js";
import {
  U64,
  U8,
  I64,
  BOOL,
  PUBKEY,
  STRING,
  HASH,
  type Value,
  type Ref,
  cBytes,
  cString,
  scalarC,
  scalarStorageC,
  optC,
  valueC,
  fieldC,
  storageDecl,
  accountMismatch,
} from "./shared.js";
import { ExpressionEmitter } from "./expressions.js";

/**
 * Calls: built-in functions, Vec methods, helpers, remaining accounts, foreign account reads and return data.
 */
export abstract class CallEmitter extends ExpressionEmitter {
  protected call(node: ts.CallExpression, topLevel: boolean): Value | undefined {
    const callee = node.expression;
    const args = node.arguments;
    const builtin = this.exportName(callee);

    if (builtin && (INT_NAMES as readonly string[]).includes(builtin)) {
      if (args.length !== 1) this.fail(node, `${builtin}() takes one argument`);
      return this.cast(args[0], { kind: "int", name: builtin as IntName });
    }
    switch (builtin) {
      case "require": {
        if (args.length !== 2) this.fail(node, "require(condition, error) takes two arguments");
        const cond = this.expect(this.expr(args[0], BOOL), BOOL, args[0]);
        const err = this.errorRef(args[1]);
        this.line(`if (!${cond.c}) TS_FAIL(${err.code}, ${cString(`Error ${err.code} ${err.name}: ${err.msg} (${this.location(node)})`)});`);
        return undefined;
      }
      case "log": {
        if (args.length !== 1) this.fail(node, "log() takes one argument");
        const v = this.expr(args[0]);
        if (v.stringLiteral !== undefined) this.line(`sol_log(${cString(v.stringLiteral)});`);
        else if (v.type.kind === "string") {
          const t = this.tmp("s");
          this.line(`TS_Str ${t} = ${v.c};`);
          this.line(`sol_log_((const char *)${t}.ptr, ${t}.len);`);
        } else {
          const value = v.literal !== undefined ? this.expect(v, U64, args[0]) : v;
          if (value.type.kind === "pubkey") this.line(`sol_log_pubkey(${value.c});`);
          else if (value.type.kind === "int") {
            // Decimal, like console.log (sol_log_64 would print five hex words).
            const t = this.tmp("s");
            this.line(`TS_Str ${t};`);
            this.line(this.textOfInt(value.type.name, value.c, t));
            this.line(`sol_log_((const char *)${t}.ptr, ${t}.len);`);
          } else if (value.type.kind === "bool") this.line(`sol_log((${value.c}) ? "true" : "false");`);
          else this.line(`sol_log_64(0, 0, 0, 0, (uint64_t)(${value.c}));`);
        }
        return undefined;
      }
      case "byteLength": {
        if (args.length !== 1) this.fail(node, "byteLength(s) takes one argument");
        const v = this.expect(this.expr(args[0]), STRING, args[0]);
        return { c: `(${v.c}).len`, type: U64 };
      }
      case "requirePda": {
        if (args.length !== 3) this.fail(node, "requirePda(account, seeds, bump) takes three arguments");
        const a = this.accountParam(args[0], "requirePda's first argument");
        // Seeds before the bump, as JS evaluates them (seed values are copied as they are lowered).
        const seeds = this.seeds(args[1], 1);
        const bump = this.expect(this.expr(args[2], U8), U8, args[2]);
        this.recordPda(a, seeds.idl);
        const b = this.tmp("bump");
        this.line(`uint8_t ${b} = ${bump.c};`);
        this.line(`${seeds.name}[${seeds.count}] = (SolSignerSeed){&${b}, 1};`);
        this.line(`TS_TRY(ts_require_pda(a_${a.name}, ${seeds.name}, ${seeds.count + 1}, params->program_id));`);
        return undefined;
      }
      case "close": {
        if (args.length !== 2) this.fail(node, "close(account, destination) takes two arguments");
        const a = this.accountParam(args[0], "close's account");
        if (a.kind.kind !== "account" || !a.kind.mut) this.fail(args[0], "close() needs a Mut<Struct> account owned by this program");
        const d = this.accountParam(args[1], "close's destination");
        if (!isWritable(d.kind)) this.fail(args[1], "the destination must be writable (Mut<...>)");
        this.line(`TS_TRY(ts_close(a_${a.name}, a_${d.name}));`);
        return undefined;
      }
      case "minimumBalance": {
        if (args.length !== 1) this.fail(node, "minimumBalance(account) takes one argument");
        const a = this.accountParam(args[0], "minimumBalance's argument");
        const t = this.tmp();
        this.line(`uint64_t ${t};`);
        this.line(`TS_TRY(ts_minimum_balance(a_${a.name}->data_len, &${t}));`);
        return { c: t, type: U64 };
      }
      case "currentSlot":
      case "currentEpoch": {
        if (args.length !== 0) this.fail(node, `${builtin}() takes no arguments`);
        const t = this.tmp();
        this.line(`uint64_t ${t};`);
        this.line(`TS_TRY(ts_clock_u64(${builtin === "currentSlot" ? 0 : 2}, &${t}));`);
        return { c: t, type: U64 };
      }
      case "now": {
        if (args.length !== 0) this.fail(node, "now() takes no arguments");
        const t = this.tmp();
        this.line(`int64_t ${t};`);
        this.line(`TS_TRY(ts_now(&${t}));`);
        return { c: t, type: I64 };
      }
      case "pubkey": {
        const lit = args[0];
        if (args.length !== 1 || !ts.isStringLiteral(lit)) this.fail(node, 'pubkey("…") takes one base58 string literal');
        const bytes = decodeAddress(lit.text);
        if (!bytes) this.fail(lit, `"${lit.text}" is not a valid base58 Solana address`);
        const t = this.tmp("pk");
        this.line(`static const SolPubkey ${t} = {${cBytes([...bytes])}};`);
        return { c: `(&${t})`, type: PUBKEY };
      }
      case "mulDiv":
      case "mulDivCeil": {
        // a * b / c with a 128-bit intermediate (u64), rounding down or up; aborts if the result does not fit.
        if (args.length !== 3) this.fail(node, `${builtin}(a, b, c) takes three u64 values`);
        const [x, y, z] = this.lowerInOrder(args, [U64, U64, U64]);
        const t = this.tmp("md");
        this.line(`uint64_t ${t};`);
        this.line(`TS_TRY(ts_mul_div(${x.c}, ${y.c}, ${z.c}, ${builtin === "mulDivCeil"}, &${t}));`);
        return { c: t, type: U64 };
      }
      case "isqrt": {
        if (args.length !== 1) this.fail(node, "isqrt(x) takes one unsigned integer");
        const v = this.expr(args[0]);
        const x = v.literal !== undefined ? this.literal(v.literal, U64, args[0]) : v;
        if (x.type.kind !== "int" || INT_INFO[x.type.name].signed) this.fail(args[0], "isqrt needs an unsigned integer (u8 … u128)");
        const wide = INT_INFO[x.type.name].bytes === 16;
        return { c: wide ? `ts_isqrt_u128(${x.c})` : `((${INT_INFO[x.type.name].c})ts_isqrt_u64((uint64_t)(${x.c})))`, type: x.type };
      }
      case "min":
      case "max": {
        if (args.length !== 2) this.fail(node, `${builtin}(a, b) takes two integers of the same type`);
        let a = this.expr(args[0]);
        const mark = this.lines.length;
        let b = this.expr(args[1], a.type.kind === "int" && a.literal === undefined ? a.type : undefined);
        a = this.settle(a, mark);
        if (a.literal !== undefined && b.literal !== undefined) {
          a = this.literal(a.literal, U64, args[0]);
          b = this.literal(b.literal, U64, args[1]);
        } else if (a.literal !== undefined) a = this.expect(a, b.type, args[0]);
        else b = this.expect(b, a.type, args[1]);
        if (a.type.kind !== "int" || !sameType(a.type, b.type)) this.fail(node, `${builtin}(a, b) takes two integers of the same type`);
        const t = this.tmp("mm");
        this.line(`${INT_INFO[a.type.name].c} ${t} = (${a.c} ${builtin === "min" ? "<" : ">"} ${b.c}) ? ${a.c} : ${b.c};`);
        return { c: t, type: a.type };
      }
      case "realloc": {
        // Resize a struct account of this program: growth is paid by `payer`; shrinking keeps the lamports in the account.
        if (args.length !== 3) this.fail(node, "realloc(account, newSize, payer) takes three arguments");
        if (!this.ix) this.fail(node, "realloc() is only available in instructions");
        const acct = this.accountParam(args[0], "realloc's account");
        const k = acct.kind;
        const struct = k.kind === "account" || k.kind === "init" || k.kind === "initIfNeeded" || k.kind === "zeroed" ? k.struct : undefined;
        // Only struct accounts: their owner and type are checked, and they never shrink below the struct.
        if (!isWritable(acct.kind) || !struct) this.fail(args[0], "realloc needs a Mut<Struct> account of this program");
        if (struct?.vec) this.fail(args[0], `${struct.name} ends in a Vec, which sizes the account itself (push/pop/clear)`);
        const size = this.expect(this.expr(args[1], U64), U64, args[1]);
        const payer = this.accountParam(args[2], "the payer");
        if (payer.kind.kind !== "signer" || !payer.kind.mut) this.fail(args[2], "the payer must be a Mut<Signer>");
        const min = struct ? `8 + sizeof(TSS_${struct.name})` : "0";
        this.line(`TS_TRY(ts_realloc(params, a_${payer.name}, a_${acct.name}, ${size.c}, entry_${acct.name}, ${min}));`);
        return undefined;
      }
      case "coreAssetOwner":
      case "coreAssetCollection": {
        // Read a Metaplex Core asset: its owner, or the collection it belongs to.
        if (args.length !== 1) this.fail(node, `${builtin}(asset) takes a Metaplex Core asset account`);
        const acct = this.anyAccount(args[0], "the asset");
        this.line(`TS_TRY(ts_core_asset(${acct}));`);
        const t = this.tmp("core");
        if (builtin === "coreAssetOwner") {
          this.line(`SolPubkey ${t};`);
          this.line(`ts_memcpy(&${t}, ${acct}->data + 1, 32);`);
          return { c: `(&${t})`, type: PUBKEY };
        }
        this.model.options.set("pubkey", PUBKEY);
        this.line(`${optC(PUBKEY)} ${t};`);
        this.line(`${t}.some = ${acct}->data[33] == 2 && ${acct}->data_len >= 66;`);
        this.line(`if (${t}.some) ts_memcpy(&${t}.v, ${acct}->data + 34, 32); else ts_memzero(&${t}.v, 32);`);
        return { c: t, type: { kind: "option", inner: PUBKEY } };
      }
      case "transferFee": {
        if (args.length !== 2) this.fail(node, "transferFee(mint, amount) takes the mint and the amount sent");
        const m = this.anyAccount(args[0], "the mint");
        this.line(`TS_TRY(ts_t22_layout(${m}, 1));`);
        const amt = this.expect(this.expr(args[1], U64), U64, args[1]);
        const t = this.tmp("fee");
        this.line(`uint64_t ${t};`);
        this.line(`TS_TRY(ts_t22_transfer_fee(${m}, ${amt.c}, &${t}));`);
        return { c: t, type: U64 };
      }
      case "transferHookProgram":
      case "permanentDelegate":
      case "mintCloseAuthority": {
        // Token-2022 mint extensions holding an optional Pubkey: TransferHook (14, program at +32),
        // PermanentDelegate (12), MintCloseAuthority (3).
        if (args.length !== 1) this.fail(node, `${builtin}(mint) takes the mint`);
        const m = this.anyAccount(args[0], "the mint");
        this.line(`TS_TRY(ts_t22_layout(${m}, 1));`);
        const [type, field] = builtin === "transferHookProgram" ? [14, 32] : builtin === "permanentDelegate" ? [12, 0] : [3, 0];
        this.model.options.set("pubkey", PUBKEY);
        const t = this.tmp("ext");
        this.line(`${optC(PUBKEY)} ${t};`);
        this.line(`${t}.some = ts_t22_key(${m}, ${type}, ${field}, &${t}.v);`);
        this.line(`if (!${t}.some) ts_memzero(&${t}.v, 32);`);
        return { c: t, type: { kind: "option", inner: PUBKEY } };
      }
      case "hasExtension": {
        if (args.length !== 2) this.fail(node, "hasExtension(account, extensionType) takes a Token-2022 mint or account and a u16 type");
        const m = this.anyAccount(args[0], "the account");
        this.line(`TS_TRY(ts_t22_layout(${m}, 0));`);
        const type = this.expect(this.expr(args[1], { kind: "int", name: "u16" }), { kind: "int", name: "u16" }, args[1]);
        const off = this.tmp("eo");
        this.line(`uint64_t ${off}, ${off}l;`);
        return { c: `ts_t22_ext(${m}, ${type.c}, &${off}, &${off}l)`, type: BOOL };
      }
      case "rentExempt": {
        if (args.length !== 1) this.fail(node, "rentExempt(space) takes the account size in bytes");
        const space = this.expect(this.expr(args[0], U64), U64, args[0]);
        const t = this.tmp();
        this.line(`uint64_t ${t};`);
        this.line(`TS_TRY(ts_minimum_balance(${space.c}, &${t}));`);
        return { c: t, type: U64 };
      }
      case "invoke":
        return this.invoke(node);
      case "sha256":
      case "keccak256":
        return this.hashCall(node, builtin);
      case "merkleVerify": {
        if (args.length !== 3) this.fail(node, "merkleVerify(leaf, proof, root) takes three arguments");
        let leaf = this.expect(this.expr(args[0], HASH), HASH, args[0]);
        const proof = ts.isIdentifier(args[1]) ? this.lookup(args[1].text) : undefined;
        if (proof?.type.kind !== "vecArg" || !sameType(proof.type.elem, HASH)) this.fail(args[1], "the proof must be a Vec<Hash> instruction argument");
        const mark = this.lines.length;
        const root = this.expect(this.expr(args[2], HASH), HASH, args[2]);
        leaf = this.settle(leaf, mark);
        return { c: `ts_merkle_verify(${leaf.c}, ${proof.c}.ptr, ${proof.c}.len, ${root.c})`, type: BOOL };
      }
      case "verifyEd25519": {
        if (args.length !== 3) this.fail(node, "verifyEd25519(instructionsSysvar, signer, message) takes three arguments");
        const ixs = this.accountParam(args[0], "the instructions sysvar");
        if (ixs.kind.kind !== "instructionsSysvar") this.fail(args[0], "pass an InstructionsSysvar parameter");
        let signer = this.expect(this.expr(args[1], PUBKEY), PUBKEY, args[1]);
        const mark = this.lines.length;
        const msg = this.expr(args[2]);
        signer = this.settle(signer, mark);
        const m =
          msg.type.kind === "string"
            ? msg.c
            : msg.type.kind === "pubkey"
              ? `ts_str((const uint8_t *)(${msg.c}), 32)`
              : this.fail(args[2], "the message must be a string, Hash or Pubkey");
        return { c: `ts_ed25519_verified(a_${ixs.name}, ${signer.c}, ${m})`, type: BOOL };
      }
      case "ethMessageHash": {
        // EIP-191 personal_sign: keccak256("\x19Ethereum Signed Message:\n" + byte length + message).
        if (args.length !== 1) this.fail(node, "ethMessageHash(message) takes the signed text");
        const m = this.expect(this.expr(args[0], STRING), STRING, args[0]);
        const msg = this.tmp("em");
        const len = this.tmp("eml");
        const parts = this.tmp("emp");
        const out = this.tmp("h");
        this.line(`TS_Str ${msg} = ${m.c};`);
        this.line(`TS_Str ${len};`);
        this.line(`TS_TRY(ts_str_u64(${msg}.len, false, &${len}));`);
        this.line(
          `SolBytes ${parts}[3] = {{(uint8_t *)${cString("\x19Ethereum Signed Message:\n")}, 26}, {(uint8_t *)${len}.ptr, ${len}.len}, {(uint8_t *)${msg}.ptr, ${msg}.len}};`,
        );
        this.line(`SolPubkey ${out};`);
        this.line(`sol_keccak256(${parts}, 3, (uint8_t *)&${out});`);
        return { c: `(&${out})`, type: HASH };
      }
      case "verifySecp256k1": {
        if (args.length !== 5) this.fail(node, "verifySecp256k1(hash, recoveryId, r, s, ethAddress) takes five arguments");
        // For any public key a signature can be made up for *some* hash, so a hash taken from instruction data
        // proves nothing: the program must compute it from the message itself.
        const hashFn = ts.isCallExpression(args[0]) ? this.exportName(args[0].expression) : undefined;
        if (hashFn !== "keccak256" && hashFn !== "ethMessageHash")
          this.fail(
            args[0],
            "compute the signed hash here: verifySecp256k1(keccak256(...message), …) or verifySecp256k1(ethMessageHash(message), …); a hash passed in can be forged",
          );
        const [h, id, r, sv, eth] = this.lowerInOrder(args, [HASH, U8, HASH, HASH, HASH]);
        return { c: `ts_secp256k1_verify(${h.c}, (uint64_t)${id.c}, ${r.c}, ${sv.c}, ${eth.c})`, type: BOOL };
      }
      case "pythPrice": {
        if (args.length !== 3) this.fail(node, "pythPrice(update, feedId, maxAgeSeconds) takes three arguments");
        const u = this.accountParam(args[0], "the price update");
        if (u.kind.kind !== "pyth") this.fail(args[0], "pass a PythPriceUpdate parameter");
        const [feed, age] = this.lowerInOrder(args.slice(1), [HASH, U64]);
        const t = this.tmp("px");
        this.line(`int64_t ${t};`);
        this.line(`TS_TRY(ts_pyth_price(a_${u.name}, ${feed.c}, ${age.c}, &${t}));`);
        return { c: t, type: I64 };
      }
      case "switchboardValue": {
        // Anyone can create a Switchboard feed: like pythPrice's feed id, the expected feed address is required.
        if (args.length !== 4) this.fail(node, "switchboardValue(feed, expectedFeed, maxStaleSlots, decimals) takes four arguments");
        const f = this.accountParam(args[0], "the feed");
        if (f.kind.kind !== "switchboard") this.fail(args[0], "pass a SwitchboardFeed parameter");
        const [expected, stale, dec] = this.lowerInOrder(args.slice(1), [PUBKEY, U64, U8]);
        const t = this.tmp("sb");
        this.line(`int64_t ${t};`);
        this.line(`if (!ts_key_eq(&a_${f.name}->key, ${expected.c})) TS_FAIL(TS_ERR_ORACLE, "TypeSOL: not the expected Switchboard feed");`);
        this.line(`TS_TRY(ts_switchboard_value(a_${f.name}, ${stale.c}, ${dec.c}, &${t}));`);
        return { c: t, type: I64 };
      }
      case "associatedTokenAddress": {
        if (args.length !== 3) this.fail(node, "associatedTokenAddress(owner, mint, tokenProgram) takes three Pubkeys");
        const [o, m, tp] = this.lowerInOrder(args, [PUBKEY, PUBKEY, PUBKEY]);
        const t = this.tmp("ata");
        this.line(`SolPubkey ${t};`);
        this.line(`TS_TRY(ts_ata_address(${o.c}, ${m.c}, ${tp.c}, &${t}));`);
        return { c: `(&${t})`, type: PUBKEY };
      }
      case "findProgramAddress": {
        // Pubkey::find_program_address(seeds, program).0: the canonical PDA of any program.
        if (args.length !== 2) this.fail(node, "findProgramAddress(seeds, program) takes the seeds and the program's address");
        const seeds = this.seeds(args[0]!, 0);
        const program = this.expect(this.expr(args[1], PUBKEY), PUBKEY, args[1]);
        const t = this.tmp("pda");
        const b = this.tmp("bump");
        this.line(`SolPubkey ${t}; uint8_t ${b};`);
        this.line(
          `if (ts_find_pda(${seeds.name}, ${seeds.count}, ${program.c}, &${t}, &${b}) != SUCCESS) TS_FAIL(TS_ERR_SEEDS, "TypeSOL: no program address for these seeds");`,
        );
        return { c: `(&${t})`, type: PUBKEY };
      }
      case "metadataAddress":
      case "masterEditionAddress": {
        if (args.length !== 1) this.fail(node, `${builtin}(mint) takes the mint`);
        const m = this.expect(this.expr(args[0], PUBKEY), PUBKEY, args[0]);
        const t = this.tmp("md");
        this.line(`SolPubkey ${t};`);
        this.line(`TS_TRY(${builtin === "metadataAddress" ? "ts_metadata_address" : "ts_master_edition_address"}(${m.c}, &${t}));`);
        return { c: `(&${t})`, type: PUBKEY };
      }
      case "initExtraAccountMetas":
      case "updateExtraAccountMetas": {
        if (args.length !== 4 && args.length !== 5) this.fail(node, `${builtin}(payer, account, mint, systemProgram, extraAccounts?)`);
        const payer = this.accountParam(args[0], "the payer");
        if (payer.kind.kind !== "signer" || !payer.kind.mut) this.fail(args[0], "the payer must be a Mut<Signer>");
        const acct = this.accountParam(args[1], "the extra-account-metas account");
        if (!isWritable(acct.kind)) this.fail(args[1], "the extra-account-metas account must be Mut<AccountInfo>");
        const mint = this.accountParam(args[2], "the mint");
        const sys = this.accountParam(args[3], "the system program");
        if (sys.kind.kind !== "system") this.fail(args[3], "pass the SystemProgram parameter");
        const { name: entries, count } = args[4] ? this.extraAccountMetas(args[4]) : { name: "NULL", count: 0 };
        const fn = builtin === "initExtraAccountMetas" ? "ts_init_extra_metas" : "ts_update_extra_metas";
        this.line(`TS_TRY(${fn}(params, a_${payer.name}, a_${acct.name}, &a_${mint.name}->key, ${entries}, ${count}));`);
        return undefined;
      }
      case "remainingAccounts":
        if (!this.ix) this.fail(node, "remainingAccounts() is only available in instructions");
        return { c: "", type: { kind: "remaining" } };
      case "readData":
        return this.readData(node);
      case "loadAccount":
      case "loadAccountMut":
      case "loadForeign":
        this.fail(node, `bind ${builtin}<T>(...) to a const first: const p = ${builtin}<T>(account)`);
      case "emit":
        return this.emitEvent(node);
      case "emitCpi": {
        // Anchor emit_cpi!: the event goes into a self-CPI's instruction data (not truncated like logs).
        if (!this.ix) this.fail(node, "emitCpi() is only available in instructions");
        if (args.length !== 3) this.fail(node, "emitCpi<T>({ ... }, eventAuthority, self) takes the event, the EventAuthority and the SelfProgram parameters");
        const auth = this.accountParam(args[1], "the event authority");
        if (auth.kind.kind !== "eventAuthority") this.fail(args[1], "pass the EventAuthority parameter");
        const self = this.accountParam(args[2], "this program");
        if (self.kind.kind !== "selfProgram") this.fail(args[2], "pass the SelfProgram parameter");
        return this.emitEvent(node, { authority: auth.name, program: self.name });
      }
      case "returnData":
        return this.returnData(node);
      case "fixedArray":
        this.fail(node, "fixedArray<T, N>(fill) is only allowed as a local declaration: const xs = fixedArray<u64, 4>(0n)");
      case "readonly":
      case "writable":
      case "readonlySigner":
      case "writableSigner":
        this.fail(node, `${builtin}() is only valid inside the accounts list of invoke()`);
      case "sighash":
      case "hex":
        this.fail(node, `${builtin}() is only valid inside the data list of invoke()`);
    }
    if (builtin) this.fail(callee, `${builtin} cannot be called here`);

    if (ts.isIdentifier(callee) && this.model.helpers.has(callee.text)) return this.callHelper(node, this.model.helpers.get(callee.text)!);

    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      // Vec<T> instruction arguments are read-only views.
      if (ts.isIdentifier(callee.expression)) {
        const l = this.lookup(callee.expression.text);
        if (l?.type.kind === "vecArg") {
          if (method !== "get" || args.length !== 1) this.fail(node, "Vec arguments are read-only: use .get(i) and .length");
          const elem = l.type.elem;
          if (!isScalar(elem)) this.fail(node, `read a field of the element: ${callee.expression.text}.get(i).field`);
          const idx = this.index(args[0], `(uint64_t)${l.c}.len`);
          const t = this.tmp("el");
          this.line(`${scalarStorageC(elem)} ${t};`);
          this.line(`ts_memcpy(&${t}, ${l.c}.ptr + ${idx} * ${scalarSize(elem)}, ${scalarSize(elem)});`);
          if (elem.kind === "pubkey") return { c: `(&${t})`, type: elem };
          if (elem.kind === "bool") {
            this.line(`if (${t} > 1) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: invalid bool in Vec argument");`);
            return { c: `(${t} != 0)`, type: elem };
          }
          if (elem.kind === "enum")
            this.line(
              `if (${t} >= ${this.model.enums.get(elem.name)!.variants.length}) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: invalid enum in Vec argument");`,
            );
          return { c: t, type: elem };
        }
      }
      // Vec<T> fields in account data
      const vecRef = this.ref(callee.expression);
      if (vecRef?.type.kind === "vec") return this.vecMethod(node, method, vecRef);
      // Array methods
      const arr = vecRef ?? this.ref(callee.expression);
      if (arr?.type.kind === "array") {
        if (method === "set") {
          if (args.length !== 2) this.fail(node, "set(index, value) takes two arguments");
          if (!arr.writable) this.fail(node, this.readOnly(arr));
          const idx = this.index(args[0], arr.type.len);
          const el: Ref = { ...arr, lv: `${arr.lv}[${idx}]`, type: arr.type.elem };
          const vt = this.storageValueType(el.type);
          if (!vt) {
            this.assertNotAliased(
              this.pathsOf(callee.expression)?.map((p) => `${p}[]`),
              node,
            );
            this.writeAggregate(el, args[1]);
            return undefined;
          }
          const v = this.expect(this.expr(args[1], vt), vt, args[1]);
          this.line(this.writeStorage(el, v.c) + ";");
          return undefined;
        }
        if (method !== "get") this.fail(node, `arrays support get(i), set(i, v) and .length, not ${method}()`);
      }
      if (method === "equals") {
        if (args.length !== 1) this.fail(node, "equals() takes one argument");
        // Pubkey.equals and Hash.equals (both 32 bytes, but not interchangeable).
        const left = this.expr(callee.expression);
        if (left.type.kind !== "pubkey") this.fail(callee.expression, "equals() compares Pubkeys or Hashes");
        const mark = this.lines.length;
        const right = this.expect(this.expr(args[0], left.type), left.type, args[0]);
        return { c: `ts_key_eq(${this.settle(left, mark).c}, ${right.c})`, type: BOOL };
      }
      if (ts.isIdentifier(callee.expression)) {
        const target = this.accounts.get(callee.expression.text);
        // Program accounts used through their methods (systemProgram.transfer, tokenProgram.*…) may be optional.
        if (target?.optional) this.assertUsable(target, callee.expression);
        if (target?.kind.kind === "token" && target.kind.init && method === (target.kind.init === "create" ? "create" : "createIfNeeded"))
          return this.createAta(node, target, topLevel);
        if (target?.kind.kind === "init" && method === "create") return this.create(node, target, topLevel);
        if (target?.kind.kind === "initIfNeeded" && method === "createIfNeeded") return this.create(node, target, topLevel, true);
        if (target?.kind.kind === "system" && method === "transfer") return this.systemTransfer(node);
        if (target?.kind.kind === "system" && method === "createAccount") return this.createAccount(node, target);
        if (target?.kind.kind === "tokenProgram") return this.tokenOp(node, target, method);
        if (target?.kind.kind === "ataProgram") return this.ataOp(node, target, method);
        if (target?.kind.kind === "metadataProgram") return this.metadataOp(node, target, method);
        if (target?.kind.kind === "coreProgram") return this.coreOp(node, target, method);
        if (target?.kind.kind === "bubblegumProgram") return this.bubblegumOp(node, target, method);
      }
    }
    if (ts.isPropertyAccessExpression(callee) && ts.isCallExpression(callee.expression) && this.exportName(callee.expression.expression) === "fixedArray")
      this.fail(callee.expression, "fixedArray<T, N>(fill) is only allowed as a local declaration: const xs = fixedArray<u64, 4>(0n)");
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "slice" && this.isRemaining(callee.expression))
      this.fail(node, "rest.slice(a, b) is only for spreading into a CPI's accounts: invoke(p, [..., ...readonly(rest.slice(a, b))], data)");
    this.fail(node, "unsupported call");
  }

  protected vecMethod(node: ts.CallExpression, method: string, v: Ref): Value | undefined {
    const args = node.arguments;
    const vt = v.type as FieldType & { kind: "vec" };
    const info = v.vec!;
    const elemRef = (idx: string): Ref => ({ ...v, lv: `${v.lv}[${idx}]`, type: vt.elem, vec: undefined, path: undefined });
    /**
     * Evaluate the value into a temporary first (JS evaluates arguments before the call runs), then return a
     * writer for the element: `push(v.length)` sees the old length, `set(i, pop())` checks i after the pop.
     */
    const stageElem = (valueNode: ts.Expression): ((el: Ref) => void) => {
      const st = this.storageValueType(vt.elem);
      const t = this.tmp("elv");
      if (!st) {
        this.line(`${fieldC(vt.elem)} ${t};`);
        this.writeAggregate({ lv: t, type: vt.elem, writable: true }, valueNode);
        return (el) => this.line(`ts_memcpy(&${el.lv}, &${t}, sizeof(${t}));`);
      }
      const val = this.ownedString(this.expect(this.expr(valueNode, st), st, valueNode));
      if (st.kind === "pubkey") this.line(`SolPubkey ${t} = *(${val.c});`);
      else this.line(`${valueC(st)} ${t} = ${val.c};`);
      const c = st.kind === "pubkey" ? `(&${t})` : t;
      return (el) => this.line(this.writeStorage(el, c) + ";");
    };
    const needWritable = () => {
      if (!v.writable) this.fail(node, this.readOnly(v));
    };
    // Elements removed or replaced here must not be referenced afterwards.
    const elemPaths = () => (ts.isPropertyAccessExpression(node.expression) ? this.pathsOf(node.expression.expression)?.map((p) => `${p}[]`) : undefined);
    const resize = (newLen: string, payer: string) => {
      if (!info.resizable || !v.account) this.fail(node, "only Vecs of declared Mut<...> / Init<...> accounts can grow or shrink");
      this.line(`TS_TRY(ts_resize(params, ${payer}, a_${v.account.name}, 8 + ${info.fixed} + (${newLen}) * ${info.elemSize}, entry_${v.account.name}));`);
    };
    switch (method) {
      case "set": {
        if (args.length !== 2) this.fail(node, "set(index, value) takes two arguments");
        needWritable();
        if (!this.storageValueType(vt.elem)) this.assertNotAliased(elemPaths(), node);
        const i = this.indexValue(args[0]);
        const write = stageElem(args[1]);
        this.checkIndex(i, `(uint64_t)${info.len}`);
        write(elemRef(i));
        return undefined;
      }
      case "push": {
        if (args.length !== 2) this.fail(node, "push(value, payer) takes the value and a Mut<Signer> that pays for the extra rent");
        needWritable();
        const payer = this.accountParam(args[1], "the payer");
        if (payer.kind.kind !== "signer" || !payer.kind.mut) this.fail(args[1], "the payer must be a Mut<Signer>");
        const write = stageElem(args[0]);
        const n = this.tmp("n");
        this.line(`uint64_t ${n} = (uint64_t)${info.len};`);
        // Resizing does not move the data, so element pointers stay valid.
        resize(`${n} + 1`, `a_${payer.name}`);
        this.line(`${info.len} = (uint32_t)(${n} + 1);`);
        write(elemRef(n));
        return undefined;
      }
      case "pop": {
        if (args.length !== 0) this.fail(node, "pop() takes no arguments");
        needWritable();
        this.assertNotAliased(elemPaths(), node);
        const st = this.storageValueType(vt.elem);
        const n = this.tmp("n");
        this.line(`uint64_t ${n} = (uint64_t)${info.len};`);
        this.line(`if (${n} == 0) TS_FAIL(TS_ERR_INDEX, "TypeSOL: pop() on an empty Vec");`);
        // Structs and arrays are dropped (pop() as a statement); read .get(length - 1) first to keep one.
        let result: Value | undefined;
        if (st) {
          const out = this.tmp("popped");
          const val = this.readStorage(elemRef(`${n} - 1`), node);
          if (st.kind === "pubkey") this.line(`SolPubkey ${out} = *(${val.c});`);
          else if (st.kind === "string") {
            // The bytes are about to be cut off: copy them to the heap first.
            this.line(`TS_Str ${out};`);
            this.line(`TS_TRY(ts_str_copy(${val.c}, &${out}));`);
          } else this.line(`${valueC(st)} ${out} = ${val.c};`);
          result = st.kind === "pubkey" ? { c: `(&${out})`, type: st } : { c: out, type: st };
        }
        this.line(`${info.len} = (uint32_t)(${n} - 1);`);
        resize(`${n} - 1`, "NULL");
        return result;
      }
      case "clear": {
        if (args.length !== 0) this.fail(node, "clear() takes no arguments");
        needWritable();
        this.assertNotAliased(elemPaths(), node);
        this.line(`${info.len} = 0;`);
        resize("0", "NULL");
        return undefined;
      }
    }
    this.fail(node, `Vecs support get, set, push, pop, clear and .length, not ${method}()`);
  }

  /** sha256(...) / keccak256(...) over strings, Pubkeys, Hashes, integers (LE) and booleans. */
  protected hashCall(node: ts.CallExpression, fn: "sha256" | "keccak256"): Value {
    if (node.arguments.length === 0 || node.arguments.length > 16) this.fail(node, `${fn}(...parts) takes 1..16 parts`);
    const parts: string[] = [];
    const values: Value[] = [];
    for (const a of node.arguments) {
      const mark = this.lines.length;
      const v = this.expr(a);
      for (let j = 0; j < values.length; j++) values[j] = this.settle(values[j], mark);
      values.push(v.literal !== undefined ? this.literal(v.literal, U64, a) : v);
    }
    for (const [i, a] of node.arguments.entries()) {
      const typed = values[i];
      if (typed.type.kind === "string") {
        const t = this.tmp("hs");
        this.line(`TS_Str ${t} = ${typed.c};`);
        parts.push(`{(uint8_t *)${t}.ptr, ${t}.len}`);
      } else if (typed.type.kind === "pubkey") parts.push(`{(uint8_t *)(${typed.c}), 32}`);
      else if (isScalar(typed.type)) {
        const t = this.tmp("hv");
        this.line(`${scalarStorageC(typed.type)} ${t} = (${scalarStorageC(typed.type)})(${typed.c});`);
        parts.push(`{(uint8_t *)&${t}, ${scalarSize(typed.type)}}`);
      } else this.fail(a, `${fn} accepts strings, Pubkeys, Hashes, integers and booleans`);
    }
    const arr = this.tmp("hp");
    const out = this.tmp("h");
    this.line(`SolBytes ${arr}[${parts.length}] = {${parts.join(", ")}};`);
    this.line(`SolPubkey ${out};`);
    this.line(`sol_${fn}(${arr}, ${parts.length}, (uint8_t *)&${out});`);
    return { c: `(&${out})`, type: HASH };
  }

  /**
   * The extra accounts of a transfer hook, as ExtraAccountMeta records (35 bytes each): `{ address, isSigner?, isWritable? }`
   * for a fixed address, `{ seeds: [...], program?, isSigner?, isWritable? }` for a PDA of this program (or, with
   * `program: index`, of the program at that account index). Seeds: string literals, seedAccountKey(i),
   * seedAccountData(i, offset, length), seedInstructionData(offset, length); packed into 32 bytes.
   */
  protected extraAccountMetas(node: ts.Expression): { name: string; count: number } {
    if (!ts.isArrayLiteralExpression(node)) this.fail(node, "the extra accounts must be an array literal of { address } / { seeds } objects");
    const bytes: number[] = [];
    const fixups: { offset: number; c: string }[] = [];
    const small = (e: ts.Expression, what: string, max = 255): number => {
      if (!ts.isBigIntLiteral(e)) this.fail(e, `${what} must be a bigint literal`);
      const v = Number(BigInt(e.text.replace(/n$/, "")));
      if (v < 0 || v > max) this.fail(e, `${what} must be 0..${max}`);
      return v;
    };
    for (const el of node.elements) {
      if (!ts.isObjectLiteralExpression(el)) this.fail(el, "each extra account is { address, … } or { seeds: [...], … }");
      const props = new Map<string, ts.Expression>();
      for (const p of el.properties) {
        if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) this.fail(p, "use plain properties: address, seeds, program, isSigner, isWritable");
        if (!["address", "seeds", "program", "isSigner", "isWritable"].includes(p.name.text)) this.fail(p.name, `unknown property "${p.name.text}"`);
        props.set(p.name.text, p.initializer);
      }
      const flag = (k: string) => {
        const v = props.get(k);
        if (!v) return 0;
        if (v.kind === ts.SyntaxKind.TrueKeyword) return 1;
        if (v.kind === ts.SyntaxKind.FalseKeyword) return 0;
        this.fail(v, `${k} must be true or false`);
      };
      const start = bytes.length;
      const address = props.get("address");
      const seeds = props.get("seeds");
      if (!!address === !!seeds) this.fail(el, "give either address or seeds");
      if (address) {
        if (props.has("program")) this.fail(props.get("program")!, "program goes with seeds, not with address");
        const v = this.expect(this.expr(address, PUBKEY), PUBKEY, address);
        bytes.push(0, ...new Array(32).fill(0));
        fixups.push({ offset: start + 1, c: v.c });
      } else {
        if (!ts.isArrayLiteralExpression(seeds!)) this.fail(seeds!, "seeds must be an array literal");
        const packed: number[] = [];
        for (const s of seeds.elements) {
          if (ts.isStringLiteral(s)) {
            const b = [...Buffer.from(s.text, "utf8")];
            if (b.length > 32) this.fail(s, "a literal seed can be at most 32 bytes");
            packed.push(1, b.length, ...b);
            continue;
          }
          const fn = ts.isCallExpression(s) ? this.exportName(s.expression) : undefined;
          const a = ts.isCallExpression(s) ? s.arguments : ([] as unknown as ts.NodeArray<ts.Expression>);
          if (fn === "seedInstructionData" && a.length === 2) packed.push(2, small(a[0]!, "the data index"), small(a[1]!, "the length"));
          else if (fn === "seedAccountKey" && a.length === 1) packed.push(3, small(a[0]!, "the account index"));
          else if (fn === "seedAccountData" && a.length === 3)
            packed.push(4, small(a[0]!, "the account index"), small(a[1]!, "the data index"), small(a[2]!, "the length"));
          else this.fail(s, "a seed is a string literal, seedAccountKey(i), seedAccountData(i, offset, length) or seedInstructionData(offset, length)");
        }
        if (packed.length > 32) this.fail(seeds!, `the packed seeds take ${packed.length} bytes; at most 32 fit`);
        const program = props.get("program");
        bytes.push(program ? 128 + small(program, "program (an account index)", 127) : 1, ...packed, ...new Array(32 - packed.length).fill(0));
      }
      bytes.push(flag("isSigner")!, flag("isWritable")!);
    }
    const count = node.elements.length;
    if (!count) return { name: "NULL", count: 0 };
    const name = this.tmp("extra_metas");
    this.line(`${fixups.length ? "" : "static const "}uint8_t ${name}[${bytes.length}] = ${cBytes(bytes)};`);
    for (const f of fixups) this.line(`ts_memcpy(${name} + ${f.offset}, ${f.c}, 32);`);
    return { name, count };
  }

  /** `remainingAccounts()` or a const bound to it. */
  protected isRemaining(node: ts.Expression): boolean {
    if (ts.isIdentifier(node)) return this.lookup(node.text)?.type.kind === "remaining";
    return ts.isCallExpression(node) && this.exportName(node.expression) === "remainingAccounts";
  }

  /** C pointer (`TsAccount *`) for an expression naming a remaining account, or undefined. */
  protected handle(node: ts.Expression): string | undefined {
    if (ts.isParenthesizedExpression(node)) return this.handle(node.expression);
    if (ts.isIdentifier(node)) {
      const l = this.lookup(node.text);
      return l?.type.kind === "account" ? l.c : undefined;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "get" &&
      this.isRemaining(node.expression.expression)
    ) {
      if (!this.ix) this.fail(node, "remainingAccounts() is only available in instructions");
      if (node.arguments.length !== 1) this.fail(node, "get(index) takes one argument");
      const n = this.ix.accounts.length;
      const idx = this.index(node.arguments[0], `(uint64_t)(params->ka_num - ${n})`);
      const t = this.tmp("acct");
      this.line(`TsAccount *${t} = params->ka[${n} + ${idx}];`);
      return t;
    }
    return undefined;
  }

  /** A declared account parameter or a remaining account, as a `TsAccount *` C expression. */
  protected anyAccount(node: ts.Expression, what: string): string {
    const h = this.handle(node);
    if (h) return h;
    return `a_${this.accountParam(node, what).name}`;
  }

  /** `readData<T>(account, offset)`: a bounds-checked little-endian read of any account's data. */
  protected readData(node: ts.CallExpression): Value {
    const targ = node.typeArguments?.[0];
    const t = targ && resolveScalarType(targ, this.scope);
    if (!t) this.fail(node, "readData needs a value type: readData<u64>(account, offset)");
    if (node.arguments.length !== 2) this.fail(node, "readData<T>(account, offset) takes an account and a byte offset");
    const acct = this.anyAccount(node.arguments[0], "readData's account");
    const off = this.expect(this.expr(node.arguments[1], U64), U64, node.arguments[1]);
    const size = scalarSize(t);
    const o = this.tmp("off");
    const out = this.tmp("rd");
    this.line(`uint64_t ${o} = ${off.c};`);
    this.line(
      `if (${o} > ${acct}->data_len || ${acct}->data_len - ${o} < ${size}) TS_FAIL(TS_ERR_ACCOUNT_TOO_SMALL, "TypeSOL: read past the end of the account data");`,
    );
    this.line(`${scalarStorageC(t)} ${out};`);
    this.line(`ts_memcpy(&${out}, ${acct}->data + ${o}, ${size});`);
    if (t.kind === "pubkey") return { c: `(&${out})`, type: t };
    if (t.kind === "bool") {
      this.line(`if (${out} > 1) TS_FAIL(TS_ERR_ACCOUNT_TOO_SMALL, "TypeSOL: not a boolean");`);
      return { c: `(${out} != 0)`, type: BOOL };
    }
    if (t.kind === "enum")
      this.line(`if (${out} >= ${this.model.enums.get(t.name)!.variants.length}) TS_FAIL(TS_ERR_ACCOUNT_TOO_SMALL, "TypeSOL: invalid enum value");`);
    return { c: out, type: t };
  }

  /** `loadForeign<T>(account, owner)`: read-only view of another program's Anchor account. */
  protected loadForeign(node: ts.CallExpression): Value {
    const targ = node.typeArguments?.[0];
    const s = targ && ts.isTypeReferenceNode(targ) && ts.isIdentifier(targ.typeName) ? this.model.structs.get(targ.typeName.text) : undefined;
    if (!s || s.size === undefined || s.vec) this.fail(node, "loadForeign needs a fixed-size struct type: loadForeign<Pool>(account, owner)");
    if (node.arguments.length !== 2) this.fail(node, "loadForeign<T>(account, owner) takes the account and its owning program's address");
    const h = this.anyAccount(node.arguments[0], "loadForeign's account");
    const owner = this.expect(this.expr(node.arguments[1], PUBKEY), PUBKEY, node.arguments[1]);
    const disc = this.tmp("disc");
    this.line(`static const uint8_t ${disc}[8] = ${cBytes(s.accountDiscriminator)};`);
    this.line(`if (!ts_key_eq(&${h}->owner, ${owner.c})) TS_FAIL(TS_ERR_WRONG_OWNER, "TypeSOL: account not owned by the expected program");`);
    this.line(`if (${h}->data_len < 8 + sizeof(TSS_${s.name})) TS_FAIL(TS_ERR_ACCOUNT_TOO_SMALL, "TypeSOL: account data too small");`);
    this.line(`if (!ts_mem_eq(${h}->data, ${disc}, 8)) TS_FAIL(TS_ERR_DISCRIMINATOR, "TypeSOL: account discriminator mismatch");`);
    // Another program wrote these bytes: check bools, enums, option tags and string lengths like arguments.
    const view = `(*((TSS_${s.name} *)(${h}->data + 8)))`;
    for (const l of this.validation(view, { kind: "struct", name: s.name }, "", `TS_FAIL(TS_ERR_ACCOUNT_TOO_SMALL, "TypeSOL: malformed foreign account data")`))
      this.line(l.trim());
    return { c: `((TSS_${s.name} *)(${h}->data + 8))`, type: { kind: "structRef", struct: s.name, writable: false } };
  }

  /** `loadAccount<T>(acct)` / `loadAccountMut<T>(acct)`: checked view of a program account. */
  protected loadAccount(node: ts.CallExpression, mut: boolean): Value {
    const targ = node.typeArguments?.[0];
    const s = targ && ts.isTypeReferenceNode(targ) && ts.isIdentifier(targ.typeName) ? this.model.structs.get(targ.typeName.text) : undefined;
    if (!s || s.size === undefined) this.fail(node, "loadAccount needs an account struct type: loadAccount<MyStruct>(account)");
    if (node.arguments.length !== 1) this.fail(node, "loadAccount<T>(account) takes one remaining account");
    const h = this.handle(node.arguments[0]);
    if (!h) this.fail(node.arguments[0], "pass a remaining account, e.g. remainingAccounts().get(i)");
    if (this.model.events.has(s.name) && s.fields.some((f) => f.type.kind === "option" || f.type.kind === "dataEnum"))
      this.fail(node, `${s.name} is emitted as an event and has Option or enum fields; declare a separate event struct`);
    this.model.accountStructs.add(s.name);
    this.line(`TS_TRY(ts_check_program_account(${h}, params->program_id, TS_DISC_${s.name}, sizeof(TSS_${s.name})));`);
    if (s.vec) this.line(`TS_TRY(ts_check_vec_len(${h}, sizeof(TSS_${s.name}), ((TSS_${s.name} *)(${h}->data + 8))->${s.vec.name}__len, TS_ELEM_${s.name}));`);
    if (mut) {
      this.line(`TS_TRY(ts_check_writable(${h}));`);
      this.line(`TS_TRY(ts_check_unaliased(params, ${h}));`);
    }
    return { c: `((TSS_${s.name} *)(${h}->data + 8))`, type: { kind: "structRef", struct: s.name, writable: mut } };
  }

  protected callHelper(node: ts.CallExpression, h: Helper): Value | undefined {
    if (node.arguments.length !== h.params.length) this.fail(node, `${h.name}() takes ${h.params.length} argument(s)`);
    // Arguments are evaluated left to right: settle earlier ones when a later one runs statements.
    // A helper that takes accounts may change account data, so account text it gets is copied first.
    const takesAccounts = h.params.some((p) => p.account);
    const values: Value[] = [];
    const pieces: (number | string)[] = [];
    h.params.forEach((p, i) => {
      const n = node.arguments[i];
      const mark = this.lines.length;
      const raw = this.helperArg(h, p, n);
      for (let j = 0; j < values.length; j++) values[j] = this.settle(values[j], mark);
      if (typeof raw === "string") pieces.push(raw);
      else {
        pieces.push(values.length);
        values.push(takesAccounts ? this.ownedString(raw) : raw);
      }
    });
    // A helper that takes a writable struct account may replace anything stored in it (see assertNotAliased).
    for (const [i, p] of h.params.entries())
      if (p.account && p.account.kind === "account" && p.account.mut && ts.isIdentifier(node.arguments[i]))
        this.assertNotAliased([node.arguments[i].text], node, h.name);
    const args = ["params", ...pieces.map((x) => (typeof x === "number" ? (values[x].type.kind === "pubkey" ? `*(${values[x].c})` : values[x].c) : x))];
    if (!h.returns) {
      this.line(`TS_TRY(fn_${h.name}(${args.join(", ")}));`);
      return undefined;
    }
    const t = this.tmp();
    if (h.returns.kind === "struct") {
      // The result lives in a local the caller owns: a reference to it reads and copies like any struct. Declared at
      // the top of the function, so a reference taken inside a block (a ternary's branch) stays valid after it.
      this.hoisted.push(`  TSS_${h.returns.name} ${t};`);
      this.line(`TS_TRY(fn_${h.name}(${[...args, `&${t}`].join(", ")}));`);
      return { c: `(&${t})`, type: { kind: "structRef", struct: h.returns.name, writable: true } };
    }
    this.line(`${scalarC(h.returns)} ${t};`);
    this.line(`TS_TRY(fn_${h.name}(${[...args, `&${t}`].join(", ")}));`);
    return h.returns.kind === "pubkey" ? { c: `(&${t})`, type: h.returns } : { c: t, type: h.returns };
  }

  /** One helper argument: a C argument list fragment (accounts, seeds, references) or a value to settle. */
  protected helperArg(h: Helper, p: Helper["params"][number], n: ts.Expression): Value | string {
    if (p.account) {
      const acct = this.accountParam(n, `${h.name}()'s ${p.name}`);
      const why = accountMismatch(acct.kind, p.account);
      if (why) this.fail(n, `${h.name}() takes ${p.name} as ${why}`);
      return `a_${acct.name}`;
    }
    switch (p.type.kind) {
      case "signerSeeds": {
        const seeds = this.signerSeedsArg(n);
        return `${seeds.name}, ${seeds.count}`;
      }
      case "structRef":
      case "arrayArg": {
        const want: FieldType = p.type.kind === "structRef" ? { kind: "struct", name: p.type.struct } : p.type.array;
        const r = this.ref(n);
        if (!r || !sameType(r.type, want)) this.fail(n, `expected a ${typeName(want)}`);
        return this.snapshotPlace(r.lv, want, h);
      }
      case "dataEnumArg": {
        const r = this.ref(n);
        if (!r || r.type.kind !== "dataEnum" || r.type.name !== p.type.name) this.fail(n, `expected a ${p.type.name}`);
        return this.snapshotPlace(r.lv, { kind: "dataEnum", name: p.type.name }, h);
      }
      case "vecArg": {
        const l = ts.isIdentifier(n) ? this.lookup(n.text) : undefined;
        if (!l || !sameType(l.type, p.type)) this.fail(n, `expected a ${typeName(p.type)} instruction argument`);
        return l.c;
      }
      default:
        return this.expect(this.expr(n, p.type), p.type, n);
    }
  }

  /**
   * A struct/array/data-enum helper argument. Helpers that take accounts may change account data, so they get a
   * copy taken at the call (JS passes the object as it was); other helpers cannot write, so a pointer is enough.
   */
  protected snapshotPlace(lv: string, type: FieldType, h: Helper): string {
    if (!h.params.some((p) => p.account)) return `(&${lv})`;
    const n = this.fieldBytes(type);
    // One buffer per call site, allocated on first use: a call in a loop must not take new heap every pass.
    const t = this.tmp("argc");
    const decl = type.kind === "array" ? storageDecl(type, `(*${t})`) : `${fieldC(type)} *${t}`;
    this.hoisted.push(`  ${decl} = NULL;`);
    this.line(`if (${t} == NULL) TS_TRY(ts_alloc(${n}, (uint8_t **)&${t}));`);
    this.line(`ts_memcpy(${t}, &${lv}, ${n});`);
    return t;
  }

  /** `signer([...seeds])` (one PDA signature), or a SignerSeeds parameter passed on. */
  protected signerSeedsArg(n: ts.Expression): { name: string; count: number | string } {
    if (ts.isIdentifier(n)) {
      const l = this.lookup(n.text);
      if (l?.type.kind === "signerSeeds") return { name: l.c, count: `${l.c}__n` };
    }
    if (ts.isCallExpression(n) && this.exportName(n.expression) === "signer") {
      if (n.arguments.length !== 1) this.fail(n, "signer([...seeds]) takes the seeds (with the bump) as an array; signer([]) signs for nothing");
      return this.seeds(n.arguments[0], 0);
    }
    this.fail(n, "pass signer([...seeds with the bump]) or a SignerSeeds parameter");
  }

  protected errorRef(node: ts.Expression): ErrorDef {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const def = this.model.errorEnums.get(node.expression.text)?.get(node.name.text);
      if (def) return def;
    }
    if (ts.isStringLiteral(node)) {
      const existing = this.model.errors.find((e) => e.msg === node.text && e.name.startsWith("RequireFailed"));
      if (existing) return existing;
      const def = { code: 6000 + this.model.errors.length, name: `RequireFailed${this.model.errors.length}`, msg: node.text };
      this.model.errors.push(def);
      return def;
    }
    this.fail(node, "the error must be a member of an exported error enum or a string literal");
  }

  protected returnData(node: ts.CallExpression): Value {
    const targ = node.typeArguments?.[0];
    const t = targ && resolveScalarType(targ, this.scope);
    if (!t) this.fail(node, "returnData needs an explicit type: returnData<u64>(program)");
    if (node.arguments.length !== 1) this.fail(node, "returnData<T>(program) takes the program that returned it");
    const program = this.accountParam(node.arguments[0], "returnData's program");
    const out = this.tmp("rd");
    if (t.kind === "pubkey") {
      this.line(`SolPubkey ${out};`);
      this.line(`TS_TRY(ts_return_data(a_${program.name}, (uint8_t *)&${out}, 32));`);
      return { c: `(&${out})`, type: t };
    }
    if (t.kind === "bool") {
      this.line(`uint8_t ${out};`);
      this.line(`TS_TRY(ts_return_data(a_${program.name}, &${out}, 1));`);
      this.line(`if (${out} > 1) TS_FAIL(TS_ERR_RETURN_DATA, "TypeSOL: invalid bool return data");`);
      return { c: `(${out} == 1)`, type: BOOL };
    }
    if (t.kind === "enum") {
      this.line(`uint8_t ${out};`);
      this.line(`TS_TRY(ts_return_data(a_${program.name}, &${out}, 1));`);
      this.line(`if (${out} >= ${this.model.enums.get(t.name)!.variants.length}) TS_FAIL(TS_ERR_RETURN_DATA, "TypeSOL: invalid enum return data");`);
      return { c: out, type: t };
    }
    this.line(`${INT_INFO[t.name].c} ${out};`);
    this.line(`TS_TRY(ts_return_data(a_${program.name}, (uint8_t *)&${out}, ${INT_INFO[t.name].bytes}));`);
    return { c: out, type: t };
  }
}
