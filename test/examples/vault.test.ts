import { Rent } from "litesvm";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, customError, decodeAccount, deployExample, expectOk, fundedSigner, ix, lamports, pda, send, type Deployed } from "../harness.js";

const SOL = 1_000_000_000n;

describe("examples/vault.ts", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployExample("vault");
  });

  it("deposits and withdraws SOL, keeps rent, then closes", async () => {
    const { svm } = d;
    const owner = await fundedSigner(svm, 20n);
    const [vault] = await pda(d.programId, ["vault", owner.address]);
    const me = { address: owner.address, signer: owner, writable: true };
    const v = { address: vault, writable: true };

    expectOk(await send(svm, owner, [ix(d, "open", {}, [me, v, { address: SYSTEM_PROGRAM }])]));
    const rent = svm.getBalance(vault)!;
    expect(rent).toBeGreaterThan(0n);

    expectOk(await send(svm, owner, [ix(d, "deposit", { amount: new BN((3n * SOL).toString()) }, [me, v, { address: SYSTEM_PROGRAM }])]));
    expect(svm.getBalance(vault)).toBe(rent + 3n * SOL);

    const before = svm.getBalance(owner.address)!;
    expectOk(await send(svm, owner, [ix(d, "withdraw", { amount: new BN(SOL.toString()) }, [me, v])]));
    const after = svm.getBalance(owner.address)!;
    expect(svm.getBalance(vault)).toBe(rent + 2n * SOL);
    expect(after - before).toBe(SOL - 5000n); // minus the tx fee

    const state = decodeAccount<{ deposited: BN; withdrawn: BN }>(d, svm, "Vault", vault);
    expect(state.deposited.toString()).toBe((3n * SOL).toString());
    expect(state.withdrawn.toString()).toBe(SOL.toString());

    // Cannot dig into the rent reserve.
    expect(customError(await send(svm, owner, [ix(d, "withdraw", { amount: new BN((2n * SOL + 1n).toString()) }, [me, v])]))).toBe(6002);

    expectOk(await send(svm, owner, [ix(d, "shut", {}, [me, v])]));
    expect(svm.getAccount(vault).exists).toBe(false);
  });

  it("stops strangers and zero amounts", async () => {
    const { svm } = d;
    const owner = await fundedSigner(svm);
    const thief = await fundedSigner(svm);
    const [vault] = await pda(d.programId, ["vault", owner.address]);
    const me = { address: owner.address, signer: owner, writable: true };
    const them = { address: thief.address, signer: thief, writable: true };
    const v = { address: vault, writable: true };
    expectOk(await send(svm, owner, [ix(d, "open", {}, [me, v, { address: SYSTEM_PROGRAM }])]));
    expectOk(await send(svm, owner, [ix(d, "deposit", { amount: new BN(SOL.toString()) }, [me, v, { address: SYSTEM_PROGRAM }])]));

    expect(customError(await send(svm, thief, [ix(d, "withdraw", { amount: new BN(1000) }, [them, v])]))).toBe(6000);
    expect(customError(await send(svm, thief, [ix(d, "shut", {}, [them, v])]))).toBe(6000);
    expect(customError(await send(svm, owner, [ix(d, "deposit", { amount: new BN(0) }, [me, v, { address: SYSTEM_PROGRAM }])]))).toBe(6001);

    // A fake "system program" account is rejected before any CPI.
    expect(customError(await send(svm, owner, [ix(d, "deposit", { amount: new BN(1) }, [me, v, { address: thief.address }])]))).toBe(3008);

    // The owner's wallet is not a Vault: owner check fires before anything else.
    expect(customError(await send(svm, owner, [ix(d, "withdraw", { amount: new BN(1) }, [me, me])]))).toBe(3007);
  });

  it("charges exactly the runtime's rent-exempt minimum, on the integer fast path and the floating-point one", async () => {
    const { svm } = d;
    const saved = svm.getRent();
    // Whole thresholds take the integer path (the runtime caps rates far below a 2^53 product); fractions take the double math.
    const cases: [bigint, number][] = [
      [6960n, 1.0],
      [3480n, 2.0],
      [3481n, 1.5],
      [1000n, 0.37],
      [7n, 3.0],
      [2n ** 30n + 1n, 2.0],
    ];
    try {
      for (const [rate, threshold] of cases) {
        const rent = new Rent(rate, threshold, 50);
        svm.setRent(rent);
        const owner = await fundedSigner(svm, 1n);
        svm.airdrop(owner.address, lamports(rent.minimumBalance(57n) + rent.minimumBalance(0n) + SOL));
        const [vault] = await pda(d.programId, ["vault", owner.address]);
        expectOk(
          await send(svm, owner, [
            ix(d, "open", {}, [{ address: owner.address, signer: owner, writable: true }, { address: vault, writable: true }, { address: SYSTEM_PROGRAM }]),
          ]),
        );
        expect(svm.getBalance(vault), `rate ${rate}, threshold ${threshold}`).toBe(rent.minimumBalance(57n));
      }
    } finally {
      svm.setRent(saved);
    }
  });
});
