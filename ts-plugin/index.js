// TypeScript language-service plugin: TypeSOL's own errors in the editor, next to TypeScript's.
//
//   programs/tsconfig.json: { "compilerOptions": { …, "plugins": [{ "name": "typesol/ts-plugin" }] } }
//
// For each program entry of the project (typesol.json), once TypeScript itself reports no errors, it runs
// `typesol check --json --stdin` on the editor's text (unsaved changes included) and shows what the compiler refuses
// (an unsupported construct, a missing account constraint…) at its line and column. Editors load tsconfig plugins
// from the workspace's TypeScript (VS Code: "TypeScript: Select TypeScript Version" → "Use Workspace Version").
// CommonJS on purpose: tsserver loads plugins with require().
"use strict";
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "dist", "cli.js");
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
    const cache = new Map(); // fileName -> { text, found }

    function typesolDiagnostics(fileName, sf) {
      const hit = cache.get(fileName);
      if (hit && hit.text === sf.text) return hit.found;
      let found = [];
      try {
        const out = execFileSync(process.execPath, [CLI, "check", fileName, "--json", "--stdin"], {
          input: sf.text,
          encoding: "utf8",
          timeout: 15000,
          // tsserver may run inside an editor's Electron: make it behave as plain Node for the child.
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          stdio: ["pipe", "pipe", "pipe"],
        });
        found = JSON.parse(out).diagnostics;
      } catch (e) {
        // Exit 1 with JSON on stdout means diagnostics; anything else is a crash worth logging, not showing.
        try {
          found = JSON.parse(String(e.stdout)).diagnostics;
        } catch {
          log(`check failed for ${fileName}: ${e.message}`);
          found = [];
        }
      }
      cache.set(fileName, { text: sf.text, found });
      return found;
    }

    const proxy = Object.create(null);
    for (const k of Object.keys(ls)) proxy[k] = (...args) => ls[k](...args);
    proxy.getSemanticDiagnostics = (fileName) => {
      const prior = ls.getSemanticDiagnostics(fileName);
      if (prior.some((d) => d.category === ts.DiagnosticCategory.Error)) return prior; // TypeScript's errors first
      if (!entriesNear(path.dirname(path.resolve(fileName))).has(path.resolve(fileName))) return prior;
      const sf = ls.getProgram() && ls.getProgram().getSourceFile(fileName);
      if (!sf) return prior;
      const own = typesolDiagnostics(fileName, sf)
        .filter((d) => path.resolve(d.file) === path.resolve(fileName))
        .map((d) => {
          const line = Math.max(0, Math.min(d.line - 1, sf.getLineStarts().length - 1));
          const start = Math.min(sf.getPositionOfLineAndCharacter(line, 0) + Math.max(0, d.column - 1), sf.end);
          const word = /^[\w$]+/.exec(sf.text.slice(start));
          return {
            file: sf,
            start,
            length: word ? word[0].length : 1,
            messageText: d.message,
            category: ts.DiagnosticCategory.Error,
            code: CODE,
            source: "typesol",
          };
        });
      return [...prior, ...own];
    };
    return proxy;
  }
  return { create };
}

module.exports = init;
