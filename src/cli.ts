#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { build, CompileError, COMPILER_VERSION, generate, SBPF_VERSIONS, verifyBinary, type Diagnostic, type Sbpf } from "./compiler/index.js";
import { generateCpi, type Idl } from "./tools/cpigen.js";
import { generatePort, type PortIdl } from "./tools/portgen.js";
import { generateClient, writeClient, type ClientIdl } from "./tools/clientgen.js";
import { buildIdl } from "./compiler/idl.js";
import { decodeAddress, loadOrCreateKeypair, readKeypair } from "./keys.js";
import { formatProfile, profileLogs } from "./tools/profile.js";
import { TEMPLATE_NAMES, type TemplateName } from "./templates.js";
import {
  addProgram,
  buildWorkspace,
  CONFIG,
  deployArgs,
  findWorkspace,
  programAddress,
  programForEntry,
  programPaths,
  scaffold,
  type Workspace,
} from "./workspace.js";
import { clusterUrl, deployPreflight, doctorChecks, formatChecks, INSTALL_AGAVE, solanaConfig as readSolanaConfig, toolchainCheck } from "./tools/doctor.js";

const ASSETS = fileURLToPath(new URL("../assets/", import.meta.url));

/** A usage problem: printed with the command's help, exit code 2. */
class UsageError extends Error {}

/** Where "SOL" starts in the banner art: "Type" is drawn in TypeScript blue, "SOL" in the Solana gradient. */
const BANNER_SOL_COLUMN = 36;

function banner(): string {
  const unicode = /utf-?8/i.test(process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || "UTF-8");
  let art = readFileSync(path.join(ASSETS, unicode ? "logo-blocks.txt" : "logo-ascii.txt"), "utf8");
  if (!process.env.NO_COLOR && process.env.TERM !== "dumb") {
    const width = Math.max(...art.split("\n").map((l) => l.length));
    const rgb = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;
    const sol = (x: number) => {
      const t = Math.min(1, Math.max(0, (x - BANNER_SOL_COLUMN) / Math.max(1, width - BANNER_SOL_COLUMN)));
      return rgb(Math.round(0x99 + (0x14 - 0x99) * t), Math.round(0x45 + (0xf1 - 0x45) * t), Math.round(0xff + (0x95 - 0xff) * t));
    };
    art = art
      .split("\n")
      .map(
        (line) =>
          [...line].map((ch, x) => (ch === " " ? ch : (x < BANNER_SOL_COLUMN ? rgb(0x31, 0x78, 0xc6) : sol(x)) + ch)).join("") + (line ? "\x1b[0m" : ""),
      )
      .join("\n");
  }
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
  new: {
    usage: "typesol new <program> [--template counter|vault|escrow]",
    help: [
      "Add a program to this project: programs/<program>.ts, tests/<program>.test.ts and its entry in typesol.json.",
      "Refuses to overwrite files. <program> must be snake_case. Templates as for `typesol init`.",
    ].join("\n  "),
    options: { template: { type: "string" } },
    run(v, args) {
      const name = one(args, "<program>");
      if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new UsageError(`"${name}" must be snake_case (a-z, 0-9, _; starting with a letter)`);
      const template = (v.template as string | undefined) ?? "counter";
      if (!(TEMPLATE_NAMES as readonly string[]).includes(template))
        throw new UsageError(`--template "${template}" is not one of ${TEMPLATE_NAMES.join(", ")}`);
      const ws = needWorkspace("new");
      const { files, missing } = addProgram(ws, name, template as TemplateName);
      for (const f of files) log(`  ${f === CONFIG ? "updated" : "created"} ${path.relative(process.cwd(), path.join(ws.root, f)) || f}`);
      if (missing.length) log(`\n  The ${template} test also needs: npm install -D ${missing.join(" ")}`);
      return 0;
    },
  },
  init: {
    usage: "typesol init [<dir>] [--name <program>] [--template counter|vault|escrow]",
    help: [
      "Create a project: typesol.json, programs/<name>.ts, tests/<name>.test.ts (LiteSVM), package.json, tsconfig.json, .gitignore, .vscode/settings.json (editor errors).",
      "Refuses to overwrite files. <name> must be snake_case (default: derived from <dir>).",
      "--template counter   a PDA counter per user (default)",
      "--template vault     a SOL vault at a PDA: deposit, withdraw above rent, close",
      "--template escrow    an SPL token escrow: make, take, refund, with the offer PDA signing for its vault",
    ].join("\n  "),
    options: { name: { type: "string" }, template: { type: "string" } },
    run(v, args) {
      if (args.length > 1) throw new UsageError("init takes at most one directory");
      if (v.name !== undefined && !/^[a-z][a-z0-9_]*$/.test(v.name as string))
        throw new UsageError(`--name "${v.name}" must be snake_case (a-z, 0-9, _; starting with a letter)`);
      const template = (v.template as string | undefined) ?? "counter";
      if (!(TEMPLATE_NAMES as readonly string[]).includes(template))
        throw new UsageError(`--template "${template}" is not one of ${TEMPLATE_NAMES.join(", ")}`);
      const root = path.resolve(args[0] ?? ".");
      const derived = path
        .basename(root)
        .replace(/[^a-z0-9]+/gi, "_")
        .replace(/^_+|_+$/g, "")
        .toLowerCase();
      const name = (v.name as string | undefined) ?? (/^[a-z]/.test(derived) ? derived : `p_${derived || "program"}`);
      const rel = path.relative(process.cwd(), root) || ".";
      for (const f of scaffold(root, name, template as TemplateName)) log(`  created ${path.join(rel, f)}`);
      const tools = toolchainCheck();
      if (!tools.ok)
        log(
          `\n  ! The Solana platform-tools are not installed yet; npm test compiles with them. Install once:\n` +
            (tools.fix ?? []).map((f) => `      ${f}`).join("\n"),
        );
      log(
        `\n  next:\n` +
          (rel === "." ? "" : `    cd ${rel}\n`) +
          `    npm install\n` +
          `    npm test             # builds ${name} and runs its test in LiteSVM, a Solana runtime in-process\n` +
          `    npx typesol doctor   # checks the toolchain, keypair and RPC before a deploy`,
      );
      return 0;
    },
  },
  build: {
    usage:
      "typesol build [<program>…] [--sbpf v0|v1|v2] [--profile]\n  typesol build <program.ts> [--out <dir>] [--program-id <keypair.json>] [--sbpf …] [--profile]",
    help: [
      `In a project (${CONFIG}): build every program, or the ones named, into <out>/<name>/ (.so, IDL .json, .client.ts, .c, .build.json).`,
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
          log(
            `  ${b.paths.name.padEnd(12)} ${b.address}${b.created ? " (new keypair)" : b.keyless ? " (no keypair here: deploying needs it)" : ""}  ${path.relative(process.cwd(), b.result.soPath)}`,
          );
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
      const client = writeClient(res.idl, path.join(outDir, `${model.name}.client.ts`));
      log(`  program   ${model.name}`);
      log(`  address   ${address}${created ? "  (new keypair: keep it, it is the program's address)" : ""}`);
      log(`  binary    ${res.soPath}`);
      log(`  idl       ${res.idlPath}`);
      log(`  client    ${client.path}`);
      log(`  manifest  ${res.manifestPath}`);
      log(`\n  deploy:   solana program deploy ${res.soPath} --program-id ${keyFile}`);
      return 0;
    },
  },
  check: {
    usage: "typesol check [<program.ts> | <program>…] [--json] [--stdin | --files]",
    help: [
      "Typecheck and validate the TypeSOL subset without building. In a project, no argument checks every program.",
      "--json    print { ok, diagnostics: [{ file, line, column, message }] } (exit 1 when there are diagnostics)",
      "--stdin   read <program.ts>'s text from stdin instead of the file (an editor's unsaved buffer); its imports are read from disk",
      '--files   read { "files": { "<absolute path>": "<text>", … } } from stdin: those files\' texts instead of the disk (unsaved buffers)',
    ].join("\n  "),
    options: { json: { type: "boolean" }, stdin: { type: "boolean" }, files: { type: "boolean" } },
    run(v, args) {
      // In a project: the named programs, or all of them.
      const ws = !v.stdin && !v.files && !args.some((a) => a.endsWith(".ts")) ? findWorkspace(process.cwd()) : undefined;
      if (ws) {
        const diagnostics: Diagnostic[] = [];
        for (const name of names(ws, args)) {
          try {
            const { model } = generate(programPaths(ws, name).entry);
            if (!v.json)
              log(`ok  ${name}: ${model.instructions.length} instruction(s), ${model.accountStructs.size} account type(s), ${model.events.size} event(s)`);
          } catch (e) {
            if (!(e instanceof CompileError)) throw e;
            diagnostics.push(...e.diagnostics);
            if (!v.json) console.error(`${name}:\n${e.message}`);
          }
        }
        if (v.json) log(JSON.stringify({ ok: !diagnostics.length, diagnostics }));
        return diagnostics.length ? 1 : 0;
      }
      const file = path.resolve(one(args, "<program.ts>"));
      let files: Map<string, string> | undefined;
      if (v.stdin) files = new Map([[file, readFileSync(0, "utf8")]]);
      else if (v.files) {
        const given = (JSON.parse(readFileSync(0, "utf8")) as { files?: Record<string, string> }).files ?? {};
        files = new Map(Object.entries(given).map(([p, t]) => [path.resolve(p), t]));
      }
      try {
        if (!files?.has(file)) mustExist(file);
        const { model } = generate(file, { files });
        if (v.json) log(JSON.stringify({ ok: true, diagnostics: [] }));
        else log(`ok  ${model.name}: ${model.instructions.length} instruction(s), ${model.accountStructs.size} account type(s), ${model.events.size} event(s)`);
        return 0;
      } catch (e) {
        if (!v.json || !(e instanceof CompileError)) throw e;
        log(JSON.stringify({ ok: false, diagnostics: e.diagnostics }));
        return 1;
      }
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
  doctor: {
    usage: "typesol doctor [--url <rpc>] [--config <solana cli config>]",
    help: [
      "Check what building, testing and deploying need: Node.js, the platform-tools, the Solana CLI, its keypair, the RPC",
      "(and the keypair's balance there) and the project. Each problem comes with the command that fixes it. Exit code 1",
      "when building is impossible (Node.js or the platform-tools); a missing deploy piece is a warning.",
    ].join("\n  "),
    options: { url: { type: "string" }, config: { type: "string" } },
    async run(v) {
      const checks = await doctorChecks({ cwd: process.cwd(), url: v.url as string | undefined, config: v.config as string | undefined });
      log(formatChecks(checks));
      return checks.some((c) => !c.ok && !c.optional) ? 1 : 0;
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
    async run(v, args) {
      const ws = needWorkspace("deploy");
      const built = buildWorkspace(ws, names(ws, args), { sbpf: sbpfOf(v), needKeypair: true });
      if (!v["dry-run"]) {
        // Before any transaction: the RPC answers and the payer can afford it, with what to do if not.
        const cfg = solanaConfig(v.config as string | undefined);
        const url = (v.url as string | undefined) ?? cfg.url;
        if (url)
          await deployPreflight({
            url: clusterUrl(url),
            payer: (v.keypair as string | undefined) ?? cfg.keypair ?? path.join(os.homedir(), ".config/solana/id.json"),
            programs: built.map((b) => ({ soPath: b.result.soPath, address: b.address, name: b.paths.name })),
          });
      }
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
          if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`\`solana\` was not found on PATH. Install the Agave CLI: ${INSTALL_AGAVE}`);
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
      const { publishIdl, rpcChain } = await import("./tools/idlpublish.js");
      const signer = await kit.createKeyPairSignerFromBytes(readKeypair(keyFile));
      const chain = rpcChain(kit.createSolanaRpc(clusterUrl(rpcUrl)));
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
  port: {
    usage: "typesol port <idl.json> [--out <file.ts>]",
    help: [
      "A TypeSOL program skeleton from an Anchor IDL (0.30+/1.x): account structs, enums, errors, events and one function per",
      "instruction with its accounts and arguments (bodies to fill in). Discriminators, account names and error order are kept,",
      "so existing clients keep working where the layouts match; the notes (stderr) list where they do not.",
    ].join("\n  "),
    options: { out: { type: "string" } },
    run(v, args) {
      const file = one(args, "<idl.json>");
      const res = generatePort(readJson(file) as PortIdl);
      if (v.out) {
        if (existsSync(v.out as string)) throw new UsageError(`${v.out} exists; refusing to overwrite it`);
        writeFileSync(v.out as string, res.source);
        log(`  wrote ${v.out}`);
      } else process.stdout.write(res.source);
      for (const n of res.notes) console.error(`  note: ${n}`);
      return 0;
    },
  },
  client: {
    usage:
      "typesol client <idl.json> [--out <file.ts>] [--address <base58>]\n  typesol client --address <program id> [--url <rpc>] [--config <solana cli config>] [--out <file.ts>]",
    help: [
      "Generate a typed TypeScript client (on @solana/kit) from an Anchor IDL (0.30+/1.x or TypeSOL). The IDL is validated first;",
      "what the client leaves out is printed as notes. `typesol build` already writes <name>.client.ts for TypeSOL programs.",
      "Without an IDL file, the IDL is read from the chain for the program at --address: the canonical Program Metadata IDL",
      "(`typesol idl publish`, Codama), else Anchor's IDL account (`anchor idl init`).",
    ].join("\n  "),
    options: { out: { type: "string" }, address: { type: "string" }, url: { type: "string" }, config: { type: "string" } },
    async run(v, args) {
      if (v.address && !decodeAddress(v.address as string)) throw new UsageError(`--address "${v.address}" is not a base58 Solana address`);
      let idl: unknown;
      if (args.length === 0) {
        if (!v.address) throw new UsageError("pass an IDL file, or --address to read the program's IDL from the chain");
        const rpcUrl = (v.url as string | undefined) ?? solanaConfig(v.config as string | undefined).url;
        if (!rpcUrl) throw new Error("no RPC: pass --url, or set json_rpc_url in the Solana CLI config");
        // Loaded only here: the other commands do not need an RPC client.
        const kit = await import("@solana/kit");
        const { fetchProgramIdl } = await import("./tools/idlpublish.js");
        const found = await fetchProgramIdl(kit.createSolanaRpc(clusterUrl(rpcUrl)), kit.address(v.address as string));
        console.error(`  IDL from ${found.source === "anchor" ? "Anchor's IDL account" : "the Program Metadata program"}`);
        idl = found.idl;
      } else {
        if (v.url) throw new UsageError("--url reads the IDL from the chain: leave out the IDL file");
        idl = readJson(one(args, "<idl.json>"));
      }
      const res = generateClient(idl as ClientIdl, { address: v.address as string | undefined });
      if (v.out) {
        writeFileSync(v.out as string, res.source);
        log(`  wrote ${v.out}`);
      } else process.stdout.write(res.source);
      for (const n of res.notes) console.error(`  note: ${n}`);
      return 0;
    },
  },
  verify: {
    usage: "typesol verify <program.ts | program> [<deployed.so>] [--address <program id>] [--url <rpc>] [--config <solana cli config>] [--sbpf v0|v1|v2]",
    help: [
      "Rebuild and compare with what is deployed. Exit 0 on a match, 3 on a mismatch.",
      "With a .so (e.g. from `solana program dump`): compare with that file.",
      "Without one: read the program from the cluster (--url, else the Solana CLI config) at --address, or at the address",
      "typesol.json records for a project program. Also prints the upgrade authority and compares the IDL published",
      "on chain (`typesol idl publish`) with the one the source builds; a published IDL that differs is a mismatch.",
      "The SBPF version is read from the deployed binary unless --sbpf is given. Reproducible builds need the same",
      "TypeSOL version and platform-tools as the original (see its <name>.build.json).",
    ].join("\n  "),
    options: { sbpf: { type: "string" }, address: { type: "string" }, url: { type: "string" }, config: { type: "string" } },
    async run(v, args) {
      if (args.length < 1 || args.length > 2) throw new UsageError("verify takes the program and, optionally, the deployed .so");
      const [target, deployedPath] = args;
      if (deployedPath && (v.address || v.url)) throw new UsageError("give either a deployed .so or --address/--url, not both");
      if (v.address && !decodeAddress(v.address as string)) throw new UsageError(`--address "${v.address}" is not a base58 Solana address`);
      const ws = findWorkspace(process.cwd());
      const name = ws && (ws.programs[target] ? target : programForEntry(ws, target));
      const entry = ws && name ? programPaths(ws, name).entry : target;
      if (!existsSync(entry)) throw new UsageError(`${entry} does not exist`);

      let deployed: Buffer;
      let onChain:
        { address: string; info: import("./tools/onchain.js").Deployed; rpc: import("@solana/kit").Rpc<import("@solana/kit").SolanaRpcApi> } | undefined;
      if (deployedPath) {
        if (!existsSync(deployedPath)) throw new UsageError(`${deployedPath} does not exist`);
        deployed = readFileSync(deployedPath);
      } else {
        const address = (v.address as string | undefined) ?? (ws && name ? ws.programs[name].address : undefined);
        if (!address) throw new UsageError("no program address: pass --address, a deployed .so, or name a project program that has been built");
        const rpcUrl = (v.url as string | undefined) ?? solanaConfig(v.config as string | undefined).url;
        if (!rpcUrl) throw new Error("no RPC: pass --url, or set json_rpc_url in the Solana CLI config");
        // Loaded only here: the other commands do not need an RPC client.
        const kit = await import("@solana/kit");
        const { fetchDeployed } = await import("./tools/onchain.js");
        const rpc = kit.createSolanaRpc(clusterUrl(rpcUrl));
        const info = await fetchDeployed(rpc, address);
        onChain = { address, info, rpc };
        deployed = info.elf;
      }
      // ELF e_flags (offset 0x30) hold the SBPF version: 0 for v0, 1 for v1, 2 for v2.
      const flags = deployed.length > 0x34 && deployed.readUInt32BE(0) === 0x7f454c46 ? deployed.readUInt32LE(0x30) : 0;
      const sbpf = sbpfOf(v) ?? SBPF_VERSIONS[flags] ?? "v0";
      const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-verify-"));
      let res, same;
      try {
        res = build(entry, dir, onChain?.address ?? "11111111111111111111111111111111", { sbpf });
        same = verifyBinary(deployed, readFileSync(res.soPath));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      const what =
        deployedPath ??
        `${onChain!.address} (${onChain!.info.dataAccount === onChain!.address ? "" : `data ${onChain!.info.dataAccount}, `}loader ${onChain!.info.loader})`;
      log(
        same
          ? `  match     ${res.manifest.binary} (sbpf ${sbpf})`
          : `  MISMATCH  ${what} is not what ${entry} builds to (${res.manifest.binary}, sbpf ${sbpf})`,
      );
      if (!onChain) return same ? 0 : 3;

      const { info } = onChain;
      log(`  authority ${info.authority ?? "none: the program is immutable"}${info.slot !== undefined ? `; last deployed in slot ${info.slot}` : ""}`);
      const { fetchIdl, metadataAddress } = await import("./tools/idlpublish.js");
      const { canonicalJson } = await import("./tools/onchain.js");
      // No canonical metadata account means nothing was published; one that cannot be read is an error, not "none".
      const at = await metadataAddress(onChain.address as never, null);
      const exists = (await onChain.rpc.getAccountInfo(at, { encoding: "base64" }).send()).value !== null;
      if (!exists) {
        log("  idl       none published on chain (typesol idl publish)");
        return same ? 0 : 3;
      }
      let published: object;
      try {
        published = await fetchIdl(onChain.rpc, onChain.address as never);
      } catch (e) {
        log(`  IDL ERROR  the IDL at ${at} could not be read: ${(e as Error).message}`);
        return 3;
      }
      const idlSame = canonicalJson(published) === canonicalJson(res.idl);
      log(
        idlSame
          ? "  idl       match: the published IDL is the one the source builds"
          : "  IDL MISMATCH  the published IDL differs from the one the source builds",
      );
      return same && idlSame ? 0 : 3;
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

/** Make the compiler read `text` for `file` (instead of the disk) until the returned function is called. */
/** json_rpc_url / keypair_path from a Solana CLI config (the given file, or the CLI's default one). */
function solanaConfig(file?: string): { url?: string; keypair?: string } {
  const cfg = readSolanaConfig(file);
  if (file && !cfg.exists) throw new UsageError(`${file} does not exist`);
  return { url: cfg.url, keypair: cfg.keypair };
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
