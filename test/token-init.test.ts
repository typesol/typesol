// Anchor's `init` / `init_if_needed` with `mint::` and `token::` constraints, as mint.create / vault.create, under
// SPL Token and Token-2022; and SystemAccount.
import * as spl from "@solana-program/token";
import * as t22 from "@solana-program/token-2022";
import { type Address, generateKeyPairSigner } from "@solana/kit";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  BN,
  SYSTEM_PROGRAM,
  TOKEN_2022,
  TOKEN_PROGRAM,
  acct,
  customError,
  deployFile,
  expectOk,
  fundedSigner,
  ix,
  pda,
  send,
  type Deployed,
} from "./harness.js";

describe("mint.create / vault.create (Anchor init + mint:: / token::)", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("./fixtures/token-init.ts", import.meta.url)));
  });

  for (const [label, program] of [
    ["SPL Token", TOKEN_PROGRAM],
    ["Token-2022", TOKEN_2022],
  ] as const) {
    it(`creates PDA mints and self-owned PDA vaults, idempotently with createIfNeeded (${label})`, async () => {
      const payer = await fundedSigner(d.svm);
      const P = { address: payer.address, signer: payer, writable: true };
      const [auth] = await pda(d.programId, ["auth"]);
      const [mint] = await pda(d.programId, ["mint", payer.address]);
      const [vault] = await pda(d.programId, ["vault", mint]);
      const tail = [{ address: program }, { address: SYSTEM_PROGRAM }];
      const res = expectOk(await send(d.svm, payer, [ix(d, "make_mint", { decimals: 6 }, [P, { address: mint, writable: true }, { address: auth }, ...tail])]));
      const [, bump] = await pda(d.programId, ["mint", payer.address]);
      expect(Buffer.from(res.returnData().data())[0]).toBe(bump);
      const m = acct(d.svm, mint);
      expect(m.programAddress).toBe(program);
      const decodedMint = (program === TOKEN_PROGRAM ? spl.getMintDecoder() : t22.getMintDecoder()).decode(m.data);
      expect(decodedMint.decimals).toBe(6);
      expect(decodedMint.mintAuthority).toEqual({ __option: "Some", value: auth });
      expect(decodedMint.freezeAuthority).toEqual({ __option: "None" });
      // A second create fails: the account exists (3000).
      expect(
        customError(await send(d.svm, payer, [ix(d, "make_mint", { decimals: 6 }, [P, { address: mint, writable: true }, { address: auth }, ...tail])])),
      ).toBe(3000);

      expectOk(await send(d.svm, payer, [ix(d, "make_vault", {}, [P, { address: mint }, { address: vault, writable: true }, ...tail])]));
      const v = (program === TOKEN_PROGRAM ? spl.getTokenDecoder() : t22.getTokenDecoder()).decode(acct(d.svm, vault).data);
      expect([v.mint, v.owner, v.amount]).toEqual([mint, vault, 0n]);

      // init_if_needed: the existing vault is accepted when it matches, refused when its owner does not (2015).
      const ensure = (owner: Address) =>
        send(d.svm, payer, [ix(d, "ensure_vault", {}, [P, { address: mint }, { address: vault, writable: true }, { address: owner }, ...tail])]);
      expect(
        Buffer.from(
          expectOk(await ensure(vault))
            .returnData()
            .data(),
        )[0],
      ).toBe(0); // existed
      expect(customError(await ensure(payer.address))).toBe(2015);

      // init_if_needed on the mint: same decimals and authorities pass, others fail (2018 decimals, 2017 freeze).
      const ensureMint = (name: string, decimals: number) =>
        send(d.svm, payer, [ix(d, name, { decimals }, [P, { address: mint, writable: true }, { address: auth }, ...tail])]);
      expect(
        Buffer.from(
          expectOk(await ensureMint("ensure_mint", 6))
            .returnData()
            .data(),
        )[0],
      ).toBe(0);
      expect(customError(await ensureMint("ensure_mint", 9))).toBe(2018);
      expect(customError(await ensureMint("ensure_frozen_mint", 6))).toBe(2017);

      // ... and creates when missing: a fresh payer's mint and vault.
      const other = await fundedSigner(d.svm);
      const O = { address: other.address, signer: other, writable: true };
      const [mint2] = await pda(d.programId, ["mint", other.address]);
      const [vault2] = await pda(d.programId, ["vault", mint2]);
      const created = expectOk(
        await send(d.svm, other, [ix(d, "ensure_mint", { decimals: 2 }, [O, { address: mint2, writable: true }, { address: auth }, ...tail])]),
      );
      expect(Buffer.from(created.returnData().data())[0]).toBe(1);
      const c2 = expectOk(
        await send(d.svm, other, [
          ix(d, "ensure_vault", {}, [O, { address: mint2 }, { address: vault2, writable: true }, { address: other.address }, ...tail]),
        ]),
      );
      expect(Buffer.from(c2.returnData().data())[0]).toBe(1);
      expect((program === TOKEN_PROGRAM ? spl.getTokenDecoder() : t22.getTokenDecoder()).decode(acct(d.svm, vault2).data).owner).toBe(other.address);
    });
  }

  it("init_if_needed with extensions: creates them, then checks an existing mint as Anchor does (2030 / 2032)", async () => {
    const payer = await fundedSigner(d.svm);
    const [mint] = await pda(d.programId, ["ext", payer.address]);
    const target = (await generateKeyPairSigner()).address;
    const run = (pointsTo: Address) =>
      send(d.svm, payer, [
        ix(d, "ext_mint", {}, [
          { address: payer.address, signer: payer, writable: true },
          { address: mint, writable: true },
          { address: pointsTo },
          { address: TOKEN_2022 },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    expect(
      Buffer.from(
        expectOk(await run(target))
          .returnData()
          .data(),
      )[0],
    ).toBe(1);
    const m = t22.getMintDecoder().decode(acct(d.svm, mint).data);
    const kinds = (m.extensions as { value: { __kind: string }[] }).value.map((e) => e.__kind).sort();
    expect(kinds).toEqual(["MetadataPointer", "MintCloseAuthority"]);
    d.svm.expireBlockhash();
    expect(
      Buffer.from(
        expectOk(await run(target))
          .returnData()
          .data(),
      )[0],
    ).toBe(0);
    // Another metadata address: ConstraintMintMetadataPointerExtensionMetadataAddress.
    expect(customError(await run((await generateKeyPairSigner()).address))).toBe(2032);

    // A mint at that address without the extensions: ConstraintMintMetadataPointerExtension.
    const other = await fundedSigner(d.svm);
    const [plain] = await pda(d.programId, ["ext", other.address]);
    const accounts = [
      { address: other.address, signer: other, writable: true },
      { address: plain, writable: true },
      { address: TOKEN_2022 },
      { address: SYSTEM_PROGRAM },
    ];
    expectOk(await send(d.svm, other, [ix(d, "plain_ext_mint", {}, accounts)]));
    const ext = await send(d.svm, other, [ix(d, "ext_mint", {}, [accounts[0]!, accounts[1]!, { address: target }, accounts[2]!, accounts[3]!])]);
    expect(customError(ext)).toBe(2030);
  });

  it("MintOf<Mint, \"auth\">: Anchor's mint::authority naming the parameter (2016)", async () => {
    const payer = await fundedSigner(d.svm);
    const [mint] = await pda(d.programId, ["ext", payer.address]);
    const create = [
      { address: payer.address, signer: payer, writable: true },
      { address: mint, writable: true },
      { address: TOKEN_2022 },
      { address: SYSTEM_PROGRAM },
    ];
    expectOk(await send(d.svm, payer, [ix(d, "plain_ext_mint", {}, create)]));
    const check = (auth: Address) => send(d.svm, payer, [ix(d, "check_mint", {}, [{ address: mint }, { address: auth }])]);
    expectOk(await check(payer.address));
    expect(customError(await check((await generateKeyPairSigner()).address))).toBe(2016);
  });

  it("creates a new keypair mint, which must sign", async () => {
    const payer = await fundedSigner(d.svm);
    const mint = await generateKeyPairSigner();
    const accounts = (signer: boolean) => [
      { address: payer.address, signer: payer, writable: true },
      signer ? { address: mint.address, signer: mint, writable: true } : { address: mint.address, writable: true },
      { address: TOKEN_PROGRAM },
      { address: SYSTEM_PROGRAM },
    ];
    expect(customError(await send(d.svm, payer, [ix(d, "keypair_mint", {}, accounts(false))]))).toBe(3010);
    const res = expectOk(await send(d.svm, payer, [ix(d, "keypair_mint", {}, accounts(true))]));
    expect(Buffer.from(res.returnData().data())[0]).toBe(0);
    const m = spl.getMintDecoder().decode(acct(d.svm, mint.address).data);
    expect([m.decimals, m.mintAuthority, m.freezeAuthority]).toEqual([
      9,
      { __option: "Some", value: payer.address },
      { __option: "Some", value: payer.address },
    ]);
    // The IDL marks the keypair account as a signer, PDA ones with their seeds.
    const ixs = d.idl.instructions as unknown as { name: string; accounts: { name: string; signer?: boolean; pda?: unknown }[] }[];
    expect(ixs.find((i) => i.name === "keypair_mint")!.accounts.find((a) => a.name === "mint")!.signer).toBe(true);
    expect(ixs.find((i) => i.name === "make_vault")!.accounts.find((a) => a.name === "vault")!.pda).toBeDefined();
  });

  it("SystemAccount refuses an account another program owns (3011)", async () => {
    const payer = await fundedSigner(d.svm);
    const [mint] = await pda(d.programId, ["mint", payer.address]);
    const [auth] = await pda(d.programId, ["auth"]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "make_mint", { decimals: 0 }, [
          { address: payer.address, signer: payer, writable: true },
          { address: mint, writable: true },
          { address: auth },
          { address: TOKEN_PROGRAM },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const tip = (to: Address) =>
      send(d.svm, payer, [
        ix(d, "tip", { amount: new BN(1_000_000) }, [
          { address: payer.address, signer: payer, writable: true },
          { address: to, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    expectOk(await tip((await generateKeyPairSigner()).address));
    expect(customError(await tip(mint))).toBe(3011);
  });
});
