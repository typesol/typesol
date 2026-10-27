import { getCreateAccountInstruction } from "@solana-program/system";
import * as spl from "@solana-program/token";
import * as t22 from "@solana-program/token-2022";
import { type Address, type KeyPairSigner, generateKeyPairSigner, lamports } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import {
  BN,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  customError,
  decodeAccount,
  deployExample,
  expectOk,
  fundedSigner,
  ix,
  pda,
  send,
  type Deployed,
  acct,
  TOKEN_2022,
} from "./harness.js";

describe("examples/minter.ts on SPL Token and Token-2022", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployExample("minter");
  });

  /** A mint whose authority is the program's config PDA; Token-2022 mints get a MintCloseAuthority extension. */
  async function setupMint(program: Address) {
    const { svm } = d;
    const admin = await fundedSigner(svm);
    const mint = await generateKeyPairSigner();
    const [config] = await pda(d.programId, ["config", mint.address]);
    const is2022 = program === TOKEN_2022;
    const space = is2022 ? t22.getMintSize([{ __kind: "MintCloseAuthority", closeAuthority: admin.address }]) : spl.getMintSize();
    const rent = svm.minimumBalanceForRentExemption(BigInt(space));
    const ixs = [
      getCreateAccountInstruction({ payer: admin, newAccount: mint, lamports: lamports(rent), space, programAddress: program }),
      ...(is2022 ? [t22.getInitializeMintCloseAuthorityInstruction({ mint: mint.address, closeAuthority: admin.address })] : []),
      is2022
        ? t22.getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: config })
        : spl.getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: config }),
    ];
    expectOk(await send(svm, admin, ixs));
    expectOk(
      await send(svm, admin, [
        ix(d, "setup", { cap: new BN(1_000_000) }, [
          { address: admin.address, signer: admin, writable: true },
          { address: config, writable: true },
          { address: mint.address },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const ata = async (owner: KeyPairSigner) => {
      const create = is2022
        ? await t22.getCreateAssociatedTokenIdempotentInstructionAsync({ payer: admin, owner: owner.address, mint: mint.address, tokenProgram: TOKEN_2022 })
        : await t22.getCreateAssociatedTokenIdempotentInstructionAsync({ payer: admin, owner: owner.address, mint: mint.address, tokenProgram: TOKEN_PROGRAM });
      expectOk(await send(svm, admin, [create]));
      return create.accounts[1].address as Address;
    };
    return { svm, admin, mint: mint.address, config, ata, program };
  }

  const balance = (svm: Deployed["svm"], a: Address) => {
    const acct = svm.getAccount(a);
    if (!acct.exists) return undefined;
    return Buffer.from(acct.data).readBigUInt64LE(64);
  };

  for (const [label, program] of [
    ["SPL Token", TOKEN_PROGRAM],
    ["Token-2022 (with extensions)", TOKEN_2022],
  ] as const) {
    it(`issues under a cap, pays with transferChecked and burns — ${label}`, async () => {
      const m = await setupMint(program);
      const alice = await fundedSigner(m.svm);
      const bob = await fundedSigner(m.svm);
      const [aliceAta, bobAta] = [await m.ata(alice), await m.ata(bob)];
      if (program === TOKEN_2022) expect(acct(m.svm, aliceAta).data.length).toBeGreaterThan(165);

      const issue = (amount: number, signer = m.admin) =>
        ix(d, "issue", { amount: new BN(amount) }, [
          { address: signer.address, signer },
          { address: m.config, writable: true },
          { address: m.mint, writable: true },
          { address: aliceAta, writable: true },
          { address: m.program },
        ]);
      expectOk(await send(m.svm, m.admin, [issue(700_000)]));
      expect(balance(m.svm, aliceAta)).toBe(700_000n);
      expect(decodeAccount<{ minted: BN }>(d, m.svm, "Config", m.config).minted.toString()).toBe("700000");
      expect(customError(await send(m.svm, m.admin, [issue(300_001)]))).toBe(6001);
      expect(customError(await send(m.svm, alice, [issue(1, alice)]))).toBe(6000);

      expectOk(
        await send(m.svm, alice, [
          ix(d, "pay", { amount: new BN(250_000) }, [
            { address: alice.address, signer: alice },
            { address: aliceAta, writable: true },
            { address: m.mint },
            { address: bobAta, writable: true },
            { address: m.program },
          ]),
        ]),
      );
      expect([balance(m.svm, aliceAta), balance(m.svm, bobAta)]).toEqual([450_000n, 250_000n]);

      const burned = expectOk(
        await send(m.svm, bob, [
          ix(d, "burn", { amount: new BN(50_000) }, [
            { address: bob.address, signer: bob },
            { address: bobAta, writable: true },
            { address: m.mint, writable: true },
            { address: m.program },
          ]),
        ]),
      );
      expect(Buffer.from(burned.returnData().data()).readBigUInt64LE()).toBe(650_000n);
    });
  }

  it("refuses a token account of another mint and a fake token program", async () => {
    const a = await setupMint(TOKEN_2022);
    const b = await setupMint(TOKEN_PROGRAM);
    const alice = await fundedSigner(a.svm);
    const foreign = await b.ata(alice);
    const issue = (to: Address, program: Address) =>
      ix(d, "issue", { amount: new BN(1) }, [
        { address: a.admin.address, signer: a.admin },
        { address: a.config, writable: true },
        { address: a.mint, writable: true },
        { address: to, writable: true },
        { address: program },
      ]);
    expect(customError(await send(a.svm, a.admin, [issue(foreign, TOKEN_2022)]))).toBe(6002);
    expect(customError(await send(a.svm, a.admin, [issue(await a.ata(alice), SYSTEM_PROGRAM)]))).toBe(3008);
  });
});
