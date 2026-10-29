import { address } from "@solana/kit";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, customError, decodeAccount, deployExample, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";
import type { TransactionMetadata } from "litesvm";

type FStr = { len: number; bytes: number[] };
type Point = { x: BN; y: BN };
type Profile = { name: FStr; home: Point; trail: Point[]; tags: FStr[]; moves: number };
const text = (s: FStr) => Buffer.from(s.bytes.slice(0, s.len)).toString("utf8");
const pt = (p: Point) => [p.x.toString(), p.y.toString()];

function events(d: Deployed, res: TransactionMetadata) {
  return res
    .logs()
    .filter((l) => l.startsWith("Program data: "))
    .map((l) => d.coder.events.decode(l.slice("Program data: ".length)))
    .filter((e): e is NonNullable<typeof e> => !!e);
}

const pinned = /Program<"([1-9A-HJ-NP-Za-km-z]+)">/.exec(readFileSync(new URL("../../examples/caller.ts", import.meta.url), "utf8"))![1];

describe("examples/profiles.ts (nested structs, strings, local arrays, events, return data)", () => {
  let d: Deployed;
  let caller: Deployed;
  beforeAll(async () => {
    d = await deployExample("profiles", { programId: address(pinned) });
    caller = await deployExample("caller", { svm: d.svm });
  });

  async function register(name: string) {
    const owner = await fundedSigner(d.svm);
    const [profile] = await pda(d.programId, ["profile", owner.address, new TextEncoder().encode(name)]);
    const res = await send(d.svm, owner, [
      ix(d, "register", { name }, [
        { address: owner.address, signer: owner, writable: true },
        { address: profile, writable: true },
        { address: SYSTEM_PROGRAM },
      ]),
    ]);
    return { owner, profile, res };
  }

  it("describes the profile PDA with const, account and arg seeds", () => {
    const acct = (d.idl.instructions.find((i) => i.name === "register")!.accounts as { name: string; pda?: { seeds: unknown[] } }[])[1];
    expect(acct.pda?.seeds).toEqual([
      { kind: "const", value: [...Buffer.from("profile")] },
      { kind: "account", path: "owner" },
      { kind: "arg", path: "name" },
    ]);
  });

  it("stores a FixedString from a string argument and renames with an event", async () => {
    const { owner, profile, res } = await register("alice");
    expectOk(res);
    expect(text(decodeAccount<Profile>(d, d.svm, "Profile", profile).name)).toBe("alice");

    const rename = (name: string, who = owner) =>
      ix(d, "rename", { name }, [
        { address: who.address, signer: who },
        { address: profile, writable: true },
      ]);
    const ok = expectOk(await send(d.svm, owner, [rename("alice the brave")]));
    expect(text(decodeAccount<Profile>(d, d.svm, "Profile", profile).name)).toBe("alice the brave");
    const ev = events(d, ok);
    expect(ev).toHaveLength(1);
    expect(ev[0].name).toBe("Renamed");
    expect([ev[0].data.from, ev[0].data.to]).toEqual(["alice", "alice the brave"]);

    expect(customError(await send(d.svm, owner, [rename("alice the brave")]))).toBe(6001);
    expect(customError(await send(d.svm, owner, [rename("x".repeat(33))]))).toBe(5105);
    const bob = await fundedSigner(d.svm);
    expect(customError(await send(d.svm, bob, [rename("bob", bob)]))).toBe(6000);
  });

  it("rejects empty names", async () => {
    const { res } = await register("");
    expect(customError(res)).toBe(6002);
  });

  it("updates nested structs and arrays of structs, emitting nested event data", async () => {
    const { owner, profile } = await register("walker");
    const move = (dx: number, dy: number) =>
      ix(d, "move", { dx: new BN(dx), dy: new BN(dy) }, [
        { address: owner.address, signer: owner },
        { address: profile, writable: true },
      ]);
    const res = expectOk(await send(d.svm, owner, [move(3, 4), move(-1, 2), move(10, -10)]));
    const p = decodeAccount<Profile>(d, d.svm, "Profile", profile);
    expect(pt(p.home)).toEqual(["12", "-4"]);
    expect(p.trail.map(pt)).toEqual([
      ["2", "6"],
      ["3", "4"],
      ["0", "0"],
      ["0", "0"],
    ]);
    expect(p.moves).toBe(3);
    const moved = events(d, res).filter((e) => e.name === "Moved");
    expect(moved.map((e) => pt(e.data.home as Point))).toEqual([
      ["3", "4"],
      ["2", "6"],
      ["12", "-4"],
    ]);
  });

  it("writes FixedString array elements with capacity and bounds checks", async () => {
    const { owner, profile } = await register("tagger");
    const tag = (slot: number, label: string) =>
      ix(d, "tag", { slot: new BN(slot), label }, [
        { address: owner.address, signer: owner },
        { address: profile, writable: true },
      ]);
    expectOk(await send(d.svm, owner, [tag(0, "hiker"), tag(2, "runner")]));
    const p = decodeAccount<Profile>(d, d.svm, "Profile", profile);
    expect(p.tags.map(text)).toEqual(["hiker", "", "runner"]);
    expect(customError(await send(d.svm, owner, [tag(3, "x")]))).toBe(5104);
    expect(customError(await send(d.svm, owner, [tag(1, "ninechars")]))).toBe(5105);
  });

  it("returns a value from an instruction and reads another program's return data via CPI", async () => {
    const { owner, profile } = await register("tripper");
    const move = (dx: number, dy: number) =>
      ix(d, "move", { dx: new BN(dx), dy: new BN(dy) }, [
        { address: owner.address, signer: owner },
        { address: profile, writable: true },
      ]);
    expectOk(await send(d.svm, owner, [move(3, 4), move(-1, 2)]));
    // home (2,6) -> (3,4) -> (0,0): |2-3|+|6-4| + |3-0|+|4-0| = 3 + 7 = 10
    const direct = expectOk(await send(d.svm, owner, [ix(d, "distance", {}, [{ address: profile }])]));
    expect(Buffer.from(direct.returnData().data()).readBigUInt64LE()).toBe(10n);

    const check = (atLeast: number) => ix(caller, "check_distance", { at_least: new BN(atLeast) }, [{ address: profile }, { address: d.programId }]);
    const viaCpi = expectOk(await send(d.svm, owner, [check(10)]));
    expect(Buffer.from(viaCpi.returnData().data()).readBigUInt64LE()).toBe(20n);
    expect(Buffer.from(viaCpi.returnData().programId())).toEqual(
      Buffer.from(new Uint8Array((await import("@solana/kit")).getAddressEncoder().encode(caller.programId))),
    );
    expect(customError(await send(d.svm, owner, [check(11)]))).toBe(6000);
  });
});
