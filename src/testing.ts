/**
 * `typesol/testing`: test a project's program in LiteSVM (an in-process Solana runtime) without the boilerplate.
 *
 *   const t = await testProgram("counter", import.meta.url);
 *   const alice = await t.wallet();
 *   const counter = await t.pda("counter", alice);
 *   t.ok(await t.send(alice, t.ix("initialize", {}, { authority: alice, counter })));
 *   t.ok(await t.send(alice, t.ix("increment", { by: 5n }, { authority: alice, counter })));
 *   expect((await t.account("Counter", counter))?.count).toBe(5n);
 *
 * Accounts are passed by name; their signer / writable flags and fixed addresses (system program, token programs…)
 * come from the IDL, as Anchor's `.accounts({...})` does, and PDAs seeded by constants, arguments or other accounts'
 * keys are derived when left out. Arguments take plain values: bigints or numbers for
 * integers, address strings for Pubkeys, null for an empty Option. Decoded accounts and return data come back the
 * same way (bigints, address strings).
 *
 * Needs `litesvm` and `@anchor-lang/core`, which `typesol init` projects have.
 */
import anchor, { type Idl } from "@anchor-lang/core";
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  AccountRole,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  isAddress,
  isOffCurveAddress,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM, TransactionMetadata } from "litesvm";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkspace, findWorkspace } from "./workspace.js";

// @anchor-lang/core is CommonJS: Node 22 cannot import its classes by name from an installed ES module.
const { BN, BorshCoder } = anchor;
type BN = InstanceType<typeof BN>;
type BorshCoder = InstanceType<typeof BorshCoder>;

export type Result = TransactionMetadata | FailedTransactionMetadata;
/** An account for an instruction: an address, a keypair (which then signs), or null to leave an optional one out. */
export type AccountInput = Address | KeyPairSigner | null;
/**
 * A PDA seed: text, an address (or keypair), raw bytes, or a bigint as a little-endian u64. A string that is a valid
 * address is taken as one; pass `new TextEncoder().encode(s)` for text that happens to look like an address.
 */
export type SeedInput = string | Address | KeyPairSigner | Uint8Array | bigint;

type IdlType = string | { option: IdlType } | { vec: IdlType } | { array: [IdlType, number] } | { defined: { name: string } };
type IdlSeed = { kind: "const"; value: number[] } | { kind: "arg"; path: string } | { kind: "account"; path: string };
interface IdlAccountItem {
  name: string;
  writable?: boolean;
  signer?: boolean;
  optional?: boolean;
  address?: string;
  pda?: { seeds: IdlSeed[]; program?: IdlSeed };
}
interface ProgramIdl {
  address: string;
  instructions: { name: string; accounts: IdlAccountItem[]; args: { name: string; type: IdlType }[]; returns?: IdlType }[];
  types?: { name: string; type: { kind: string; fields?: { name: string; type: IdlType }[] } }[];
}

const BIG = new Set(["u64", "i64", "u128", "i128"]);
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const isSigner = (v: unknown): v is KeyPairSigner => typeof v === "object" && v !== null && "address" in v && "signTransactions" in v;

export interface TestProgram {
  svm: LiteSVM;
  programId: Address;
  idl: Idl;
  coder: BorshCoder;
  /** A new keypair funded with `sol` SOL (default 10). */
  wallet(sol?: number): Promise<KeyPairSigner>;
  /** The program's PDA for these seeds. */
  pda(...seeds: SeedInput[]): Promise<Address>;
  /** The PDA and its bump. */
  pdaWithBump(...seeds: SeedInput[]): Promise<[Address, number]>;
  /** An instruction of this program, accounts by name (`authority` or `authority`'s snake_case), args as plain values. */
  ix(
    name: string,
    args?: Record<string, unknown>,
    accounts?: Record<string, AccountInput>,
    remaining?: { address: Address; writable?: boolean; signer?: KeyPairSigner }[],
  ): Instruction;
  /** Send instructions in one transaction paid by `payer` (keypairs passed as accounts sign too). */
  send(payer: KeyPairSigner, ...ixs: Instruction[]): Promise<Result>;
  /** The successful result, or a thrown error with the program's logs. */
  ok(res: Result): TransactionMetadata;
  /** The custom error code of a failed transaction (6000+ for the program's error enums); throws if it succeeded. */
  errorCode(res: Result): number;
  /** An account of this program decoded by its IDL type, or null when it does not exist. */
  account<T = Record<string, unknown>>(type: string, address: Address): Promise<T | null>;
  /** A successful instruction's return data, decoded by its IDL `returns` type. */
  returned<T = unknown>(instruction: string, res: Result): T;
  /** Lamports of any account (0 when it does not exist). */
  balance(address: Address): bigint;
}

/** Build `program` of the project around `from` (a file URL such as import.meta.url, or a directory) and load it. */
export async function testProgram(program: string, from: string | URL): Promise<TestProgram> {
  const start = typeof from === "string" && !from.startsWith("file:") ? from : path.dirname(fileURLToPath(from));
  const ws = findWorkspace(start);
  if (!ws) throw new Error(`no typesol.json at or above ${start}`);
  if (!ws.programs[program]) throw new Error(`typesol.json has no program "${program}" (it has ${Object.keys(ws.programs).join(", ")})`);
  const [built] = buildWorkspace(ws, [program]);
  const svm = new LiteSVM();
  const programId = built.address as Address;
  svm.addProgramFromFile(programId, built.result.soPath);
  return programHarness(svm, programId, built.result.idl as unknown as Idl);
}

/** The same helpers for a program already loaded into `svm` at `programId` with this IDL. */
export function programHarness(svm: LiteSVM, programId: Address, idl: Idl): TestProgram {
  const coder = new BorshCoder(idl);
  const pidl = idl as unknown as ProgramIdl;
  const types = new Map((pidl.types ?? []).map((t) => [t.name, t]));
  const enc = getAddressEncoder();

  /** A plain value → what the Anchor coder expects for `type`. */
  const toCoder = (v: unknown, type: IdlType, where: string): unknown => {
    if (typeof type === "string") {
      if (BIG.has(type)) return new BN(String(v));
      if (/^[ui](8|16|32)$/.test(type)) return Number(v);
      if (type === "pubkey") {
        const a = isSigner(v) ? v.address : (v as string);
        if (typeof a !== "string" || !isAddress(a)) throw new Error(`${where}: expected an address`);
        return { toBuffer: () => Buffer.from(enc.encode(a)) };
      }
      return v;
    }
    if ("option" in type) return v === null || v === undefined ? null : toCoder(v, type.option, where);
    if ("vec" in type) return (v as unknown[]).map((x, i) => toCoder(x, type.vec, `${where}[${i}]`));
    if ("array" in type) return (v as unknown[]).map((x, i) => toCoder(x, type.array[0], `${where}[${i}]`));
    const def = types.get(type.defined.name);
    if (def?.type.kind === "struct" && def.type.fields && typeof v === "object" && v !== null) {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(def.type.fields.map((f) => [f.name, toCoder(o[f.name] ?? o[camel(f.name)], f.type, `${where}.${f.name}`)]));
    }
    return v;
  };

  /** What the coder decodes → plain values (bigints, address strings), recursively. */
  const plain = (v: unknown): unknown => {
    if (v === null || v === undefined) return v;
    if (BN.isBN(v)) return BigInt((v as BN).toString());
    if (typeof v === "object" && typeof (v as { toBase58?: unknown }).toBase58 === "function") return (v as { toBase58(): string }).toBase58();
    if (Array.isArray(v)) return v.map(plain);
    if (v instanceof Uint8Array) return v;
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o).sort().join(",");
      // Account data keeps Options and FixedStrings in a fixed layout; give them back as the plain value / string.
      if (keys === "is_some,value") return o.is_some ? plain(o.value) : null;
      if (keys === "bytes,len" && Array.isArray(o.bytes)) return Buffer.from((o.bytes as number[]).slice(0, Number(o.len))).toString("utf8");
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, plain(x)]));
    }
    return v;
  };

  /** find_program_address, synchronously (sha256 + the curve check), so ix() can fill PDAs in. */
  const findPda = (seeds: Uint8Array[], program: Address): Address => {
    for (let bump = 255; bump >= 0; bump--) {
      const h = createHash("sha256");
      for (const s of seeds) h.update(s);
      h.update(Uint8Array.of(bump));
      h.update(new Uint8Array(enc.encode(program)));
      h.update("ProgramDerivedAddress");
      const a = getAddressDecoder().decode(h.digest());
      if (isOffCurveAddress(a)) return a;
    }
    throw new Error("no off-curve bump for these seeds");
  };

  /** An argument's bytes as a seed: little-endian integers at their width, bool as one byte, Pubkey, UTF-8 text. */
  const argSeed = (v: unknown, type: IdlType): Uint8Array | undefined => {
    if (typeof type !== "string" || v === undefined || v === null) return undefined;
    const int = /^([ui])(8|16|32|64|128)$/.exec(type);
    if (int) {
      const bytes = Number(int[2]) / 8;
      let n = BigInt.asUintN(bytes * 8, BigInt(v as bigint | number));
      const out = new Uint8Array(bytes);
      for (let i = 0; i < bytes; i++, n >>= 8n) out[i] = Number(n & 0xffn);
      return out;
    }
    if (type === "bool") return Uint8Array.of(v ? 1 : 0);
    if (type === "pubkey") return new Uint8Array(enc.encode((isSigner(v) ? v.address : v) as Address));
    if (type === "string") return new TextEncoder().encode(v as string);
    return undefined;
  };

  const seedBytes = (s: SeedInput): Uint8Array => {
    if (s instanceof Uint8Array) return s;
    if (typeof s === "bigint") {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setBigUint64(0, s, true);
      return b;
    }
    if (isSigner(s)) return new Uint8Array(enc.encode(s.address));
    if (isAddress(s)) return new Uint8Array(enc.encode(s));
    return new TextEncoder().encode(s);
  };

  const harness: TestProgram = {
    svm,
    programId,
    idl,
    coder,
    async wallet(sol = 10) {
      const k = await generateKeyPairSigner();
      svm.airdrop(k.address, lamports(BigInt(Math.round(sol * 1e9))));
      return k;
    },
    async pda(...seeds) {
      return (await harness.pdaWithBump(...seeds))[0];
    },
    async pdaWithBump(...seeds) {
      const [a, bump] = await getProgramDerivedAddress({ programAddress: programId, seeds: seeds.map(seedBytes) });
      return [a, bump];
    },
    ix(name, args = {}, accounts = {}, remaining = []) {
      const def = pidl.instructions.find((i) => i.name === name || i.name === snake(name));
      if (!def) throw new Error(`the program has no instruction "${name}" (it has ${pidl.instructions.map((i) => i.name).join(", ")})`);
      const given = new Map(Object.entries(accounts).map(([k, v]) => [snake(k), v]));
      for (const k of given.keys()) if (!def.accounts.some((a) => a.name === k)) throw new Error(`${def.name} has no account "${k}"`);
      const argsIn = args as Record<string, unknown>;
      // PDAs whose seeds are constants, arguments or other accounts' keys are filled in, as the generated client does.
      const addressOf = (name: string): Address | undefined => {
        const v = given.get(name);
        return v === undefined || v === null ? undefined : isSigner(v) ? v.address : v;
      };
      for (let progress = true; progress;) {
        progress = false;
        for (const a of def.accounts) {
          if (given.has(a.name) || !a.pda || a.address) continue;
          const seed = (s: IdlSeed): Uint8Array | undefined => {
            if (s.kind === "const") return Uint8Array.from(s.value);
            if (s.kind === "account") {
              const at = s.path.includes(".") ? undefined : addressOf(s.path);
              return at && new Uint8Array(enc.encode(at));
            }
            const arg = def.args.find((x) => x.name === s.path);
            return arg && argSeed(argsIn[arg.name] ?? argsIn[camel(arg.name)], arg.type);
          };
          const seeds = a.pda.seeds.map(seed);
          const program = a.pda.program ? seed(a.pda.program) : new Uint8Array(enc.encode(programId));
          if (seeds.some((x) => x === undefined) || !program || program.length !== 32) continue;
          given.set(a.name, findPda(seeds as Uint8Array[], getAddressDecoder().decode(program)));
          progress = true;
        }
      }
      const metas = def.accounts.map((a) => {
        let v = given.has(a.name) ? given.get(a.name)! : undefined;
        if (v === undefined && a.address) v = a.address as Address;
        if (v === undefined || v === null) {
          if (!a.optional) throw new Error(`${def.name}: account "${camel(a.name)}" is required`);
          return { address: programId, role: AccountRole.READONLY }; // left out: the program's own id stands in
        }
        if (a.signer && !isSigner(v)) throw new Error(`${def.name}: account "${camel(a.name)}" signs; pass its keypair, not its address`);
        const address = isSigner(v) ? v.address : v;
        const role = a.signer
          ? a.writable
            ? AccountRole.WRITABLE_SIGNER
            : AccountRole.READONLY_SIGNER
          : a.writable
            ? AccountRole.WRITABLE
            : AccountRole.READONLY;
        return { address, role, ...(isSigner(v) && a.signer ? { signer: v } : {}) };
      });
      for (const r of remaining)
        metas.push({
          address: r.address,
          role: r.signer ? (r.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : r.writable ? AccountRole.WRITABLE : AccountRole.READONLY,
          ...(r.signer ? { signer: r.signer } : {}),
        });
      const a = args as Record<string, unknown>;
      const encoded = Object.fromEntries(def.args.map((x) => [x.name, toCoder(a[x.name] ?? a[camel(x.name)], x.type, `${def.name}(${camel(x.name)})`)]));
      return { programAddress: programId, accounts: metas, data: new Uint8Array(coder.instruction.encode(def.name, encoded)) } as unknown as Instruction;
    },
    async send(payer, ...ixs) {
      const tx = await pipe(
        createTransactionMessage({ version: 0 }),
        (t) => setTransactionMessageFeePayerSigner(payer, t),
        (t) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(t),
        (t) => appendTransactionMessageInstructions(ixs, t),
        (t) => signTransactionMessageWithSigners(t),
      );
      const res = svm.sendTransaction(tx);
      svm.expireBlockhash();
      return res;
    },
    ok(res) {
      if (res instanceof FailedTransactionMetadata) throw new Error(`transaction failed: ${String(res.err())}\n${res.meta().logs().join("\n")}`);
      return res;
    },
    errorCode(res) {
      if (!(res instanceof FailedTransactionMetadata)) throw new Error("expected the transaction to fail, but it succeeded");
      const m = /Custom\D*(\d+)/.exec(String(res.err()));
      if (!m) throw new Error(`not a custom program error: ${String(res.err())}\n${res.meta().logs().join("\n")}`);
      return Number(m[1]);
    },
    async account<T>(type: string, address: Address) {
      const a = svm.getAccount(address);
      if (!a.exists) return null;
      return plain(coder.accounts.decode(type, Buffer.from(a.data))) as T;
    },
    returned<T>(instruction: string, res: Result) {
      const def = pidl.instructions.find((i) => i.name === instruction || i.name === snake(instruction));
      if (!def?.returns) throw new Error(`${instruction} returns nothing`);
      const data = Buffer.from(harness.ok(res).returnData().data());
      const t = def.returns;
      if (typeof t === "string") {
        if (t === "pubkey") return getAddressDecoder().decode(data) as T;
        if (t === "bool") return (data[0] !== 0) as T;
        const signed = t.startsWith("i");
        const bytes = Number(t.slice(1)) / 8;
        let n = 0n;
        for (let i = bytes - 1; i >= 0; i--) n = (n << 8n) | BigInt(data[i]);
        if (signed && n >= 1n << BigInt(bytes * 8 - 1)) n -= 1n << BigInt(bytes * 8);
        return (bytes <= 4 ? Number(n) : n) as T;
      }
      if ("defined" in t) return plain(coder.types.decode(t.defined.name, data)) as T;
      throw new Error(`decode ${instruction}'s return data yourself (${JSON.stringify(t)})`);
    },
    balance(address) {
      return svm.getBalance(address) ?? 0n;
    },
  };
  return harness;
}
