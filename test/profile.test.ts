import { generateKeyPairSigner } from "@solana/kit";
import { LiteSVM } from "litesvm";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BorshCoder, type Idl } from "@anchor-lang/core";
import { describe, expect, it } from "vitest";
import { build } from "../src/compiler/index.js";
import { profileLogs } from "../src/profile.js";
import { BN, customError, deployFile, expectOk, fundedSigner, ix, send } from "./harness.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/profiled.ts", import.meta.url));

async function withAcc(profile: boolean) {
  const id = (await generateKeyPairSigner()).address;
  const out = build(FIXTURE, mkdtempSync(path.join(os.tmpdir(), "typesol-prof-")), id, { profile });
  const svm = new LiteSVM();
  svm.addProgramFromFile(id, out.soPath);
  const d = { svm, programId: id, coder: new BorshCoder(out.idl as unknown as Idl), idl: out.idl as unknown as Idl };
  const acc = (await generateKeyPairSigner()).address;
  const data = Buffer.alloc(16);
  Buffer.from(out.model.structs.get("Acc")!.accountDiscriminator).copy(data);
  svm.setAccount({ address: acc, data: new Uint8Array(data), executable: false, lamports: 1_000_000n as never, programAddress: id, space: 16n });
  return { d, acc };
}

describe("source locations and --profile", () => {
  it("names the TypeScript line in runtime failures", async () => {
    const d = await deployFile(FIXTURE);
    const payer = await fundedSigner(d.svm);
    const res = await send(d.svm, payer, [ix(d, "work", { n: new BN(5) }, [{ address: payer.address, writable: true }])]);
    expect(customError(res)).toBe(3007);
    const { d: p, acc } = await withAcc(false);
    const payer2 = await fundedSigner(p.svm);
    const big = await send(p.svm, payer2, [ix(p, "work", { n: new BN(200) }, [{ address: acc, writable: true }])]);
    expect(customError(big)).toBe(6000);
    expect((big as { meta(): { logs(): string[] } }).meta().logs()).toContain("Program log: Error 6000 RequireFailed0: too big (profiled.ts:13)");
  });

  it("attributes compute units to statements; the profile adds up to the measured cost", async () => {
    const { d, acc } = await withAcc(true);
    const payer = await fundedSigner(d.svm);
    // Enough loop passes that the statements, not the fixed entry and return-data cost, make up most of the total.
    const r = expectOk(await send(d.svm, payer, [ix(d, "work", { n: new BN(100) }, [{ address: acc, writable: true }])]));
    const rows = profileLogs(r.logs(), d.programId);
    const byLine = Object.fromEntries(rows.map((row) => [row.location, row]));
    expect(byLine["profiled.ts:10"].calls).toBe(100); // the loop body
    expect(byLine["profiled.ts:9"].calls).toBe(1);
    expect(Object.keys(byLine)).toEqual(expect.arrayContaining(["profiled.ts:8", "profiled.ts:12", "profiled.ts:13", "profiled.ts:14"]));
    // Against the same program built without markers: the profile explains the statements' cost to within the
    // entry/dispatch code that runs before the first marker.
    const { d: plain, acc: acc2 } = await withAcc(false);
    const p2 = await fundedSigner(plain.svm);
    const consumed = Number(
      expectOk(await send(plain.svm, p2, [ix(plain, "work", { n: new BN(100) }, [{ address: acc2, writable: true }])])).computeUnitsConsumed(),
    );
    const profiled = rows.reduce((s, row) => s + row.units, 0);
    expect(profiled).toBeLessThanOrEqual(consumed);
    expect(profiled).toBeGreaterThan(consumed * 0.5);
  });
});
