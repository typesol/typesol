import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { BN, customError, deployFile, expectOk, fundedSigner, ix, send } from "../harness.js";

const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");
const heapFrame = (bytes: number) => {
  const data = Buffer.alloc(5);
  data[0] = 1; // RequestHeapFrame
  data.writeUInt32LE(bytes, 1);
  return { programAddress: COMPUTE_BUDGET, accounts: [], data: new Uint8Array(data) };
};

const cuLimit = (units: number) => {
  const data = Buffer.alloc(5);
  data[0] = 2; // SetComputeUnitLimit
  data.writeUInt32LE(units, 1);
  return { programAddress: COMPUTE_BUDGET, accounts: [], data: new Uint8Array(data) };
};

describe("heap size (const HEAP_SIZE_KIB)", () => {
  it("uses a larger heap frame when declared and requested; the default stops at 32 KiB with 5110", async () => {
    const big = await deployFile(fileURLToPath(new URL("../fixtures/bigheap.ts", import.meta.url)));
    const payer = await fundedSigner(big.svm);
    // A 2^15-byte string (it doubles in place on the heap): more than the default 32 KiB heap.
    const r = expectOk(await send(big.svm, payer, [cuLimit(1_400_000) as never, heapFrame(64 * 1024) as never, ix(big, "grow", { rounds: new BN(15) }, [])]));
    expect(Buffer.from(r.returnData().data()).readBigUInt64LE()).toBe(32768n);
    // Without the heap frame request the program runs past the real heap and the runtime stops it.
    const unrequested = await send(big.svm, payer, [cuLimit(1_400_000) as never, ix(big, "grow", { rounds: new BN(15) }, [])]);
    expect(String((unrequested as { err?: () => unknown }).err?.())).toMatch(/AccessViolation|ProgramFailedToComplete|InstructionError/);

    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-heap-"));
    const src = readFileSync(fileURLToPath(new URL("../fixtures/bigheap.ts", import.meta.url)), "utf8").replace(
      "const HEAP_SIZE_KIB = 64n;",
      "const HEAP_SIZE_KIB = 32n;",
    );
    writeFileSync(path.join(dir, "smallheap.ts"), src);
    const small = await deployFile(path.join(dir, "smallheap.ts"));
    const p2 = await fundedSigner(small.svm);
    expect(customError(await send(small.svm, p2, [cuLimit(1_400_000) as never, ix(small, "grow", { rounds: new BN(15) }, [])]))).toBe(5110);
  });
});
