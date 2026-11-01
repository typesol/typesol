/**
 * A release's manifest: the compiler and toolchain that built it, and the sha256 of the SBF binary, IDL and C that
 * every program in a source tree builds to, with the reference binaries the differential tests compare against and
 * the test corpus. Two manifests of the same sources diff program by program, so anyone can check a claim such as
 * "programs that use none of the new features build to the same binaries", or redo it after either side upgrades.
 *
 *   node scripts/release-manifest.ts --out manifest.json
 *   node scripts/release-manifest.ts --compiler node_modules/@typesol/cli --sources ../typesol-0.37.0 --out a.json
 *   node scripts/release-manifest.ts --diff a.json b.json
 *
 * --compiler: a @typesol/cli package (or this checkout, the default; run `pnpm build` first). --sources: the tree
 * whose examples/ and ports (showcase/program-examples/, or showcase/ after 0.38.0) are built (default: this checkout). Every program is built at one address, so
 * the IDLs compare too.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ADDRESS = "11111111111111111111111111111112";
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const here = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

type Manifest = {
  compiler: string;
  toolchain: { clang: string; platformTools?: string; node: string; typescript: string; runtime: string };
  sources: { root: string; commit?: string };
  programs: Record<string, { so: string; idl: string; c: string; bytes: number } | { error: string }>;
  references: Record<string, string>;
  corpus: { files: number; sha256: string };
};

if (args[0] === "--diff") {
  const [a, b] = [args[1], args[2]].map((f) => JSON.parse(readFileSync(f!, "utf8")) as Manifest);
  const names = [...new Set([...Object.keys(a!.programs), ...Object.keys(b!.programs)])].sort();
  const rows = { same: [] as string[], binary: [] as string[], idl: [] as string[], only: [] as string[] };
  for (const n of names) {
    const [x, y] = [a!.programs[n], b!.programs[n]];
    if (!x || !y || "error" in x || "error" in y) {
      if (!x || !y || "error" in x !== "error" in y) rows.only.push(n);
      continue;
    }
    if (x.so === y.so && x.idl === y.idl) rows.same.push(n);
    else if (x.so !== y.so) rows.binary.push(n);
    else rows.idl.push(n);
  }
  console.log(`${a!.compiler} → ${b!.compiler}`);
  console.log(`  same binary and IDL: ${rows.same.length}`);
  console.log(`  binary differs: ${rows.binary.length}${rows.binary.length ? `\n    ${rows.binary.join("\n    ")}` : ""}`);
  console.log(`  IDL differs (same binary): ${rows.idl.length}${rows.idl.length ? `\n    ${rows.idl.join("\n    ")}` : ""}`);
  console.log(`  built by only one: ${rows.only.length}${rows.only.length ? `\n    ${rows.only.join("\n    ")}` : ""}`);
  process.exit(0);
}

const compilerRoot = path.resolve(opt("--compiler") ?? here);
const sourceRoot = path.resolve(opt("--sources") ?? here);
const out = opt("--out") ?? "manifest.json";
const compiler = (await import(pathToFileURL(path.join(compilerRoot, "dist/compiler/index.js")).href)) as {
  build: (entry: string, outDir: string, address: string) => { soPath: string; idlPath: string; cPath: string };
  COMPILER_VERSION: string;
};
const toolchain = (await import(pathToFileURL(path.join(compilerRoot, "dist/compiler/toolchain.js")).href)) as {
  toolchainVersion: () => string;
  findToolchain: () => { clang: string };
};
const ts = (await import(pathToFileURL(path.join(compilerRoot, "node_modules/typescript/lib/typescript.js")).href).catch(() => import("typescript"))) as {
  default?: { version: string };
  version?: string;
};

const files = (dir: string): string[] => {
  let found: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const f of entries.sort()) {
    const p = path.join(dir, f);
    if (f === "node_modules" || f === "target") continue;
    if (statSync(p).isDirectory()) found = found.concat(files(p));
    else found.push(p);
  }
  return found;
};

const programs: Manifest["programs"] = {};
const scratch = mkdtempSync(path.join(os.tmpdir(), "typesol-manifest-"));
// The programs: examples/, and the mainnet ports and program-examples ports (showcase/program-examples up to 0.38.0, showcase/ after).
const roots = ["examples", "showcase/program-examples", "showcase/mainnet", "showcase/program-examples"]
  .map((d) => path.join(sourceRoot, d))
  .filter((d) => existsSync(d));
const entries = roots.flatMap((d) => files(d)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"));
for (const [i, entry] of entries.entries()) {
  const rel = path.relative(sourceRoot, entry);
  try {
    const r = compiler.build(entry, path.join(scratch, String(i)), ADDRESS);
    const so = readFileSync(r.soPath);
    programs[rel] = { so: sha256(so), idl: sha256(readFileSync(r.idlPath)), c: sha256(readFileSync(r.cPath)), bytes: so.length };
  } catch (e) {
    // Files that are not programs on their own (modules other files import) are listed with why.
    programs[rel] = {
      error: String((e as Error).message)
        .split("\n")[0]!
        .replace(sourceRoot, ".")
        .slice(0, 200),
    };
  }
}
rmSync(scratch, { recursive: true, force: true });

const references: Manifest["references"] = {};
for (const f of files(path.join(sourceRoot, "test/programs"))) if (f.endsWith(".so")) references[path.relative(sourceRoot, f)] = sha256(readFileSync(f));
const corpus = files(path.join(sourceRoot, "test")).filter((f) => !f.endsWith(".so"));
const corpusHash = createHash("sha256");
for (const f of corpus)
  corpusHash
    .update(`${path.relative(sourceRoot, f)}\0`)
    .update(readFileSync(f))
    .update("\0");
let commit: string | undefined;
try {
  commit = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  /* not a checkout */
}
const clang = toolchain.findToolchain().clang;
const manifest: Manifest = {
  compiler: compiler.COMPILER_VERSION,
  toolchain: {
    clang: toolchain.toolchainVersion(),
    platformTools: /platform-tools-sdk\/sbf|\/(v\d+\.\d+[^/]*)\//.exec(clang)?.[1],
    node: process.version,
    typescript: ts.default?.version ?? ts.version ?? "",
    runtime: sha256(readFileSync(path.join(compilerRoot, "runtime/typesol_rt.h"))),
  },
  sources: { root: path.basename(sourceRoot), ...(commit ? { commit } : {}) },
  programs,
  references,
  corpus: { files: corpus.length, sha256: corpusHash.digest("hex") },
};
writeFileSync(out, `${JSON.stringify(manifest, null, 1)}\n`);
const built = Object.values(programs).filter((p) => !("error" in p)).length;
console.log(`${built} programs built (${entries.length - built} modules), ${Object.keys(references).length} reference binaries → ${out}`);
