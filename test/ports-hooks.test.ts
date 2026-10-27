// Ports of tokens/token-2022/transfer-hook/* with extra accounts (helpers in hook-helpers.ts).
import { getTransferSolInstruction } from "@solana-program/system";
import * as spl from "@solana-program/token";
import * as t22 from "@solana-program/token-2022";
import { address, generateKeyPairSigner, lamports } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { describe, expect, it } from "vitest";
import { ATA_PROGRAM, BN, SYSTEM_PROGRAM, TOKEN_2022, TOKEN_PROGRAM, customError, expectOk, fundedSigner, ix, pda, send } from "./harness.js";
import { ataOf, deployPort, pk, tokenBalance } from "./ports-helpers.js";

const WSOL = address("So11111111111111111111111111111111111111112");
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

describe("port: tokens/token-2022/transfer-hook/transfer-cost", () => {
  it("charges the sender WSOL on every transfer through the hook's seven extra accounts", async () => {
    const d = await deployPort("tokens/token-2022/transfer-hook/transfer-cost.ts", "FjcHckEgXcBhFmSGai3FRpDLiT6hbpV893n8iTxVd81g");
    const { svm } = d;
    const sender = await fundedSigner(svm, 20n);
    // The native mint (absent from a fresh LiteSVM): an initialized SPL Token mint, 9 decimals, no authorities.
    const mintData = new Uint8Array(82);
    mintData[44] = 9;
    mintData[45] = 1;
    svm.setAccount({
      address: WSOL,
      data: mintData,
      executable: false,
      lamports: lamports(svm.minimumBalanceForRentExemption(82n)),
      programAddress: TOKEN_PROGRAM,
      space: 82n,
    });
    const [delegate] = await pda(d.programId, ["delegate"]);
    const delegateWsol = await ataOf(delegate, WSOL);
    const senderWsol = await ataOf(sender.address, WSOL);
    expectOk(
      await send(svm, sender, [
        spl.getCreateAssociatedTokenIdempotentInstruction({ payer: sender, ata: delegateWsol, owner: delegate, mint: WSOL }),
        spl.getCreateAssociatedTokenIdempotentInstruction({ payer: sender, ata: senderWsol, owner: sender.address, mint: WSOL }),
        getTransferSolInstruction({ source: sender, destination: senderWsol, amount: 1_000_000n }),
        spl.getSyncNativeInstruction({ account: senderWsol }),
      ]),
    );
    const mint = await hookMint(svm, sender, d.programId);
    const [counter] = await pda(d.programId, ["counter"]);
    expectOk(
      await send(svm, sender, [
        ix(d, "initialize_extra_account_meta_list", {}, [
          { address: sender.address, signer: sender, writable: true },
          { address: await validationAccount(d.programId, mint), writable: true },
          { address: mint },
          { address: counter, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const source = await ataFor(svm, sender, sender.address, mint, 100n);
    const destination = await ataFor(svm, sender, (await generateKeyPairSigner()).address, mint, 0n);
    const extra = [
      { address: WSOL },
      { address: TOKEN_PROGRAM },
      { address: ATA_PROGRAM },
      { address: delegate, writable: true },
      { address: delegateWsol, writable: true },
      { address: senderWsol, writable: true },
      { address: counter, writable: true },
    ];
    const transfer = async (amount: bigint) =>
      send(svm, sender, [await hookedTransfer(d.programId, { source, mint, destination, authority: sender, amount }, extra)]);
    // Without the sender approving the delegate, the WSOL transfer inside the hook fails.
    expect(await transfer(10n)).toBeInstanceOf(FailedTransactionMetadata);
    expectOk(await send(svm, sender, [spl.getApproveInstruction({ source: senderWsol, delegate, owner: sender, amount: 1_000n })]));
    const r = expectOk(await transfer(10n));
    expect(r.logs()).toContain("Program log: This token has been transferred 1 times");
    expect(tokenBalance(svm, delegateWsol)).toBe(10n);
    expect(tokenBalance(svm, destination)).toBe(10n);
  });
});

describe("port: tokens/token-2022/transfer-hook/allow-block-list-token", () => {
  it("allows, blocks and thresholds transfers from the mint's metadata and per-wallet entries", async () => {
    const d = await deployPort("tokens/token-2022/transfer-hook/allow-block-list-token.ts", "3ku1ZEGvBEEfhaYsAzBZuecTPEa58ZRhoVqHVGpGxVGi");
    const { svm } = d;
    const payer = await fundedSigner(svm);
    const [config] = await pda(d.programId, ["config"]);
    expectOk(
      await send(svm, payer, [
        ix(d, "init_config", {}, [{ address: payer.address, signer: payer, writable: true }, { address: config, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    const mintKp = await generateKeyPairSigner();
    const mint = mintKp.address;
    const metas = await validationAccount(d.programId, mint);
    expectOk(
      await send(svm, payer, [
        ix(
          d,
          "init_mint",
          {
            decimals: 2,
            mint_authority: pk(payer.address),
            freeze_authority: pk(payer.address),
            permanent_delegate: pk(payer.address),
            transfer_hook_authority: pk(payer.address),
            mode: { Allow: {} },
            threshold: new BN(0),
            name: "Listed",
            symbol: "ABL",
            uri: "https://example.com/abl.json",
          },
          [
            { address: payer.address, signer: payer, writable: true },
            { address: mint, signer: mintKp, writable: true },
            { address: metas, writable: true },
            { address: SYSTEM_PROGRAM },
            { address: TOKEN_2022 },
          ],
        ),
      ]),
    );
    const meta = () => {
      const m = t22.getMintDecoder().decode((svm.getAccount(mint) as { data: Uint8Array }).data);
      return (m.extensions as { value: { __kind: string; additionalMetadata?: Map<string, string> }[] }).value.find((e) => e.__kind === "TokenMetadata")!
        .additionalMetadata!;
    };
    expect([...meta()]).toEqual([["AB", "Allow"]]);

    const sender = await fundedSigner(svm);
    const source = await ataFor(svm, payer, sender.address, mint, 1_000n);
    const receiver = (await generateKeyPairSigner()).address;
    const destination = await ataFor(svm, payer, receiver, mint, 0n);
    const [senderEntry] = await pda(d.programId, ["ab_wallet", sender.address]);
    const [receiverEntry] = await pda(d.programId, ["ab_wallet", receiver]);
    const transfer = async (amount: bigint) =>
      send(svm, sender, [
        await hookedTransfer(d.programId, { source, mint, destination, authority: sender, amount }, [{ address: senderEntry }, { address: receiverEntry }]),
      ]);
    const wallet = (owner: string, allowed: boolean) =>
      send(svm, payer, [
        ix(d, "init_wallet", { args: { allowed } }, [
          { address: payer.address, signer: payer, writable: true },
          { address: config },
          { address: owner },
          { address: owner === sender.address ? senderEntry : receiverEntry, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    const mode = (m: object, threshold: number) =>
      send(svm, payer, [
        ix(d, "change_mode", { args: { mode: m, threshold: new BN(threshold) } }, [
          { address: payer.address, signer: payer, writable: true },
          { address: mint, writable: true },
          { address: TOKEN_2022 },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);

    // Allow mode: only listed (allowed) destinations.
    expect(customError(await transfer(10n))).toBe(6001);
    expectOk(await wallet(receiver, true));
    expectOk(await transfer(10n));
    // A blocked wallet is refused in every mode.
    expectOk(await wallet(sender.address, false));
    expect(customError(await transfer(10n))).toBe(6003);
    expectOk(
      await send(svm, payer, [
        ix(d, "remove_wallet", {}, [
          { address: payer.address, signer: payer, writable: true },
          { address: config },
          { address: sender.address },
          { address: senderEntry, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    expect(svm.getAccount(senderEntry).exists).toBe(false);
    // Mixed: unlisted destinations may receive less than the threshold.
    expectOk(
      await send(svm, payer, [
        ix(d, "remove_wallet", {}, [
          { address: payer.address, signer: payer, writable: true },
          { address: config },
          { address: receiver },
          { address: receiverEntry, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    expectOk(await mode({ Mixed: {} }, 100));
    expect([...meta()]).toEqual([
      ["AB", "Mixed"],
      ["threshold", "100"],
    ]);
    expectOk(await transfer(99n));
    expect(customError(await transfer(100n))).toBe(6002);
    // Block mode: unlisted wallets pass; the threshold field is reset to 0.
    expectOk(await mode({ Block: {} }, 5));
    expect(meta().get("threshold")).toBe("0");
    expectOk(await transfer(500n));
    // Only the config authority manages wallets.
    const stranger = await fundedSigner(svm);
    expect(
      customError(
        await send(svm, stranger, [
          ix(d, "init_wallet", { args: { allowed: true } }, [
            { address: stranger.address, signer: stranger, writable: true },
            { address: config },
            { address: receiver },
            { address: receiverEntry, writable: true },
            { address: SYSTEM_PROGRAM },
          ]),
        ]),
      ),
    ).toBe(2001);
    // resize_meta_list rewrites the list (already the right size).
    expectOk(
      await send(svm, payer, [
        ix(d, "resize_meta_list", {}, [
          { address: payer.address, signer: payer, writable: true },
          { address: mint },
          { address: metas, writable: true },
          { address: SYSTEM_PROGRAM },
          { address: TOKEN_2022 },
        ]),
      ]),
    );
    expectOk(await transfer(1n));

    // attach_to_mint: point another hooked mint at this program and write its list.
    const other = await hookMint(svm, payer, (await generateKeyPairSigner()).address);
    expectOk(
      await send(svm, payer, [
        ix(d, "attach_to_mint", {}, [
          { address: payer.address, signer: payer, writable: true },
          { address: other, writable: true },
          { address: await validationAccount(d.programId, other), writable: true },
          { address: SYSTEM_PROGRAM },
          { address: TOKEN_2022 },
        ]),
      ]),
    );
    expect(t22.getMintDecoder().decode((svm.getAccount(other) as { data: Uint8Array }).data).extensions).toMatchObject({
      value: [{ __kind: "TransferHook", programId: d.programId }],
    });
  });
});
