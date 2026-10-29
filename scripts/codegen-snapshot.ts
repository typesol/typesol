/**
 * The generated C and IDL of every program in the repository (examples, test fixtures, ports, Anchor twins), one
 * file each plus a SUMS list, for refactors that must not change the output:
 *
 *   pnpm build && node scripts/codegen-snapshot.ts /tmp/before
 *   … refactor …
 *   pnpm build && node scripts/codegen-snapshot.ts /tmp/after && diff /tmp/before/SUMS /tmp/after/SUMS
 *
 * Files that do not compile on their own (libraries imported by others) are recorded with their errors, so a change
 * in those shows up too.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CompileError, generate } from "../dist/compiler/index.js";
import { buildIdl } from "../dist/compiler/idl.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = process.argv[2];
if (!out) throw new Error("usage: node scripts/codegen-snapshot.ts <out-dir>");
mkdirSync(out, { recursive: true });

const files: string[] = [];
const walk = (dir: string) => {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (f === "node_modules" || f === "target") continue;
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts")) files.push(p);
  }
};
for (const d of ["examples", "test/fixtures", "test/ports", "test/anchor-twins"]) {
  try {
    walk(path.join(root, d));
  } catch {
    /* not there */
  }
}

const sums: string[] = [];
let generated = 0;
for (const file of files.sort()) {
  const rel = path.relative(root, file);
  let text: string;
  try {
    const g = generate(file);
    text = `${g.c}\n/* IDL */\n${JSON.stringify(buildIdl(g.model, "11111111111111111111111111111111"), null, 1)}`;
    generated++;
  } catch (e) {
    if (!(e instanceof CompileError)) throw e;
    text = `ERROR ${e.diagnostics.map((d) => d.message).join(" | ")}`;
  }
  sums.push(`${createHash("sha256").update(text).digest("hex")}  ${rel}`);
  writeFileSync(path.join(out, `${rel.replaceAll("/", "__")}.out`), text);
}
writeFileSync(path.join(out, "SUMS"), `${sums.join("\n")}\n`);
console.log(`${files.length} files, ${generated} generated, ${files.length - generated} recorded with their errors → ${out}`);
