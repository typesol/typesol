// Metaplex Core plugin literals refused at compile time (the plugins themselves run in test/metaplex.test.ts).
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CompileError, generate } from "../src/compiler/index.js";

describe("Metaplex Core plugins", () => {
  it("refuses plugin literals Core would reject", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-coreplug-"));
    const errors = (call: string) => {
      const file = path.join(dir, `p${Math.random().toString(36).slice(2)}.ts`);
      writeFileSync(
        file,
        `import { type AccountInfo, type MplCoreProgram, type Mut, type Signer, type SystemProgram } from "typesol";\n` +
          `export function f(asset: Mut<Signer>, payer: Mut<Signer>, other: AccountInfo, core: MplCoreProgram, sys: SystemProgram): void {\n  ${call};\n}\n`,
      );
      try {
        generate(file);
        return "";
      } catch (e) {
        if (e instanceof CompileError) return e.diagnostics.map((x) => x.message).join(" | ");
        throw e;
      }
    };
    const create = (plugins: string) => errors(`core.createAsset(asset, null, null, payer, null, sys, "n", "u", [${plugins}])`);
    expect(create(`{ kind: "Royalties", basisPoints: 500n, creators: [{ address: payer.key, percentage: 100n }] }`)).toBe("");
    expect(create(`{ kind: "Royalties", basisPoints: 500n, creators: [{ address: payer.key, percentage: 90n }] }`)).toMatch(/add up to 90; Core requires 100/);
    expect(create(`{ kind: "Royalties", basisPoints: 10001n, creators: [] }`)).toMatch(/at most 10000/);
    expect(create(`{ kind: "BurnDelegate" }, { kind: "BurnDelegate" }`)).toMatch(/listed twice/);
    expect(create(`{ kind: "TransferDelegate", authority: other.key }, { kind: "AddBlocker", authority: "none" }`)).toBe("");
    expect(create(`{ kind: "MasterEdition" } as never`)).not.toBe("");
    expect(errors(`core.updatePlugin(asset, null, payer, null, sys, { kind: "FreezeDelegate", frozen: true, authority: "owner" })`)).toMatch(
      /authority is set when it is added/,
    );
    expect(errors(`core.removePlugin(asset, null, payer, null, sys, "Edition")`)).toBe("");
    expect(errors(`core.burnAsset(asset, null, payer, null); core.mintPlugin(asset)`)).not.toBe("");
    const add = (plugin: string) => errors(`core.addExternalPlugin(asset, null, payer, null, sys, ${plugin})`);
    expect(add(`{ kind: "AppData", dataAuthority: "owner", schema: "json" }`)).toBe("");
    expect(add(`{ kind: "Oracle", baseAddress: other.key, checks: [{ event: "transfer", canReject: true }], resultsOffset: 8n }`)).toBe("");
    expect(add(`{ kind: "Oracle", baseAddress: other.key, checks: [{ event: "mint" as never }] }`)).toMatch(/event is "create", "transfer"/);
    expect(add(`{ kind: "AppData", dataAuthority: "owner", hookedProgram: other.key } as never`)).toMatch(/AppData takes dataAuthority, schema and authority/);
    expect(add(`{ kind: "LifecycleHook", hookedProgram: other.key, checks: [], extraAccounts: [{ kind: "customPda" } as never] }`)).toMatch(
      /an extra account is/,
    );
  });
});
