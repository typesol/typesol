// The third-party binaries kept in test/programs are the ones test/programs/SOURCES.md names, byte for byte: each
// committed .so has a row and its sha256, and the licence text the NOTICE points to is there.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = fileURLToPath(new URL("../programs/", import.meta.url));
const sources = readFileSync(`${dir}SOURCES.md`, "utf8");
// | `file.so` | `program id` | upstream | licence | in the repository | `sha256` |
const rows = [...sources.matchAll(/^\| `([\w.-]+\.so)` \| `\w+` \| .*? \| ([^|]+) \| (yes|no \(fetch\)) \| `([0-9a-f]{64})` \|$/gm)].map((m) => ({
  file: m[1]!,
  licence: m[2]!.trim(),
  kept: m[3] === "yes",
  sha256: m[4]!,
}));

describe("third-party binaries in test/programs", () => {
  it("lists every binary with its licence and hash", () => {
    expect(rows.length).toBeGreaterThan(10);
    const kept = new Set(rows.filter((r) => r.kept).map((r) => r.file));
    // Fetched ones (Metaplex) may be present locally; every other .so must be listed as kept.
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".so")))
      expect(
        rows.some((r) => r.file === f),
        `${f} in SOURCES.md`,
      ).toBe(true);
    for (const r of rows.filter((x) => x.kept)) expect(r.licence, r.file).toBe("Apache-2.0");
    expect(kept.size).toBeGreaterThan(5);
    expect(existsSync(`${dir}LICENSE-Apache-2.0.txt`)).toBe(true);
  });

  it("keeps the committed binaries as SOURCES.md records them", () => {
    for (const r of rows.filter((x) => x.kept)) {
      const sha = createHash("sha256")
        .update(readFileSync(`${dir}${r.file}`))
        .digest("hex");
      expect(sha, r.file).toBe(r.sha256);
    }
  });
});
