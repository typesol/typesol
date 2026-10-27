import * as spl from "@solana-program/token";
import * as t22 from "@solana-program/token-2022";
import { lamports } from "@solana/kit";
import { type Address, type KeyPairSigner, address, generateKeyPairSigner, getAddressEncoder } from "@solana/kit";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, TOKEN_PROGRAM, customError, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed, TOKEN_2022 } from "./harness.js";

const TREASURY = address("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T");
const NATIVE_MINT = address("So11111111111111111111111111111111111111112");
const pk = (a: string) => ({ toBuffer: () => Buffer.from(getAddressEncoder().encode(a as never)), toBase58: () => a });

describe("token operations, constraints and fields (test/fixtures/tokenops.ts)", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  let config: Address;
  let bump: number;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/tokenops.ts", import.meta.url)));
    payer = await fundedSigner(d.svm, 50n);
    [config, bump] = await pda(d.programId, ["config"]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "setup", {}, [{ address: payer.address, signer: payer, writable: true }, { address: config, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
  });
  const ret = (r: ReturnType<typeof expectOk>) => Buffer.from(r.returnData().data()).readBigUInt64LE();
  const tokenAmount = (a: Address) => spl.getTokenDecoder().decode(new Uint8Array((d.svm.getAccount(a) as { data: Uint8Array }).data)).amount;

  async function world(program: Address) {
    const mint = await generateKeyPairSigner();
    expectOk(
      await send(d.svm, payer, [
        ix(d, "create_mint", {}, [
          { address: payer.address, signer: payer, writable: true },
          { address: mint.address, signer: mint, writable: true },
          { address: config },
          { address: SYSTEM_PROGRAM },
          { address: program },
        ]),
      ]),
    );
    const [vault, vbump] = await pda(d.programId, ["vault", mint.address]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "create_vault", { bump: vbump }, [
          { address: payer.address, signer: payer, writable: true },
          { address: vault, writable: true },
          { address: mint.address },
          { address: config },
          { address: SYSTEM_PROGRAM },
          { address: program },
        ]),
      ]),
    );
    const mintTo = (to: Address, amount: number) =>
      send(d.svm, payer, [
        ix(d, "mint_to", { amount: new BN(amount) }, [
          { address: mint.address, writable: true },
          { address: to, writable: true },
          { address: config },
          { address: program },
        ]),
      ]);
    return { mint: mint.address, vault, mintTo };
  }

  for (const [label, program] of [
    ["SPL Token", TOKEN_PROGRAM],
    ["Token-2022", TOKEN_2022],
  ] as const) {
    it(`creates a mint and a PDA vault, mints, delegates, freezes and reads the fields (${label})`, async () => {
      const { mint, vault, mintTo } = await world(program);
      const m = t22.getMintDecoder().decode(new Uint8Array((d.svm.getAccount(mint) as { data: Uint8Array }).data));
      expect([m.decimals, m.isInitialized, (m.mintAuthority as { value?: string }).value, (m.freezeAuthority as { value?: string }).value]).toEqual([
        6,
        true,
        config,
        config,
      ]);
      expect((d.svm.getAccount(vault) as { programAddress: string }).programAddress).toBe(program);
      expectOk(await mintTo(vault, 500));
      expect(tokenAmount(vault)).toBe(500n);

      const inspect = async () => ret(expectOk(await send(d.svm, payer, [ix(d, "inspect", {}, [{ address: vault }, { address: mint }])])));
      expect(await inspect()).toBe(0n);
      const spender = (await generateKeyPairSigner()).address;
      const delegate = (amount: number, owner = config) =>
        send(d.svm, payer, [
          ix(d, "delegate", { amount: new BN(amount) }, [
            { address: vault, writable: true },
            { address: mint },
            { address: owner },
            { address: spender },
            { address: program },
          ]),
        ]);
      expectOk(await delegate(120));
      expect(await inspect()).toBe(120_000n + 10n);
      expectOk(await send(d.svm, payer, [ix(d, "undelegate", {}, [{ address: vault, writable: true }, { address: config }, { address: program }])]));
      expect(await inspect()).toBe(0n);

      const freeze = (on: boolean) =>
        send(d.svm, payer, [ix(d, "freeze", { on }, [{ address: vault, writable: true }, { address: mint }, { address: config }, { address: program }])]);
      expectOk(await freeze(true));
      expect(await inspect()).toBe(100n);
      expect(customError(await mintTo(vault, 1))).toBe(17); // SPL Token: AccountFrozen
      expectOk(await freeze(false));
      expectOk(await mintTo(vault, 1));
    });
  }

  it("enforces HasOne on token accounts and mints (2014 / 2015 / 2016 / 2017)", async () => {
    const a = await world(TOKEN_PROGRAM);
    const b = await world(TOKEN_PROGRAM);
    const spender = (await generateKeyPairSigner()).address;
    const stranger = await fundedSigner(d.svm);
    const delegate = (vault: Address, mint: Address, owner: Address) =>
      send(d.svm, payer, [
        ix(d, "delegate", { amount: new BN(1) }, [
          { address: vault, writable: true },
          { address: mint },
          { address: owner },
          { address: spender },
          { address: TOKEN_PROGRAM },
        ]),
      ]);
    expect(customError(await delegate(a.vault, b.mint, config))).toBe(2014);
    // Same mint, but a token account owned by someone else.
    const ata = (await spl.findAssociatedTokenPda({ owner: stranger.address, mint: a.mint, tokenProgram: TOKEN_PROGRAM }))[0];
    expectOk(await send(d.svm, stranger, [await spl.getCreateAssociatedTokenInstructionAsync({ payer: stranger, owner: stranger.address, mint: a.mint })]));
    expect(customError(await delegate(ata, a.mint, config))).toBe(2015);
    // A mint whose authorities are someone else.
    const foreign = await generateKeyPairSigner();
    expectOk(
      await send(d.svm, stranger, [
        ...(await (async () => {
          const { getCreateAccountInstruction } = await import("@solana-program/system");
          return [
            getCreateAccountInstruction({
              payer: stranger,
              newAccount: foreign,
              lamports: lamports(d.svm.minimumBalanceForRentExemption(82n)),
              space: 82,
              programAddress: TOKEN_PROGRAM,
            }),
          ];
        })()),
        spl.getInitializeMint2Instruction({ mint: foreign.address, decimals: 0, mintAuthority: stranger.address, freezeAuthority: stranger.address }),
      ]),
    );
    const sAta = (await spl.findAssociatedTokenPda({ owner: stranger.address, mint: foreign.address, tokenProgram: TOKEN_PROGRAM }))[0];
    expectOk(
      await send(d.svm, stranger, [await spl.getCreateAssociatedTokenInstructionAsync({ payer: stranger, owner: stranger.address, mint: foreign.address })]),
    );
    const mintTo = send(d.svm, payer, [
      ix(d, "mint_to", { amount: new BN(1) }, [
        { address: foreign.address, writable: true },
        { address: sAta, writable: true },
        { address: config },
        { address: TOKEN_PROGRAM },
      ]),
    ]);
    expect(customError(await mintTo)).toBe(2016);
    const freeze = send(d.svm, payer, [
      ix(d, "freeze", { on: true }, [{ address: sAta, writable: true }, { address: foreign.address }, { address: config }, { address: TOKEN_PROGRAM }]),
    ]);
    expect(customError(await freeze)).toBe(2017);
  });

  it("hands over and removes authorities with setAuthority", async () => {
    const { mint } = await world(TOKEN_2022);
    const next = (await generateKeyPairSigner()).address;
    const authorities = async (who: Address) => ret(expectOk(await send(d.svm, payer, [ix(d, "authorities", { who: pk(who) }, [{ address: mint }])])));
    expect(await authorities(config)).toBe(11n);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "hand_over", { next: pk(next), keep: true }, [{ address: mint, writable: true }, { address: config }, { address: TOKEN_2022 }]),
      ]),
    );
    expect(await authorities(next)).toBe(1n);
    const { mint: m2 } = await world(TOKEN_PROGRAM);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "hand_over", { next: pk(next), keep: false }, [{ address: m2, writable: true }, { address: config }, { address: TOKEN_PROGRAM }]),
      ]),
    );
    expect(ret(expectOk(await send(d.svm, payer, [ix(d, "authorities", { who: pk(next) }, [{ address: m2 }])])))).toBe(2n);
  });

  it("checks associated token accounts declaratively (2009)", async () => {
    const { mint, vault, mintTo } = await world(TOKEN_PROGRAM);
    const owner = await fundedSigner(d.svm);
    const ata = (await spl.findAssociatedTokenPda({ owner: owner.address, mint, tokenProgram: TOKEN_PROGRAM }))[0];
    expectOk(await send(d.svm, owner, [await spl.getCreateAssociatedTokenInstructionAsync({ payer: owner, owner: owner.address, mint })]));
    expectOk(await mintTo(ata, 9));
    const check = (acct: Address) => send(d.svm, payer, [ix(d, "check_ata", {}, [{ address: acct }, { address: owner.address }, { address: mint }])]);
    expect(ret(expectOk(await check(ata)))).toBe(9n);
    expect(customError(await check(vault))).toBe(2009);
    expect(d.idl.instructions.find((i) => i.name === "check_ata")!.accounts[0]).toMatchObject({ name: "account" });
  });

  it("pins Address<…> accounts (2012) and reads pubkey() constants", async () => {
    const pay = (to: Address) =>
      send(d.svm, payer, [
        ix(d, "pay_fee", { amount: new BN(1_000_000) }, [
          { address: payer.address, signer: payer, writable: true },
          { address: to, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    expectOk(await pay(TREASURY));
    expect(d.svm.getBalance(TREASURY)).toBe(1_000_000n);
    expect(customError(await pay((await generateKeyPairSigner()).address))).toBe(2012);
    expect(d.idl.instructions.find((i) => i.name === "pay_fee")!.accounts[1]).toMatchObject({ name: "treasury", writable: true, address: TREASURY });
  });

  it("wraps SOL and syncs the native token amount", async () => {
    // litesvm ships the token programs but not the native mint account: plant it (9 decimals, initialized, no authorities).
    const data = new Uint8Array(82);
    data[44] = 9;
    data[45] = 1;
    d.svm.setAccount({
      address: NATIVE_MINT,
      data,
      executable: false,
      lamports: lamports(d.svm.minimumBalanceForRentExemption(82n)),
      programAddress: TOKEN_PROGRAM,
      space: 82n,
    });
    const owner = await fundedSigner(d.svm);
    const ata = (await spl.findAssociatedTokenPda({ owner: owner.address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM }))[0];
    expectOk(await send(d.svm, owner, [await spl.getCreateAssociatedTokenInstructionAsync({ payer: owner, owner: owner.address, mint: NATIVE_MINT })]));
    const r = expectOk(
      await send(d.svm, owner, [
        ix(d, "wrap", { lamports: new BN(2_000_000) }, [
          { address: owner.address, signer: owner, writable: true },
          { address: ata, writable: true },
          { address: SYSTEM_PROGRAM },
          { address: TOKEN_PROGRAM },
        ]),
      ]),
    );
    expect(ret(r)).toBe(2_000_000n);
  });
});
