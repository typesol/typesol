import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import ts from "typescript";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { analyze } from "./analyze.js";
import { emitProgram, type EmitOptions } from "./emit/index.js";
import { buildIdl } from "./idl.js";
import { buildSharedObject, toolchainVersion, type Sbpf } from "./toolchain.js";
import { RUNTIME_DIR } from "./toolchain.js";
import type { ProgramModel } from "./model.js";

export { CompileError, formatDiagnostic, type Diagnostic } from "./diagnostics.js";
export type { ProgramModel } from "./model.js";
export { SBPF_VERSIONS, type Sbpf } from "./toolchain.js";

export interface Generated {
  model: ProgramModel;
  c: string;
  /** The TypeSOL source files of the program (entry and relative imports). */
  files: string[];
}

/** Typecheck, enforce the TypeSOL subset, and generate C. Throws CompileError with every diagnostic. */
export function generate(entry: string, opts: EmitOptions = {}): Generated {
  const analysis = analyze(entry);
  analysis.reporter.throwIfAny();
  const c = emitProgram(analysis, opts);
  analysis.reporter.throwIfAny();
  return { model: analysis.model, c, files: analysis.files };
}

/** What a build was made from, written next to it as <name>.build.json (see `typesol verify`). */
export interface BuildManifest {
  program: string;
  compiler: string;
  clang: string;
  /** The TypeScript version that type-checked the sources (pinned: it decides what compiles). */
  typescript: string;
  sbpf: Sbpf;
  profile: boolean;
  /** sha256 of each source file of the program (relative to the entry's directory) and of the runtime header. */
  sources: Record<string, string>;
  /** sha256 of the .so. */
  binary: string;
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

export interface BuildResult extends Generated {
  manifest: BuildManifest;
  manifestPath: string;
  soPath: string;
  cPath: string;
  idlPath: string;
  idl: ReturnType<typeof buildIdl>;
}

/** Full build: `<outDir>/<name>.c`, `<name>.so`, `<name>.json` (Anchor IDL). */
export function build(entry: string, outDir: string, programAddress: string, opts: { sbpf?: Sbpf; profile?: boolean } = {}): BuildResult {
  const gen = generate(entry, { profile: opts.profile });
  mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, gen.model.name);
  const cPath = `${base}.c`;
  const soPath = `${base}.so`;
  const idlPath = `${base}.json`;
  writeFileSync(cPath, gen.c);
  buildSharedObject(cPath, soPath, opts.sbpf);
  const idl = buildIdl(gen.model, programAddress);
  writeFileSync(idlPath, JSON.stringify(idl, null, 2) + "\n");
  const root = path.dirname(path.resolve(entry));
  const sources: Record<string, string> = {};
  for (const f of gen.files) sources[path.relative(root, f)] = sha256(readFileSync(f));
  sources["<runtime>/typesol_rt.h"] = sha256(readFileSync(path.join(RUNTIME_DIR, "typesol_rt.h")));
  const manifest: BuildManifest = {
    program: gen.model.name,
    compiler: COMPILER_VERSION,
    clang: toolchainVersion(),
    typescript: ts.version,
    sbpf: opts.sbpf ?? "v0",
    profile: !!opts.profile,
    sources,
    binary: sha256(readFileSync(soPath)),
  };
  const manifestPath = `${base}.build.json`;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { ...gen, cPath, soPath, idlPath, idl, manifest, manifestPath };
}

/** The package version (one source: package.json), recorded in build manifests and shown by the CLI. */
export const COMPILER_VERSION: string = (createRequire(import.meta.url)("../../package.json") as { version: string }).version;

/**
 * Whether `deployed` (a .so, e.g. from `solana program dump`) is exactly what `entry` builds to. Program accounts
 * keep the ELF zero-padded to their allocation, so trailing zeros are ignored.
 */
export function verifyBinary(deployed: Buffer, built: Buffer): boolean {
  let end = deployed.length;
  while (end > built.length && deployed[end - 1] === 0) end--;
  return end === built.length && deployed.subarray(0, end).equals(built);
}
