// `acct.pdaBump` on Seeds<…> accounts (Anchor `ctx.bumps.<account>`): test/fixtures/pda-bump.ts.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { CompileError, generate } from "../src/compiler/index.js";
import { SYSTEM_PROGRAM, customError, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "./harness.js";

describe("pdaBump on Seeds<…> accounts", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/pda-bump.ts", import.meta.url)));
  });

  it("is the canonical bump the check found, or the stored bump field", async () => {
    const payer = await fundedSigner(d.svm);
    const [auth, authBump] = await pda(d.programId, ["auth", payer.address]);
    const r = expectOk(await send(d.svm, payer, [ix(d, "found", {}, [{ address: payer.address, signer: payer }, { address: auth }])]));
    expect([...r.returnData().data()]).toEqual([authBump]);

    const [vault, vaultBump] = await pda(d.programId, ["vault", payer.address]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "make", {}, [{ address: payer.address, signer: payer, writable: true }, { address: vault, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    const s = expectOk(await send(d.svm, payer, [ix(d, "stored", {}, [{ address: payer.address, signer: payer }, { address: vault }])]));
    expect([...s.returnData().data()]).toEqual([vaultBump]);

    // Another payer's PDA still fails the check before the body reads the bump.
    const other = await fundedSigner(d.svm);
    expect(customError(await send(d.svm, other, [ix(d, "found", {}, [{ address: other.address, signer: other }, { address: auth }])]))).toBe(2006);
  });

  it("is refused on accounts without Seeds<…>", () => {
    const f = path.join(mkdtempSync(path.join(os.tmpdir(), "typesol-bump-")), "p.ts");
    writeFileSync(f, `import { type AccountInfo, type u8 } from "typesol";\nexport function f(a: AccountInfo): u8 { return a.pdaBump; }\n`);
    let message = "";
    try {
      generate(f);
    } catch (e) {
      if (!(e instanceof CompileError)) throw e;
      message = e.diagnostics.map((x) => x.message).join("\n");
    }
    expect(message).toMatch(/'pdaBump' does not exist/); // the type checker refuses it first
  });
});
