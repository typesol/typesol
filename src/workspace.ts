/**
 * Projects: `typesol init` scaffolds one, `typesol.json` lists its programs, `typesol build` / `typesol deploy`
 * work on all of them.
 *
 *   {
 *     "programs": { "counter": { "path": "programs/counter.ts", "address": "…" } },
 *     "out": "target",
 *     "sbpf": "v0"
 *   }
 *
 * Program keypairs live in `<out>/deploy/<name>-keypair.json` (created on first build; keep them, never commit them).
 * The address is recorded in typesol.json on first build, so a lost or swapped keypair is caught before deploying.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { writeClient } from "./clientgen.js";
import { build, COMPILER_VERSION, SBPF_VERSIONS, type BuildResult, type Sbpf } from "./compiler/index.js";
import { loadOrCreateKeypair } from "./keys.js";

export const CONFIG = "typesol.json";

/** A program entry in typesol.json: its entry file and (recorded on first build) its address. */
export interface ProgramEntry {
  path: string;
  address?: string;
}

export interface Workspace {
  root: string;
  file: string;
  programs: Record<string, ProgramEntry>;
  out: string;
  sbpf: Sbpf;
}

export function findWorkspace(dir: string): Workspace | undefined {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const file = path.join(d, CONFIG);
    if (existsSync(file)) return readWorkspace(file);
    if (path.dirname(d) === d) return undefined;
  }
}

function readWorkspace(file: string): Workspace {
  let raw: { programs?: Record<string, string | ProgramEntry>; out?: string; sbpf?: Sbpf };
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file}: not valid JSON (${(e as Error).message})`);
  }
  if (raw.sbpf !== undefined && !SBPF_VERSIONS.includes(raw.sbpf)) throw new Error(`${file}: "sbpf" must be one of ${SBPF_VERSIONS.join(", ")}`);
  if (raw.out !== undefined && typeof raw.out !== "string") throw new Error(`${file}: "out" must be a directory path`);
  if (!raw.programs || typeof raw.programs !== "object" || !Object.keys(raw.programs).length)
    throw new Error(`${file}: "programs" must map names to entry files`);
  const programs: Record<string, ProgramEntry> = {};
  for (const [name, entry] of Object.entries(raw.programs)) {
    const e = typeof entry === "string" ? { path: entry } : entry;
    if (!/^[a-z][a-z0-9_]*$/.test(name) || !e || typeof e.path !== "string" || (e.address !== undefined && typeof e.address !== "string"))
      throw new Error(`${file}: program "${name}" needs a snake_case name and { "path": "…", "address"?: "…" } (or just the path)`);
    programs[name] = e;
  }
  return { root: path.dirname(file), file, programs, out: raw.out ?? "target", sbpf: raw.sbpf ?? "v0" };
}

export interface ProgramPaths {
  name: string;
  entry: string;
  outDir: string;
  keypair: string;
}

export function programPaths(ws: Workspace, name: string): ProgramPaths {
  const entry = ws.programs[name];
  if (!entry) throw new Error(`no program "${name}" in ${CONFIG} (have: ${Object.keys(ws.programs).join(", ")})`);
  const out = path.resolve(ws.root, ws.out);
  return { name, entry: path.resolve(ws.root, entry.path), outDir: path.join(out, name), keypair: path.join(out, "deploy", `${name}-keypair.json`) };
}

/** The configured program whose entry file is `file`, if any. */
export function programForEntry(ws: Workspace, file: string): string | undefined {
  const abs = path.resolve(file);
  return Object.keys(ws.programs).find((n) => programPaths(ws, n).entry === abs);
}

/**
 * The program's keypair (created on first use) checked against the address recorded in typesol.json, which is
 * recorded on first build. A mismatch means the keypair was lost or replaced: deploying would create a new program.
 */
export function programAddress(ws: Workspace, name: string): { address: string; created: boolean } {
  const paths = programPaths(ws, name);
  const recorded = ws.programs[name].address;
  if (recorded && !existsSync(paths.keypair))
    throw new Error(
      `${name}: ${path.relative(ws.root, paths.keypair)} is missing, but ${CONFIG} records ${recorded}. Restore the keypair (it is the program's address); removing "address" from ${CONFIG} would give the program a new address.`,
    );
  mkdirSync(path.dirname(paths.keypair), { recursive: true });
  const { address, created } = loadOrCreateKeypair(paths.keypair);
  if (recorded && recorded !== address)
    throw new Error(`${name}: ${path.relative(ws.root, paths.keypair)} is ${address}, but ${CONFIG} records ${recorded}. Restore the right keypair.`);
  if (!recorded) {
    const raw = JSON.parse(readFileSync(ws.file, "utf8")) as { programs: Record<string, string | ProgramEntry> };
    raw.programs[name] = { path: ws.programs[name].path, address };
    writeFileSync(ws.file, JSON.stringify(raw, null, 2) + "\n");
    ws.programs[name].address = address;
  }
  return { address, created };
}

/** Build every program (or the ones named). */
export function buildWorkspace(
  ws: Workspace,
  names = Object.keys(ws.programs),
  opts: { sbpf?: Sbpf; profile?: boolean } = {},
): { paths: ProgramPaths; address: string; created: boolean; result: BuildResult; clientPath: string }[] {
  return names.map((name) => {
    const paths = programPaths(ws, name);
    const { address, created } = programAddress(ws, name);
    const result = build(paths.entry, paths.outDir, address, { sbpf: opts.sbpf ?? ws.sbpf, profile: opts.profile });
    // The TypeScript client (docs/client.md) is written with the build, from the same IDL.
    const clientPath = writeClient(result.idl, path.join(paths.outDir, `${result.model.name}.client.ts`)).path;
    return { paths, address, created, result, clientPath };
  });
}

/** The `solana program deploy` arguments for one built program (deploying again upgrades it). */
export function deployArgs(soPath: string, keypair: string, opts: { url?: string; payer?: string; config?: string }): string[] {
  const args = ["program", "deploy", soPath, "--program-id", keypair, "--use-rpc"];
  if (opts.config) args.unshift("-C", opts.config);
  if (opts.url) args.push("--url", opts.url);
  if (opts.payer) args.push("--keypair", opts.payer);
  return args;
}

const PROGRAM = `import { type Account, type Init, type Mut, type Pubkey, type Signer, type SystemProgram, type u8, type u64, require } from "typesol";

export interface Counter {
  authority: Pubkey;
  count: u64;
  bump: u8;
}

export enum CounterError {
  Unauthorized = "Only the counter's authority can change it",
}

/** Create the caller's counter at PDA ["counter", authority]. */
export function initialize(authority: Mut<Signer>, counter: Init<Counter>, systemProgram: SystemProgram): void {
  counter.bump = counter.create(authority, ["counter", authority.key]);
  counter.authority = authority.key;
  counter.count = 0n;
}

export function increment(authority: Signer, counter: Mut<Counter>, by: u64): void {
  require(counter.authority === authority.key, CounterError.Unauthorized);
  counter.count += by;
}

export function assertAtLeast(counter: Account<Counter>, min: u64): void {
  require(counter.count >= min, "counter is below the expected minimum");
}
`;

const TEST = (name: string) => `// Runs the program in LiteSVM (an in-process Solana runtime): \`npm test\`.
import { BN, BorshCoder, type Idl } from "@anchor-lang/core";
import {
  AccountRole,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkspace, findWorkspace } from "typesol/workspace";
import { beforeAll, describe, expect, it } from "vitest";

const SYSTEM = "11111111111111111111111111111111" as Address;
const ws = findWorkspace(path.dirname(fileURLToPath(import.meta.url)))!;

describe("${name}", () => {
  const svm = new LiteSVM();
  let programId: Address;
  let coder: BorshCoder;
  beforeAll(() => {
    const [built] = buildWorkspace(ws, ["${name}"]);
    programId = built.address as Address;
    svm.addProgramFromFile(programId, built.result.soPath);
    coder = new BorshCoder(built.result.idl as unknown as Idl);
  });

  const ix = (name: string, args: object, accounts: { address: Address; signer?: KeyPairSigner; writable?: boolean }[]): Instruction => ({
    programAddress: programId,
    accounts: accounts.map((a) => ({
      address: a.address,
      role: a.signer ? (a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY,
      ...(a.signer ? { signer: a.signer } : {}),
    })) as Instruction["accounts"],
    data: new Uint8Array(coder.instruction.encode(name, args)),
  });
  const send = async (payer: KeyPairSigner, ixs: Instruction[]) => {
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
  };

  it("initializes and increments the caller's counter", async () => {
    const alice = await generateKeyPairSigner();
    svm.airdrop(alice.address, lamports(1_000_000_000n));
    const [counter] = await getProgramDerivedAddress({ programAddress: programId, seeds: ["counter", getAddressEncoder().encode(alice.address)] });
    const me = { address: alice.address, signer: alice, writable: true };
    expect(await send(alice, [ix("initialize", {}, [me, { address: counter, writable: true }, { address: SYSTEM }])])).not.toBeInstanceOf(FailedTransactionMetadata);
    expect(await send(alice, [ix("increment", { by: new BN(5) }, [{ address: alice.address, signer: alice }, { address: counter, writable: true }])])).not.toBeInstanceOf(FailedTransactionMetadata);
    const account = svm.getAccount(counter);
    if (!account.exists) throw new Error("counter was not created");
    const state = coder.accounts.decode("Counter", Buffer.from(account.data));
    expect(state.count.toString()).toBe("5");
  });
});
`;

/** Create a project: typesol.json, one program, a LiteSVM test, configs. Refuses to overwrite files. */
export function scaffold(dir: string, name: string): string[] {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`program name "${name}" must be snake_case`);
  const files: Record<string, string> = {
    [CONFIG]: JSON.stringify({ programs: { [name]: { path: `programs/${name}.ts` } }, out: "target", sbpf: "v0" }, null, 2) + "\n",
    [`programs/${name}.ts`]: PROGRAM,
    "programs/tsconfig.json":
      JSON.stringify(
        {
          compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, noEmit: true, types: [], lib: ["ES2022"] },
          include: ["**/*.ts"],
        },
        null,
        2,
      ) + "\n",
    [`tests/${name}.test.ts`]: TEST(name),
    "package.json":
      JSON.stringify(
        {
          name,
          private: true,
          type: "module",
          scripts: { build: "typesol build", test: "vitest run", typecheck: "tsc -p tsconfig.json", deploy: "typesol deploy" },
          engines: { node: ">=22.12" },
          devDependencies: {
            typesol: `^${COMPILER_VERSION}`,
            "@types/node": "^22.0.0",
            typescript: "^6.0.3",
            "@anchor-lang/core": "^1.2.1",
            "@solana/kit": "^8.5.0",
            litesvm: "^1.6.1",
            vitest: "^5.0.5",
          },
        },
        null,
        2,
      ) + "\n",
    // target/deploy/*-keypair.json are the programs' addresses: never commit them, but keep a backup.
    ".gitignore":
      "node_modules/\n# target/deploy/*-keypair.json are the programs' addresses (and upgrade keys): never commit them, but BACK THEM UP.\n# A fresh clone cannot build or deploy a program whose address is recorded in typesol.json without its keypair.\ntarget/\n",
    "tsconfig.json":
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            types: ["node"],
          },
          include: ["tests/**/*.ts"],
        },
        null,
        2,
      ) + "\n",
  };
  const existing = Object.keys(files).filter((f) => existsSync(path.join(dir, f)));
  if (existing.length) throw new Error(`refusing to overwrite: ${existing.join(", ")}`);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  return Object.keys(files);
}
