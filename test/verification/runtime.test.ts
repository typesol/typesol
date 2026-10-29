import { address, getAddressEncoder } from "@solana/kit";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../runtime/typesol_rt.h", import.meta.url), "utf8");
const bytesOf = (name: string) => {
  const m = new RegExp(`${name} = \\{\\{([^}]*)\\}\\}`).exec(src);
  if (!m) throw new Error(`${name} not found`);
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
};

describe("runtime/typesol_rt.h", () => {
  // Every hard-coded program id must be the real one.
  const ids: [string, string][] = [
    ["TS_TOKEN_PROGRAM_ID", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
    ["TS_TOKEN_2022_PROGRAM_ID", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"],
    ["TS_ED25519_PROGRAM_ID", "Ed25519SigVerify111111111111111111111111111"],
    ["TS_INSTRUCTIONS_SYSVAR_ID", "Sysvar1nstructions1111111111111111111111111"],
    ["TS_PYTH_RECEIVER_ID", "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"],
    ["TS_SWITCHBOARD_MAINNET_ID", "SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv"],
    ["TS_SWITCHBOARD_DEVNET_ID", "Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2"],
    ["TS_ATA_PROGRAM_ID", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"],
    ["TS_BPF_UPGRADEABLE_LOADER_ID", "BPFLoaderUpgradeab1e11111111111111111111111"],
    ["TS_MPL_METADATA_ID", "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"],
    ["TS_MPL_CORE_ID", "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"],
    ["TS_BUBBLEGUM_ID", "BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY"],
  ];
  for (const [name, base58] of ids) {
    it(`${name} is ${base58}`, () => {
      expect(bytesOf(name)).toEqual([...getAddressEncoder().encode(address(base58))]);
    });
  }
});

describe("stack usage", () => {
  it("builds an instruction with several CPIs and events without blowing the 4KB frame", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { build } = await import("../../src/compiler/index.js");
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-stack-"));
    const file = path.join(dir, "busy.ts");
    writeFileSync(
      file,
      `import { type AccountInfo, type Mut, type Pubkey, type Signer, type UncheckedProgram, type u64, emit, invoke, readonly, readonlySigner, sighash, writable } from "typesol";
export interface Ping { who: Pubkey; n: u64; }
export function busy(a: Signer, b: Mut<AccountInfo>, p: UncheckedProgram, n: u64): void {
  invoke(p, [readonlySigner(a), writable(b)], [sighash("one"), n]);
  emit<Ping>({ who: a.key, n });
  invoke(p, [readonlySigner(a), writable(b)], [sighash("two"), n, n]);
  emit<Ping>({ who: b.key, n });
  invoke(p, [readonly(a), writable(b)], [sighash("three"), a.key, b.key]);
  emit<Ping>({ who: p.key, n });
}
`,
    );
    expect(() => build(file, dir, "11111111111111111111111111111111")).not.toThrow();
  });
});
