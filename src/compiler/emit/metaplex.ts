import ts from "typescript";
import { type AccountParam, type ScalarType, type ValueType, isWritable, optionKey } from "../model.js";
import { U64, U8, BOOL, PUBKEY, STRING, type Value, cBytes } from "./shared.js";
import { TokenEmitter } from "./token.js";

const U16V: ValueType = { kind: "int", name: "u16" };

/** One piece of a Metaplex instruction's Borsh data: fixed bytes, or a value lowered and serialized in source order. */
type MplField = { bytes: number[] } | { value: ts.Expression; type: ValueType } | { c: string; n: string };

/**
 * Bubblegum instructions that replace a leaf: discriminator, accounts in order ([label, writable, signer, optional,
 * either-signs]) and the leaf's shape. Optional accounts take `null` (the program id). The Merkle proof follows the
 * leaf (and metadata) as remaining accounts.
 */
const BUBBLEGUM_OPS: Record<
  string,
  { disc: number[]; leaf: "v2" | "delegate" | "meta" | "v1"; accounts: [string, boolean, boolean, boolean?, ("owner" | "delegate")?][] }
> = {
  delegateV2: {
    disc: [95, 87, 125, 140, 181, 131, 128, 227],
    leaf: "delegate",
    accounts: [
      ["treeConfig", true, false],
      ["payer", true, true],
      ["leafOwner", false, true, true],
      ["previousLeafDelegate", false, false, true],
      ["newLeafDelegate", false, false],
      ["merkleTree", true, false],
      ["logWrapper", false, false],
      ["compressionProgram", false, false],
      ["systemProgram", false, false],
    ],
  },
  ...Object.fromEntries(
    [
      ["freezeV2", [200, 151, 244, 102, 16, 195, 255, 3], false],
      ["thawV2", [96, 133, 101, 93, 82, 220, 146, 191], false],
      ["setNonTransferableV2", [181, 141, 206, 58, 242, 199, 152, 168], true],
    ].map(([name, disc, needsCollection]) => [
      name as string,
      {
        disc: disc as number[],
        leaf: "v2" as const,
        accounts: [
          ["treeConfig", true, false],
          ["payer", true, true],
          ["authority", false, true, true],
          ["leafOwner", false, false],
          ["leafDelegate", false, false, name === "setNonTransferableV2"],
          ["merkleTree", true, false],
          ["coreCollection", false, false, !needsCollection],
          ["logWrapper", false, false],
          ["compressionProgram", false, false],
          ["systemProgram", false, false],
        ] as [string, boolean, boolean, boolean?][],
      },
    ]),
  ),
  updateMetadataV2: {
    disc: [43, 103, 89, 42, 121, 242, 62, 72],
    leaf: "meta",
    accounts: [
      ["treeConfig", true, false],
      ["payer", true, true],
      ["authority", false, true, true],
      ["leafOwner", false, false],
      ["leafDelegate", false, false, true],
      ["merkleTree", true, false],
      ["coreCollection", false, false, true],
      ["logWrapper", false, false],
      ["compressionProgram", false, false],
      ["systemProgram", false, false],
    ],
  },
  ...Object.fromEntries(
    [
      ["verifyCreatorV2", [85, 138, 140, 42, 22, 241, 118, 102]],
      ["unverifyCreatorV2", [174, 112, 29, 142, 230, 100, 239, 7]],
    ].map(([name, disc]) => [
      name as string,
      {
        disc: disc as number[],
        leaf: "meta" as const,
        accounts: [
          ["treeConfig", true, false],
          ["payer", true, true],
          ["creator", false, true, true],
          ["leafOwner", false, false],
          ["leafDelegate", false, false, true],
          ["merkleTree", true, false],
          ["logWrapper", false, false],
          ["compressionProgram", false, false],
          ["systemProgram", false, false],
        ] as [string, boolean, boolean, boolean?][],
      },
    ]),
  ),
  setCollectionV2: {
    disc: [229, 35, 61, 91, 15, 14, 99, 160],
    leaf: "meta",
    accounts: [
      ["treeConfig", true, false],
      ["payer", true, true],
      ["authority", false, true, true],
      ["newCollectionAuthority", false, true, true],
      ["leafOwner", false, false],
      ["leafDelegate", false, false, true],
      ["merkleTree", true, false],
      ["coreCollection", true, false, true],
      ["newCoreCollection", true, false, true],
      ["mplCoreCpiSigner", false, false, true],
      ["logWrapper", false, false],
      ["compressionProgram", false, false],
      ["mplCoreProgram", false, false],
      ["systemProgram", false, false],
    ],
  },
  // V1 trees (SPL Account Compression, SPL Noop).
  transfer: {
    disc: [163, 52, 200, 231, 140, 3, 69, 186],
    leaf: "v1",
    accounts: [
      ["treeConfig", false, false],
      ["leafOwner", false, false, false, "owner"],
      ["leafDelegate", false, false, false, "delegate"],
      ["newLeafOwner", false, false],
      ["merkleTree", true, false],
      ["logWrapper", false, false],
      ["compressionProgram", false, false],
      ["systemProgram", false, false],
    ],
  },
  burn: {
    disc: [116, 110, 29, 56, 107, 219, 42, 93],
    leaf: "v1",
    accounts: [
      ["treeConfig", false, false],
      ["leafOwner", false, false, false, "owner"],
      ["leafDelegate", false, false, false, "delegate"],
      ["merkleTree", true, false],
      ["logWrapper", false, false],
      ["compressionProgram", false, false],
      ["systemProgram", false, false],
    ],
  },
  delegate: {
    disc: [90, 147, 75, 178, 85, 88, 4, 137],
    leaf: "v1",
    accounts: [
      ["treeConfig", false, false],
      ["leafOwner", false, false, false, "owner"],
      ["previousLeafDelegate", false, false],
      ["newLeafDelegate", false, false],
      ["merkleTree", true, false],
      ["logWrapper", false, false],
      ["compressionProgram", false, false],
      ["systemProgram", false, false],
    ],
  },
};

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
  "FreezeExecute",
  "PermanentFreezeExecute",
  "Groups",
] as const;
const CORE_PLUGIN_FIELDS: Record<string, string[]> = {
  Royalties: ["basisPoints", "creators", "ruleSet"],
  MasterEdition: ["maxSupply", "name", "uri"],
  VerifiedCreators: ["signatures"],
  Autograph: ["signatures"],
  FreezeExecute: ["frozen"],
  PermanentFreezeExecute: ["frozen"],
  FreezeDelegate: ["frozen"],
  PermanentFreezeDelegate: ["frozen"],
  UpdateDelegate: ["additionalDelegates"],
  Attributes: ["attributes"],
  Edition: ["number"],
};

/** Metaplex: Token Metadata, Core (plugins and external plugins) and Bubblegum. */
export abstract class MetaplexEmitter extends TokenEmitter {
  protected metadataOp(node: ts.CallExpression, program: AccountParam, method: string): undefined {
    if (method === "createMasterEditionV3" || method === "verifyCollection") return this.metadataCollectionOp(node, program, method);
    if (method === "updateMetadataAccountsV2") return this.metadataUpdate(node, program);
    if (method !== "createV3")
      this.fail(
        node.expression,
        `the Token Metadata program supports createV3, createMasterEditionV3, verifyCollection and updateMetadataAccountsV2, not ${method}`,
      );
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
          const c = this.mplCreators(p.initializer);
          creators = c.buf;
          ncreators = c.count;
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

  /** Metaplex creators `[{ address, verified, share }, …]` (1 to 5, shares adding up to 100): 34 bytes each. */
  protected mplCreators(list0: ts.Expression): { buf: string; count: string } {
    if (!ts.isArrayLiteralExpression(list0)) this.fail(list0, "creators: [{ address, verified, share }, …] (an array literal)");
    const list = list0.elements;
    if (list.length < 1 || list.length > 5) this.fail(list0, "Metaplex takes 1 to 5 creators");
    const buf = this.tmp("creators");
    this.line(`uint8_t ${buf}[${34 * list.length}];`);
    let shares = 0n;
    let constant = true;
    list.forEach((el, i) => {
      if (!ts.isObjectLiteralExpression(el)) this.fail(el, "a creator is { address, verified, share }");
      const field = (k: string) => {
        const q = el.properties.find((x) => ts.isPropertyAssignment(x) && ts.isIdentifier(x.name) && x.name.text === k) as ts.PropertyAssignment | undefined;
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
    if (constant && shares !== 100n) this.fail(list0, `creator shares add up to ${shares}; Metaplex requires 100`);
    return { buf, count: String(list.length) };
  }

  /**
   * updateMetadataAccountsV2(metadata, updateAuthority, data | null, newUpdateAuthority | null, primarySaleHappened |
   * null, isMutable | null, signerSeeds?): Anchor's `update_metadata_accounts_v2`. `data` is the whole new DataV2
   * (`{ name, symbol, uri, sellerFeeBasisPoints, creators?, collection? }`); each null leaves that part as it is.
   */
  protected metadataUpdate(node: ts.CallExpression, program: AccountParam): undefined {
    const a = node.arguments;
    const usage =
      "updateMetadataAccountsV2(metadata, updateAuthority, data | null, newUpdateAuthority | null, primarySaleHappened | null, isMutable | null, signerSeeds?)";
    if (a.length !== 6 && a.length !== 7) this.fail(node, usage);
    const metadata = this.accountParam(a[0], "the metadata account");
    if (!isWritable(metadata.kind)) this.fail(a[0], "the metadata account must be Mut<AccountInfo>");
    const ua = this.accountParam(a[1], "the update authority");
    const isNull = (n: ts.Expression) => n.kind === ts.SyntaxKind.NullKeyword;
    let hasData = "false";
    let name = "ts_str(NULL, 0)";
    let symbol = name;
    let uri = name;
    let fee = "0";
    let creators = "NULL";
    let ncreators = "-1";
    let collection = "NULL";
    if (!isNull(a[2])) {
      if (!ts.isObjectLiteralExpression(a[2])) this.fail(a[2], "data is { name, symbol, uri, sellerFeeBasisPoints, creators?, collection? } or null");
      const props = this.literalProps(a[2], ["name", "symbol", "uri", "sellerFeeBasisPoints", "creators", "collection"], "data");
      for (const k of ["name", "symbol", "uri", "sellerFeeBasisPoints"]) if (!props.has(k)) this.fail(a[2], `data needs ${k} (it replaces the whole DataV2)`);
      const text = (k: string) => {
        const t = this.tmp("md");
        this.line(`TS_Str ${t} = ${this.expect(this.expr(props.get(k)!, STRING), STRING, props.get(k)!).c};`);
        return t;
      };
      [name, symbol, uri] = ["name", "symbol", "uri"].map(text);
      const f = this.tmp("fee");
      this.line(`uint16_t ${f} = ${this.expect(this.expr(props.get("sellerFeeBasisPoints")!, U16V), U16V, props.get("sellerFeeBasisPoints")!).c};`);
      fee = f;
      if (props.has("creators")) ({ buf: creators, count: ncreators } = this.mplCreators(props.get("creators")!));
      if (props.has("collection")) {
        const key = this.expect(this.expr(props.get("collection")!, PUBKEY), PUBKEY, props.get("collection")!);
        const t = this.tmp("coll");
        this.line(`SolPubkey ${t} = *(${key.c});`);
        collection = `&${t}`;
      }
      hasData = "true";
    }
    let next = "NULL";
    if (!isNull(a[3])) {
      const key = this.expect(this.expr(a[3], PUBKEY), PUBKEY, a[3]);
      const t = this.tmp("ua");
      this.line(`SolPubkey ${t} = *(${key.c});`);
      next = `&${t}`;
    }
    const flag = (n: ts.Expression) => (isNull(n) ? "-1" : `((${this.expect(this.expr(n, BOOL), BOOL, n).c}) ? 1 : 0)`);
    const primary = flag(a[4]);
    const mutable = flag(a[5]);
    const seeds = this.signerSeeds(a[6], ua, a[1]);
    this.line(
      `TS_TRY(ts_mpl_update_v2(params, a_${program.name}, a_${metadata.name}, a_${ua.name}, ${hasData}, ${name}, ${symbol}, ${uri}, ${fee}, ${creators}, ${ncreators}, ${collection}, ${next}, ${primary}, ${mutable}, ${seeds.name}, ${seeds.count}));`,
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
      } else if ("c" in f) put(f.c, f.n);
      else this.serialize(this.expect(this.expr(f.value, f.type), f.type, f.value), f.value, put);
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
    if (kind === "Groups") this.fail(kindNode, "Groups is kept by Core's group instructions (AddCollectionsToGroupV1 …), not set as a plugin");
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
        // rule_set: None, or { programAllowList: [...] } / { programDenyList: [...] }
        const rs = props.get("ruleSet");
        if (!rs) fields.push({ bytes: [0] });
        else {
          const pick = ts.isObjectLiteralExpression(rs) && rs.properties.length === 1 ? rs.properties[0] : undefined;
          const which = pick && ts.isPropertyAssignment(pick) && ts.isIdentifier(pick.name) ? pick.name.text : undefined;
          if (
            !pick ||
            (which !== "programAllowList" && which !== "programDenyList") ||
            !ts.isArrayLiteralExpression((pick as ts.PropertyAssignment).initializer)
          )
            this.fail(rs, "ruleSet is { programAllowList: [programs] } or { programDenyList: [programs] }");
          const progs = ((pick as ts.PropertyAssignment).initializer as ts.ArrayLiteralExpression).elements;
          if (progs.length > 16) this.fail(rs, "at most 16 programs in a rule set");
          fields.push({ bytes: [which === "programAllowList" ? 1 : 2, ...u32(progs.length)] }, ...progs.map((k) => ({ value: k, type: PUBKEY })));
        }
        break;
      }
      case "MasterEdition": {
        // Option<u32>, Option<String>, Option<String>: left out or null is None.
        const opt = (k: string, t: ValueType): MplField[] => {
          const v = props.get(k);
          return !v || v.kind === ts.SyntaxKind.NullKeyword ? [{ bytes: [0] }] : [{ bytes: [1] }, { value: v, type: t }];
        };
        fields.push(...opt("maxSupply", { kind: "int", name: "u32" }), ...opt("name", STRING), ...opt("uri", STRING));
        break;
      }
      case "VerifiedCreators":
      case "Autograph": {
        const sigs = list("signatures", 16);
        fields.push({ bytes: u32(sigs.length) });
        const second = kind === "VerifiedCreators" ? "verified" : "message";
        for (const sg of sigs) {
          if (!ts.isObjectLiteralExpression(sg)) this.fail(sg, `a signature is { address, ${second} }`);
          const get = (k: string) => {
            const q = sg.properties.find(
              (x) => (ts.isPropertyAssignment(x) || ts.isShorthandPropertyAssignment(x)) && ts.isIdentifier(x.name) && x.name.text === k,
            );
            if (!q) this.fail(sg, `a signature needs ${k}`);
            return ts.isPropertyAssignment(q) ? q.initializer : (q as ts.ShorthandPropertyAssignment).name;
          };
          fields.push({ value: get("address"), type: PUBKEY }, { value: get(second), type: kind === "VerifiedCreators" ? BOOL : STRING });
        }
        break;
      }
      case "FreezeExecute":
      case "PermanentFreezeExecute":
        fields.push({ value: need("frozen"), type: BOOL });
        break;

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

  /**
   * Metaplex Core: assets and collections (with plugins), plugins and external plugin adapters added, updated, written
   * and removed, transfer and burn. Each method is a row of CORE_OPS below: its accounts in order, its data.
   */
  protected coreOp(node: ts.CallExpression, core: AccountParam, method: string): undefined {
    const a = node.arguments;
    const p = `a_${core.name}`;
    const op = this.coreOps()[method];
    if (!op)
      this.fail(
        node.expression,
        `Metaplex Core supports createAsset, createCollection, addPlugin, updatePlugin, removePlugin, addExternalPlugin, removeExternalPlugin, writeExternalPluginData (and the Collection forms), transferAsset and burnAsset, not ${method}`,
      );
    // An array literal of object literals right after the fixed arguments is the plugin list; the signer seeds follow.
    const isPlugins = (n: ts.Expression | undefined) =>
      !!n && ts.isArrayLiteralExpression(n) && (n.elements.length === 0 || n.elements.every((e) => ts.isObjectLiteralExpression(e)));
    const list = op.plugins && isPlugins(a[op.args]) ? a[op.args] : undefined;
    const seedsAt = op.args + (list ? 1 : 0);
    if (op.plugins ? a.length < op.args || a.length > seedsAt + 1 : a.length !== op.args && a.length !== op.args + 1) this.fail(node, op.usage(method));
    const metas = op.metas.map((m) => (m === "self" ? ([p, false, false] as [string, boolean, boolean]) : this.mplMeta(a[m[0]]!, core, m[1], m[2], m[3])));
    const data = this.mplData(node, op.max, op.data(a, list));
    this.cpi(p, metas, data.buf, data.len, a[seedsAt] ? this.signingSeeds(a[seedsAt]) : { name: "NULL", count: 0 });
    return undefined;
  }

  /**
   * Core instructions: `args` fixed arguments (then an optional plugin list when `plugins`, then optional signer
   * seeds), accounts in order (`[argument, label, writable, signer]`, or "self": the Core program, Core's "none" for an
   * optional account), at most `max` bytes of data.
   */
  private coreOps(): Record<
    string,
    {
      usage: (method: string) => string;
      args: number;
      plugins?: boolean;
      metas: ([number, string, boolean, boolean] | "self")[];
      max: number;
      data: (a: ts.NodeArray<ts.Expression>, plugins: ts.Expression | undefined) => MplField[];
    }
  > {
    const str = (n: ts.Expression) => ({ value: n, type: STRING });
    const asset = [0, "the asset", true, false] as [number, string, boolean, boolean];
    const assetPlugin = {
      usage: (m: string) => `${m}(asset, collection | null, payer, authority | null, systemProgram, ${m === "removePlugin" ? "kind" : "plugin"}, signerSeeds?)`,
      args: 6,
      // Add/Remove/UpdatePluginV1: asset, collection, payer, authority, systemProgram, logWrapper.
      metas: [
        asset,
        [1, "the collection", true, false],
        [2, "the payer", true, true],
        [3, "the authority", false, true],
        [4, "the system program", false, false],
        "self",
      ] as ([number, string, boolean, boolean] | "self")[],
      max: 2048,
    };
    const collectionPlugin = {
      usage: (m: string) => `${m}(collection, payer, authority | null, systemProgram, ${m === "removeCollectionPlugin" ? "kind" : "plugin"}, signerSeeds?)`,
      args: 5,
      // Add/Remove/UpdateCollectionPluginV1: collection, payer, authority, systemProgram, logWrapper.
      metas: [
        [0, "the collection", true, false],
        [1, "the payer", true, true],
        [2, "the authority", false, true],
        [3, "the system program", false, false],
        "self",
      ] as ([number, string, boolean, boolean] | "self")[],
      max: 2048,
    };
    const assetPluginOp = (method: string, disc: number) => ({
      ...assetPlugin,
      data: (a: ts.NodeArray<ts.Expression>) => [
        { bytes: [disc] },
        ...(method === "removePlugin" ? [this.corePluginType(a[5]!)] : this.corePlugin(a[5]!, method === "addPlugin")),
      ],
    });
    const collectionPluginOp = (method: string, disc: number) => ({
      ...collectionPlugin,
      data: (a: ts.NodeArray<ts.Expression>) => [
        { bytes: [disc] },
        ...(method === "removeCollectionPlugin" ? [this.corePluginType(a[4]!)] : this.corePlugin(a[4]!, method === "addCollectionPlugin")),
      ],
    });
    // Add/RemoveExternalPluginAdapterV1: asset, collection, payer, authority, systemProgram, logWrapper; the write has a
    // buffer account (left out: the data is in the instruction) before systemProgram. The Collection forms drop the asset.
    const external = (method: string, disc: number, collection: boolean) => {
      const write = method.startsWith("write");
      const add = method.startsWith("add");
      const n = (collection ? 5 : 6) + (write ? 1 : 0);
      const at = collection ? 4 : 5;
      const head = collection ? "collection, payer, authority | null, systemProgram" : "asset, collection | null, payer, authority | null, systemProgram";
      const metas: ([number, string, boolean, boolean] | "self")[] = collection
        ? [
            [0, "the collection", true, false],
            [1, "the payer", true, true],
            [2, "the authority", false, true],
          ]
        : [asset, [1, "the collection", true, false], [2, "the payer", true, true], [3, "the authority", false, true]];
      if (write) metas.push("self");
      metas.push([collection ? 3 : 4, "the system program", false, false], "self");
      return {
        usage: (m: string) => `${m}(${head}, ${add ? "plugin" : write ? "key, data" : "key"}, signerSeeds?)`,
        args: n,
        metas,
        max: 1024,
        data: (a: ts.NodeArray<ts.Expression>) => [
          { bytes: [disc] },
          ...(add
            ? this.coreExternalPlugin(a[at]!)
            : write
              ? [...this.coreExternalKey(a[at]!), ...this.coreExternalData(a[at + 1]!)]
              : this.coreExternalKey(a[at]!)),
        ],
      };
    };
    return {
      createAsset: {
        usage: () => "createAsset(asset, collection | null, authority | null, payer, owner | null, systemProgram, name, uri, plugins?, signerSeeds?)",
        args: 8,
        plugins: true,
        // CreateV1: asset, collection, authority, payer, owner, updateAuthority (the collection's, or the payer by
        // default), systemProgram, logWrapper.
        metas: [
          [0, "the asset", true, true],
          [1, "the collection", true, false],
          [2, "the collection authority", false, true],
          [3, "the payer", true, true],
          [4, "the owner", false, false],
          "self",
          [5, "the system program", false, false],
          "self",
        ],
        max: 2048,
        data: (a, plugins) => [{ bytes: [0, 0] }, str(a[6]!), str(a[7]!), ...this.corePluginList(plugins)],
      },
      createCollection: {
        usage: () => "createCollection(collection, updateAuthority | null, payer, systemProgram, name, uri, plugins?, signerSeeds?)",
        args: 6,
        plugins: true,
        // CreateCollectionV1: collection, updateAuthority, payer, systemProgram.
        metas: [
          [0, "the collection", true, true],
          [1, "the update authority", false, false],
          [2, "the payer", true, true],
          [3, "the system program", false, false],
        ],
        max: 2048,
        data: (a, plugins) => [{ bytes: [1] }, str(a[4]!), str(a[5]!), ...this.corePluginList(plugins)],
      },
      addPlugin: assetPluginOp("addPlugin", 2),
      removePlugin: assetPluginOp("removePlugin", 4),
      updatePlugin: assetPluginOp("updatePlugin", 6),
      addCollectionPlugin: collectionPluginOp("addCollectionPlugin", 3),
      removeCollectionPlugin: collectionPluginOp("removeCollectionPlugin", 5),
      updateCollectionPlugin: collectionPluginOp("updateCollectionPlugin", 7),
      transferAsset: {
        usage: () => "transferAsset(asset, collection | null, payer, authority | null, newOwner, signerSeeds?)",
        args: 5,
        // TransferV1: asset, collection, payer, authority, newOwner, systemProgram, logWrapper.
        metas: [
          asset,
          [1, "the collection", false, false],
          [2, "the payer", true, true],
          [3, "the authority", false, true],
          [4, "the new owner", false, false],
          "self",
          "self",
        ],
        max: 8,
        data: () => [{ bytes: [14, 0] }],
      },
      burnAsset: {
        usage: () => "burnAsset(asset, collection | null, payer, authority | null, signerSeeds?)",
        args: 4,
        // BurnV1: asset, collection, payer, authority, systemProgram, logWrapper.
        metas: [asset, [1, "the collection", true, false], [2, "the payer", true, true], [3, "the authority", false, true], "self", "self"],
        max: 8,
        data: () => [{ bytes: [12, 0] }],
      },
      addExternalPlugin: external("addExternalPlugin", 22, false),
      removeExternalPlugin: external("removeExternalPlugin", 24, false),
      writeExternalPluginData: external("writeExternalPluginData", 28, false),
      addCollectionExternalPlugin: external("addCollectionExternalPlugin", 23, true),
      removeCollectionExternalPlugin: external("removeCollectionExternalPlugin", 25, true),
      writeCollectionExternalPluginData: external("writeCollectionExternalPluginData", 29, true),
    };
  }

  /** The fields of a Core object literal (`{ kind: "AppData", … }`) by name. */
  private coreProps(node: ts.Expression, what: string): Map<string, ts.Expression> {
    let n = node;
    while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) n = n.expression;
    if (!ts.isObjectLiteralExpression(n)) this.fail(n, `${what} is an object literal: { kind: "…", … }`);
    const props = new Map<string, ts.Expression>();
    for (const q of n.properties) {
      if (ts.isPropertyAssignment(q) && ts.isIdentifier(q.name)) props.set(q.name.text, q.initializer);
      else if (ts.isShorthandPropertyAssignment(q)) props.set(q.name.text, q.name);
      else this.fail(q, "write the fields as name: value");
    }
    return props;
  }

  /** PluginAuthority: "none" | "owner" | "updateAuthority" (literals), or an address. */
  private coreAuthority(n: ts.Expression): MplField[] {
    if (ts.isStringLiteral(n)) {
      const i = ["none", "owner", "updateAuthority"].indexOf(n.text);
      if (i < 0) this.fail(n, 'an authority is "none", "owner", "updateAuthority" or a Pubkey');
      return [{ bytes: [i] }];
    }
    return [{ bytes: [3] }, { value: n, type: PUBKEY }];
  }

  private coreOption(n: ts.Expression | undefined, inner: (n: ts.Expression) => MplField[]): MplField[] {
    return n ? [{ bytes: [1] }, ...inner(n)] : [{ bytes: [0] }];
  }

  private coreSchema(n: ts.Expression): MplField[] {
    const i = ts.isStringLiteral(n) ? ["binary", "json", "msgpack"].indexOf(n.text) : -1;
    if (i < 0) this.fail(n, 'schema is "binary", "json" or "msgpack"');
    return [{ bytes: [i] }];
  }

  /** Vec<(HookableLifecycleEvent, ExternalCheckResult)>: `[{ event: "transfer", canReject: true }, …]`. */
  private coreChecks(n: ts.Expression | undefined, at: ts.Node): MplField[] {
    if (!n || !ts.isArrayLiteralExpression(n)) this.fail(n ?? at, 'checks is a list: [{ event: "transfer", canApprove: true, canReject: true }]');
    const out: MplField[] = [{ bytes: [n.elements.length & 0xff, 0, 0, 0] }];
    for (const e of n.elements) {
      const p = this.coreProps(e, "a lifecycle check");
      const ev = p.get("event");
      const i = ev && ts.isStringLiteral(ev) ? ["create", "transfer", "burn", "update", "execute"].indexOf(ev.text) : -1;
      if (i < 0) this.fail(ev ?? e, 'event is "create", "transfer", "burn", "update" or "execute"');
      let flags = 0;
      for (const [k, bit] of [
        ["canListen", 1],
        ["canApprove", 2],
        ["canReject", 4],
      ] as const) {
        const v = p.get(k);
        if (v && v.kind !== ts.SyntaxKind.TrueKeyword && v.kind !== ts.SyntaxKind.FalseKeyword) this.fail(v, `${k} is true or false`);
        if (v?.kind === ts.SyntaxKind.TrueKeyword) flags |= bit;
      }
      for (const k of p.keys())
        if (!["event", "canListen", "canApprove", "canReject"].includes(k))
          this.fail(e, `a lifecycle check has event, canListen, canApprove and canReject, not ${k}`);
      out.push({ bytes: [i, flags, 0, 0, 0] });
    }
    return out;
  }

  /** ExtraAccount: `{ kind: "address", address, isSigner?, isWritable? }` or a preconfigured one (`{ kind: "owner" }`, …). */
  private coreExtraAccount(n: ts.Expression): MplField[] {
    const p = this.coreProps(n, "an extra account");
    const kind = p.get("kind");
    const kinds = ["program", "collection", "owner", "recipient", "asset", "customPda", "address"];
    const i = kind && ts.isStringLiteral(kind) ? kinds.indexOf(kind.text) : -1;
    if (i < 0 || i === 5) this.fail(kind ?? n, 'an extra account is { kind: "address", address } or "program", "collection", "owner", "recipient", "asset"');
    const flag = (k: string) => {
      const v = p.get(k);
      if (v && v.kind !== ts.SyntaxKind.TrueKeyword && v.kind !== ts.SyntaxKind.FalseKeyword) this.fail(v, `${k} is true or false`);
      return v?.kind === ts.SyntaxKind.TrueKeyword ? 1 : 0;
    };
    if (i === 6) {
      const addr = p.get("address");
      if (!addr) this.fail(n, "an address extra account needs address");
      return [{ bytes: [6] }, { value: addr, type: PUBKEY }, { bytes: [flag("isSigner"), flag("isWritable")] }];
    }
    return [{ bytes: [i, flag("isSigner"), flag("isWritable")] }];
  }

  /**
   * ExternalPluginAdapterInitInfo from a literal: `{ kind: "AppData", dataAuthority, schema? }`, `{ kind: "Oracle",
   * baseAddress, checks, resultsOffset?, baseAddressConfig? }`, `{ kind: "LifecycleHook", hookedProgram, checks,
   * extraAccounts?, dataAuthority?, schema? }` and the Linked forms (collections); `authority?` is the plugin's own.
   */
  protected coreExternalPlugin(n: ts.Expression): MplField[] {
    const p = this.coreProps(n, "a Core external plugin");
    const kind = p.get("kind");
    const kinds = ["LifecycleHook", "Oracle", "AppData", "LinkedLifecycleHook", "LinkedAppData"];
    const i = kind && ts.isStringLiteral(kind) ? kinds.indexOf(kind.text) : -1;
    if (i < 0) this.fail(kind ?? n, `a Core external plugin is ${kinds.join(", ")}`);
    const allowed: Record<number, string[]> = {
      0: ["hookedProgram", "checks", "extraAccounts", "dataAuthority", "schema"],
      1: ["baseAddress", "checks", "baseAddressConfig", "resultsOffset"],
      2: ["dataAuthority", "schema"],
      3: ["hookedProgram", "checks", "extraAccounts", "dataAuthority", "schema"],
      4: ["dataAuthority", "schema"],
    };
    for (const k of p.keys())
      if (k !== "kind" && k !== "authority" && !allowed[i]!.includes(k)) this.fail(n, `${kinds[i]} takes ${allowed[i]!.join(", ")} and authority, not ${k}`);
    const need = (k: string) => p.get(k) ?? this.fail(n, `${kinds[i]} needs ${k}`);
    const auth = this.coreOption(p.get("authority"), (x) => this.coreAuthority(x));
    const schema = this.coreOption(p.get("schema"), (x) => this.coreSchema(x));
    if (i === 2 || i === 4) return [{ bytes: [i] }, ...this.coreAuthority(need("dataAuthority")), ...auth, ...schema];
    if (i === 1) {
      const offset = p.get("resultsOffset");
      const off: MplField[] = !offset
        ? [{ bytes: [0] }]
        : ts.isStringLiteral(offset) && (offset.text === "none" || offset.text === "anchor")
          ? [{ bytes: [1, offset.text === "none" ? 0 : 1] }]
          : [{ bytes: [1, 2] }, { value: offset, type: U64 }];
      return [
        { bytes: [1] },
        { value: need("baseAddress"), type: PUBKEY },
        ...auth,
        ...this.coreChecks(need("checks"), n),
        ...this.coreOption(p.get("baseAddressConfig"), (x) => this.coreExtraAccount(x)),
        ...off,
      ];
    }
    const extras = p.get("extraAccounts");
    if (extras && !ts.isArrayLiteralExpression(extras)) this.fail(extras, "extraAccounts is a list of extra accounts");
    return [
      { bytes: [i] },
      { value: need("hookedProgram"), type: PUBKEY },
      ...auth,
      ...this.coreChecks(need("checks"), n),
      ...(extras ? [{ bytes: [1, extras.elements.length & 0xff, 0, 0, 0] }, ...extras.elements.flatMap((e) => this.coreExtraAccount(e))] : [{ bytes: [0] }]),
      ...this.coreOption(p.get("dataAuthority"), (x) => this.coreAuthority(x)),
      ...schema,
    ];
  }

  /** ExternalPluginAdapterKey: `{ kind: "AppData", dataAuthority }`, `{ kind: "Oracle", address }`, `{ kind: "LifecycleHook", address }`, … */
  protected coreExternalKey(n: ts.Expression): MplField[] {
    const p = this.coreProps(n, "a Core external plugin key");
    const kind = p.get("kind");
    const kinds = ["LifecycleHook", "Oracle", "AppData", "LinkedLifecycleHook", "LinkedAppData"];
    const i = kind && ts.isStringLiteral(kind) ? kinds.indexOf(kind.text) : -1;
    if (i < 0) this.fail(kind ?? n, `a Core external plugin key is ${kinds.join(", ")}`);
    if (i === 2 || i === 4) return [{ bytes: [i] }, ...this.coreAuthority(p.get("dataAuthority") ?? this.fail(n, `${kinds[i]}'s key is its dataAuthority`))];
    return [
      { bytes: [i] },
      { value: p.get("address") ?? this.fail(n, `${kinds[i]}'s key is its address (the oracle's base address or the hooked program)`), type: PUBKEY },
    ];
  }

  /** The data written: Option<Vec<u8>> from a string, a Vec<u8> argument, or null (clears it). */
  protected coreExternalData(n: ts.Expression): MplField[] {
    if (n.kind === ts.SyntaxKind.NullKeyword) return [{ bytes: [0] }];
    const l = ts.isIdentifier(n) ? this.lookup(n.text) : undefined;
    if (l?.type.kind === "vecArg") {
      if (l.type.elem.kind !== "int" || l.type.elem.name !== "u8") this.fail(n, "data is a string, a Vec<u8> argument or null");
      const t = this.tmp("dl");
      this.line(`uint32_t ${t} = (uint32_t)${l.c}.len;`);
      return [{ bytes: [1] }, { c: `&${t}`, n: "4" }, { c: `${l.c}.ptr`, n: `(uint64_t)${t}` }];
    }
    return [{ bytes: [1] }, { value: n, type: STRING }];
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
      case "mintToCollection": {
        // MintToCollectionV1: MintV1's accounts plus the collection authority (signing), its record PDA (or null),
        // the collection mint, metadata (writable) and master edition, Bubblegum's signer PDA and Token Metadata;
        // MetadataArgs with Some({ verified: false, key: collection mint }) (Bubblegum verifies it).
        if (a.length !== 17 && a.length !== 18)
          this.fail(
            node,
            "mintToCollection(treeConfig, leafOwner, leafDelegate, merkleTree, payer, treeDelegate, collectionAuthority, collectionAuthorityRecordPda | null, collectionMint, collectionMetadata, collectionEdition, bubblegumSigner, logWrapper, compressionProgram, tokenMetadataProgram, systemProgram, { name, symbol, uri, sellerFeeBasisPoints, creators?, isMutable?, editionNonce? }, signerSeeds?)",
          );
        const metas = [
          acct(0, "the tree config", true, false),
          acct(1, "the leaf owner", false, false),
          acct(2, "the leaf delegate", false, false),
          acct(3, "the merkle tree", true, false),
          acct(4, "the payer", false, true),
          acct(5, "the tree delegate", false, true),
          acct(6, "the collection authority", false, true),
          acct(7, "the collection authority record", false, false),
          acct(8, "the collection mint", false, false),
          acct(9, "the collection metadata", true, false),
          acct(10, "the collection edition", false, false),
          acct(11, "Bubblegum's signer", false, false),
          acct(12, "the log wrapper", false, false),
          acct(13, "the compression program", false, false),
          acct(14, "Token Metadata", false, false),
          acct(15, "the system program", false, false),
        ];
        const md = a[16]!;
        if (!ts.isObjectLiteralExpression(md))
          this.fail(md, "the metadata is { name, symbol, uri, sellerFeeBasisPoints, creators?, isMutable?, editionNonce? }");
        const props = this.literalProps(md, ["name", "symbol", "uri", "sellerFeeBasisPoints", "creators", "isMutable", "editionNonce"], "the metadata");
        const need = (k: string) => props.get(k) ?? this.fail(md, `the metadata needs ${k}`);
        // `collectionMint.key`, read where the call is.
        const key = ts.factory.createPropertyAccessExpression(a[8]! as ts.Identifier, "key");
        ts.setTextRange(key, a[8]!);
        (key as { parent?: ts.Node }).parent = node;
        const nonce = props.get("editionNonce");
        const data = this.mplData(node, 1024, [
          { bytes: [153, 18, 178, 47, 197, 158, 86, 15] },
          { value: need("name"), type: STRING },
          { value: need("symbol"), type: STRING },
          { value: need("uri"), type: STRING },
          { value: need("sellerFeeBasisPoints"), type: { kind: "int", name: "u16" } },
          { bytes: [0] }, // primarySaleHappened
          props.get("isMutable") ? { value: props.get("isMutable")!, type: BOOL } : { bytes: [1] },
          ...(nonce ? [{ bytes: [1] }, { value: nonce, type: U8 }] : [{ bytes: [0] }]),
          { bytes: [1, 0] }, // tokenStandard Some(NonFungible)
          { bytes: [1, 0] }, // collection Some({ verified: false, … })
          { value: key, type: PUBKEY },
          { bytes: [0, 0] }, // uses None, tokenProgramVersion Original
          ...this.bubblegumCreators(props.get("creators")),
        ]);
        this.cpi(p, metas, data.buf, data.len, seedsAt(17));
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
    // The leaf an instruction replaces. "v2": { root, dataHash, creatorHash, assetDataHash?, flags?, nonce, index };
    // "delegate": the same with collectionHash? before assetDataHash; "meta": { root, assetDataHash?, flags?, nonce,
    // index } (the hashes come from the metadata passed); "v1": { root, dataHash, creatorHash, nonce, index }.
    const leafFields = (n: ts.Expression, shape: "v2" | "delegate" | "meta" | "v1" = "v2"): MplField[] => {
      const known =
        shape === "v1"
          ? ["root", "dataHash", "creatorHash", "nonce", "index"]
          : shape === "meta"
            ? ["root", "assetDataHash", "flags", "nonce", "index"]
            : ["root", "dataHash", "creatorHash", ...(shape === "delegate" ? ["collectionHash"] : []), "assetDataHash", "flags", "nonce", "index"];
      if (!ts.isObjectLiteralExpression(n)) this.fail(n, `the leaf is { ${known.join(", ")} }`);
      const props = new Map<string, ts.Expression>();
      for (const q of n.properties) {
        if (ts.isPropertyAssignment(q) && ts.isIdentifier(q.name)) props.set(q.name.text, q.initializer);
        else if (ts.isShorthandPropertyAssignment(q)) props.set(q.name.text, q.name);
        else this.fail(q, "write leaf fields as name: value");
      }
      for (const [k, v] of props) if (!known.includes(k)) this.fail(v, `the leaf has no field ${k}`);
      const need = (k: string) => props.get(k) ?? this.fail(n, `the leaf needs ${k}`);
      // Left out or null: None. A value that may be null at run time (`Hash | null`) goes as a Borsh Option.
      const opt = (k: string, t: ScalarType): MplField[] => {
        const v = props.get(k);
        if (!v || v.kind === ts.SyntaxKind.NullKeyword) return [{ bytes: [0] }];
        this.model.options.set(optionKey(t), t);
        return [{ value: v, type: { kind: "option", inner: t } as ValueType }];
      };
      const hashes: MplField[] =
        shape === "meta"
          ? []
          : [
              { value: need("dataHash"), type: HASH },
              { value: need("creatorHash"), type: HASH },
            ];
      const tail: MplField[] = [
        { value: need("nonce"), type: U64v },
        { value: need("index"), type: U32 },
      ];
      if (shape === "v1") return [{ value: need("root"), type: HASH }, ...hashes, ...tail];
      return [
        { value: need("root"), type: HASH },
        ...hashes,
        ...(shape === "delegate" ? opt("collectionHash", HASH as ScalarType) : []),
        ...opt("assetDataHash", HASH as ScalarType),
        ...opt("flags", U8 as ScalarType),
        ...tail,
      ];
    };
    // MetadataArgsV2 from { name, symbol, uri, sellerFeeBasisPoints, primarySaleHappened?, isMutable?, creators?,
    // collection? } (a leaf's current metadata: the program hashes it to check the leaf).
    const metadataV2 = (md: ts.Expression): MplField[] => {
      if (!ts.isObjectLiteralExpression(md))
        this.fail(md, "the metadata is { name, symbol, uri, sellerFeeBasisPoints, primarySaleHappened?, isMutable?, creators?, collection? }");
      const props = this.literalProps(
        md,
        ["name", "symbol", "uri", "sellerFeeBasisPoints", "primarySaleHappened", "isMutable", "creators", "collection"],
        "the metadata",
      );
      const need = (k: string) => props.get(k) ?? this.fail(md, `the metadata needs ${k}`);
      const fields: MplField[] = [
        { value: need("name"), type: STRING },
        { value: need("symbol"), type: STRING },
        { value: need("uri"), type: STRING },
        { value: need("sellerFeeBasisPoints"), type: { kind: "int", name: "u16" } },
      ];
      const flag = (k: string, dflt: number): MplField => (props.get(k) ? { value: props.get(k)!, type: BOOL } : { bytes: [dflt] });
      fields.push(flag("primarySaleHappened", 0), flag("isMutable", 1), { bytes: [1, 0] }); // token_standard: Some(NonFungible)
      fields.push(...this.bubblegumCreators(props.get("creators")));
      const coll = props.get("collection");
      if (!coll || coll.kind === ts.SyntaxKind.NullKeyword) fields.push({ bytes: [0] });
      else {
        this.model.options.set("pubkey", PUBKEY);
        fields.push({ value: coll, type: { kind: "option", inner: PUBKEY } as ValueType });
      }
      return fields;
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
    const op = BUBBLEGUM_OPS[method];
    if (op) {
      // accounts…, [leaf, metadata?, update?], proof, signerSeeds?
      const nAccounts = op.accounts.length;
      const extra = op.leaf === "meta" ? (method === "updateMetadataV2" ? 2 : 1) : 0;
      const proofAt = nAccounts + 1 + extra;
      if (a.length !== proofAt + 1 && a.length !== proofAt + 2)
        this.fail(
          node,
          `${method}(${op.accounts.map(([l, , , o]) => (o ? `${l} | null` : l)).join(", ")}, leaf${extra ? (extra === 2 ? ", currentMetadata, update" : ", metadata") : ""}, proof, signerSeeds?)`,
        );
      const hasSeeds = !!a[proofAt + 1];
      const metas = op.accounts.map(([label, w, s, optional, either], i): [string, boolean, boolean | string] => {
        if (!optional && a[i]!.kind === ts.SyntaxKind.NullKeyword) this.fail(a[i]!, `pass ${label}`);
        const m = this.mplMeta(a[i]!, bg, label, w, s);
        // V1 leaf owner / delegate: either may sign (a PDA owner signs with the seeds).
        if (either)
          return [
            m[0],
            w,
            either === "owner"
              ? `(${m[0]}->is_signer || ${hasSeeds})`
              : `(${m[0]}->is_signer || (${hasSeeds} && ${m[0]} == ${`a_${(this.accountParam(a[i - 1]!, "the leaf owner") as AccountParam).name}`}))`,
          ];
        return m;
      });
      const fields: MplField[] = [{ bytes: op.disc }, ...leafFields(a[nAccounts]!, op.leaf)];
      if (op.leaf === "meta") fields.push(...metadataV2(a[nAccounts + 1]!));
      if (method === "updateMetadataV2") fields.push(...this.bubblegumUpdateArgs(a[nAccounts + 2]!));
      const data = this.mplData(node, 2048, fields);
      this.cpi(p, metas as [string, boolean, boolean][], data.buf, data.len, seedsAt(proofAt + 1), proofRange(a[proofAt]!));
      return undefined;
    }
    this.fail(
      node.expression,
      `Bubblegum supports createTree, mint, mintToCollection, createTreeV2, mintV2, transferV2, burnV2, ${Object.keys(BUBBLEGUM_OPS).join(", ")}, not ${method}`,
    );
  }

  /** Vec<Creator> (address, verified, share) from a literal list; shares add up to 100 when literal. */
  protected bubblegumCreators(creators: ts.Expression | undefined): MplField[] {
    if (creators && !ts.isArrayLiteralExpression(creators)) this.fail(creators, "creators: [{ address, verified, share }, …] (an array literal)");
    const list = creators ? (creators as ts.ArrayLiteralExpression).elements : [];
    if (list.length > 5) this.fail(creators!, "Bubblegum takes at most 5 creators");
    const fields: MplField[] = [{ bytes: [list.length, 0, 0, 0] }];
    let shares = 0n;
    let constant = true;
    for (const el of list) {
      if (!ts.isObjectLiteralExpression(el)) this.fail(el, "a creator is { address, verified, share }");
      const props = this.literalProps(el, ["address", "verified", "share"], "a creator");
      const f = (k: string) => props.get(k) ?? this.fail(el, `a creator needs ${k}`);
      const share = f("share");
      if (ts.isBigIntLiteral(share)) shares += BigInt(share.text.slice(0, -1));
      else constant = false;
      fields.push({ value: f("address"), type: PUBKEY }, { value: f("verified"), type: BOOL }, { value: share, type: U8 });
    }
    if (list.length && constant && shares !== 100n) this.fail(creators!, `creator shares add up to ${shares}; Bubblegum requires 100`);
    return fields;
  }

  /** UpdateArgs: every field optional (left out or null: unchanged). */
  protected bubblegumUpdateArgs(n: ts.Expression): MplField[] {
    if (!ts.isObjectLiteralExpression(n))
      this.fail(n, "the update is { name?, symbol?, uri?, creators?, sellerFeeBasisPoints?, primarySaleHappened?, isMutable? }");
    const props = this.literalProps(n, ["name", "symbol", "uri", "creators", "sellerFeeBasisPoints", "primarySaleHappened", "isMutable"], "the update");
    const opt = (k: string, t: ValueType): MplField[] => {
      const v = props.get(k);
      return !v || v.kind === ts.SyntaxKind.NullKeyword ? [{ bytes: [0] }] : [{ bytes: [1] }, { value: v, type: t }];
    };
    const creators = props.get("creators");
    return [
      ...opt("name", STRING),
      ...opt("symbol", STRING),
      ...opt("uri", STRING),
      ...(creators && creators.kind !== ts.SyntaxKind.NullKeyword ? [{ bytes: [1] }, ...this.bubblegumCreators(creators)] : [{ bytes: [0] }]),
      ...opt("sellerFeeBasisPoints", { kind: "int", name: "u16" }),
      ...opt("primarySaleHappened", BOOL),
      ...opt("isMutable", BOOL),
    ];
  }
}
