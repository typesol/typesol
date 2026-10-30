// typesol clone: cluster accounts and programs copied for the tests, and loaded back into a LiteSVM.
import { type Address, generateKeyPairSigner, getAddressEncoder } from "@solana/kit";
import { LiteSVM } from "litesvm";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { testProgram } from "../../src/testing.js";
import { cloneAccounts, loadClonedAccounts } from "../../src/tools/clone.js";
import { expectOk, fundedSigner, send } from "../harness.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI = path.join(ROOT, "dist/cli.js");
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";
const tmp = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), "typesol-clone-")));

/** A cluster of three accounts: a token-owned account, an upgradeable program (spl_noop) and its ProgramData. */
async function cluster() {
  const [plain, program, programData] = await Promise.all([0, 1, 2].map(async () => (await generateKeyPairSigner()).address));
  const elf = readFileSync(path.join(ROOT, "test/programs/spl_noop.so"));
  const programAccount = Buffer.alloc(36);
  programAccount.writeUInt32LE(2, 0);
  Buffer.from(getAddressEncoder().encode(programData)).copy(programAccount, 4);
  const header = Buffer.alloc(45);
  header.writeUInt32LE(3, 0);
  const accounts = new Map<string, { lamports: bigint; owner: string; executable: boolean; data: [string, string] }>([
    [plain, { lamports: 2_039_280n, owner: TOKEN, executable: false, data: [Buffer.from([1, 2, 3, 4]).toString("base64"), "base64"] }],
    [program, { lamports: 1_141_440n, owner: UPGRADEABLE, executable: true, data: [programAccount.toString("base64"), "base64"] }],
    [programData, { lamports: 9_000_000n, owner: UPGRADEABLE, executable: false, data: [Buffer.concat([header, elf]).toString("base64"), "base64"] }],
  ]);
  const rpc = {
    getMultipleAccounts: (addresses: string[]) => ({ send: async () => ({ value: addresses.map((a) => accounts.get(a) ?? null) }) }),
  };
  return { plain, program, programData, elf, accounts, rpc };
}

describe("typesol clone", () => {
  it("writes accounts as JSON and programs as their ELF, and loads them into a LiteSVM", async () => {
    const c = await cluster();
    const dir = tmp();
    const lines = await cloneAccounts(c.rpc as never, [c.plain, c.program], dir);
    expect(lines).toHaveLength(2);
    expect(readFileSync(path.join(dir, `${c.program}.so`))).toEqual(c.elf);
    const json = JSON.parse(readFileSync(path.join(dir, `${c.plain}.json`), "utf8"));
    expect(json).toEqual({ address: c.plain, lamports: "2039280", owner: TOKEN, executable: false, data: "AQIDBA==" });

    const svm = new LiteSVM();
    expect(loadClonedAccounts(svm as never, dir)).toBe(2);
    const a = svm.getAccount(c.plain as Address);
    expect([a.exists, a.exists && [...a.data], a.exists && a.programAddress, a.exists && a.lamports]).toEqual([true, [1, 2, 3, 4], TOKEN, 2_039_280n]);
    // The cloned program runs.
    const payer = await fundedSigner(svm);
    expectOk(await send(svm, payer, [{ programAddress: c.program as Address, accounts: [], data: new Uint8Array([1]) } as never]));

    await expect(cloneAccounts(c.rpc as never, [(await generateKeyPairSigner()).address], tmp())).rejects.toThrow(/not found on the cluster/);
    expect(loadClonedAccounts(svm as never, path.join(dir, "none"))).toBe(0);
  });

  it("runs from the CLI against an RPC, with the project's clone list", async () => {
    const c = await cluster();
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const { id, method, params } = JSON.parse(body);
        const value =
          method === "getMultipleAccounts"
            ? (params[0] as string[]).map((a) => {
                const x = c.accounts.get(a);
                return x && { ...x, lamports: Number(x.lamports), rentEpoch: 0, space: Buffer.from(x.data[0], "base64").length };
              })
            : null;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const run = (args: string[], cwd: string) =>
      new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
        const p = spawn("node", [CLI, ...args], { cwd });
        let stdout = "";
        let stderr = "";
        p.stdout.on("data", (d) => (stdout += d));
        p.stderr.on("data", (d) => (stderr += d));
        p.on("close", (status) => resolve({ status, stdout, stderr }));
      });
    try {
      const dir = tmp();
      writeFileSync(path.join(dir, "typesol.json"), JSON.stringify({ programs: { app: "programs/app.ts" }, clone: [c.plain, c.program] }));
      const out = await run(["clone", "--url", url], dir);
      expect(out.stderr).toBe("");
      expect(out.status).toBe(0);
      expect(out.stdout).toContain("2 written to tests/accounts");
      expect(existsSync(path.join(dir, "tests/accounts", `${c.program}.so`))).toBe(true);
      // The RPC address is not echoed.
      expect(out.stdout).not.toContain(url);
      const one = await run(["clone", c.plain, "--url", url, "--out", "fixtures"], dir);
      expect(one.status).toBe(0);
      expect(existsSync(path.join(dir, "fixtures", `${c.plain}.json`))).toBe(true);
    } finally {
      server.close();
    }
    const bare = tmp();
    expect(spawnSync("node", [CLI, "clone"], { cwd: bare, encoding: "utf8" }).status).toBe(2);
    expect(spawnSync("node", [CLI, "clone", "not-an-address"], { cwd: bare, encoding: "utf8" }).status).toBe(2);
  });
  it("testProgram loads the project's cloned accounts", async () => {
    const c = await cluster();
    const dir = tmp();
    writeFileSync(path.join(dir, "typesol.json"), JSON.stringify({ programs: { app: "programs/app.ts" } }));
    mkdirSync(path.join(dir, "programs"));
    writeFileSync(path.join(dir, "programs/app.ts"), `import { type Signer } from "typesol";\nexport function ping(who: Signer): void {}\n`);
    await cloneAccounts(c.rpc as never, [c.plain], path.join(dir, "tests/accounts"));
    const t = await testProgram("app", dir);
    const a = t.svm.getAccount(c.plain as Address);
    expect(a.exists && [...a.data]).toEqual([1, 2, 3, 4]);
  });
});
