import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, customError, decodeAccount, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "./harness.js";
import { generateKeyPairSigner, getAddressEncoder } from "@solana/kit";

type Board = { scores: BN[]; players: { toBase58(): string }[]; used: boolean[]; count: number };
const pk = (a: string) => ({ toBuffer: () => Buffer.from(getAddressEncoder().encode(a as never)) });

describe("loops, helpers and fixed arrays (test/fixtures/scores.ts)", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/scores.ts", import.meta.url)));
  });

  async function board() {
    const admin = await fundedSigner(d.svm);
    const [addr] = await pda(d.programId, ["board", admin.address]);
    expectOk(
      await send(d.svm, admin, [
        ix(d, "setup", {}, [{ address: admin.address, signer: admin, writable: true }, { address: addr, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    const submit = (player: string, score: number, signer = admin) =>
      ix(d, "submit", { player: pk(player), score: new BN(score) }, [
        { address: signer.address, signer },
        { address: addr, writable: true },
      ]);
    return { admin, addr, submit };
  }

  it("emits array types in the IDL", () => {
    const fields = (d.idl.types?.[0].type as { fields: { name: string; type: unknown }[] }).fields;
    expect(fields.find((f) => f.name === "scores")?.type).toEqual({ array: ["u64", 8] });
    expect(fields.find((f) => f.name === "players")?.type).toEqual({ array: ["pubkey", 8] });
  });

  it("fills slots, keeps each player's best score, and reports a full board", async () => {
    const { admin, addr, submit } = await board();
    const players = await Promise.all(Array.from({ length: 9 }, () => generateKeyPairSigner()));
    expectOk(await send(d.svm, admin, [submit(players[0].address, 50), submit(players[1].address, 70)]));
    expectOk(await send(d.svm, admin, [submit(players[0].address, 40), submit(players[0].address, 90)]));
    let s = decodeAccount<Board>(d, d.svm, "Board", addr);
    expect(s.count).toBe(2);
    expect(s.scores.slice(0, 3).map(String)).toEqual(["90", "70", "0"]);
    expect(s.players[1].toBase58()).toBe(players[1].address);
    expect(s.used.slice(0, 3)).toEqual([true, true, false]);

    for (let i = 2; i < 8; i++) expectOk(await send(d.svm, admin, [submit(players[i].address, i)]));
    expect(customError(await send(d.svm, admin, [submit(players[8].address, 1)]))).toBe(6001);
    s = decodeAccount<Board>(d, d.svm, "Board", addr);
    expect(s.count).toBe(8);
  });

  it("runs helpers with for-loops, continue and break", async () => {
    const { admin, addr } = await board();
    const poke = (index: number, n: number, skip: number, cap: number) =>
      ix(d, "poke", { index: new BN(index), n: new BN(n), skip: new BN(skip), cap: new BN(cap) }, [{ address: addr, writable: true }]);
    // 1..10 skipping multiples of 3 = 55 - (3+6+9) = 37
    expectOk(await send(d.svm, admin, [poke(0, 10, 3, 1_000)]));
    // stops as soon as the running total passes 10: 1+2+4+5 = 12
    expectOk(await send(d.svm, admin, [poke(1, 100, 3, 10)]));
    const s = decodeAccount<Board>(d, d.svm, "Board", addr);
    expect([s.scores[0].toString(), s.scores[1].toString()]).toEqual(["37", "12"]);
  });

  it("bounds-checks array indexes", async () => {
    const { admin, addr } = await board();
    const poke = ix(d, "poke", { index: new BN(8), n: new BN(1), skip: new BN(2), cap: new BN(9) }, [{ address: addr, writable: true }]);
    expect(customError(await send(d.svm, admin, [poke]))).toBe(5104);
  });

  it("rejects non-admins through a helper", async () => {
    const { submit } = await board();
    const other = await fundedSigner(d.svm);
    expect(customError(await send(d.svm, other, [submit(other.address, 1, other)]))).toBe(6000);
  });

  it("stops runaway loops at the compute budget", async () => {
    const { admin, addr } = await board();
    const poke = ix(d, "poke", { index: new BN(0), n: new BN("18446744073709551615"), skip: new BN(2), cap: new BN("18446744073709551615") }, [
      { address: addr, writable: true },
    ]);
    const res = await send(d.svm, admin, [poke]);
    const r = res as { meta?: () => { logs(): string[] } };
    expect(r.meta?.().logs().join("\n")).toMatch(/exceeded CUs meter/);
  });
});
