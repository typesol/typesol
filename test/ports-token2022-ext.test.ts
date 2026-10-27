// Ports of the Token-2022 extension examples added in the second batch (see test/ports/README.md).
import { getCreateAccountInstruction } from "@solana-program/system";
import * as t22 from "@solana-program/token-2022";
import { address, generateKeyPairSigner, lamports, some } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { describe, expect, it } from "vitest";
import { SYSTEM_PROGRAM, TOKEN_2022, customError, expectOk, fundedSigner, ix, pda, send } from "./harness.js";
import { createMint, deployPort, fundAta, tokenBalance } from "./ports-helpers.js";

const MEMO_PROGRAM = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

describe("port: tokens/token-2022/cpi-guard", () => {
  it("a CPI transfer fails while the sender's CPI guard is on and works once it is off", async () => {
    const d = await deployPort("tokens/token-2022/cpi-guard.ts", "6tU3MEowU6oxxeDZLSxEwzcEZsZrhBJsfUR6xECvShid");
    const { svm } = d;
    const payer = await fundedSigner(svm);
    const mint = await createMint(svm, payer, { tokenProgram: TOKEN_2022, decimals: 2 });
    // The sender's token account, with the CpiGuard extension enabled (as the upstream test sets it up).
    const token = await generateKeyPairSigner();
    const space = t22.getTokenSize([t22.extension("CpiGuard", { lockCpi: true })]);
    expectOk(
      await send(svm, payer, [
        getCreateAccountInstruction({
          payer,
          newAccount: token,
          lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(space))),
          space,
          programAddress: TOKEN_2022,
        }),
        t22.getInitializeAccount3Instruction({ account: token.address, mint, owner: payer.address }),
        t22.getEnableCpiGuardInstruction({ token: token.address, owner: payer }),
        t22.getMintToInstruction({ mint, token: token.address, mintAuthority: payer, amount: 2n }),
      ]),
    );
    const [recipient] = await pda(d.programId, ["pda"]);
    const transfer = () =>
      send(svm, payer, [
        ix(d, "cpi_transfer", {}, [
          { address: payer.address, signer: payer, writable: true },
          { address: token.address, writable: true },
          { address: recipient, writable: true },
          { address: mint },
          { address: TOKEN_2022 },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    const blocked = await transfer();
    expect(blocked).toBeInstanceOf(FailedTransactionMetadata);
    expect((blocked as FailedTransactionMetadata).meta().logs().join("\n")).toMatch(/cpi guard/i);
    expect(tokenBalance(svm, token.address)).toBe(2n);
    expectOk(await send(svm, payer, [t22.getDisableCpiGuardInstruction({ token: token.address, owner: payer })]));
    expectOk(await transfer()); // creates the recipient PDA token account
    expectOk(await transfer()); // reuses it
    expect(tokenBalance(svm, recipient)).toBe(2n);
    expect(tokenBalance(svm, token.address)).toBe(0n);
    const acc = t22.getTokenDecoder().decode(svm.getAccount(recipient).exists ? (svm.getAccount(recipient) as { data: Uint8Array }).data : new Uint8Array());
    expect([acc.mint, acc.owner]).toEqual([mint, recipient]);
  });
});

describe("port: tokens/token-2022/immutable-owner", () => {
  it("creates a token account whose owner cannot be changed", async () => {
    const d = await deployPort("tokens/token-2022/immutable-owner.ts", "6g5URpqqurW8RbKjuGeRCVZBKky3J4kYcLeotQ6vj6UT");
    const { svm } = d;
    const payer = await fundedSigner(svm);
    const mint = await createMint(svm, payer, { tokenProgram: TOKEN_2022, decimals: 2 });
    const token = await generateKeyPairSigner();
    expectOk(
      await send(svm, payer, [
        ix(d, "initialize", {}, [
          { address: payer.address, signer: payer, writable: true },
          { address: token.address, signer: token, writable: true },
          { address: mint },
          { address: TOKEN_2022 },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const acc = t22.getTokenDecoder().decode((svm.getAccount(token.address) as { data: Uint8Array }).data);
    expect([acc.mint, acc.owner]).toEqual([mint, payer.address]);
    expect(acc.extensions).toEqual(some([{ __kind: "ImmutableOwner" }]));
    // Changing the owner fails (Token-2022 OwnerImmutable).
    const other = (await generateKeyPairSigner()).address;
    const change = await send(svm, payer, [
      t22.getSetAuthorityInstruction({ owned: token.address, owner: payer, authorityType: t22.AuthorityType.AccountOwner, newAuthority: other }),
    ]);
    expect(change).toBeInstanceOf(FailedTransactionMetadata);
  });
});

describe("port: tokens/token-2022/memo-transfer", () => {
  it("requires a memo on incoming transfers until the owner disables it", async () => {
    const d = await deployPort("tokens/token-2022/memo-transfer.ts", "5BQyC7y2Pc283woThq11uZRqsgcRbBRLKz4yQ8BJadi2");
    const { svm } = d;
    const payer = await fundedSigner(svm);
    const mint = await createMint(svm, payer, { tokenProgram: TOKEN_2022, decimals: 2 });
    const token = await generateKeyPairSigner();
    expectOk(
      await send(svm, payer, [
        ix(d, "initialize", {}, [
          { address: payer.address, signer: payer, writable: true },
          { address: token.address, signer: token, writable: true },
          { address: mint },
          { address: TOKEN_2022 },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const acc = t22.getTokenDecoder().decode((svm.getAccount(token.address) as { data: Uint8Array }).data);
    expect(acc.extensions).toEqual(some([{ __kind: "MemoTransfer", requireIncomingTransferMemos: true }]));
    const from = await fundAta(svm, payer, payer.address, mint, 10n, { tokenProgram: TOKEN_2022 });
    const transfer = (withMemo: boolean) =>
      send(svm, payer, [
        ...(withMemo ? [{ programAddress: MEMO_PROGRAM, accounts: [], data: new TextEncoder().encode("hello") }] : []),
        t22.getTransferCheckedInstruction({ source: from, mint, destination: token.address, authority: payer, amount: 1n, decimals: 2 }),
      ]);
    expect(await transfer(false)).toBeInstanceOf(FailedTransactionMetadata);
    expectOk(await transfer(true));
    // Only the token account's owner may disable it.
    const disable = (who: typeof payer) =>
      send(svm, who, [
        ix(d, "disable", {}, [{ address: who.address, signer: who, writable: true }, { address: token.address, writable: true }, { address: TOKEN_2022 }]),
      ]);
    const stranger = await fundedSigner(svm);
    expect(customError(await disable(stranger))).toBe(2015);
    expectOk(await disable(payer));
    expectOk(await transfer(false));
    expect(tokenBalance(svm, token.address)).toBe(2n);
  });
});

describe("port: tokens/token-2022/group", () => {
  it("creates the PDA mint with a GroupPointer to itself", async () => {
    const d = await deployPort("tokens/token-2022/group.ts", "2q91RT4FSHVdyuBMDiCtnZn2ETSrG4mLFZvEC3UxKfue");
    const { svm } = d;
    const payer = await fundedSigner(svm);
    const [mint] = await pda(d.programId, ["group"]);
    const init = () =>
      send(svm, payer, [
        ix(d, "test_initialize_group", {}, [
          { address: payer.address, signer: payer, writable: true },
          { address: mint, writable: true },
          { address: TOKEN_2022 },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    expectOk(await init());
    const m = t22.getMintDecoder().decode((svm.getAccount(mint) as { data: Uint8Array }).data);
    expect([m.decimals, m.mintAuthority, m.freezeAuthority]).toEqual([2, some(mint), some(mint)]);
    expect(m.extensions).toEqual(some([{ __kind: "GroupPointer", authority: some(mint), groupAddress: some(mint) }]));
    // `init`: a second call fails, the mint exists.
    expect(await init()).toBeInstanceOf(FailedTransactionMetadata);
  });
});

describe("port: tokens/token-2022/interest-bearing", () => {
  it("creates an interest-bearing mint and lets only the rate authority change the rate", async () => {
    const d = await deployPort("tokens/token-2022/interest-bearing.ts", "DMQdkzRJz8uQSN8Kx2QYmQJn6xLKhsu3LcPYxs314MgC");
    const { svm } = d;
    const payer = await fundedSigner(svm);
    const mint = await generateKeyPairSigner();
    expectOk(
      await send(svm, payer, [
        ix(d, "initialize", { rate: 0 }, [
          { address: payer.address, signer: payer, writable: true },
          { address: mint.address, signer: mint, writable: true },
          { address: TOKEN_2022 },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const config = () => {
      const m = t22.getMintDecoder().decode((svm.getAccount(mint.address) as { data: Uint8Array }).data);
      const ext = (m.extensions as { __option: string; value: { __kind: string; rateAuthority: unknown; currentRate: number }[] }).value;
      return [m.decimals, ext[0]!.__kind, ext[0]!.rateAuthority, ext[0]!.currentRate];
    };
    expect(config()).toEqual([2, "InterestBearingConfig", payer.address, 0]);
    const update = (who: typeof payer, rate: number) =>
      send(svm, who, [
        ix(d, "update_rate", { rate }, [
          { address: who.address, signer: who, writable: true },
          { address: mint.address, writable: true },
          { address: TOKEN_2022 },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    expectOk(await update(payer, 100));
    expect(config()[3]).toBe(100);
    const stranger = await fundedSigner(svm);
    expect(await update(stranger, 5)).toBeInstanceOf(FailedTransactionMetadata);
    expect(config()[3]).toBe(100);
  });
});
