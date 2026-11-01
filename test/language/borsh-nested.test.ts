// Options inside Options (Marginfi's BankConfigFast: Option<InterestRateConfigOpt>, which holds Options itself), as
// Anchor sends and emits them: an argument struct is read as Borsh at every depth (an empty Option one byte), and a
// @layout borsh event writes it back the same way, so the event's bytes are the argument's bytes. Also f64 fields.
import { BorshCoder } from "@anchor-lang/core";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, acct, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

const SOURCE = `import { type FixedArray, type Option, type Signer, type f64, type u16, type u32, type u64, emit, f64FromBits } from "typesol";

export interface Wrapped {
  value: FixedArray<u8, 16>;
}
export interface Point {
  util: u32;
  rate: u32;
}
export interface RateOpt {
  fixed_apr: Option<Wrapped>;
  zero_util: Option<u32>;
  points: Option<FixedArray<Point, 3>>;
}
export interface ConfigOpt {
  deposit_limit: Option<u64>;
  rate: Option<RateOpt>;
  tiers: Option<FixedArray<u16, 3>>;
  last: u16;
}
/** @layout borsh */
export interface Configured {
  config: ConfigOpt;
  fee: f64;
}

export interface Store {
  deposit: u64;
  zero_util: u32;
  apr_first: u8;
  tiers: FixedArray<u16, 3>;
  second_util: u32;
  last: u16;
}

export function open(store: Init<Store>, payer: Mut<Signer>, system_program: SystemProgram): void {
  store.create(payer, ["store"]);
}

/** What the port's configure_bank does: copy each Some value into account data, at any depth. */
export function apply(store: Mut<Store>, config: ConfigOpt): void {
  if (config.deposit_limit !== null) store.deposit = config.deposit_limit;
  if (config.rate !== null) {
    if (config.rate.zero_util !== null) store.zero_util = config.rate.zero_util;
    if (config.rate.fixed_apr !== null) store.apr_first = config.rate.fixed_apr.value.get(0n);
    if (config.rate.points !== null) store.second_util = config.rate.points.get(1n).util;
  }
  if (config.tiers !== null) store.tiers = config.tiers;
  store.last = config.last;
}

export function configure(payer: Signer, config: ConfigOpt): void {
  emit<Configured>({ config, fee: f64FromBits(4611686018427387904n) });
}
`.replace("type FixedArray, ", "type FixedArray, type u8, type Init, type Mut, type SystemProgram, ");

describe("Borsh Options inside Options", () => {
  let d: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-borsh-nested-"));
    writeFileSync(path.join(dir, "cfg.ts"), SOURCE);
    d = await deployFile(path.join(dir, "cfg.ts"));
  });

  it("describes them as Anchor does", () => {
    const t = (n: string) => d.idl.types!.find((x) => x.name === n)!.type as { fields: { name: string; type: unknown }[] };
    expect(t("ConfigOpt").fields.map((f) => f.type)).toEqual([
      { option: "u64" },
      { option: { defined: { name: "RateOpt" } } },
      { option: { array: ["u16", 3] } },
      "u16",
    ]);
    expect(t("RateOpt").fields.map((f) => f.type)).toEqual([
      { option: { defined: { name: "Wrapped" } } },
      { option: "u32" },
      { option: { array: [{ defined: { name: "Point" } }, 3] } },
    ]);
    expect(t("Configured").fields.map((f) => f.type)).toEqual([{ defined: { name: "ConfigOpt" } }, "f64"]);
  });

  const cases: [string, Record<string, unknown>][] = [
    ["all empty", { deposit_limit: null, rate: null, tiers: null, last: 7 }],
    ["an empty inner struct", { deposit_limit: new BN(5), rate: { fixed_apr: null, zero_util: null, points: null }, tiers: null, last: 1 }],
    [
      "everything set",
      {
        deposit_limit: new BN("18446744073709551615"),
        rate: { fixed_apr: { value: [...Array(16).keys()] }, zero_util: 9, points: [1, 2, 3].map((i) => ({ util: i, rate: 100 * i })) },
        tiers: [10, 20, 30],
        last: 65535,
      },
    ],
    ["inner partly set", { deposit_limit: null, rate: { fixed_apr: null, zero_util: 4, points: null }, tiers: [1, 2, 3], last: 0 }],
  ];
  for (const [label, config] of cases)
    it(`reads ${label} and emits the same bytes`, async () => {
      const payer = await fundedSigner(d.svm);
      const coder = new BorshCoder(d.idl);
      const r = expectOk(await send(d.svm, payer, [ix(d, "configure", { config }, [{ address: payer.address, signer: payer }])]));
      const line = r.logs().find((l) => l.startsWith("Program data:"))!;
      const bytes = Buffer.from(line.slice("Program data: ".length), "base64");
      // The event's bytes after its discriminator: the argument as Anchor encoded it, then the f64.
      const sent = coder.types.encode("ConfigOpt", config);
      expect(bytes.subarray(8, 8 + sent.length).toString("hex")).toBe(Buffer.from(sent).toString("hex"));
      expect(bytes.length).toBe(8 + sent.length + 8);
      expect(coder.events.decode(line.slice("Program data: ".length))?.data.fee).toBe(2);
    });

  it("reads the Some values at every depth into account data", async () => {
    const payer = await fundedSigner(d.svm);
    const [store] = await pda(d.programId, ["store"]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "open", {}, [{ address: store, writable: true }, { address: payer.address, signer: payer, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    const read = () => d.coder.accounts.decode("Store", Buffer.from(acct(d.svm, store).data));
    const apply = (config: Record<string, unknown>) => send(d.svm, payer, [ix(d, "apply", { config }, [{ address: store, writable: true }])]);
    expectOk(await apply(cases[2]![1]));
    let s = read();
    expect([String(s.deposit), s.zero_util, s.apr_first, s.tiers, s.second_util, s.last]).toEqual(["18446744073709551615", 9, 0, [10, 20, 30], 2, 65535]);
    // Empty Options leave the fields as they were; a partly set inner struct changes only its Some fields.
    expectOk(await apply(cases[3]![1]));
    s = read();
    expect([String(s.deposit), s.zero_util, s.apr_first, s.tiers, s.second_util, s.last]).toEqual(["18446744073709551615", 4, 0, [1, 2, 3], 2, 0]);
    expectOk(
      await apply({ deposit_limit: null, rate: { fixed_apr: { value: [7, ...Array(15).fill(0)] }, zero_util: null, points: null }, tiers: null, last: 9 }),
    );
    s = read();
    expect([s.zero_util, s.apr_first, s.last]).toEqual([4, 7, 9]);
  });

  it("refuses a truncated argument", async () => {
    const payer = await fundedSigner(d.svm);
    const good = ix(d, "configure", { config: cases[2]![1] }, [{ address: payer.address, signer: payer }]);
    const cut = { ...good, data: good.data!.subarray(0, good.data!.length - 3) };
    expect(await send(d.svm, payer, [cut])).toHaveProperty("err");
  });
});
