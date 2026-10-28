// const { a, b: c } = s: scalars copy, nested structs alias account data, the forms it refuses.
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, customError, decodeAccount, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed, compileErrors } from "./harness.js";

describe("object destructuring", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/destructure.ts", import.meta.url)));
  });

  it("reads fields into locals and aliases nested structs", async () => {
    const owner = await fundedSigner(d.svm);
    const [player] = await pda(d.programId, ["player", owner.address]);
    const p = { address: player, writable: true };
    expectOk(await send(d.svm, owner, [ix(d, "join", {}, [{ address: owner.address, signer: owner, writable: true }, p, { address: SYSTEM_PROGRAM }])]));
    const r = expectOk(await send(d.svm, owner, [ix(d, "play", { points: new BN(5) }, [{ address: owner.address, signer: owner }, p])]));
    expect(Buffer.from(r.returnData().data()).readBigUInt64LE(0)).toBe(7n * 100n + 3n);
    const s = decodeAccount<{ score: BN; pos: { x: BN; y: BN } }>(d, d.svm, "Player", player);
    expect([s.score.toNumber(), s.pos.x.toNumber(), s.pos.y.toNumber()]).toEqual([5, 7, 3]);

    const other = await fundedSigner(d.svm);
    expect(customError(await send(d.svm, other, [ix(d, "play", { points: new BN(1) }, [{ address: other.address, signer: other }, p])]))).toBe(6000);
  });

  it("refuses rest, defaults, nesting and calls", () => {
    const errors = (body: string) =>
      compileErrors(
        `import { type Account, type u64 } from "typesol";\nexport interface Q { x: u64; y: u64 }\nexport interface S { q: Q; n: u64 }\nfunction mk(): Q { return { x: 1n, y: 2n }; }\n${body}`,
      );
    expect(errors(`export function f(s: Account<S>): void { const { n, ...rest } = s; }`)).toMatch(/rest is not supported/);
    expect(errors(`export function f(s: Account<S>): void { const { q: { x } } = s; }`)).toMatch(/nested destructuring/);
    expect(errors(`export function f(): void { const { x } = mk(); }`)).toMatch(/bind a call to a const first/);
  });
});
