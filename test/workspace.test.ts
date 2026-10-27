import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = path.join(ROOT, "dist/cli.js");
const dirs: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), "typesol-ws-")));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const run = (args: string[], cwd: string) => spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8" });

/** Typecheck and run a scaffolded project's own test (`typesol` linked to this checkout; other dev dependencies from this repo). */
function runGeneratedTest(dir: string) {
  mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  symlinkSync(ROOT, path.join(dir, "node_modules/typesol"), "dir");
  for (const dep of ["@anchor-lang", "@solana", "@solana-program", "litesvm", "vitest", "@types", "typescript"])
    symlinkSync(path.join(ROOT, "node_modules", dep), path.join(dir, "node_modules", dep), "dir");
  execFileSync("node", [path.join(ROOT, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], { cwd: dir, stdio: "pipe" });
  execFileSync("node", [path.join(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--root", dir], { cwd: dir, stdio: "pipe" });
}

describe("projects: typesol init / build / deploy --dry-run", () => {
  it("scaffolds a project that typechecks and whose own test passes; records the program address", () => {
    const dir = tmp();
    expect(run(["init", ".", "--name", "tally"], dir).status).toBe(0);
    for (const f of ["typesol.json", "programs/tally.ts", "tests/tally.test.ts", "package.json", "tsconfig.json"])
      expect(existsSync(path.join(dir, f))).toBe(true);
    expect(run(["init", ".", "--name", "tally"], dir).stderr).toMatch(/refusing to overwrite/);

    const out = run(["build"], dir);
    expect(out.status).toBe(0);
    const address = /tally\s+(\w{32,44})/.exec(out.stdout)![1];
    const config = JSON.parse(readFileSync(path.join(dir, "typesol.json"), "utf8"));
    expect(config.programs.tally).toEqual({ path: "programs/tally.ts", address });
    expect(JSON.parse(readFileSync(path.join(dir, "target/tally/tally.json"), "utf8")).address).toBe(address);
    // The .ts of a configured program builds as that program (same keypair and output).
    expect(run(["build", "programs/tally.ts"], dir).stdout).toContain(address);
    expect(existsSync(path.join(dir, "programs/target"))).toBe(false);

    // Flags reach the build; --out is refused for configured programs; unknown flags are errors (exit 2).
    expect(run(["build", "--sbpf", "v2"], dir).status).toBe(0);
    expect(JSON.parse(readFileSync(path.join(dir, "target/tally/tally.build.json"), "utf8")).sbpf).toBe("v2");
    expect(run(["build", "--out", "elsewhere"], dir).status).toBe(2);
    expect(run(["build", "--sbfp", "v2"], dir).status).toBe(2);
    expect(run(["build", "nosuch"], dir).status).toBe(2);
    expect(run(["build", "--help"], dir).status).toBe(0);

    const plan = run(["deploy", "--dry-run", "--url", "http://127.0.0.1:8899"], dir);
    expect(plan.stdout.trim().split("\n").at(-1)).toBe(
      `solana program deploy ${path.join(dir, "target/tally/tally.so")} --program-id ${path.join(dir, "target/deploy/tally-keypair.json")} --use-rpc --url http://127.0.0.1:8899`,
    );

    // A swapped or lost keypair is caught before anything is deployed.
    renameSync(path.join(dir, "target/deploy/tally-keypair.json"), path.join(dir, "kp.bak"));
    expect(run(["build"], dir).stderr).toMatch(/is missing, but typesol\.json records/);
    renameSync(path.join(dir, "kp.bak"), path.join(dir, "target/deploy/tally-keypair.json"));

    // The generated test typechecks and passes.
    runGeneratedTest(dir);
  });

  it.each(["vault", "escrow"])("--template %s: the program is the matching example and the generated test passes", (template) => {
    const dir = tmp();
    expect(run(["init", ".", "--name", "app", "--template", template], dir).status).toBe(0);
    expect(readFileSync(path.join(dir, "programs/app.ts"), "utf8")).toBe(readFileSync(path.join(ROOT, `examples/${template}.ts`), "utf8"));
    runGeneratedTest(dir);
  });

  it("the default template is examples/counter.ts; unknown templates are usage errors", () => {
    const dir = tmp();
    expect(run(["init", ".", "--name", "app"], dir).status).toBe(0);
    expect(readFileSync(path.join(dir, "programs/app.ts"), "utf8")).toBe(readFileSync(path.join(ROOT, "examples/counter.ts"), "utf8"));
    const bad = run(["init", "other", "--template", "nope"], dir);
    expect([bad.status, bad.stderr]).toEqual([2, expect.stringMatching(/--template "nope" is not one of counter, vault, escrow/)]);
    expect(existsSync(path.join(dir, "other"))).toBe(false);
  });

  it("explains instead of crashing: bad typesol.json, unknown commands, missing files", () => {
    const dir = tmp();
    writeFileSync(path.join(dir, "typesol.json"), "{ programs: ");
    const bad = run(["build"], dir);
    expect([bad.status, bad.stderr]).toEqual([1, expect.stringMatching(/typesol\.json: not valid JSON/)]);
    expect(run(["frobnicate"], dir).status).toBe(2);
    expect(run(["profile", "nosuch.txt"], dir).stderr).toMatch(/does not exist/);
    expect(run(["cpi", "x.json", "--address", "nope"], dir).status).toBe(2);
    expect(run(["--version"], dir).stdout.trim()).toBe(JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version);
  });
});
