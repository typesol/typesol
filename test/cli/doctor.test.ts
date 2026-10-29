// The first minutes: `typesol doctor`, what `init` says when the platform-tools are missing, and the checks `deploy`
// runs before sending anything (an RPC that does not answer, a payer that cannot pay), against a fake RPC.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI = path.join(ROOT, "dist/cli.js");
const dirs: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), "typesol-doctor-")));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Runs the CLI without blocking this process (the fake RPC below answers from it). */
const run = (args: string[], cwd: string, env: Record<string, string> = {}) =>
  new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    execFile("node", [CLI, ...args], { cwd, env: { ...process.env, ...env } }, (err, stdout, stderr) =>
      resolve({ status: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
/** A user with no Solana toolchain and no Solana CLI config: an empty HOME, and only Node on PATH. */
const fresh = () => {
  const home = tmp();
  return { HOME: home, PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter), TYPESOL_SBF_SDK: "" };
};

/** A JSON-RPC server that answers like a cluster where `balance` lamports sit in every account. */
let rpc: Server;
let rpcUrl = "";
let balance = 0;
beforeAll(async () => {
  rpc = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { method, id } = JSON.parse(body) as { method: string; id: number };
      const result =
        method === "getVersion"
          ? { "solana-core": "3.1.10" }
          : method === "getBalance"
            ? { value: balance }
            : method === "getAccountInfo"
              ? { value: null }
              : method === "getMinimumBalanceForRentExemption"
                ? 100_000_000
                : null;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((r) => rpc.listen(0, "127.0.0.1", r));
  rpcUrl = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
});
afterAll(() => rpc.close());

describe("first minutes: doctor, init, deploy preflight", () => {
  it("doctor and init point a user without the platform-tools at the install commands", async () => {
    const env = fresh();
    const dir = tmp();
    const init = await run(["init", "app", "--name", "counter"], dir, env);
    expect(init.status).toBe(0);
    expect(init.stdout).toContain("created app/programs/counter.ts");
    expect(init.stdout).toMatch(/platform-tools are not installed yet[\s\S]*release\.anza\.xyz[\s\S]*cargo-build-sbf --version/);
    expect(init.stdout).toMatch(/next:\n {4}cd app\n {4}npm install\n {4}npm test/);

    const doctor = await run(["doctor"], path.join(dir, "app"), env);
    expect(doctor.status).toBe(1); // building is impossible without the platform-tools
    expect(doctor.stdout).toMatch(/ERR {2}platform-tools/);
    expect(doctor.stdout).toMatch(/! {3}keypair .*\n.*solana-keygen new/);
    expect(doctor.stdout).toMatch(/ok {3}project +typesol\.json: counter/);
  });

  it("doctor on this machine: everything building needs is there (exit 0), and the RPC's balance is read", async () => {
    const dir = tmp();
    const home = tmp();
    mkdirSync(path.join(home, ".config/solana"), { recursive: true });
    // A throwaway keypair (64 bytes) as the CLI's default payer.
    writeFileSync(path.join(home, ".config/solana/id.json"), JSON.stringify(Array.from({ length: 64 }, (_, i) => i + 1)));
    balance = 0;
    const doctor = await run(["doctor", "--url", rpcUrl], dir, { HOME: home });
    expect(doctor.stdout).toMatch(/ok {3}RPC +127\.0\.0\.1:\d+ \(solana-core 3\.1\.10\)/);
    expect(doctor.stdout).toMatch(/! {3}balance +0 SOL on 127\.0\.0\.1:\d+\n.*solana airdrop 2 --url localhost/);
  });

  it("deploy stops before any transaction when the RPC does not answer, or the payer cannot pay", async () => {
    const dir = tmp();
    expect((await run(["init", ".", "--name", "counter"], dir)).status).toBe(0);
    const payer = path.join(dir, "payer.json");
    writeFileSync(payer, JSON.stringify(Array.from({ length: 64 }, (_, i) => 64 - i)));

    // A port nothing listens on: open one, note it, close it.
    const closed = await new Promise<number>((r) => {
      const s = createServer().listen(0, "127.0.0.1", () => {
        const port = (s.address() as AddressInfo).port;
        s.close(() => r(port));
      });
    });
    const down = await run(["deploy", "--url", `http://127.0.0.1:${closed}`, "--keypair", payer], dir);
    expect(down.status).toBe(1);
    expect(down.stderr).toMatch(/cannot reach 127\.0\.0\.1:\d+ \(ECONNREFUSED\)\. Start a local validator .*solana-test-validator/);

    balance = 1_000;
    const poor = await run(["deploy", "--url", rpcUrl, "--keypair", payer], dir);
    expect(poor.status).toBe(1);
    // A first deploy: twice the rent (100_000_000 from the fake RPC) plus fees.
    expect(poor.stderr).toMatch(/the payer \w+ has 1000 lamports on 127\.0\.0\.1:\d+; deploying needs about 0\.21 SOL .*solana airdrop 2 \w+ --url localhost/);
  });
});
