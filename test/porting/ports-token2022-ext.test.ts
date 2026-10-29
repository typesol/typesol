// Ports of the Token-2022 extension examples added in the second batch (see test/ports/README.md).
import { getCreateAccountInstruction } from "@solana-program/system";
import * as t22 from "@solana-program/token-2022";
import { type Address, address, generateKeyPairSigner, getAddressEncoder, lamports, some } from "@solana/kit";
import { createHash } from "node:crypto";
import { FailedTransactionMetadata } from "litesvm";
import { describe, expect, it } from "vitest";
import { ATA_PROGRAM, BN, SYSTEM_PROGRAM, TOKEN_2022, acct, customError, expectOk, fundedSigner, ix, pda, send } from "../harness.js";
import { ataOf, createMint, deployPort, fundAta, tokenBalance } from "../ports-helpers.js";

const MEMO_PROGRAM = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const SESSION_PROGRAM = address("KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5");
const SYSVAR_RENT = address("SysvarRent111111111111111111111111111111111");

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
    const transfer = (withMint = mint) =>
      send(svm, payer, [
        ix(d, "cpi_transfer", {}, [
          { address: payer.address, signer: payer, writable: true },
          { address: token.address, writable: true },
          { address: recipient, writable: true },
          { address: withMint },
          { address: TOKEN_2022 },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    // token::mint = mint_account: another mint fails with ConstraintTokenMint, as in Anchor.
    const otherMint = await createMint(svm, payer, { tokenProgram: TOKEN_2022, decimals: 2 });
    expect(customError(await transfer(otherMint))).toBe(2014);
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

describe("port: tokens/token-2022/metadata", () => {
  it("creates a mint with on-mint metadata, updates, removes and emits it, and drops the update authority", async () => {
    const d = await deployPort("tokens/token-2022/metadata.ts", "HZcin721jw6Uc14yybjYqXRPw4w2GzmXCBYnMddYueyU");
    const { svm } = d;
    const payer = await fundedSigner(svm);
    const mint = await generateKeyPairSigner();
    expectOk(
      await send(svm, payer, [
        ix(d, "initialize", { args: { name: "TypeSOL", symbol: "TS", uri: "https://typesol.com/meta.json" } }, [
          { address: payer.address, signer: payer, writable: true },
          { address: mint.address, signer: mint, writable: true },
          { address: TOKEN_2022 },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const metadata = () => {
      const m = t22.getMintDecoder().decode((svm.getAccount(mint.address) as { data: Uint8Array }).data);
      const ext = (m.extensions as { value: { __kind: string }[] }).value;
      return ext.find((e) => e.__kind === "TokenMetadata") as unknown as {
        updateAuthority: unknown;
        name: string;
        symbol: string;
        uri: string;
        additionalMetadata: Map<string, string>;
      };
    };
    expect(metadata()).toMatchObject({ updateAuthority: some(payer.address), name: "TypeSOL", symbol: "TS", uri: "https://typesol.com/meta.json" });
    const update = (field: object, value: string) =>
      send(svm, payer, [
        ix(d, "update_field", { args: { field, value } }, [
          { address: payer.address, signer: payer, writable: true },
          { address: mint.address, writable: true },
          { address: TOKEN_2022 },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    expectOk(await update({ Name: {} }, "TypeSOL Token, renamed"));
    expect(metadata().name).toBe("TypeSOL Token, renamed");
    expectOk(await update({ Key: { key: "color" } }, "red"));
    expect(metadata().additionalMetadata.get("color")).toBe("red");
    const lamports = svm.getBalance(mint.address)!;
    expect(lamports).toBeGreaterThanOrEqual(
      svm.minimumBalanceForRentExemption(BigInt(svm.getAccount(mint.address).exists ? (svm.getAccount(mint.address) as { data: Uint8Array }).data.length : 0)),
    );
    expectOk(
      await send(svm, payer, [
        ix(d, "remove_key", { key: "color" }, [
          { address: payer.address, signer: payer, writable: true },
          { address: mint.address, writable: true },
          { address: TOKEN_2022 },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    expect(metadata().additionalMetadata.has("color")).toBe(false);
    // emit: the token program returns the Borsh TokenMetadata as return data.
    const emitted = expectOk(await send(svm, payer, [ix(d, "emit", {}, [{ address: mint.address }, { address: TOKEN_2022 }])]));
    expect(Buffer.from(emitted.returnData().data()).includes(Buffer.from("TypeSOL Token, renamed"))).toBe(true);
    // update_authority with no new authority: the metadata can no longer be changed.
    expectOk(
      await send(svm, payer, [
        ix(d, "update_authority", {}, [
          { address: payer.address, signer: payer },
          { address: d.programId },
          { address: mint.address, writable: true },
          { address: TOKEN_2022 },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    expect(metadata().updateAuthority).toEqual({ __option: "None" });
    expect(await update({ Symbol: {} }, "NOPE")).toBeInstanceOf(FailedTransactionMetadata);
  });
});

describe("port: tokens/token-2022/nft-meta-data-pointer", () => {
  it("mints the NFT, then chops trees as the player or through a session key, updating the NFT's wood", async () => {
    const d = await deployPort("tokens/token-2022/nft-meta-data-pointer.ts", "H31ofLpWqeAzF2Pg54HSPQGYifJad843tTJg8vCYVoh3");
    const { svm } = d;
    const enc = getAddressEncoder();
    const payer = await fundedSigner(svm);
    const level = "level1";
    const [player] = await pda(d.programId, ["player", payer.address]);
    const [gameData] = await pda(d.programId, [level]);
    const [nftAuthority] = await pda(d.programId, ["nft_authority"]);
    expectOk(
      await send(svm, payer, [
        ix(d, "init_player", { level_seed: level }, [
          { address: player, writable: true },
          { address: gameData, writable: true },
          { address: payer.address, signer: payer, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    // Anchor's space = 1000 for both accounts.
    expect([acct(svm, player).data.length, acct(svm, gameData).data.length]).toEqual([1000, 1000]);
    // mint_nft
    const mint = await generateKeyPairSigner();
    const ata = await ataOf(payer.address, mint.address, TOKEN_2022);
    expectOk(
      await send(svm, payer, [
        ix(d, "mint_nft", {}, [
          { address: payer.address, signer: payer, writable: true },
          { address: SYSTEM_PROGRAM },
          { address: TOKEN_2022 },
          { address: ata, writable: true },
          { address: mint.address, signer: mint, writable: true },
          { address: SYSVAR_RENT },
          { address: ATA_PROGRAM },
          { address: nftAuthority, writable: true },
        ]),
      ]),
    );
    expect(tokenBalance(svm, ata)).toBe(1n);
    const mintState = () => t22.getMintDecoder().decode((svm.getAccount(mint.address) as { data: Uint8Array }).data);
    const meta = () =>
      (mintState().extensions as { value: { __kind: string; name?: string; additionalMetadata?: Map<string, string> }[] }).value.find(
        (e) => e.__kind === "TokenMetadata",
      )!;
    expect(mintState().mintAuthority).toEqual({ __option: "None" });
    expect([meta().name, meta().additionalMetadata!.get("level")]).toEqual(["Beaver", "1"]);
    // chop_tree
    const chop = (signer: typeof payer, session: Address | null, counter: number) =>
      send(svm, signer, [
        ix(d, "chop_tree", { level_seed: level, counter }, [
          { address: session ?? d.programId },
          { address: player, writable: true },
          { address: gameData, writable: true },
          { address: signer.address, signer, writable: true },
          { address: SYSTEM_PROGRAM },
          { address: mint.address, writable: true },
          { address: nftAuthority, writable: true },
          { address: TOKEN_2022 },
        ]),
      ]);
    expectOk(await chop(payer, null, 1));
    expect(meta().additionalMetadata!.get("wood")).toBe("1");
    const stranger = await fundedSigner(svm);
    expect(customError(await chop(stranger, null, 2))).toBe(6001);
    // A session key: a SessionToken of the session-keys program for (this program, the session signer, the player).
    const sessionSigner = await fundedSigner(svm);
    const token = (await generateKeyPairSigner()).address;
    const setToken = (signer: Address, validUntil: bigint) => {
      const data = new Uint8Array(8 + 32 * 3 + 8);
      data.set(createHash("sha256").update("account:SessionToken").digest().subarray(0, 8), 0);
      data.set(enc.encode(payer.address), 8);
      data.set(enc.encode(d.programId), 40);
      data.set(enc.encode(signer), 72);
      new DataView(data.buffer).setBigInt64(104, validUntil, true);
      svm.setAccount({ address: token, data, executable: false, lamports: lamports(10_000_000n), programAddress: SESSION_PROGRAM, space: BigInt(data.length) });
    };
    const nowTs = svm.getClock().unixTimestamp;
    setToken(sessionSigner.address, nowTs + 3600n);
    expectOk(await chop(sessionSigner, token, 3));
    expect(meta().additionalMetadata!.get("wood")).toBe("2");
    setToken(sessionSigner.address, nowTs - 1n); // expired
    expect(customError(await chop(sessionSigner, token, 4))).toBe(6001);
    setToken(stranger.address, nowTs + 3600n); // issued to someone else
    expect(customError(await chop(sessionSigner, token, 5))).toBe(6001);
  });
});

describe("port: tokens/token-2022/transfer-fee", () => {
  it("charges the transfer fee, harvests it from the remaining accounts, withdraws it and changes it", async () => {
    const d = await deployPort("tokens/token-2022/transfer-fee.ts", "4evptdGtALCNT8uTxJhbWBRZpBE8w5oNtmgfSyfQu7td");
    const { svm } = d;
    const payer = await fundedSigner(svm);
    const mint = await generateKeyPairSigner();
    expectOk(
      await send(svm, payer, [
        ix(d, "initialize", { transfer_fee_basis_points: 100, maximum_fee: new BN(1) }, [
          { address: payer.address, signer: payer, writable: true },
          { address: mint.address, signer: mint, writable: true },
          { address: TOKEN_2022 },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const senderAta = await fundAta(svm, payer, payer.address, mint.address, 300n, { tokenProgram: TOKEN_2022 });
    const recipient = (await generateKeyPairSigner()).address;
    const recipientAta = await ataOf(recipient, mint.address, TOKEN_2022);
    const transfer = (amount: number) =>
      send(svm, payer, [
        ix(d, "transfer", { amount: new BN(amount) }, [
          { address: payer.address, signer: payer, writable: true },
          { address: recipient },
          { address: mint.address, writable: true },
          { address: senderAta, writable: true },
          { address: recipientAta, writable: true },
          { address: TOKEN_2022 },
          { address: ATA_PROGRAM },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    const withheld = (a: Address) => {
      const raw = (svm.getAccount(a) as { data: Uint8Array }).data;
      const ext = (t22.getTokenDecoder().decode(raw).extensions as { value: { __kind: string; withheldAmount?: bigint }[] }).value;
      return ext.find((e) => e.__kind === "TransferFeeAmount")!.withheldAmount;
    };
    const t1 = expectOk(await transfer(100)); // 1% of 100
    expect(t1.logs()).toContain("Program log: fee amount 1");
    expectOk(await transfer(200)); // 1% of 200 = 2, capped at the maximum fee of 1
    expect(tokenBalance(svm, recipientAta)).toBe(298n);
    expect(withheld(recipientAta)).toBe(2n);
    // harvest: the recipient's account, plus an account that is not a token account (Token-2022 skips it).
    const stray = (await generateKeyPairSigner()).address;
    expectOk(
      await send(svm, payer, [
        ix(d, "harvest", {}, [
          { address: mint.address, writable: true },
          { address: TOKEN_2022 },
          { address: recipientAta, writable: true },
          { address: stray },
        ]),
      ]),
    );
    expect(withheld(recipientAta)).toBe(0n);
    expectOk(
      await send(svm, payer, [
        ix(d, "withdraw", {}, [
          { address: payer.address, signer: payer },
          { address: mint.address, writable: true },
          { address: senderAta, writable: true },
          { address: TOKEN_2022 },
        ]),
      ]),
    );
    expect(tokenBalance(svm, senderAta)).toBe(2n);
    // update_fee: the new fee applies from the next epoch (Token-2022 keeps the older one for the current epoch).
    const update = (who: typeof payer) =>
      send(svm, who, [
        ix(d, "update_fee", { transfer_fee_basis_points: 0, maximum_fee: new BN(0) }, [
          { address: who.address, signer: who },
          { address: mint.address, writable: true },
          { address: TOKEN_2022 },
        ]),
      ]);
    expect(await update(await fundedSigner(svm))).toBeInstanceOf(FailedTransactionMetadata);
    expectOk(await update(payer));
  });
});
