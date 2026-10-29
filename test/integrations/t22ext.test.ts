import { getCreateAccountInstruction } from "@solana-program/system";
import * as t22 from "@solana-program/token-2022";
import { type Address, address, generateKeyPairSigner, getAddressEncoder, some } from "@solana/kit";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "../harness.js";

const T22 = address(t22.TOKEN_2022_PROGRAM_ADDRESS);
const pk = (a: string) => ({ toBuffer: () => Buffer.from(getAddressEncoder().encode(a as never)) });

describe("Token-2022 extension reads (test/fixtures/t22ext.ts)", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/t22ext.ts", import.meta.url)));
  });
  const u64 = (r: ReturnType<typeof expectOk>) => Buffer.from(r.returnData().data()).readBigUInt64LE();

  async function mintWith(exts: object[], inits: (mint: Address) => object[]) {
    const payer = await fundedSigner(d.svm);
    const mint = await generateKeyPairSigner();
    const space = exts.length ? t22.getMintSize(exts as never) : 82;
    expectOk(
      await send(d.svm, payer, [
        getCreateAccountInstruction({ payer, newAccount: mint, lamports: d.svm.minimumBalanceForRentExemption(BigInt(space)), space, programAddress: T22 }),
        ...(inits(mint.address) as never[]),
        t22.getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: payer.address }),
      ]),
    );
    return { payer, mint: mint.address };
  }

  it("computes transfer fees like spl-token-2022 (ceil, capped), and 0 without the extension", async () => {
    const cfg = await generateKeyPairSigner();
    const auth = cfg.address;
    const { payer, mint } = await mintWith(
      [
        {
          __kind: "TransferFeeConfig",
          transferFeeConfigAuthority: auth,
          withdrawWithheldAuthority: auth,
          withheldAmount: 0n,
          olderTransferFee: { epoch: 0n, maximumFee: 500n, transferFeeBasisPoints: 125 },
          newerTransferFee: { epoch: 0n, maximumFee: 500n, transferFeeBasisPoints: 125 },
        },
      ],
      (m) => [
        t22.getInitializeTransferFeeConfigInstruction({
          mint: m,
          transferFeeConfigAuthority: auth,
          withdrawWithheldAuthority: auth,
          transferFeeBasisPoints: 125,
          maximumFee: 500n,
        }),
      ],
    );
    const fee = async (amount: number) => u64(expectOk(await send(d.svm, payer, [ix(d, "fee", { amount: new BN(amount) }, [{ address: mint }])])));
    expect(await fee(0)).toBe(0n);
    expect(await fee(1)).toBe(1n); // ceil(0.0125)
    expect(await fee(10_000)).toBe(125n);
    expect(await fee(10_001)).toBe(126n);
    expect(await fee(1_000_000)).toBe(500n); // capped
    // A new fee applies two epochs after it is set; before that the older one still counts.
    expectOk(
      await send(d.svm, payer, [
        t22.getSetTransferFeeInstruction({ mint, transferFeeConfigAuthority: cfg, transferFeeBasisPoints: 50, maximumFee: 1_000n }) as never,
      ]),
    );
    expect(await fee(10_000)).toBe(125n);
    const clock = d.svm.getClock();
    clock.epoch += 2n;
    d.svm.setClock(clock);
    expect(await fee(10_000)).toBe(50n);
    expect(await fee(1_000_000)).toBe(1_000n);
    const plain = await mintWith([], () => []);
    expect(u64(expectOk(await send(d.svm, plain.payer, [ix(d, "fee", { amount: new BN(10_000) }, [{ address: plain.mint }])])))).toBe(0n);
  });

  it("reads the transfer hook program, permanent delegate, close authority and non-transferable flag", async () => {
    const who = (await generateKeyPairSigner()).address;
    const { payer, mint } = await mintWith(
      [
        { __kind: "TransferHook", authority: who, programId: who },
        { __kind: "PermanentDelegate", delegate: who },
        { __kind: "MintCloseAuthority", closeAuthority: who },
      ],
      (m) => [
        t22.getInitializeTransferHookInstruction({ mint: m, authority: who, programId: who }),
        t22.getInitializePermanentDelegateInstruction({ mint: m, delegate: who }),
        t22.getInitializeMintCloseAuthorityInstruction({ mint: m, closeAuthority: some(who) as never }),
      ],
    );
    const flags = async (m: Address, w: Address) => u64(expectOk(await send(d.svm, payer, [ix(d, "flags", { who: pk(w) }, [{ address: m }])])));
    expect(await flags(mint, who)).toBe(7n);
    const nt = await mintWith([{ __kind: "NonTransferable" }], (m) => [t22.getInitializeNonTransferableMintInstruction({ mint: m })]);
    expect(await flags(nt.mint, who)).toBe(8n);
  });
});
