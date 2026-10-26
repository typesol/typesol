#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { build, CompileError, COMPILER_VERSION, generate, SBPF_VERSIONS, verifyBinary, type Sbpf } from "./compiler/index.js";
import { generateCpi, type Idl } from "./cpigen.js";
import { buildIdl } from "./compiler/idl.js";
import { decodeAddress, loadOrCreateKeypair, readKeypair } from "./keys.js";
import { formatProfile, profileLogs } from "./profile.js";
import { buildWorkspace, CONFIG, deployArgs, findWorkspace, programAddress, programForEntry, programPaths, scaffold, type Workspace } from "./workspace.js";

const ASSETS = fileURLToPath(new URL("../assets/", import.meta.url));

/** A usage problem: printed with the command's help, exit code 2. */
class UsageError extends Error {}

function banner(): string {
  const unicode = /utf-?8/i.test(process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || "UTF-8");
  const art = readFileSync(path.join(ASSETS, unicode ? "logo-blocks.txt" : "logo-ascii.txt"), "utf8");
  return `\n${art}\n  TypeScript in, SBF out.  v${COMPILER_VERSION}\n`;
}

const SBPF = `--sbpf v0|v1|v2      SBPF version (default v0, or "sbpf" in ${CONFIG}); v1/v2 need clusters that enabled them`;

interface Command {
  usage: string;
  help: string;
  options: NonNullable<ParseArgsConfig["options"]>;
  run(values: Record<string, string | boolean | undefined>, positionals: string[]): Promise<number> | number;
}

const COMMANDS: Record<string, Command> = {
  init: {
    usage: "typesol init [<dir>] [--name <program>]",
    help: "Create a project: typesol.json, programs/<name>.ts, tests/<name>.test.ts (LiteSVM), package.json, tsconfig.json, .gitignore.\n  Refuses to overwrite files. <name> must be snake_case (default: derived from <dir>).",
    options: { name: { type: "string" } },
    run(v, args) {
      if (args.length > 1) throw new UsageError("init takes at most one directory");
      if (v.name !== undefined && !/^[a-z][a-z0-9_]*$/.test(v.name as string))
        throw new UsageError(`--name "${v.name}" must be snake_case (a-z, 0-9, _; starting with a letter)`);
      const root = path.resolve(args[0] ?? ".");
      const derived = path
        .basename(root)
        .replace(/[^a-z0-9]+/gi, "_")
        .replace(/^_+|_+$/g, "")
        .toLowerCase();
      const name = (v.name as string | undefined) ?? (/^[a-z]/.test(derived) ? derived : `p_${derived || "program"}`);
      for (const f of scaffold(root, name)) log(`  created ${path.join(root, f)}`);
      log(`\n  next: cd ${path.relative(process.cwd(), root) || "."} && npm install && npm test`);
      return 0;
    },
  },
  build: {
    usage:
      "typesol build [<program>…] [--sbpf v0|v1|v2] [--profile]\n  typesol build <program.ts> [--out <dir>] [--program-id <keypair.json>] [--sbpf …] [--profile]",
    help: [
      `In a project (${CONFIG}): build every program, or the ones named, into <out>/<name>/ (.so, IDL .json, .c, .build.json).`,
      "Outside a project, or with a .ts file: build that file (its keypair is created next to the output if needed).",
      SBPF,
      "--profile            log a marker and the remaining compute units before every statement (for `typesol profile`; not for release)",
      "--quiet              no banner",
    ].join("\n  "),
    options: { sbpf: { type: "string" }, profile: { type: "boolean" }, out: { type: "string" }, "program-id": { type: "string" }, quiet: { type: "boolean" } },
    run(v, args) {
      const sbpf = sbpfOf(v);
      const profile = !!v.profile;
      const ws = findWorkspace(process.cwd());
      const file = args.length === 1 && args[0].endsWith(".ts") ? args[0] : undefined;
      // A .ts that is one of the project's programs builds as that program (same keypair, output and settings).
      const inProject = ws && (file ? programForEntry(ws, file) : undefined);
      if (ws && (!file || inProject)) {
        if (v.out || v["program-id"])
          throw new UsageError(`--out and --program-id do not apply to programs of ${CONFIG} (use "out" there; keypairs live in <out>/deploy/)`);
        if (!v.quiet && process.stdout.isTTY) log(banner());
        for (const b of buildWorkspace(ws, inProject ? [inProject] : names(ws, args), { sbpf, profile }))
          log(`  ${b.paths.name.padEnd(12)} ${b.address}${b.created ? " (new keypair)" : ""}  ${path.relative(process.cwd(), b.result.soPath)}`);
        return 0;
      }
      if (!file)
        throw new UsageError(
          args.length
            ? `"${args.join(" ")}" is not a .ts file, and there is no ${CONFIG} here`
            : `nothing to build: give a .ts file, or run inside a project (${CONFIG})`,
        );
      mustExist(file);
      if (!v.quiet && process.stdout.isTTY) log(banner());
      const outDir = (v.out as string | undefined) ?? path.join(path.dirname(file), "target");
      const { model } = generate(file);
      const keyFile = (v["program-id"] as string | undefined) ?? path.join(outDir, `${model.name}-keypair.json`);
      mkdirSync(path.dirname(keyFile), { recursive: true });
      const { address, created } = loadOrCreateKeypair(keyFile);
      const res = build(file, outDir, address, { sbpf: sbpf ?? "v0", profile });
      log(`  program   ${model.name}`);
      log(`  address   ${address}${created ? "  (new keypair: keep it, it is the program's address)" : ""}`);
      log(`  binary    ${res.soPath}`);
      log(`  idl       ${res.idlPath}`);
      log(`  manifest  ${res.manifestPath}`);
      log(`\n  deploy:   solana program deploy ${res.soPath} --program-id ${keyFile}`);
      return 0;
    },
  },
  check: {
    usage: "typesol check <program.ts>",
    help: "Typecheck and validate the TypeSOL subset without building.",
    options: {},
    run(_, args) {
      const { model } = generate(mustExist(one(args, "<program.ts>")));
      log(`ok  ${model.name}: ${model.instructions.length} instruction(s), ${model.accountStructs.size} account type(s), ${model.events.size} event(s)`);
      return 0;
    },
  },
  "emit-c": {
    usage: "typesol emit-c <program.ts> [--out <file.c>] [--profile]",
    help: "Print or write the generated C.",
    options: { out: { type: "string" }, profile: { type: "boolean" } },
    run(v, args) {
      const { c } = generate(mustExist(one(args, "<program.ts>")), { profile: !!v.profile });
      if (v.out) writeFileSync(v.out as string, c);
      else process.stdout.write(c);
      return 0;
    },
  },
  deploy: {
    usage: "typesol deploy [<program>…] [--url <rpc>] [--keypair <payer.json>] [--config <solana cli config>] [--sbpf v0|v1|v2] [--dry-run]",
    help: [
      `In a project: build, then \`solana program deploy\` each program at its <out>/deploy/<name>-keypair.json address.`,
      "Deploying again upgrades it (the payer must be the upgrade authority). --dry-run builds and prints the commands.",
      "Needs the Agave CLI (`solana`) on PATH.",
    ].join("\n  "),
    options: { url: { type: "string" }, keypair: { type: "string" }, config: { type: "string" }, "dry-run": { type: "boolean" }, sbpf: { type: "string" } },
    run(v, args) {
      const ws = needWorkspace("deploy");
      const built = buildWorkspace(ws, names(ws, args), { sbpf: sbpfOf(v) });
      for (const b of built) {
        const cliArgs = deployArgs(b.result.soPath, b.paths.keypair, { url: v.url as string, payer: v.keypair as string, config: v.config as string });
        if (v["dry-run"]) {
          log(`solana ${cliArgs.map(shellQuote).join(" ")}`);
          continue;
        }
        log(`  deploying ${b.paths.name} (${b.address})…`);
        try {
          execFileSync("solana", cliArgs, { stdio: "inherit" });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT")
            throw new Error("`solana` was not found on PATH. Install the Agave CLI: https://docs.anza.xyz/cli/install");
          throw new Error(`solana program deploy failed for ${b.paths.name} (see its output above)`);
        }
      }
      return 0;
    },
  },
  idl: {
    usage: "typesol idl publish [<program>…] [--url <rpc>] [--keypair <authority.json>] [--config <solana cli config>] [--non-canonical]",
    help: [
      `In a project: compile (no binary is rebuilt), then write each program's IDL to the Program Metadata program (seed "idl"), where Anchor`,
      "and explorers read it. The canonical IDL must be signed by the program's upgrade authority; --non-canonical",
      "writes one tied to the signer instead. Without --url/--keypair the Solana CLI config is used.",
    ].join("\n  "),
    options: { url: { type: "string" }, keypair: { type: "string" }, config: { type: "string" }, "non-canonical": { type: "boolean" } },
    async run(v, [sub, ...args]) {
      if (sub !== "publish") throw new UsageError(`unknown idl command "${sub ?? ""}" (expected "publish")`);
      const ws = needWorkspace("idl publish");
      const { url, keypair } = solanaConfig(v.config as string | undefined);
      const rpcUrl = (v.url as string | undefined) ?? url;
      const keyFile = (v.keypair as string | undefined) ?? keypair;
      if (!rpcUrl) throw new Error("no RPC: pass --url, or set json_rpc_url in the Solana CLI config");
      if (!keyFile || !existsSync(keyFile))
        throw new Error(`no signer keypair${keyFile ? ` at ${keyFile}` : ""}: pass --keypair, or set keypair_path in the Solana CLI config`);
      // Loaded only here: the other commands do not need an RPC client.
      const kit = await import("@solana/kit");
      const { publishIdl, rpcChain } = await import("./idlpublish.js");
      const signer = await kit.createKeyPairSignerFromBytes(readKeypair(keyFile));
      const chain = rpcChain(kit.createSolanaRpc(rpcUrl));
      for (const name of names(ws, args)) {
        // The IDL only needs the compiled model and the program address: the deployed binary is left alone.
        const { address } = programAddress(ws, name);
        const idl = buildIdl(generate(programPaths(ws, name).entry).model, address);
        const at = await publishIdl(chain, { program: kit.address(address), idl, payer: signer, canonical: !v["non-canonical"] });
        log(`  ${name.padEnd(12)} IDL at ${at}${v["non-canonical"] ? " (non-canonical)" : ""}`);
      }
      return 0;
    },
  },
  cpi: {
    usage: "typesol cpi <idl.json> [--out <file.ts>] [--prefix <name>] [--address <base58>]",
    help: "Generate TypeSOL helpers that call another program's instructions, from its Anchor IDL (0.30+/1.x or TypeSOL).",
    options: { out: { type: "string" }, prefix: { type: "string" }, address: { type: "string" } },
    run(v, args) {
      const file = one(args, "<idl.json>");
      if (v.address && !decodeAddress(v.address as string)) throw new UsageError(`--address "${v.address}" is not a base58 Solana address`);
      if (v.prefix && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.prefix as string)) throw new UsageError("--prefix must be an identifier");
      const res = generateCpi(readJson(file) as Idl, { prefix: v.prefix as string, address: v.address as string });
      if (v.out) {
        writeFileSync(v.out as string, res.source);
        log(`  wrote ${v.out}: ${res.generated.length} helper(s)`);
      } else process.stdout.write(res.source);
      for (const s of res.skipped) console.error(`  skipped ${s.instruction}: ${s.reason}`);
      return 0;
    },
  },
  verify: {
    usage: "typesol verify <program.ts | program> <deployed.so> [--sbpf v0|v1|v2]",
    help: [
      "Rebuild and compare with a deployed binary (e.g. from `solana program dump`). Exit 0 on a match, 3 on a mismatch.",
      "The SBPF version is read from the deployed binary unless --sbpf is given. Reproducible builds need the same",
      "TypeSOL version and platform-tools as the original (see its <name>.build.json).",
    ].join("\n  "),
    options: { sbpf: { type: "string" } },
    run(v, args) {
      if (args.length !== 2) throw new UsageError("verify takes the program and the deployed .so");
      const [target, deployedPath] = args;
      const ws = findWorkspace(process.cwd());
      const name = ws && (ws.programs[target] ? target : programForEntry(ws, target));
      const entry = ws && name ? programPaths(ws, name).entry : target;
      if (!existsSync(entry)) throw new UsageError(`${entry} does not exist`);
      if (!existsSync(deployedPath)) throw new UsageError(`${deployedPath} does not exist`);
      const deployed = readFileSync(deployedPath);
      // ELF e_flags (offset 0x30) hold the SBPF version: 0 for v0, 1 for v1, 2 for v2.
      const flags = deployed.length > 0x34 && deployed.readUInt32BE(0) === 0x7f454c46 ? deployed.readUInt32LE(0x30) : 0;
      const sbpf = sbpfOf(v) ?? SBPF_VERSIONS[flags] ?? "v0";
      const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-verify-"));
      let res, same;
      try {
        res = build(entry, dir, "11111111111111111111111111111111", { sbpf });
        same = verifyBinary(deployed, readFileSync(res.soPath));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      log(
        same
          ? `  match     ${res.manifest.binary} (sbpf ${sbpf})`
          : `  MISMATCH  ${deployedPath} is not what ${entry} builds to (${res.manifest.binary}, sbpf ${sbpf})`,
      );
      return same ? 0 : 3;
    },
  },
  profile: {
    usage: "typesol profile <logs.txt | -> [--program <id>]",
    help: "Compute units per TypeScript line, from the logs of a transaction run against a --profile build (one log line per line).",
    options: { program: { type: "string" } },
    run(v, args) {
      const file = one(args, "<logs.txt>");
      if (file !== "-" && !existsSync(file)) throw new UsageError(`${file} does not exist`);
      const logs = readFileSync(file === "-" ? 0 : file, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const rows = profileLogs(logs, v.program as string | undefined);
      if (!rows.length) {
        console.error("no profile markers found: run a transaction against a `typesol build --profile` binary and pass its logs");
        return 1;
      }
      log(formatProfile(rows));
      return 0;
    },
  },
};

const USAGE = `Usage:\n${Object.values(COMMANDS)
  .map((c) => `  ${c.usage}`)
  .join("\n")}\n  typesol --version\n\nRun \`typesol <command> --help\` for details.`;

function log(s: string) {
  console.log(s);
}

function mustExist(file: string): string {
  if (!existsSync(file)) throw new UsageError(`${file} does not exist`);
  return file;
}

/** Quote a command-line word for a POSIX shell when it needs it. */
function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function one(args: string[], what: string): string {
  if (args.length !== 1) throw new UsageError(`expected exactly one ${what}`);
  return args[0];
}

function sbpfOf(v: Record<string, unknown>): Sbpf | undefined {
  const s = v.sbpf as string | undefined;
  if (s !== undefined && !SBPF_VERSIONS.includes(s as Sbpf)) throw new UsageError(`--sbpf must be one of ${SBPF_VERSIONS.join(", ")}`);
  return s as Sbpf | undefined;
}

function names(ws: Workspace, args: string[]): string[] {
  for (const a of args) if (!ws.programs[a]) throw new UsageError(`no program "${a}" in ${ws.file} (have: ${Object.keys(ws.programs).join(", ")})`);
  return args.length ? args : Object.keys(ws.programs);
}

function needWorkspace(cmd: string): Workspace {
  const ws = findWorkspace(process.cwd());
  if (!ws) throw new Error(`${cmd} works in a project (${CONFIG}); create one with \`typesol init\``);
  return ws;
}

function readJson(file: string): unknown {
  if (!existsSync(file)) throw new UsageError(`${file} does not exist`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file}: not valid JSON (${(e as Error).message})`);
  }
}

/** json_rpc_url / keypair_path from a Solana CLI config (the given file, or the CLI's default one). */
function solanaConfig(file?: string): { url?: string; keypair?: string } {
  const configPath = file ?? path.join(os.homedir(), ".config/solana/cli/config.yml");
  if (!existsSync(configPath)) {
    if (file) throw new UsageError(`${file} does not exist`);
    return {};
  }
  const text = readFileSync(configPath, "utf8");
  const get = (k: string) => new RegExp(`^${k}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, "m").exec(text)?.[1];
  const expand = (p?: string) => (p?.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);
  return { url: get("json_rpc_url"), keypair: expand(get("keypair_path")) };
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "--version" || cmd === "-v" || cmd === "-V") {
    log(COMPILER_VERSION);
    return 0;
  }
  if (cmd === "help" && rest[0] && COMMANDS[rest[0]]) {
    log(`Usage: ${COMMANDS[rest[0]].usage}\n\n  ${COMMANDS[rest[0]].help}`);
    return 0;
  }
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    if (process.stdout.isTTY) log(banner());
    log(USAGE);
    return cmd ? 0 : 2;
  }
  const command = COMMANDS[cmd];
  if (!command) {
    console.error(`unknown command "${cmd}"\n\n${USAGE}`);
    return 2;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    log(`Usage: ${command.usage}\n\n  ${command.help}`);
    return 0;
  }
  try {
    const { values, positionals } = parseArgs({ args: rest, options: command.options, allowPositionals: true, strict: true });
    return await command.run(values as Record<string, string | boolean | undefined>, positionals);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (e instanceof UsageError || (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS"))) {
      console.error(`${(e as Error).message}\n\nUsage: ${command.usage}\n\n  ${command.help}`);
      return 2;
    }
    throw e;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  if (e instanceof CompileError) {
    console.error(e.message);
    console.error(`\n${e.diagnostics.length} error(s)`);
  } else console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
