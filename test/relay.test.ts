import { address } from "@solana/kit";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, customError, decodeAccount, deployExample, expectOk, fundedSigner, ix, pda, send, type Deployed } from "./harness.js";

const pinned = /Program<"([1-9A-HJ-NP-Za-km-z]+)">/.exec(readFileSync(new URL("../examples/relay.ts", import.meta.url), "utf8"))![1];

describe("examples/relay.ts (cross-program invocation)", () => {
  let relay: Deployed;
  let counter: Deployed;
  beforeAll(async () => {
    relay = await deployExample("relay");
    counter = await deployExample("counter", { svm: relay.svm, programId: address(pinned) });
  });

  it("pins the callee address in the IDL", () => {
    const accts = relay.idl.instructions.find((i) => i.name === "relay_increment")!.accounts as { name: string; address?: string }[];
    expect(accts.find((a) => a.name === "counter_program")?.address).toBe(pinned);
  });

  it("increments a counter in another program, passing the signature through", async () => {
    const { svm } = relay;
    const alice = await fundedSigner(svm);
    const [ctr] = await pda(counter.programId, ["counter", alice.address]);
    expectOk(
      await send(svm, alice, [
        ix(counter, "initialize", {}, [
          { address: alice.address, signer: alice, writable: true },
          { address: ctr, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const viaRelay = (by: number, signer = alice) =>
      ix(relay, "relay_increment", { by: new BN(by) }, [{ address: signer.address, signer }, { address: ctr, writable: true }, { address: counter.programId }]);
    expectOk(await send(svm, alice, [viaRelay(4), viaRelay(5)]));
    expect(decodeAccount<{ count: BN }>(counter, svm, "Counter", ctr).count.toString()).toBe("9");

    // The callee still enforces its own rules: someone else's signature is rejected inside the CPI.
    const mallory = await fundedSigner(svm);
    expect(customError(await send(svm, mallory, [viaRelay(1, mallory)]))).toBe(6000);
  });

  it("refuses a look-alike program in the pinned slot", async () => {
    const { svm } = relay;
    const alice = await fundedSigner(svm);
    const res = await send(svm, alice, [
      ix(relay, "relay_increment", { by: new BN(1) }, [
        { address: alice.address, signer: alice },
        { address: alice.address, writable: true },
        { address: relay.programId },
      ]),
    ]);
    expect(customError(res)).toBe(3008);
  });

  it("pays out of a PDA treasury with a raw, PDA-signed System transfer", async () => {
    const { svm } = relay;
    const admin = await fundedSigner(svm);
    const [treasury, bump] = await pda(relay.programId, ["treasury", admin.address]);
    svm.airdrop(treasury, 2_000_000_000n as never);
    const bob = await fundedSigner(svm, 1n);
    const pay = (amount: bigint, b = bump, who = admin, t = treasury) =>
      ix(relay, "payout", { amount: new BN(amount.toString()), bump: b }, [
        { address: who.address, signer: who },
        { address: t, writable: true },
        { address: bob.address, writable: true },
        { address: SYSTEM_PROGRAM },
      ]);
    const before = svm.getBalance(bob.address)!;
    expectOk(await send(svm, admin, [pay(500_000_000n)]));
    expect(svm.getBalance(bob.address)! - before).toBe(500_000_000n);
    expect(svm.getBalance(treasury)).toBe(1_500_000_000n);

    // Another admin cannot drain this treasury: the PDA check fails before the CPI.
    const eve = await fundedSigner(svm);
    expect(customError(await send(svm, eve, [pay(1n, bump, eve)]))).toBe(2006);
  });
});
