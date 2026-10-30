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
import { writeClient } from "./tools/clientgen.js";
import { build, COMPILER_VERSION, SBPF_VERSIONS, type BuildResult, type Sbpf } from "./compiler/index.js";
import { loadOrCreateKeypair } from "./keys.js";
import { TEMPLATES, type TemplateName } from "./templates.js";

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
 * Building and testing only need the address: without the keypair (a fresh clone, CI) they use the recorded one,
 * and only deploying (`needKeypair`) refuses.
 */
export function programAddress(ws: Workspace, name: string, opts: { needKeypair?: boolean } = {}): { address: string; created: boolean; keyless?: boolean } {
  const paths = programPaths(ws, name);
  const recorded = ws.programs[name].address;
  if (recorded && !existsSync(paths.keypair) && !opts.needKeypair) return { address: recorded, created: false, keyless: true };
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
  opts: { sbpf?: Sbpf; profile?: boolean; needKeypair?: boolean } = {},
): { paths: ProgramPaths; address: string; created: boolean; keyless?: boolean; result: BuildResult; clientPath: string }[] {
  return names.map((name) => {
    const paths = programPaths(ws, name);
    const { address, created, keyless } = programAddress(ws, name, { needKeypair: opts.needKeypair });
    const result = build(paths.entry, paths.outDir, address, { sbpf: opts.sbpf ?? ws.sbpf, profile: opts.profile });
    // The TypeScript client (docs/client.md) is written with the build, from the same IDL.
    const clientPath = writeClient(result.idl, path.join(paths.outDir, `${result.model.name}.client.ts`)).path;
    return { paths, address, created, keyless, result, clientPath };
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

/** Create a project: typesol.json, one program from a template, its LiteSVM test, configs (editor settings included). Refuses to overwrite files. */
export function scaffold(dir: string, name: string, template: TemplateName = "counter"): string[] {
  const t = TEMPLATES[template];
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`program name "${name}" must be snake_case`);
  const files: Record<string, string> = {
    [CONFIG]: JSON.stringify({ programs: { [name]: { path: `programs/${name}.ts` } }, out: "target", sbpf: "v0" }, null, 2) + "\n",
    [`programs/${name}.ts`]: t.program,
    "programs/tsconfig.json":
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            strict: true,
            noEmit: true,
            types: [],
            lib: ["ES2022"],
            // TypeSOL's own errors in the editor (with the workspace's TypeScript; see docs/cli.md).
            plugins: [{ name: "typesol/ts-plugin" }],
          },
          include: ["**/*.ts"],
        },
        null,
        2,
      ) + "\n",
    [`tests/${name}.test.ts`]: t.test(name),
    "package.json":
      JSON.stringify(
        {
          name,
          private: true,
          type: "module",
          scripts: {
            build: "typesol build",
            // The tests and the typecheck import the client the build writes: build first.
            pretest: "typesol build --quiet",
            test: "vitest run",
            pretypecheck: "typesol build --quiet",
            typecheck: "tsc -p tsconfig.json",
            deploy: "typesol deploy",
          },
          engines: { node: ">=22.12" },
          devDependencies: {
            // Published as @typesol/cli, installed under the name programs import ("typesol", "typesol/workspace").
            typesol: `npm:@typesol/cli@^${COMPILER_VERSION}`,
            "@types/node": "^22.0.0",
            typescript: "^6.0.3",
            "@anchor-lang/core": "^1.2.1",
            "@solana/kit": "^8.5.0",
            litesvm: "^1.6.1",
            vitest: "^5.0.5",
            ...t.devDependencies,
          },
        },
        null,
        2,
      ) + "\n",
    // VS Code loads tsconfig plugins (typesol/ts-plugin) only with the workspace's TypeScript: offer to switch to it.
    ".vscode/settings.json":
      JSON.stringify({ "typescript.tsdk": "node_modules/typescript/lib", "typescript.enablePromptUseWorkspaceTsdk": true }, null, 2) + "\n",
    // target/deploy/*-keypair.json are the programs' addresses: never commit them, but keep a backup.
    ".gitignore":
      "node_modules/\n# target/deploy/*-keypair.json are the programs' addresses (and upgrade keys): never commit them, but BACK THEM UP.\n# Without it, a fresh clone still builds and tests at the address recorded in typesol.json, but cannot deploy.\ntarget/\n",
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

/**
 * Add a program to an existing project: programs/<name>.ts and tests/<name>.test.ts from a template, and its entry in
 * typesol.json. Returns the files written and the template's extra devDependencies the package.json lacks.
 */
export function addProgram(ws: Workspace, name: string, template: TemplateName = "counter"): { files: string[]; missing: string[] } {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`program name "${name}" must be snake_case`);
  if (ws.programs[name]) throw new Error(`${CONFIG} already has a program "${name}"`);
  const t = TEMPLATES[template];
  const files: Record<string, string> = { [`programs/${name}.ts`]: t.program, [`tests/${name}.test.ts`]: t.test(name) };
  const existing = Object.keys(files).filter((f) => existsSync(path.join(ws.root, f)));
  if (existing.length) throw new Error(`refusing to overwrite: ${existing.join(", ")}`);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(ws.root, file)), { recursive: true });
    writeFileSync(path.join(ws.root, file), text);
  }
  const raw = JSON.parse(readFileSync(ws.file, "utf8")) as { programs: Record<string, string | ProgramEntry> };
  raw.programs[name] = { path: `programs/${name}.ts` };
  writeFileSync(ws.file, JSON.stringify(raw, null, 2) + "\n");
  ws.programs[name] = { path: `programs/${name}.ts` };
  const pkgFile = path.join(ws.root, "package.json");
  const pkg = existsSync(pkgFile)
    ? (JSON.parse(readFileSync(pkgFile, "utf8")) as { devDependencies?: Record<string, string>; dependencies?: Record<string, string> })
    : {};
  const have = { ...pkg.dependencies, ...pkg.devDependencies };
  const missing = Object.entries(t.devDependencies ?? {})
    .filter(([dep]) => !(dep in have))
    .map(([dep, v]) => `${dep}@${v}`);
  return { files: [...Object.keys(files), CONFIG], missing };
}
