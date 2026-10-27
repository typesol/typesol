// Ports of tokens/token-2022/transfer-hook/* with extra accounts (helpers in hook-helpers.ts).
import { generateKeyPairSigner } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { describe, expect, it } from "vitest";
import { ATA_PROGRAM, BN, SYSTEM_PROGRAM, TOKEN_2022, customError, expectOk, fundedSigner, ix, pda, send } from "./harness.js";
import { deployPort, tokenBalance } from "./ports-helpers.js";
import { ataFor, hookMint, hookedTransfer, validationAccount } from "./hook-helpers.js";

describe("port: tokens/token-2022/transfer-hook/counter", () => {
  it("lists the counter PDA as an extra account; Token-2022 passes it to the hook on each transfer", async () => {
    const d = await deployPort("tokens/token-2022/transfer-hook/counter.ts", "1qahDxKHeCLZhbBU2NyMU6vQCQmEUmdeSEBrG5drffK");
    const { svm } = d;
    const payer = await fundedSigner(svm);
    const mint = await hookMint(svm, payer, d.programId);
    const [counter] = await pda(d.programId, ["counter"]);
    expectOk(
      await send(svm, payer, [
        ix(d, "initialize_extra_account_meta_list", {}, [
          { address: payer.address, signer: payer, writable: true },
          { address: await validationAccount(d.programId, mint), writable: true },
          { address: mint },
          { address: counter, writable: true },
          { address: TOKEN_2022 },
          { address: ATA_PROGRAM },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const source = await ataFor(svm, payer, payer.address, mint, 100n);
    const recipient = (await generateKeyPairSigner()).address;
    const destination = await ataFor(svm, payer, recipient, mint, 0n);
    const r = expectOk(
      await send(svm, payer, [
        await hookedTransfer(d.programId, { source, mint, destination, authority: payer, amount: 60n }, [{ address: counter, writable: true }]),
      ]),
    );
    expect(r.logs()).toContain("Program log: The amount is too big: 60");
    expect(r.logs()).toContain("Program log: This token has been transferred 1 times");
    expect(tokenBalance(svm, destination)).toBe(60n);
    // Without the extra account (or with another one), Token-2022 refuses the transfer.
    const wrong = (await generateKeyPairSigner()).address;
    expect(
      await send(svm, payer, [
        await hookedTransfer(d.programId, { source, mint, destination, authority: payer, amount: 1n }, [{ address: wrong, writable: true }]),
      ]),
    ).toBeInstanceOf(FailedTransactionMetadata);
    // Calling the hook directly fails: the source is not transferring.
    expect(
      await send(svm, payer, [
        ix(d, "transfer_hook", { amount: new BN(1) }, [
          { address: source },
          { address: mint },
          { address: destination },
          { address: payer.address },
          { address: await validationAccount(d.programId, mint) },
          { address: counter },
        ]),
      ]),
    ).toBeInstanceOf(FailedTransactionMetadata);
  });
});

describe("port: tokens/token-2022/transfer-hook/account-data-as-seed", () => {
  it("derives the extra account from the source account's owner (account data as a seed)", async () => {
    const d = await deployPort("tokens/token-2022/transfer-hook/account-data-as-seed.ts", "1qahDxKHeCLZhbBU2NyMU6vQCQmEUmdeSEBrG5drffK");
    const { svm } = d;
    const payer = await fundedSigner(svm);
    const mint = await hookMint(svm, payer, d.programId);
    const [counter] = await pda(d.programId, ["counter", payer.address]);
    expectOk(
      await send(svm, payer, [
        ix(d, "initialize_extra_account_meta_list", {}, [
          { address: payer.address, signer: payer, writable: true },
          { address: await validationAccount(d.programId, mint), writable: true },
          { address: mint },
          { address: counter, writable: true },
          { address: TOKEN_2022 },
          { address: ATA_PROGRAM },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const source = await ataFor(svm, payer, payer.address, mint, 10n);
    const destination = await ataFor(svm, payer, (await generateKeyPairSigner()).address, mint, 0n);
    const r = expectOk(
      await send(svm, payer, [
        await hookedTransfer(d.programId, { source, mint, destination, authority: payer, amount: 5n }, [{ address: counter, writable: true }]),
      ]),
    );
    expect(r.logs()).toContain("Program log: This token has been transferred 1 times");
    // Someone else's counter does not match the owner's data: refused.
    const [other] = await pda(d.programId, ["counter", (await generateKeyPairSigner()).address]);
    expect(
      await send(svm, payer, [
        await hookedTransfer(d.programId, { source, mint, destination, authority: payer, amount: 1n }, [{ address: other, writable: true }]),
      ]),
    ).toBeInstanceOf(FailedTransactionMetadata);
  });
});

describe("port: tokens/token-2022/transfer-hook/transfer-switch", () => {
  it("lets a sender transfer only while the admin has their switch on", async () => {
    const d = await deployPort("tokens/token-2022/transfer-hook/transfer-switch.ts", "FjcHckEgXcBhFmSGai3FRpDLiT6hbpV893n8iTxVd81g");
    const { svm } = d;
    const admin = await fundedSigner(svm);
    const [adminConfig] = await pda(d.programId, ["admin-config"]);
    const configure = (who: typeof admin, next: string) =>
      send(svm, who, [
        ix(d, "configure_admin", {}, [
          { address: who.address, signer: who, writable: true },
          { address: next, writable: true },
          { address: adminConfig, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    // First configuration: anyone may set the admin. Naming yourself (admin == new_admin, both writable) is refused by
    // TypeSOL's aliasing check (2040), so the deployer names the admin key.
    const deployer = await fundedSigner(svm);
    expect(customError(await configure(deployer, deployer.address))).toBe(2040);
    expectOk(await configure(deployer, admin.address));
    const stranger = await fundedSigner(svm);
    expect(customError(await configure(stranger, (await generateKeyPairSigner()).address))).toBe(6002);
    expect(customError(await configure(admin, admin.address))).toBe(2040);

    const mint = await hookMint(svm, admin, d.programId);
    expectOk(
      await send(svm, admin, [
        ix(d, "initialize_extra_account_metas_list", {}, [
          { address: admin.address, signer: admin, writable: true },
          { address: mint },
          { address: await validationAccount(d.programId, mint), writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const sender = await fundedSigner(svm);
    const source = await ataFor(svm, admin, sender.address, mint, 10n);
    const destination = await ataFor(svm, admin, (await generateKeyPairSigner()).address, mint, 0n);
    const [senderSwitch] = await pda(d.programId, [sender.address]);
    const toggle = (on: boolean) =>
      send(svm, admin, [
        ix(d, "switch_", { on }, [
          { address: admin.address, signer: admin, writable: true },
          { address: sender.address, writable: true },
          { address: adminConfig },
          { address: senderSwitch, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    const transfer = async () =>
      send(svm, sender, [await hookedTransfer(d.programId, { source, mint, destination, authority: sender, amount: 1n }, [{ address: senderSwitch }])]);
    expectOk(await toggle(false));
    expect(customError(await transfer())).toBe(6001);
    expectOk(await toggle(true));
    expectOk(await transfer());
    expect(tokenBalance(svm, destination)).toBe(1n);
  });
});
