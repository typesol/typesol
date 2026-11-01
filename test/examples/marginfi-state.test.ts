// examples/marginfi/state.ts against Marginfi's on-chain IDL and its mainnet accounts: the port's IDL describes every
// account type exactly as the on-chain IDL does (fields, order, types; docs aside), and fields read through TypeSOL from
// the mainnet group, a bank and the fee state are the values Anchor's coder decodes from the same bytes.
import { BorshCoder, type Idl, web3 } from "@anchor-lang/core";
import { address, lamports } from "@solana/kit";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "../harness.js";

const PROGRAM = address("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");
const ONCHAIN = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/marginfi/marginfi.idl.json", import.meta.url)), "utf8")) as Idl;
const fixture = (a: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/marginfi/mainnet/${a}.json`, import.meta.url)), "utf8")) as { address: string; lamports: string; owner: string; data: string };
const GROUP = "4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8";
const BANK = "2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB";
const FEE_STATE = "HoMNdUF3RDZDPKAARYK1mxcPFfUnPjLmpKYibZzAijev";

describe("examples/marginfi/state.ts against Marginfi on mainnet", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/marginfi-state.ts", import.meta.url)), { programId: PROGRAM });
    for (const a of [GROUP, BANK, FEE_STATE]) {
      const f = fixture(a);
      const data = Buffer.from(f.data, "base64");
      d.svm.setAccount({ address: address(a), data: new Uint8Array(data), executable: false, lamports: lamports(BigInt(f.lamports)), programAddress: PROGRAM, space: BigInt(data.length) });
    }
  });

  it("describes every account type as the on-chain IDL does", () => {
    const strip = (v: unknown) => JSON.parse(JSON.stringify(v, (k, x) => (k === "docs" ? undefined : x)));
    const types = (idl: Idl) => new Map((idl.types ?? []).map((t) => [t.name, strip(t)]));
    const [ours, theirs] = [types(d.idl), types(ONCHAIN)];
    const accounts = ONCHAIN.accounts!.map((a) => a.name);
    expect(d.idl.accounts!.map((a) => a.name).sort()).toEqual([...accounts].sort());
    for (const a of ONCHAIN.accounts!) expect(d.idl.accounts!.find((x) => x.name === a.name)?.discriminator, a.name).toEqual(a.discriminator);
    // The account types and every type they hold.
    const seen = new Set<string>();
    const visit = (name: string) => {
      if (seen.has(name)) return;
      seen.add(name);
      expect(ours.get(name), name).toEqual(theirs.get(name));
      JSON.stringify(theirs.get(name), (k, v) => {
        if (k === "defined") visit(typeof v === "string" ? v : v.name);
        return v;
      });
    };
    for (const a of accounts) visit(a);
    expect(seen.size).toBeGreaterThan(40);
  });

  it("reads the mainnet group, bank and fee state as Anchor decodes them", async () => {
    const coder = new BorshCoder(ONCHAIN);
    const decode = (name: string, a: string) => coder.accounts.decode(name, Buffer.from(fixture(a).data, "base64"));
    const [group, bank, fee] = [decode("MarginfiGroup", GROUP), decode("Bank", BANK), decode("FeeState", FEE_STATE)];
    const payer = await fundedSigner(d.svm);
    const r = expectOk(await send(d.svm, payer, [ix(d, "peek", {}, [{ address: address(GROUP) }, { address: address(BANK) }, { address: address(FEE_STATE) }])]));
    const got = d.coder.types.decode("Peek", Buffer.from(r.returnData().data()));
    const i80 = (w: { value: number[] }) => Buffer.from(w.value).readBigInt64LE(8) * (1n << 64n) + Buffer.from(w.value).readBigUInt64LE(0);
    const want = {
      mint_decimals: bank.mint_decimals,
      asset_share_value: i80(bank.asset_share_value),
      liability_share_value: i80(bank.liability_share_value),
      last_update: BigInt(bank.last_update.toString()),
      flags: BigInt(bank.flags.toString()),
      liquidation_insurance_fee: bank.liquidation_insurance_fee,
      oracle_key_0: (bank.config.oracle_keys[0] as web3.PublicKey).toBase58(),
      group_admin: (group.admin as web3.PublicKey).toBase58(),
      banks: group.banks,
      risk_admin: (group.risk_admin as web3.PublicKey).toBase58(),
      rate_limiter_last_admin_update_seq: BigInt(group.rate_limiter_last_admin_update_seq.toString()),
      global_fee_wallet: (fee.global_fee_wallet as web3.PublicKey).toBase58(),
      program_fee_rate: i80(fee.program_fee_rate),
      order_init_flat_sol_fee: fee.order_init_flat_sol_fee,
    };
    const norm = (o: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v instanceof web3.PublicKey ? v.toBase58() : typeof v === "object" && v && "toString" in v ? BigInt(String(v)) : v]));
    expect(norm(got)).toEqual(norm(want));
    // Real values, not zeros: an asset share value above 1 (2^48) and a group with banks.
    expect(want.asset_share_value).toBeGreaterThan(1n << 48n);
    expect(want.banks).toBeGreaterThan(0);
  });
});
