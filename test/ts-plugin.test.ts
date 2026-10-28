// The editor plugin: TypeSOL's diagnostics through a real TypeScript language service, for the editor's text.
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const plugin = require("../ts-plugin/index.js") as (m: { typescript: typeof ts }) => { create(info: unknown): ts.LanguageService };

function project() {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "typesol-plugin-")));
  expect(spawnSync("node", [path.join(ROOT, "dist/cli.js"), "init", ".", "--name", "app"], { cwd: dir }).status).toBe(0);
  const file = path.join(dir, "programs/app.ts");
  const texts = new Map([[file, readFileSync(file, "utf8")]]);
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    paths: { typesol: [path.join(ROOT, "lib/typesol.d.ts")] },
    noEmit: true,
    types: [],
  };
  const versions = new Map<string, number>();
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => [...texts.keys()],
    getScriptVersion: (f) => String(versions.get(f) ?? 0),
    getScriptSnapshot: (f) => {
      const t = texts.get(f) ?? ts.sys.readFile(f);
      return t === undefined ? undefined : ts.ScriptSnapshot.fromString(t);
    },
    getCurrentDirectory: () => dir,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: (f) => texts.has(f) || ts.sys.fileExists(f),
    readFile: (f) => texts.get(f) ?? ts.sys.readFile(f),
  };
  const ls = plugin({ typescript: ts }).create({ languageService: ts.createLanguageService(host), project: { projectService: { logger: { info() {} } } } });
  const edit = (f: string, text: string) => {
    texts.set(f, text);
    versions.set(f, (versions.get(f) ?? 0) + 1);
  };
  return { dir, file, ls, edit, text: () => texts.get(file)! };
}

describe("typesol/ts-plugin", () => {
  it("adds nothing for a valid program", () => {
    const p = project();
    expect(p.ls.getSemanticDiagnostics(p.file)).toEqual([]);
  });

  it("shows the compiler's refusal at its position, for the unsaved text", () => {
    const p = project();
    const bad = p.text().replace("counter.count += by;", "const rate = 1.5;\n  counter.count += by;");
    p.edit(p.file, bad);
    writeFileSync(path.join(p.dir, "unused.txt"), ""); // the file on disk is untouched: the plugin checks the editor text
    const diags = p.ls.getSemanticDiagnostics(p.file);
    // A floating-point literal, at the literal.
    expect(diags.map((d) => String(d.messageText))).toEqual([expect.stringMatching(/no floating-point numbers/)]);
    expect(diags[0]).toMatchObject({ source: "typesol", code: 9900, category: ts.DiagnosticCategory.Error });
    expect(bad.slice(diags[0].start!, diags[0].start! + 3)).toBe("1.5");
  });

  it("leaves TypeScript's own errors alone and skips files that are not program entries", () => {
    const p = project();
    p.edit(p.file, p.text().replace("counter.count += by;", "counter.count += 1;")); // a TypeScript error (number vs bigint)
    const diags = p.ls.getSemanticDiagnostics(p.file);
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.every((d) => d.source !== "typesol")).toBe(true);
    const helper = path.join(p.dir, "programs/math.ts");
    p.edit(helper, `import { type u64 } from "typesol";\nexport const f = (x: u64) => x;\n`);
    expect(p.ls.getSemanticDiagnostics(helper)).toEqual([]);
  });
});
