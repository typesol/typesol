import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { build, verifyBinary } from "../../src/compiler/index.js";

const ESCROW = fileURLToPath(new URL("../../examples/escrow.ts", import.meta.url));
const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "typesol-verify-test-"));

describe("reproducible builds", () => {
  it("builds byte-identical binaries in different directories and for different program ids, with a manifest", () => {
    const a = build(ESCROW, tmp(), "11111111111111111111111111111112");
    const b = build(ESCROW, tmp(), "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T");
    expect(readFileSync(a.soPath).equals(readFileSync(b.soPath))).toBe(true);
    expect(a.manifest.binary).toBe(b.manifest.binary);
    expect(Object.keys(a.manifest.sources)).toEqual(["escrow.ts", "<runtime>/typesol_rt.h"]);
    expect(JSON.parse(readFileSync(a.manifestPath, "utf8")).clang).toMatch(/^clang version/);
  });

  it("verifies a deployed binary (zero padding allowed) and rejects a different one", () => {
    const built = readFileSync(build(ESCROW, tmp(), "11111111111111111111111111111112").soPath);
    expect(verifyBinary(Buffer.concat([built, Buffer.alloc(4096)]), built)).toBe(true);
    const tampered = Buffer.from(built);
    tampered[200] ^= 1;
    expect(verifyBinary(tampered, built)).toBe(false);
    const dir = tmp();
    writeFileSync(path.join(dir, "dumped.so"), Buffer.concat([built, Buffer.alloc(100)]));
    expect(execFileSync("node", [CLI, "verify", ESCROW, path.join(dir, "dumped.so")], { encoding: "utf8" })).toMatch(/match/);
    writeFileSync(path.join(dir, "other.so"), tampered);
    expect(() => execFileSync("node", [CLI, "verify", ESCROW, path.join(dir, "other.so")], { stdio: "pipe" })).toThrow();
  });
});
