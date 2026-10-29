// TypeScript language-service plugin: TypeSOL's own errors in the editor, next to TypeScript's.
//
//   programs/tsconfig.json: { "compilerOptions": { …, "plugins": [{ "name": "typesol/ts-plugin" }] } }
//
// Once TypeScript itself reports no errors in a file, the program entries of the project (typesol.json) are checked
// with the TypeSOL compiler on the editor's text (unsaved changes in every open file included), and what the compiler
// refuses (an unsupported construct, a constraint that cannot hold…) is shown where it is: in the entry or in any file
// it imports. The compiler runs in the editor's process once it has loaded (an ESM import, started when the plugin
// is created) and as `typesol check --json --files` until then. Editors load tsconfig plugins from the workspace's
// TypeScript (VS Code: "TypeScript: Select TypeScript Version" → "Use Workspace Version"; `typesol init` sets that up).
// CommonJS on purpose: tsserver loads plugins with require().
"use strict";
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const DIST = path.join(__dirname, "..", "dist");
const CLI = path.join(DIST, "cli.js");
const CODE = 9900;

/** The program entry files of the typesol.json at or above `dir` (absolute), or an empty set. */
function entriesNear(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    const config = path.join(d, "typesol.json");
    if (fs.existsSync(config)) {
      try {
        const programs = JSON.parse(fs.readFileSync(config, "utf8")).programs || {};
        return new Set(Object.values(programs).map((p) => path.resolve(d, typeof p === "string" ? p : p.path)));
      } catch {
        return new Set();
      }
    }
    if (path.dirname(d) === d) return new Set();
  }
}

function init({ typescript: ts }) {
  function create(info) {
    const ls = info.languageService;
    const log = (m) => info.project.projectService.logger.info(`[typesol] ${m}`);
    /** The compiler, loaded in the background; until then each check runs as a child process. */
    let compiler;
    const ready = import(pathToFileURL(path.join(DIST, "compiler", "index.js")).href).then(
      (m) => (compiler = m),
      (e) => log(`in-process compiler unavailable (${e.message}); checking with the CLI`),
    );
    const cache = new Map(); // entry -> { key, found }

    /** The diagnostics of one program entry for these texts: in-process when possible, else through the CLI. */
    function check(entry, files) {
      if (compiler) {
        try {
          compiler.generate(entry, { files: new Map(Object.entries(files)) });
          return [];
        } catch (e) {
          if (e instanceof compiler.CompileError) return e.diagnostics;
          log(`check failed for ${entry}: ${e.message}`);
          return [];
        }
      }
      try {
        const out = execFileSync(process.execPath, [CLI, "check", entry, "--json", "--files"], {
          input: JSON.stringify({ files }),
          encoding: "utf8",
          timeout: 15000,
          // tsserver may run inside an editor's Electron: make it behave as plain Node for the child.
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          stdio: ["pipe", "pipe", "pipe"],
        });
        return JSON.parse(out).diagnostics;
      } catch (e) {
        // Exit 1 with JSON on stdout means diagnostics; anything else is a crash worth logging, not showing.
        try {
          return JSON.parse(String(e.stdout)).diagnostics;
        } catch {
          log(`check failed for ${entry}: ${e.message}`);
          return [];
        }
      }
    }

    /** `check`, cached on the texts it reads and the modification times of the .ts files beside the entry. */
    function cachedCheck(entry, files) {
      const hash = createHash("sha1");
      for (const f of Object.keys(files).sort()) hash.update(`${f}\0${files[f]}\0`);
      const dir = path.dirname(entry);
      try {
        for (const f of fs.readdirSync(dir).sort()) if (f.endsWith(".ts")) hash.update(`${f}:${fs.statSync(path.join(dir, f)).mtimeMs};`);
      } catch {
        /* the texts alone */
      }
      const key = hash.digest("hex");
      const hit = cache.get(entry);
      if (hit && hit.key === key) return hit.found;
      const found = check(entry, files);
      cache.set(entry, { key, found });
      return found;
    }

    const proxy = Object.create(null);
    for (const k of Object.keys(ls)) proxy[k] = (...args) => ls[k](...args);
    proxy.getSemanticDiagnostics = (fileName) => {
      const prior = ls.getSemanticDiagnostics(fileName);
      if (prior.some((d) => d.category === ts.DiagnosticCategory.Error)) return prior; // TypeScript's errors first
      const target = path.resolve(fileName);
      const entries = entriesNear(path.dirname(target));
      if (!entries.size) return prior;
      const program = ls.getProgram();
      const sf = program && program.getSourceFile(fileName);
      if (!sf) return prior;
      // The editor's text of the project's own files (open buffers included).
      const files = {};
      for (const f of program.getSourceFiles()) if (!f.isDeclarationFile && !f.fileName.includes("/node_modules/")) files[path.resolve(f.fileName)] = f.text;
      // An entry is checked on its own; another file through every entry (whichever imports it reports it).
      const run = entries.has(target) ? [target] : [...entries].filter((e) => fs.existsSync(e) || files[e] !== undefined);
      const seen = new Set();
      const own = [];
      for (const entry of run)
        for (const d of cachedCheck(entry, files)) {
          if (path.resolve(d.file) !== target) continue;
          const id = `${d.line}:${d.column}:${d.message}`;
          if (seen.has(id)) continue;
          seen.add(id);
          const line = Math.max(0, Math.min(d.line - 1, sf.getLineStarts().length - 1));
          const start = Math.min(sf.getPositionOfLineAndCharacter(line, 0) + Math.max(0, d.column - 1), sf.end);
          const word = /^[\w$]+/.exec(sf.text.slice(start));
          own.push({
            file: sf,
            start,
            length: Math.max(1, Math.min(d.length || (word ? word[0].length : 1), sf.end - start)),
            messageText: d.message,
            category: ts.DiagnosticCategory.Error,
            code: CODE,
            source: "typesol",
          });
        }
      return [...prior, ...own];
    };
    // Tests (and curious hosts) can wait for the in-process compiler.
    proxy.typesolReady = () => ready;
    return proxy;
  }
  return { create };
}

module.exports = init;
