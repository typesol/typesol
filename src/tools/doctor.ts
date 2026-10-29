// `typesol doctor` and the checks `init` and `deploy` run before they need something: Node, the platform-tools the
// compiler builds with, the Solana CLI, its keypair and RPC, the project, and (with an RPC) whether it answers and the
// payer can afford a deploy. Each problem comes with the command that fixes it.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findToolchain } from "../compiler/toolchain.js";
import { base58, readKeypair } from "../keys.js";
import { findWorkspace } from "../workspace.js";

export const INSTALL_AGAVE = 'sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"';
const MIN_NODE = [22, 12] as const;

export interface Check {
  ok: boolean;
  /** A missing optional piece (the Solana CLI is only needed to deploy). */
  optional?: boolean;
  what: string;
  detail: string;
  fix?: string[];
}

/** The platform-tools the compiler needs: found, or what to run. */
export function toolchainCheck(): Check {
  try {
    const tc = findToolchain();
    let version = "";
    try {
      version = execFileSync(tc.clang, ["--version"], { encoding: "utf8" })
        .split("\n")[0]!
        .replace(/\s*\(.*$/, "");
    } catch {
      /* the path is enough */
    }
    return { ok: true, what: "platform-tools", detail: version || tc.sdk };
  } catch (e) {
    return {
      ok: false,
      what: "platform-tools",
      detail: (e as Error).message.split(". ")[0]!,
      fix: [INSTALL_AGAVE, "cargo-build-sbf --version   # once: downloads the platform-tools TypeSOL compiles with"],
    };
  }
}

/** json_rpc_url / keypair_path from a Solana CLI config (the given file, or the CLI's default one). */
export function solanaConfig(file?: string): { url?: string; keypair?: string; file: string; exists: boolean } {
  const configPath = file ?? path.join(os.homedir(), ".config/solana/cli/config.yml");
  if (!existsSync(configPath)) return { file: configPath, exists: false };
  const text = readFileSync(configPath, "utf8");
  const get = (k: string) => new RegExp(`^${k}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, "m").exec(text)?.[1];
  const expand = (p?: string) => (p?.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);
  return { url: get("json_rpc_url"), keypair: expand(get("keypair_path")), file: configPath, exists: true };
}

/** The Solana CLI's cluster monikers, as `solana --url` accepts them; anything else is used as given. */
export function clusterUrl(url: string): string {
  const monikers: Record<string, string> = {
    "mainnet-beta": "https://api.mainnet-beta.solana.com",
    m: "https://api.mainnet-beta.solana.com",
    devnet: "https://api.devnet.solana.com",
    d: "https://api.devnet.solana.com",
    testnet: "https://api.testnet.solana.com",
    t: "https://api.testnet.solana.com",
    localhost: "http://127.0.0.1:8899",
    l: "http://127.0.0.1:8899",
  };
  return monikers[url] ?? url;
}

/** Only the host: an RPC URL can carry an API key in its path or query, and these messages may be shared. */
export function rpcHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the RPC";
  }
}

/** The cluster an RPC belongs to, for the airdrop hint (mainnet has none). */
function clusterOf(url: string): "devnet" | "testnet" | "localhost" | undefined {
  const host = rpcHost(url);
  if (/devnet/.test(host)) return "devnet";
  if (/testnet/.test(host)) return "testnet";
  if (/^(127\.0\.0\.1|localhost|0\.0\.0\.0)(:|$)/.test(host)) return "localhost";
  return undefined;
}

export async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result as T;
}

/** fetch's "fetch failed" says little: the cause's code (ECONNREFUSED, ENOTFOUND, a timeout) says more. */
export const errText = (e: unknown) => {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  return err.cause?.code ?? err.cause?.message ?? (err.name === "TimeoutError" ? "no answer in 10 s" : err.message);
};

const sol = (lamports: number) =>
  lamports === 0 ? "0 SOL" : lamports < 100_000 ? `${lamports} lamports` : `${(lamports / 1e9).toFixed(lamports < 1e7 ? 4 : 2)} SOL`;
/** A cost, rounded up so the advice is enough. */
const solUp = (lamports: number) => `${(Math.ceil(lamports / 1e7) / 100).toFixed(2)} SOL`;

/**
 * Before `solana program deploy`: the RPC answers, and the payer holds enough for the program's rent (a first deploy
 * holds about twice the binary's rent while the buffer exists; an upgrade, the buffer's). Throws with what to do.
 */
export async function deployPreflight(opts: { url: string; payer?: string; programs: { soPath: string; address: string; name: string }[] }): Promise<void> {
  const host = rpcHost(opts.url);
  try {
    await rpc(opts.url, "getVersion");
  } catch (e) {
    const local = clusterOf(opts.url) === "localhost";
    throw new Error(
      `cannot reach ${host} (${errText(e)}). ` +
        (local
          ? "Start a local validator in another terminal: `solana-test-validator`, or deploy to devnet with --url devnet."
          : "Check --url (or json_rpc_url in the Solana CLI config); for a test deploy use --url devnet or a local `solana-test-validator`."),
    );
  }
  if (!opts.payer || !existsSync(opts.payer)) return; // the Solana CLI reports a missing keypair itself
  const payer = base58(readKeypair(opts.payer).subarray(32));
  let need = 0;
  for (const p of opts.programs) {
    const size = statSync(p.soPath).size;
    const exists = (await rpc<{ value: unknown }>(opts.url, "getAccountInfo", [p.address, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }])).value;
    const rent = await rpc<number>(opts.url, "getMinimumBalanceForRentExemption", [size + 45]);
    need += exists ? rent : 2 * rent;
  }
  need += 5_000_000; // fees for the buffer writes
  const balance = (await rpc<{ value: number }>(opts.url, "getBalance", [payer])).value;
  if (balance >= need) return;
  const cluster = clusterOf(opts.url);
  const airdrop = cluster ? ` Get test SOL: \`solana airdrop ${Math.max(2, Math.ceil((need - balance) / 1e9))} ${payer} --url ${cluster}\`.` : "";
  throw new Error(
    `the payer ${payer} has ${sol(balance)} on ${host}; deploying needs about ${solUp(need)} (rent, mostly returned when a buffer closes).${airdrop}`,
  );
}

/** Everything `typesol doctor` checks, in order. */
export async function doctorChecks(opts: { cwd: string; url?: string; config?: string }): Promise<Check[]> {
  const checks: Check[] = [];
  const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
  const nodeOk = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  checks.push({
    ok: nodeOk,
    what: "Node.js",
    detail: process.versions.node,
    fix: nodeOk ? undefined : [`install Node.js ${MIN_NODE.join(".")} or later (https://nodejs.org)`],
  });
  checks.push(toolchainCheck());
  let solanaVersion: string | undefined;
  try {
    solanaVersion = execFileSync("solana", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(" (")[0]!
      .trim();
  } catch {
    /* not installed */
  }
  checks.push(
    solanaVersion
      ? { ok: true, what: "Solana CLI", detail: solanaVersion }
      : { ok: false, optional: true, what: "Solana CLI", detail: "not on PATH (needed to deploy, not to build or test)", fix: [INSTALL_AGAVE] },
  );
  const cfg = solanaConfig(opts.config);
  const keypair = cfg.keypair ?? path.join(os.homedir(), ".config/solana/id.json");
  if (existsSync(keypair)) {
    let address = "";
    try {
      address = base58(readKeypair(keypair).subarray(32));
    } catch (e) {
      checks.push({ ok: false, optional: true, what: "keypair", detail: (e as Error).message });
    }
    if (address) checks.push({ ok: true, what: "keypair", detail: `${address} (${keypair.replace(os.homedir(), "~")})` });
  } else
    checks.push({
      ok: false,
      optional: true,
      what: "keypair",
      detail: `none at ${keypair.replace(os.homedir(), "~")} (the deploy payer)`,
      fix: ["solana-keygen new"],
    });
  const url = opts.url ? clusterUrl(opts.url) : cfg.url;
  if (!url) checks.push({ ok: false, optional: true, what: "RPC", detail: "none set (deploy takes --url)", fix: ["solana config set --url devnet"] });
  else {
    const cluster = clusterOf(url);
    try {
      const v = await rpc<{ "solana-core": string }>(url, "getVersion");
      checks.push({ ok: true, what: "RPC", detail: `${rpcHost(url)} (solana-core ${v["solana-core"]})` });
      if (existsSync(keypair)) {
        const balance = (await rpc<{ value: number }>(url, "getBalance", [base58(readKeypair(keypair).subarray(32))])).value;
        checks.push(
          balance > 0
            ? { ok: true, what: "balance", detail: sol(balance) }
            : {
                ok: false,
                optional: true,
                what: "balance",
                detail: `0 SOL on ${rpcHost(url)}`,
                fix: [
                  cluster && cluster !== "localhost"
                    ? `solana airdrop 2 --url ${cluster}`
                    : cluster
                      ? "solana airdrop 2 --url localhost"
                      : "fund the keypair above",
                ],
              },
        );
      }
    } catch (e) {
      checks.push({
        ok: false,
        optional: true,
        what: "RPC",
        detail: `${rpcHost(url)} does not answer (${errText(e)})`,
        fix: cluster === "localhost" ? ["solana-test-validator   # in another terminal"] : ["pass --url devnet, or fix json_rpc_url in the Solana CLI config"],
      });
    }
  }
  const ws = findWorkspace(opts.cwd);
  checks.push(
    ws
      ? { ok: true, what: "project", detail: `${path.relative(opts.cwd, ws.file) || ws.file}: ${Object.keys(ws.programs).join(", ")}` }
      : { ok: true, optional: true, what: "project", detail: "none here (typesol init <dir> creates one)" },
  );
  return checks;
}

export function formatChecks(checks: Check[]): string {
  const mark = (c: Check) => (c.ok ? "ok " : c.optional ? " ! " : "ERR");
  const width = Math.max(...checks.map((c) => c.what.length));
  return checks
    .map((c) => `  ${mark(c)}  ${c.what.padEnd(width)}  ${c.detail}${(c.fix ?? []).map((f) => `\n${" ".repeat(width + 9)}${f}`).join("")}`)
    .join("\n");
}
