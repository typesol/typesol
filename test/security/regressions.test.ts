import { generateKeyPairSigner, type Address } from "@solana/kit";
import { TransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_PROGRAM, lamports, customError, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

describe("regressions (test/fixtures/regress.ts)", () => {
  let d: Deployed;
  let payer: Awaited<ReturnType<typeof fundedSigner>>;
  let box: Address;
  let pts: Address;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/regress.ts", import.meta.url)));
  });
  const fresh = async () => {
    payer = await fundedSigner(d.svm);
    [box] = await pda(d.programId, ["box", payer.address]);
    [pts] = await pda(d.programId, ["pts", payer.address]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "make", {}, [
          { address: payer.address, signer: payer, writable: true },
          { address: box, writable: true },
          { address: pts, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
  };
  const call = async (name: string, args: Record<string, unknown> = {}, extra: { address: Address; writable?: boolean }[] = []) => {
    const res = await send(d.svm, payer, [ix(d, name, args, [{ address: box, writable: true }, ...extra])]);
    return res;
  };
  const ret = (res: Awaited<ReturnType<typeof send>>) => Buffer.from(expectOk(res).returnData().data()).readBigUInt64LE();
  const withPayer = (name: string) =>
    send(d.svm, payer, [
      ix(d, name, {}, [{ address: payer.address, signer: payer, writable: true }, { address: box, writable: true }, { address: SYSTEM_PROGRAM }]),
    ]);

  it("a local copy of account text keeps its value after the field changes", async () => {
    await fresh();
    expect(ret(await call("str_alias"))).toBe(1n);
    expect(ret(await call("str_ternary", { flag: true }))).toBe(1n);
  });

  it("operands are read left to right, before a later operand pops", async () => {
    await fresh();
    expect(ret(await call("len_plus_pop"))).toBe(33n);
    expect(ret(await call("cmp_pop"))).toBe(1n);
    expect(ret(await call("helper_args"))).toBe(110n);
    expect(ret(await withPayer("compound_pop"))).toBe(12n);
  });

  it("strings support += on locals and FixedString fields", async () => {
    await fresh();
    expect(ret(await call("str_plus_eq"))).toBe(303n);
  });

  it("Option equality matches JS, including null === null and empty vs value", async () => {
    await fresh();
    expect(ret(await call("opt_eq"))).toBe(1n + 4n + 8n + 32n + 64n);
  });

  it("Option values print as the value or null in templates", async () => {
    await fresh();
    expect(ret(await call("tpl_opt"))).toBe(4n * 100n + 7n);
  });

  it("Option<struct> copies whole from another Option<struct> (and onto itself)", async () => {
    await fresh();
    expect(ret(await call("opt_struct_copy"))).toBe(49n);
  });

  it("Vec.get() assigns, and pop() of a Vec of structs works as a statement", async () => {
    await fresh();
    expect(ret(await call("vec_get_assign"))).toBe(10n);
    const res = await send(d.svm, payer, [ix(d, "drop_last", {}, [{ address: pts, writable: true }])]);
    expect(ret(res)).toBe(101n);
  });

  it("an out-of-range enum inside a data-enum argument is rejected", async () => {
    await fresh();
    expectOk(await call("apply", { cmd: { Set: { mode: { Auto: {} } } } }));
    const good = ix(d, "apply", { cmd: { Set: { mode: { Auto: {} } } } }, [{ address: box, writable: true }]);
    const data = Uint8Array.from(good.data!);
    data[data.length - 1] = 200;
    expect(customError(await send(d.svm, payer, [{ ...good, data }]))).toBe(102);
  });

  it("a remaining account written through .lamports may not be a declared account", async () => {
    await fresh();
    expect(customError(await call("skim", {}, [{ address: box, writable: true }]))).toBe(2040);
    d.svm.airdrop(box, lamports(1_000n));
    const other = await fundedSigner(d.svm, 1n);
    expectOk(await call("skim", {}, [{ address: other.address, writable: true }]));
  });

  it("more than 32 accounts is refused instead of silently truncated", async () => {
    await fresh();
    const extra = Array.from({ length: 32 }, () => ({ address: box }));
    expect(customError(await call("str_alias", {}, extra))).toBe(5113);
    const nobody = (await generateKeyPairSigner()).address;
    expect(ret(await call("str_alias", {}, [{ address: nobody }]))).toBe(1n); // the refused call changed nothing
  });
});
