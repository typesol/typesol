// Data enums whose variants hold strings: Borsh in arguments and events (as Anchor encodes them), values in code,
// never account data.
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { programHarness, type TestProgram } from "../src/testing.js";
import { deployFile, type Deployed, compileErrors } from "./harness.js";

describe("data enums with strings", () => {
  let d: Deployed;
  let t: TestProgram;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/enumstr.ts", import.meta.url)));
    t = programHarness(d.svm, d.programId, d.idl as never);
  });

  const events = (res: Parameters<TestProgram["ok"]>[0]) =>
    t
      .ok(res)
      .logs()
      .filter((l) => l.startsWith("Program data: "))
      .map((l) => t.coder.events.decode(l.slice("Program data: ".length)))
      .map((e) => e && { name: e.name, cmd: JSON.parse(JSON.stringify(e.data.cmd)) });

  it("describes them as Borsh enums in the IDL, with no fixed form", () => {
    const types = d.idl.types as { name: string; type: { variants?: { name: string; fields?: { name: string; type: unknown }[] }[] } }[];
    expect(types.find((x) => x.name === "Command")?.type.variants?.[0]).toEqual({
      name: "Say",
      fields: [
        { name: "text", type: "string" },
        { name: "times", type: "u8" },
      ],
    });
    expect(types.some((x) => x.name === "FixedEnum_Command")).toBe(false);
  });

  it("decodes string variants from instruction data and emits them back in events", async () => {
    const owner = await t.wallet();
    const board = await t.pda("board", owner);
    t.ok(await t.send(owner, t.ix("setup", {}, { owner })));
    const say = await t.send(owner, t.ix("run", { cmd: { Say: { text: "héllo", times: 3 } } }, { owner, board }));
    expect(t.returned("run", say)).toBe(6n * 3n); // "héllo" is 6 UTF-8 bytes
    expect(events(say)).toEqual([{ name: "Said", cmd: { Say: { text: "héllo", times: 3 } } }]);

    const rename = await t.send(owner, t.ix("run", { cmd: { Rename: { to: "renamed" } } }, { owner, board }));
    expect(t.returned("run", rename)).toBe(7n);
    expect(events(rename)).toEqual([{ name: "Said", cmd: { Say: { text: "start", times: 1 } } }]);
    expect((await t.account<{ title: string }>("Board", board))?.title).toBe("renamed");
    expect(t.returned("run", await t.send(owner, t.ix("run", { cmd: { Nop: {} } }, { owner, board })))).toBe(0n);
  });

  it("keeps nested variable enums decodable (IDL) and copies account text assigned into a field", async () => {
    const owner = await t.wallet();
    const nested = await t.send(owner, t.ix("nest", { text: "hi", times: 2, tail: 9 }, { owner }));
    const data = t
      .ok(nested)
      .logs()
      .filter((l) => l.startsWith("Program data: "))
      .map((l) => JSON.parse(JSON.stringify(t.coder.events.decode(l.slice("Program data: ".length))?.data)));
    expect(data).toEqual([{ w: { Wrap: { c: { Say: { text: "hi", times: 2 } }, tail: 9 } } }]);

    const board = await t.pda("board", owner);
    t.ok(await t.send(owner, t.ix("setup", {}, { owner })));
    expect(events(await t.send(owner, t.ix("assignField", {}, { owner, board })))).toEqual([{ name: "Said", cmd: { Say: { text: "start", times: 1 } } }]);
  });

  it("refuses them in account data and refuses Vec variants", () => {
    const errors = (body: string) =>
      compileErrors(`import { type Account, type Vec, type u64 } from "typesol";\nexport type C = { kind: "A"; s: string } | { kind: "B" };\n${body}\n`);
    expect(errors(`export interface S { c: C; n: u64 }\nexport function f(s: Account<S>): void {}`)).toMatch(/string field|cannot be account data/);
    expect(errors(`export type V = { kind: "A"; xs: Vec<u64> };\nexport function f(v: V): void {}`)).toMatch(/a Vec cannot be one/);
  });
});
