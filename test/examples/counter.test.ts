import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, customError, decodeAccount, deployExample, expectOk, fundedSigner, ix, pda, send, type Deployed, acct } from "../harness.js";

describe("examples/counter.ts", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployExample("counter");
  });

  it("initializes, increments, and enforces the authority", async () => {
    const { svm } = d;
    const alice = await fundedSigner(svm);
    const [counter, bump] = await pda(d.programId, ["counter", alice.address]);

    expectOk(
      await send(svm, alice, [
        ix(d, "initialize", {}, [{ address: alice.address, signer: alice, writable: true }, { address: counter, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    let state = decodeAccount<{ authority: { toBase58(): string }; count: BN; bump: number }>(d, svm, "Counter", counter);
    expect(state.authority.toBase58()).toBe(alice.address);
    expect(state.count.toString()).toBe("0");
    expect(state.bump).toBe(bump);
    expect(acct(svm, counter).programAddress).toBe(d.programId);

    const inc = (by: bigint, signer = alice) =>
      ix(d, "increment", { by: new BN(by.toString()) }, [
        { address: signer.address, signer },
        { address: counter, writable: true },
      ]);
    expectOk(await send(svm, alice, [inc(5n), inc(7n)]));
    state = decodeAccount(d, svm, "Counter", counter);
    expect(state.count.toString()).toBe("12");

    const mallory = await fundedSigner(svm);
    expect(customError(await send(svm, mallory, [inc(1n, mallory)]))).toBe(6000);

    // Checked arithmetic: u64 overflow aborts instead of wrapping.
    expect(customError(await send(svm, alice, [inc(2n ** 64n - 1n)]))).toBe(5100);
    state = decodeAccount(d, svm, "Counter", counter);
    expect(state.count.toString()).toBe("12");
  });

  it("rejects re-initialization, wrong PDAs and unsigned callers", async () => {
    const { svm } = d;
    const bob = await fundedSigner(svm);
    const [counter] = await pda(d.programId, ["counter", bob.address]);
    const init = (target = counter) =>
      ix(d, "initialize", {}, [{ address: bob.address, signer: bob, writable: true }, { address: target, writable: true }, { address: SYSTEM_PROGRAM }]);
    expectOk(await send(svm, bob, [init()]));
    expect(customError(await send(svm, bob, [init()]))).toBe(0); // the System Program's AccountAlreadyInUse, as under Anchor

    const [someoneElses] = await pda(d.programId, ["counter", (await fundedSigner(svm)).address]);
    expect(customError(await send(svm, bob, [init(someoneElses)]))).toBe(2006);

    // Naming the authority without its signature fails the signer check (the fee payer here is someone else).
    const payer = await fundedSigner(svm);
    const res = await send(svm, payer, [ix(d, "increment", { by: new BN(1) }, [{ address: bob.address }, { address: counter, writable: true }])]);
    expect(customError(res)).toBe(3010);
  });

  it("still initializes when someone pre-funds the PDA address", async () => {
    const { svm } = d;
    const dan = await fundedSigner(svm);
    const [counter] = await pda(d.programId, ["counter", dan.address]);
    // Griefing attempt: a stranger sends 1 lamport, then 0.05 SOL (more than rent), to the future PDA.
    svm.airdrop(counter, 1n as never);
    expectOk(
      await send(svm, dan, [
        ix(d, "initialize", {}, [{ address: dan.address, signer: dan, writable: true }, { address: counter, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    const acct = svm.getAccount(counter);
    expect(acct.exists && acct.programAddress).toBe(d.programId);
    expect(decodeAccount<{ count: BN }>(d, svm, "Counter", counter).count.toString()).toBe("0");

    const erin = await fundedSigner(svm);
    const [rich] = await pda(d.programId, ["counter", erin.address]);
    svm.airdrop(rich, 50_000_000n as never);
    expectOk(
      await send(svm, erin, [
        ix(d, "initialize", {}, [{ address: erin.address, signer: erin, writable: true }, { address: rich, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    expect(svm.getBalance(rich)).toBe(50_000_000n);
  });

  it("checks owner and discriminator on read-only accounts", async () => {
    const { svm } = d;
    const carol = await fundedSigner(svm);
    const [counter] = await pda(d.programId, ["counter", carol.address]);
    expectOk(
      await send(svm, carol, [
        ix(d, "initialize", {}, [{ address: carol.address, signer: carol, writable: true }, { address: counter, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    const check = (target: typeof counter, min: number) => ix(d, "assert_at_least", { min: new BN(min) }, [{ address: target }]);
    expectOk(await send(svm, carol, [check(counter, 0)]));
    expect(customError(await send(svm, carol, [check(counter, 1)]))).toBe(6001);
    // A wallet (system-owned) account is not a Counter.
    expect(customError(await send(svm, carol, [check(carol.address, 0)]))).toBe(3007);
  });
});
