// The solana-developers/program-examples Anchor programs TypeSOL cannot express yet (BLOCKED in test/ports/README.md):
// each case compiles the smallest TypeSOL rendering of the construct the original needs and checks the compiler still
// refuses it. When one of these starts compiling, the probe fails and the program can be ported.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CompileError, generate } from "../src/compiler/index.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-ports-blocked-"));
function compileErrors(name: string, source: string): string[] {
  const file = path.join(dir, `${name}.ts`);
  writeFileSync(file, source);
  try {
    generate(file);
  } catch (e) {
    if (e instanceof CompileError) return e.diagnostics.map((x) => x.message);
    throw e;
  }
  return [];
}

/** A transfer hook whose ExtraAccountMetaList holds an extra account. */
function hookWithExtraAccount(name: string): string[] {
  return compileErrors(
    name,
    `import { type AccountInfo, type Mint, type Mut, type Signer, type SystemProgram, initExtraAccountMetas } from "typesol";
/** @discriminator spl-transfer-hook-interface:initialize-extra-account-metas */
export function initializeExtraAccountMetaList(payer: Mut<Signer>, extraMetas: Mut<AccountInfo>, mint: Mint, systemProgram: SystemProgram): void {
  initExtraAccountMetas(payer, extraMetas, mint, systemProgram, [{ seeds: ["counter"], isSigner: false, isWritable: true }]);
}`,
  );
}

/** Each BLOCKED program, the upstream line that needs the construct, and the probe for it. */
const BLOCKED: { program: string; source: string; construct: string; probe: (name: string) => string[]; refused: RegExp }[] = [
  ...[
    ["tokens/token-2022/transfer-hook/account-data-as-seed", "account-data-as-seed/src/lib.rs:129 `ExtraAccountMeta::new_with_seeds(…Seed::AccountData…)`"],
    ["tokens/token-2022/transfer-hook/allow-block-list-token", "abl-token/src/utils.rs:18 `ExtraAccountMeta::new_with_seeds(…)`"],
    [
      "tokens/token-2022/transfer-hook/counter",
      'counter/src/lib.rs:125 `ExtraAccountMeta::new_with_seeds(&[Seed::Literal { bytes: b"counter".to_vec() }], false, true)`',
    ],
    [
      "tokens/token-2022/transfer-hook/transfer-cost",
      "transfer-cost/src/lib.rs:161 `ExtraAccountMeta::new_with_pubkey(&wsol_mint, false, false)` and six more",
    ],
    [
      "tokens/token-2022/transfer-hook/transfer-switch",
      "transfer-switch/src/instructions/initialise_extra_account_metas_list.rs:41 `ExtraAccountMeta::new_with_seeds(…)`",
    ],
  ].map(([program, source]) => ({
    program,
    source,
    construct: "an extra account in the transfer hook's ExtraAccountMetaList",
    probe: hookWithExtraAccount,
    refused: /Expected 4 arguments/,
  })),
];

for (const b of BLOCKED) {
  describe(`port: ${b.program}`, () => {
    it(`is blocked: ${b.construct} does not compile yet`, () => {
      // When this fails, the construct compiles: port the program (upstream needs it at the line in the message).
      expect(b.probe(b.program.replace(/\W/g, "_")).join("\n"), `${b.program}: ${b.source}`).toMatch(b.refused);
    });
  });
}
