// Ports of the tokens/token-2022/ Anchor programs of solana-developers/program-examples: each describe runs the flows
// of the original's TypeScript tests against the TypeSOL rewrite under test/ports/tokens/token-2022/. Status and
// reasons per program: test/ports/README.md.
import * as t22 from "@solana-program/token-2022";
import { type Address, AccountRole, type Instruction, generateKeyPairSigner, some } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { describe, expect, it } from "vitest";
import { ATA_PROGRAM, BN, SYSTEM_PROGRAM, TOKEN_2022, acct, customError, expectOk, fundedSigner, ix, pda, send } from "../harness.js";
import { ataOf, deployPort, fundAta, tokenBalance } from "../ports-helpers.js";

const mintOf = (svm: Parameters<typeof acct>[0], a: Address) => t22.getMintDecoder().decode(acct(svm, a).data);

describe("port: tokens/token-2022/basics", () => {
  it("creates a PDA mint, a PDA token account and ATAs, mints and transfers", async () => {
    const d = await deployPort("tokens/token-2022/basics.ts", "6qNqxkRF791FXFeQwqYQLEzAbGiqDULC5SSHVsfRoG89");
    const { svm } = d;
    const signer = await fundedSigner(svm);
    const name = "TypeSOL token";
    const [mint] = await pda(d.programId, ["token-2022-token", signer.address, name]);
    const createToken = () =>
      send(svm, signer, [
        ix(d, "create_token", { token_name: name }, [
          { address: signer.address, signer, writable: true },
          { address: mint, writable: true },
          { address: SYSTEM_PROGRAM },
          { address: TOKEN_2022 },
        ]),
      ]);
    expectOk(await createToken());
    expect(acct(svm, mint).programAddress).toBe(TOKEN_2022);
    expect(mintOf(svm, mint).mintAuthority).toEqual(some(signer.address));

    const [tokenAccount] = await pda(d.programId, ["token-2022-token-account", signer.address, mint]);
    expectOk(
      await send(svm, signer, [
        ix(d, "create_token_account", {}, [
          { address: signer.address, signer, writable: true },
          { address: mint },
          { address: tokenAccount, writable: true },
          { address: SYSTEM_PROGRAM },
          { address: TOKEN_2022 },
        ]),
      ]),
    );
    expect(tokenBalance(svm, tokenAccount)).toBe(0n);

    const signerAta = await ataOf(signer.address, mint, TOKEN_2022);
    expectOk(
      await send(svm, signer, [
        ix(d, "create_associated_token_account", {}, [
          { address: signer.address, signer, writable: true },
          { address: mint },
          { address: signerAta, writable: true },
          { address: SYSTEM_PROGRAM },
          { address: TOKEN_2022 },
          { address: ATA_PROGRAM },
        ]),
      ]),
    );
    expectOk(
      await send(svm, signer, [
        ix(d, "mint_token", { amount: new BN(200) }, [
          { address: signer.address, signer, writable: true },
          { address: mint, writable: true },
          { address: signerAta, writable: true },
          { address: TOKEN_2022 },
        ]),
      ]),
    );
    expect(tokenBalance(svm, signerAta)).toBe(200n);

    const to = await fundedSigner(svm, 1n);
    const toAta = await ataOf(to.address, mint, TOKEN_2022);
    const transfer = () =>
      send(svm, signer, [
        ix(d, "transfer_token", { amount: new BN(50) }, [
          { address: signer.address, signer, writable: true },
          { address: signerAta, writable: true },
          { address: to.address },
          { address: toAta, writable: true },
          { address: mint, writable: true },
          { address: TOKEN_2022 },
          { address: SYSTEM_PROGRAM },
          { address: ATA_PROGRAM },
        ]),
      ]);
    expectOk(await transfer());
    expect(tokenBalance(svm, toAta)).toBe(50n);
    // `init` (not init_if_needed): the recipient's ATA now exists, so a second transfer_token fails in the ATA
    // program's Create ("Provided owner is not allowed": the account already belongs to Token-2022).
    const again = await transfer();
    expect(again).toBeInstanceOf(FailedTransactionMetadata);
    expect(String((again as FailedTransactionMetadata).err())).toMatch(/index: 0, error: IllegalOwner/);
    expect(tokenBalance(svm, signerAta)).toBe(150n);
  });
});

/** A keypair mint created by a port's `initialize(payer, mint_account, token_program, system_program)`. */
async function initMint(d: Awaited<ReturnType<typeof deployPort>>, name = "initialize", args: Record<string, unknown> = {}) {
  const payer = await fundedSigner(d.svm);
  const mint = await generateKeyPairSigner();
  const res = await send(d.svm, payer, [
    ix(d, name, args, [
      { address: payer.address, signer: payer, writable: true },
      { address: mint.address, signer: mint, writable: true },
      { address: TOKEN_2022 },
      { address: SYSTEM_PROGRAM },
    ]),
  ]);
  return { payer, mint: mint.address, res };
}

describe("port: tokens/token-2022/mint-close-authority", () => {
  it("creates a mint with a close authority and lets only that authority close it", async () => {
    const d = await deployPort("tokens/token-2022/mint-close-authority.ts", "AcfQLsYKuzprcCNH1n96pKKgAbAnZchwpbr3gbVN742n");
    const { payer, mint, res } = await initMint(d);
    expectOk(res);
    const ext = mintOf(d.svm, mint).extensions;
    expect(ext).toEqual(some([{ __kind: "MintCloseAuthority", closeAuthority: payer.address }]));
    const close = (who: typeof payer) =>
      send(d.svm, who, [
        ix(d, "close", {}, [{ address: who.address, signer: who, writable: true }, { address: mint, writable: true }, { address: TOKEN_2022 }]),
      ]);
    const stranger = await fundedSigner(d.svm);
    expect(customError(await close(stranger))).toBe(6000);
    expectOk(await close(payer));
    expect(d.svm.getAccount(mint).exists).toBe(false);
  });
});

describe("port: tokens/token-2022/permanent-delegate", () => {
  it("creates a mint whose permanent delegate is the payer", async () => {
    const d = await deployPort("tokens/token-2022/permanent-delegate.ts", "A9rxKS84ZoJVyeTfQbCEfxME2vvAM4uwSMjkmhR5XWb1");
    const { payer, mint, res } = await initMint(d);
    expectOk(res);
    expect(mintOf(d.svm, mint).extensions).toEqual(some([{ __kind: "PermanentDelegate", delegate: payer.address }]));
    // The delegate can burn tokens it does not own.
    const holder = await fundedSigner(d.svm, 1n);
    const ata = await fundAta(d.svm, payer, holder.address, mint, 10n, { tokenProgram: TOKEN_2022 });
    expectOk(await send(d.svm, payer, [t22.getBurnCheckedInstruction({ account: ata, mint, authority: payer, amount: 4n, decimals: 2 })]));
    expect(tokenBalance(d.svm, ata)).toBe(6n);
  });
});

describe("port: tokens/token-2022/non-transferable", () => {
  it("creates a mint whose tokens cannot be transferred", async () => {
    const d = await deployPort("tokens/token-2022/non-transferable.ts", "8Bz4wpHaUckiC169Rg5ZfaBHFemp5S8RwTSDTKzhJ9W");
    const { payer, mint, res } = await initMint(d);
    expectOk(res);
    expect(mintOf(d.svm, mint).extensions).toEqual(some([{ __kind: "NonTransferable" }]));
    const from = await fundAta(d.svm, payer, payer.address, mint, 100n, { tokenProgram: TOKEN_2022 });
    const other = await fundedSigner(d.svm, 1n);
    const to = await fundAta(d.svm, payer, other.address, mint, 0n, { tokenProgram: TOKEN_2022 });
    // Token-2022 NonTransferable error (0x25).
    const r = await send(d.svm, payer, [
      t22.getTransferCheckedInstruction({ source: from, mint, destination: to, authority: payer, amount: 50n, decimals: 2 }),
    ]);
    expect(customError(r)).toBe(37);
    expect(tokenBalance(d.svm, from)).toBe(100n);
  });
});

describe("port: tokens/token-2022/default-account-state", () => {
  it("freezes new token accounts until the freeze authority changes the default", async () => {
    const d = await deployPort("tokens/token-2022/default-account-state.ts", "5LdYbHiUsFxVG8bfqoeBkhBYMRmWZb3BoLuABgYW7coB");
    const { payer, mint, res } = await initMint(d);
    expectOk(res);
    const frozen = await fundAta(d.svm, payer, payer.address, mint, 0n, { tokenProgram: TOKEN_2022 });
    // Minting into a frozen account fails (Token-2022 AccountFrozen = 0x11).
    const mintTo = (to: Address) => send(d.svm, payer, [t22.getMintToInstruction({ mint, token: to, mintAuthority: payer, amount: 1n })]);
    expect(customError(await mintTo(frozen))).toBe(17);
    const update = (who: typeof payer, state: object) =>
      send(d.svm, who, [
        ix(d, "update_default_state", { account_state: state }, [
          { address: who.address, signer: who, writable: true },
          { address: mint, writable: true },
          { address: TOKEN_2022 },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    const stranger = await fundedSigner(d.svm);
    expect(customError(await update(stranger, { Initialized: {} }))).toBe(2017);
    expectOk(await update(payer, { Initialized: {} }));
    const other = await fundedSigner(d.svm, 1n);
    const open = await fundAta(d.svm, payer, other.address, mint, 0n, { tokenProgram: TOKEN_2022 });
    expectOk(await mintTo(open));
    expect(tokenBalance(d.svm, open)).toBe(1n);
  });
});

describe("port: tokens/token-2022/transfer-hook/hello-world", () => {
  it("runs on every Token-2022 transfer and refuses to be called outside one", async () => {
    const d = await deployPort("tokens/token-2022/transfer-hook/hello-world.ts", "jY5DfVksJT8Le38LCaQhz5USeiGu4rUeVSS8QRAMoba");
    const { svm } = d;
    const { payer, mint, res } = await initMint(d, "initialize", { decimals: 2 });
    expectOk(res);
    expect(mintOf(svm, mint).extensions).toEqual(some([{ __kind: "TransferHook", authority: payer.address, programId: d.programId }]));
    const [extraMetas] = await pda(d.programId, ["extra-account-metas", mint]);
    // Anchor clients send just the interface discriminator (the handler takes no arguments).
    const initMetas: Instruction = {
      programAddress: d.programId,
      accounts: [
        { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payer } as never,
        { address: extraMetas, role: AccountRole.WRITABLE },
        { address: mint, role: AccountRole.READONLY },
        { address: TOKEN_2022, role: AccountRole.READONLY },
        { address: ATA_PROGRAM, role: AccountRole.READONLY },
        { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      ],
      data: Uint8Array.from([43, 34, 13, 49, 167, 88, 235, 235]),
    };
    expectOk(await send(svm, payer, [initMetas]));
    expect(acct(svm, extraMetas).data.length).toBe(16);

    const from = await fundAta(svm, payer, payer.address, mint, 1_000n, { tokenProgram: TOKEN_2022 });
    const recipient = await fundedSigner(svm, 1n);
    const to = await fundAta(svm, payer, recipient.address, mint, 0n, { tokenProgram: TOKEN_2022 });
    const base = t22.getTransferCheckedInstruction({ source: from, mint, destination: to, authority: payer, amount: 100n, decimals: 2 });
    const transfer = {
      ...base,
      accounts: [...base.accounts, { address: extraMetas, role: AccountRole.READONLY }, { address: d.programId, role: AccountRole.READONLY }],
    };
    const logs = expectOk(await send(svm, payer, [transfer as never])).logs();
    expect(logs).toContain("Program log: Hello Transfer Hook!");
    expect(tokenBalance(svm, to)).toBe(100n);

    // Calling the hook directly: the source account is not mid-transfer.
    const execute: Instruction = {
      programAddress: d.programId,
      accounts: [from, mint, to, payer.address, extraMetas].map((address) => ({ address, role: AccountRole.READONLY })),
      data: Uint8Array.from([105, 37, 101, 197, 75, 251, 102, 26, ...new Uint8Array(new BigUint64Array([100n]).buffer)]),
    };
    expect(customError(await send(svm, payer, [execute]))).toBe(6000);
  });
});
