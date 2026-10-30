import ts from "typescript";
import { type AccountParam, type ValueType, isWritable } from "../model.js";
import { U64, U8, BOOL, PUBKEY, STRING, cBytes, optC } from "./shared.js";
import { CreateEmitter } from "./create.js";

/** SPL Token and Token-2022 instructions (`tokenProgram.transfer(…)` and the rest) and the ATA program's. */
export abstract class TokenEmitter extends CreateEmitter {
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
        // A Mut<Mint>, or a mint created and initialized earlier in this instruction (Mut<Signer> / Mut<AccountInfo>).
        const mint = this.accountParam(a[0], "the mint");
        if (!isWritable(mint.kind) || (mint.kind.kind !== "mint" && mint.kind.kind !== "signer" && mint.kind.kind !== "info"))
          this.fail(a[0], "the mint must be a Mut<Mint>, or a Mut<Signer> / Mut<AccountInfo> mint this instruction created");
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
        // The mint may have been created and initialized earlier in this instruction (a Mut<Signer> or Mut<AccountInfo>).
        const mint = this.accountParam(a[0], "the mint");
        if (!isWritable(mint.kind)) this.fail(a[0], "the mint must be writable (Mut<...>)");
        const ua = this.accountParam(a[1], "the update authority");
        const ma = this.accountParam(a[2], "the mint authority");
        const [nm, sym, uri] = [a[3], a[4], a[5]].map((n) => this.expect(this.expr(n, STRING), STRING, n).c);
        const s = this.signerSeeds(a[6], ma, a[2]);
        this.line(`TS_TRY(ts_t22_init_metadata(params, ${p}, a_${mint.name}, a_${ua.name}, a_${ma.name}, ${nm}, ${sym}, ${uri}, ${s.name}, ${s.count}));`);
        return undefined;
      }
      case "closeAccount": {
        arity(3);
        // A token account, or (Token-2022, with a MintCloseAuthority and no supply left) a mint.
        const acct = this.accountParam(a[0], "the closed account");
        if (!((acct.kind.kind === "token" || acct.kind.kind === "mint") && (acct.kind as { mut: boolean }).mut))
          this.fail(a[0], "the closed account must be a Mut<TokenAccount> or a Mut<Mint>");
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
    const decimals = (mint: AccountParam) => (put: Put) => put(`&a_${mint.name}->data[44]`, "1", 1);
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
    // The Token Group interface (spl-token-group-interface), which Token-2022 implements: 8-byte discriminators.
    const grouped = (
      disc: number[],
      fields: ((put: Put) => void)[],
      metas: [AccountParam, boolean, boolean][],
      seeds: { name: string; count: number | string },
    ) => {
      const { buf, len, put, finish } = this.byteBuffer("grp", 96, "TS_ERR_INSTRUCTION_DATA", "token group instruction");
      const d = this.tmp("disc");
      this.line(`static const uint8_t ${d}[8] = {${disc.join(", ")}};`);
      put(d, "8", 8);
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
    switch (method) {
      case "initializeTokenGroup": {
        token2022Only();
        if (a.length !== 5 && a.length !== 6)
          this.fail(node, "initializeTokenGroup(group, mint, mintAuthority, updateAuthority | null, maxSize, signerSeeds?)");
        const group = anyAcct(a[0], "the group", true);
        const mint = anyAcct(a[1], "the mint", false);
        const auth = this.accountParam(a[2], "the mint authority");
        grouped(
          [121, 113, 108, 39, 54, 51, 0, 4],
          [nonZeroKey(a[3]), value(a[4], U64)],
          [
            [group, true, false],
            [mint, false, false],
            [auth, false, true],
          ],
          this.signerSeeds(a[5], auth, a[2]),
        );
        return undefined;
      }
      case "initializeGroupMember": {
        token2022Only();
        if (a.length !== 5 && a.length !== 6)
          this.fail(node, "initializeGroupMember(member, memberMint, memberMintAuthority, group, groupUpdateAuthority, signerSeeds?)");
        const member = anyAcct(a[0], "the member", true);
        const memberMint = anyAcct(a[1], "the member mint", false);
        const mintAuth = this.accountParam(a[2], "the member mint's authority");
        const group = anyAcct(a[3], "the group", true);
        const groupAuth = this.accountParam(a[4], "the group's update authority");
        grouped(
          [152, 32, 222, 176, 223, 237, 116, 134],
          [],
          [
            [member, true, false],
            [memberMint, false, false],
            [mintAuth, false, true],
            [group, true, false],
            [groupAuth, false, true],
          ],
          a[5] ? this.signingSeeds(a[5]) : none,
        );
        return undefined;
      }
      case "updateGroupMaxSize": {
        token2022Only();
        if (a.length !== 3 && a.length !== 4) this.fail(node, "updateGroupMaxSize(group, updateAuthority, maxSize, signerSeeds?)");
        const group = anyAcct(a[0], "the group", true);
        const auth = this.accountParam(a[1], "the update authority");
        grouped(
          [108, 37, 171, 143, 248, 30, 18, 110],
          [value(a[2], U64)],
          [
            [group, true, false],
            [auth, false, true],
          ],
          this.signerSeeds(a[3], auth, a[1]),
        );
        return undefined;
      }
      case "updateGroupAuthority": {
        token2022Only();
        if (a.length !== 3 && a.length !== 4) this.fail(node, "updateGroupAuthority(group, updateAuthority, next | null, signerSeeds?)");
        const group = anyAcct(a[0], "the group", true);
        const auth = this.accountParam(a[1], "the update authority");
        grouped(
          [161, 105, 88, 1, 237, 221, 216, 203],
          [nonZeroKey(a[2])],
          [
            [group, true, false],
            [auth, false, true],
          ],
          this.signerSeeds(a[3], auth, a[1]),
        );
        return undefined;
      }
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
      case "updateDefaultAccountState": {
        token2022Only();
        if (a.length !== 3 && a.length !== 4) this.fail(node, "updateDefaultAccountState(mint, freezeAuthority, frozen, signerSeeds?)");
        const mint = anyAcct(a[0], "the mint", true);
        const auth = this.accountParam(a[1], "the freeze authority");
        const frozen = this.expect(this.expr(a[2], BOOL), BOOL, a[2]);
        const st = this.tmp("st");
        this.line(`uint8_t ${st} = (${frozen.c}) ? 2 : 1;`);
        simple(
          28,
          [byte(1), (put) => put(`&${st}`, "1", 1)],
          [
            [mint, true, false],
            [auth, false, true],
          ],
          this.signerSeeds(a[3], auth, a[1]),
        );
        return undefined;
      }
      case "enableRequiredMemoTransfers":
      case "disableRequiredMemoTransfers": {
        token2022Only();
        if (a.length !== 2 && a.length !== 3) this.fail(node, `${method}(account, owner, signerSeeds?)`);
        const acct = anyAcct(a[0], "the token account", true);
        const owner = this.accountParam(a[1], "the owner");
        simple(
          30,
          [byte(method === "enableRequiredMemoTransfers" ? 0 : 1)],
          [
            [acct, true, false],
            [owner, false, true],
          ],
          this.signerSeeds(a[2], owner, a[1]),
        );
        return undefined;
      }
      case "updateTransferHook": {
        token2022Only();
        if (a.length !== 3 && a.length !== 4) this.fail(node, "updateTransferHook(mint, authority, programId | null, signerSeeds?)");
        const mint = anyAcct(a[0], "the mint", true);
        const auth = this.accountParam(a[1], "the transfer hook authority");
        simple(
          36,
          [byte(1), nonZeroKey(a[2])],
          [
            [mint, true, false],
            [auth, false, true],
          ],
          this.signerSeeds(a[3], auth, a[1]),
        );
        return undefined;
      }
      case "updateInterestRate": {
        token2022Only();
        if (a.length !== 3 && a.length !== 4) this.fail(node, "updateInterestRate(mint, rateAuthority, rate, signerSeeds?)");
        const mint = anyAcct(a[0], "the mint", true);
        const auth = this.accountParam(a[1], "the rate authority");
        simple(
          33,
          [byte(1), value(a[2], I16)],
          [
            [mint, true, false],
            [auth, false, true],
          ],
          this.signerSeeds(a[3], auth, a[1]),
        );
        return undefined;
      }
      case "transferCheckedWithFee": {
        token2022Only();
        if (a.length !== 6 && a.length !== 7) this.fail(node, "transferCheckedWithFee(from, mint, to, authority, amount, fee, signerSeeds?)");
        const from = want(a[0], "token", true, "the source");
        const mint = want(a[1], "mint", false, "the mint");
        const to = want(a[2], "token", true, "the destination");
        const auth = this.accountParam(a[3], "the authority");
        // The decimals are the mint's own (checked when the mint was), as transferChecked does.
        const dec = (put: Put) => {
          const t = this.tmp("dec");
          this.line(`uint8_t ${t} = a_${mint.name}->data[44];`);
          put(`&${t}`, "1", 1);
        };
        simple(
          26,
          [byte(1), value(a[4], U64), dec, value(a[5], U64)],
          [
            [from, true, false],
            [mint, false, false],
            [to, true, false],
            [auth, false, true],
          ],
          this.signerSeeds(a[6], auth, a[3]),
        );
        return undefined;
      }
      case "harvestWithheldTokensToMint": {
        token2022Only();
        if (a.length !== 2) this.fail(node, "harvestWithheldTokensToMint(mint, sources): sources is remainingAccounts() or rest.slice(a, b)");
        if (!this.ix) this.fail(node, "harvestWithheldTokensToMint takes remaining accounts, so only instructions can call it");
        const mint = anyAcct(a[0], "the mint", true);
        const range = this.remainingRange(a[1]) ?? this.fail(a[1], "pass the source token accounts as remainingAccounts() or rest.slice(a, b)");
        const { buf, len, put, finish } = this.byteBuffer("tok", 2, "TS_ERR_INSTRUCTION_DATA", "token instruction");
        byte(26)(put);
        byte(4)(put);
        finish(node);
        // The sources go as they were passed (Token-2022 skips any it cannot harvest from).
        this.cpi(p, [[`a_${mint.name}`, true, false]], buf, len, none, { ...range, asPassed: true });
        return undefined;
      }
      case "withdrawWithheldTokensFromMint": {
        token2022Only();
        if (a.length !== 3 && a.length !== 4) this.fail(node, "withdrawWithheldTokensFromMint(mint, destination, authority, signerSeeds?)");
        const mint = anyAcct(a[0], "the mint", true);
        const dest = want(a[1], "token", true, "the destination");
        const auth = this.accountParam(a[2], "the withdraw authority");
        simple(
          26,
          [byte(2)],
          [
            [mint, true, false],
            [dest, true, false],
            [auth, false, true],
          ],
          this.signerSeeds(a[3], auth, a[2]),
        );
        return undefined;
      }
      case "setTransferFee": {
        token2022Only();
        if (a.length !== 4 && a.length !== 5) this.fail(node, "setTransferFee(mint, configAuthority, basisPoints, maximumFee, signerSeeds?)");
        const mint = anyAcct(a[0], "the mint", true);
        const auth = this.accountParam(a[1], "the config authority");
        const bps = (put: Put) => {
          const v = this.expect(this.expr(a[2], U16), U16, a[2]);
          this.line(`if (${v.c} > 10000) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: transfer fee above 10000 basis points");`);
          this.serialize(v, a[2], put);
        };
        simple(
          26,
          [byte(5), bps, value(a[3], U64)],
          [
            [mint, true, false],
            [auth, false, true],
          ],
          this.signerSeeds(a[4], auth, a[1]),
        );
        return undefined;
      }
      case "updateMetadataField":
      case "removeMetadataKey":
      case "updateMetadataAuthority":
      case "emitMetadata": {
        token2022Only();
        // The Token Metadata interface (spl-token-metadata-interface), served by Token-2022 for metadata in the mint.
        const usage = {
          updateMetadataField: "updateMetadataField(mint, updateAuthority, field, value, signerSeeds?)",
          removeMetadataKey: "removeMetadataKey(mint, updateAuthority, key, idempotent, signerSeeds?)",
          updateMetadataAuthority: "updateMetadataAuthority(mint, updateAuthority, newAuthority | null, signerSeeds?)",
          emitMetadata: "emitMetadata(mint)",
        }[method];
        const fixedArgs = { updateMetadataField: 4, removeMetadataKey: 4, updateMetadataAuthority: 3, emitMetadata: 1 }[method];
        if (a.length !== fixedArgs && (method === "emitMetadata" || a.length !== fixedArgs + 1)) this.fail(node, usage);
        const disc = {
          updateMetadataField: "dde9312db5cadcc8",
          removeMetadataKey: "ea122038598d25b5",
          updateMetadataAuthority: "d7e4a6e45464567b",
          emitMetadata: "faa6b4fa0d0cb846",
        }[method];
        const mint = anyAcct(a[0], "the mint", method !== "emitMetadata");
        const auth = method === "emitMetadata" ? undefined : this.accountParam(a[1], "the update authority");
        const { buf, len, put, finish } = this.byteBuffer("tmd", 1232, "TS_ERR_INSTRUCTION_DATA", "token metadata instruction");
        const d = this.tmp("disc");
        this.line(`static const uint8_t ${d}[8] = ${cBytes([...Buffer.from(disc, "hex")])};`);
        put(d, "8", 8);
        if (method === "updateMetadataField") {
          // Field: Name / Symbol / Uri for those names, otherwise Key(field), as the Token-2022 CLI reads them.
          const f = this.expect(this.expr(a[2], STRING), STRING, a[2]);
          const ft = this.tmp("field");
          const tag = this.tmp("ftag");
          this.line(`TS_Str ${ft} = ${f.c};`);
          this.line(
            `uint8_t ${tag} = ts_str_eq(${ft}, ts_str((const uint8_t *)"name", 4)) ? 0 : ts_str_eq(${ft}, ts_str((const uint8_t *)"symbol", 6)) ? 1 : ts_str_eq(${ft}, ts_str((const uint8_t *)"uri", 3)) ? 2 : 3;`,
          );
          put(`&${tag}`, "1", 1);
          const kl = this.tmp("klen");
          this.line(`uint32_t ${kl} = (uint32_t)${ft}.len;`);
          put(`&${kl}`, `(${tag} == 3 ? 4 : 0)`);
          put(`${ft}.ptr`, `(${tag} == 3 ? ${ft}.len : 0)`);
          this.serialize(this.expect(this.expr(a[3], STRING), STRING, a[3]), a[3], put);
        } else if (method === "removeMetadataKey") {
          const key = this.expect(this.expr(a[2], STRING), STRING, a[2]);
          const idem = this.expect(this.expr(a[3], BOOL), BOOL, a[3]);
          const t = this.tmp("idem");
          this.line(`uint8_t ${t} = (${idem.c}) ? 1 : 0;`);
          put(`&${t}`, "1", 1);
          this.serialize(key, a[2], put);
        } else if (method === "updateMetadataAuthority") {
          nonZeroKey(a[2])(put);
        } else {
          // start: None, end: None (the whole TokenMetadata as return data).
          byte(0)(put);
          byte(0)(put);
        }
        finish(node);
        const seeds = auth ? this.signerSeeds(a[fixedArgs], auth, a[1]) : none;
        this.cpi(
          p,
          auth
            ? [
                [`a_${mint.name}`, true, false],
                [`a_${auth.name}`, false, true],
              ]
            : [[`a_${mint.name}`, false, false]],
          buf,
          len,
          seeds,
        );
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
      // The checked forms take the decimals from the mint, as transferChecked does.
      case "approveChecked": {
        arity(5);
        const src = want(a[0], "token", true, "the source");
        const mint = want(a[1], "mint", false, "the mint");
        const delegate = this.accountParam(a[2], "the delegate");
        const owner = this.accountParam(a[3], "the owner");
        const s = this.signerSeeds(a[5], owner, a[3]);
        simple(
          13,
          [value(a[4], U64), decimals(mint)],
          [
            [src, true, false],
            [mint, false, false],
            [delegate, false, false],
            [owner, false, true],
          ],
          s,
        );
        return undefined;
      }
      case "mintToChecked": {
        arity(4);
        const mint = want(a[0], "mint", true, "the mint");
        const to = want(a[1], "token", true, "the destination");
        const auth = this.accountParam(a[2], "the mint authority");
        const s = this.signerSeeds(a[4], auth, a[2]);
        simple(
          14,
          [value(a[3], U64), decimals(mint)],
          [
            [mint, true, false],
            [to, true, false],
            [auth, false, true],
          ],
          s,
        );
        return undefined;
      }
      case "burnChecked": {
        arity(4);
        const from = want(a[0], "token", true, "the burned account");
        const mint = want(a[1], "mint", true, "the mint");
        const auth = this.accountParam(a[2], "the authority");
        const s = this.signerSeeds(a[4], auth, a[2]);
        simple(
          15,
          [value(a[3], U64), decimals(mint)],
          [
            [from, true, false],
            [mint, true, false],
            [auth, false, true],
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
      `token programs support transfer, transferChecked, mintTo, burn, closeAccount, approve, revoke, setAuthority, freezeAccount, thawAccount, syncNative, initializeMint2, initializeAccount3, initializeMetadata, updateMetadataField, removeMetadataKey, updateMetadataAuthority, emitMetadata, the Token-2022 extension instructions (updateDefaultAccountState, updateTransferHook, enableRequiredMemoTransfers, disableRequiredMemoTransfers, updateInterestRate, transferCheckedWithFee, harvestWithheldTokensToMint, withdrawWithheldTokensFromMint, setTransferFee) and initializers (initializeTransferFeeConfig, initializeMintCloseAuthority, initializeNonTransferableMint, initializePermanentDelegate, initializeDefaultAccountState, initializeMetadataPointer, initializeGroupPointer, initializeGroupMemberPointer, initializeTransferHook, initializeInterestBearingMint, initializeImmutableOwner), not ${method}`,
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

  /** memoProgram.memo(text, signers?, signerSeeds?): SPL Memo v2, the UTF-8 text as data, each signer a signing account. */
  protected memoOp(node: ts.CallExpression, program: AccountParam, method: string): undefined {
    if (method !== "memo") this.fail(node.expression, "the Memo program has memo(text, signers?, signerSeeds?)");
    const a = node.arguments;
    if (a.length < 1 || a.length > 3) this.fail(node, "memo(text, signers?, signerSeeds?)");
    const text = this.expect(this.expr(a[0], STRING), STRING, a[0]);
    const list = a[1];
    if (list && !ts.isArrayLiteralExpression(list)) this.fail(list, "the signers are a list of accounts: [authority, …]");
    const signers = list ? (list as ts.ArrayLiteralExpression).elements.map((e) => this.accountParam(e, "a memo signer")) : [];
    const t = this.tmp("memo");
    this.line(`TS_Str ${t} = ${text.c};`);
    const seeds = a[2] ? this.signingSeeds(a[2]) : { name: "NULL", count: 0 };
    if (!signers.length) this.line(`TS_TRY(ts_cpi(params, a_${program.name}, (uint8_t *)${t}.ptr, ${t}.len, NULL, 0, ${seeds.name}, ${seeds.count}));`);
    else
      this.cpi(
        `a_${program.name}`,
        signers.map((s) => [`a_${s.name}`, false, true]),
        `(uint8_t *)${t}.ptr`,
        `${t}.len`,
        seeds,
      );
    return undefined;
  }
}
