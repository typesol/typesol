import { type Idl, BorshCoder } from "@anchor-lang/core";
import { generateKeyPairSigner } from "@solana/kit";
import { LiteSVM } from "litesvm";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { build, SBPF_VERSIONS } from "../src/compiler/index.js";
import { BN, SYSTEM_PROGRAM, expectOk, fundedSigner, ix, pda, send } from "./harness.js";

const COUNTER = fileURLToPath(new URL("../examples/counter.ts", import.meta.url));

describe("SBPF versions", () => {
  for (const sbpf of SBPF_VERSIONS) {
    it(`builds and runs examples/counter.ts for SBPF ${sbpf}`, async () => {
      const id = (await generateKeyPairSigner()).address;
      const out = build(COUNTER, mkdtempSync(path.join(os.tmpdir(), `typesol-${sbpf}-`)), id, { sbpf });
      // e_flags in the ELF header carry the SBPF version (0 for v0).
      const flags = readFileSync(out.soPath).readUInt32LE(0x30);
      expect(flags).toBe(sbpf === "v0" ? 0 : Number(sbpf.slice(1)));
      const svm = new LiteSVM();
      svm.addProgramFromFile(id, out.soPath);
      const d = { svm, programId: id, coder: new BorshCoder(out.idl as unknown as Idl), idl: out.idl as unknown as Idl };
      const alice = await fundedSigner(svm);
      const [counter] = await pda(id, ["counter", alice.address]);
      expectOk(
        await send(svm, alice, [
          ix(d, "initialize", {}, [
            { address: alice.address, signer: alice, writable: true },
            { address: counter, writable: true },
            { address: SYSTEM_PROGRAM },
          ]),
        ]),
      );
      expectOk(
        await send(svm, alice, [
          ix(d, "increment", { by: new BN(3) }, [
            { address: alice.address, signer: alice },
            { address: counter, writable: true },
          ]),
        ]),
      );
    });
  }
});
