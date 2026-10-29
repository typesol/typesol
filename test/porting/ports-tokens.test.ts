// Ports of the tokens/ Anchor programs of solana-developers/program-examples that run without Metaplex: each describe
// runs the flows of the original's TypeScript tests against the TypeSOL rewrite under test/ports/tokens/. Status and
// reasons per program: test/ports/README.md.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { getMintDecoder } from "@solana-program/token";
import { type Address, generateKeyPairSigner, getAddressDecoder, getU64Encoder, isOffCurveAddress, none } from "@solana/kit";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ATA_PROGRAM,
  BN,
  SYSTEM_PROGRAM,
  TOKEN_2022,
  TOKEN_PROGRAM,
  acct,
  customError,
  decodeAccount,
  expectOk,
  fundedSigner,
  ix,
  pda,
  send,
} from "../harness.js";
import { addrBytes, ataOf, createMint, deployPort, fundAta, pk, tokenBalance } from "../ports-helpers.js";

const le64 = (n: bigint) => new Uint8Array(getU64Encoder().encode(n));

describe("port: tokens/escrow", () => {
  it.each([
    ["SPL Token", TOKEN_PROGRAM],
    ["Token-2022", TOKEN_2022],
  ])("makes, takes and refunds offers (%s mints), and refuses a non-maker refund", async (_, tokenProgram) => {
    const d = await deployPort("tokens/escrow.ts", "3o3jk7aj2aGCGsbChkgeNdHcBmeEmGA7BtpnTXdVSgtr");
    const { svm } = d;
    const alice = await fundedSigner(svm);
    const bob = await fundedSigner(svm);
    const mintA = await createMint(svm, alice, { tokenProgram, decimals: 6 });
    const mintB = await createMint(svm, bob, { tokenProgram, decimals: 6 });
    const aliceA = await fundAta(svm, alice, alice.address, mintA, 1_000_000_000n, { tokenProgram });
    const bobB = await fundAta(svm, bob, bob.address, mintB, 1_000_000_000n, { tokenProgram });
    // Bob's A account and Alice's B account do not exist yet: take_offer creates them (init_if_needed).
    const bobA = await ataOf(bob.address, mintA, tokenProgram);
    const aliceB = await ataOf(alice.address, mintB, tokenProgram);

    let nextId = 1n;
    const make = async () => {
      const id = nextId++;
      const [offer] = await pda(d.programId, ["offer", alice.address, le64(id)]);
      const vault = await ataOf(offer, mintA, tokenProgram);
      expectOk(
        await send(svm, alice, [
          ix(d, "make_offer", { id: new BN(id.toString()), token_a_offered_amount: new BN(1_000_000), token_b_wanted_amount: new BN(2_000_000) }, [
            { address: alice.address, signer: alice, writable: true },
            { address: mintA },
            { address: mintB },
            { address: aliceA, writable: true },
            { address: offer, writable: true },
            { address: vault, writable: true },
            { address: ATA_PROGRAM },
            { address: tokenProgram },
            { address: SYSTEM_PROGRAM },
          ]),
        ]),
      );
      expect(tokenBalance(svm, vault)).toBe(1_000_000n);
      const o = decodeAccount<{ maker: { toBase58(): string }; token_mint_a: { toBase58(): string }; token_b_wanted_amount: BN }>(d, svm, "Offer", offer);
      expect(o.maker.toBase58()).toBe(alice.address);
      expect(o.token_mint_a.toBase58()).toBe(mintA);
      expect(o.token_b_wanted_amount.toString()).toBe("2000000");
      return { offer, vault };
    };
    const refund = (who: typeof alice, whoA: Address, offer: Address, vault: Address) =>
      send(svm, who, [
        ix(d, "refund_offer", {}, [
          { address: who.address, signer: who, writable: true },
          { address: mintA },
          { address: whoA, writable: true },
          { address: offer, writable: true },
          { address: vault, writable: true },
          { address: tokenProgram },
        ]),
      ]);

    const first = await make();
    expectOk(
      await send(svm, bob, [
        ix(d, "take_offer", {}, [
          { address: bob.address, signer: bob, writable: true },
          { address: alice.address, writable: true },
          { address: mintA },
          { address: mintB },
          { address: bobA, writable: true },
          { address: bobB, writable: true },
          { address: aliceB, writable: true },
          { address: first.offer, writable: true },
          { address: first.vault, writable: true },
          { address: ATA_PROGRAM },
          { address: tokenProgram },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    expect(tokenBalance(svm, bobA)).toBe(1_000_000n);
    expect(tokenBalance(svm, aliceB)).toBe(2_000_000n);
    expect(svm.getAccount(first.offer).exists).toBe(false);
    expect(svm.getAccount(first.vault).exists).toBe(false);

    const second = await make();
    const before = tokenBalance(svm, aliceA)!;
    // Bob claims to be the maker: the offer PDA is not derived from him. Seeds are checked before has_one, as in
    // Anchor, so it fails as Anchor's does (2006).
    await fundAta(svm, bob, bob.address, mintA, 0n, { tokenProgram });
    expect(customError(await refund(bob, bobA, second.offer, second.vault))).toBe(2006);
    expectOk(await refund(alice, aliceA, second.offer, second.vault));
    expect(tokenBalance(svm, aliceA)).toBe(before + 1_000_000n);
    expect(svm.getAccount(second.offer).exists).toBe(false);
    expect(svm.getAccount(second.vault).exists).toBe(false);
  });
});

describe("port: tokens/token-fundraiser", () => {
  it("runs a campaign to its deadline and refunds, and pays out one that met its target", async () => {
    const d = await deployPort("tokens/token-fundraiser.ts", "Eoiuq1dXvHxh6dLx3wh9gj8kSAUpga11krTrbfF5XYsC");
    const { svm } = d;
    const DAY = 86_400n;
    const wallet = await fundedSigner(svm);
    const maker = await fundedSigner(svm);
    const mint = await createMint(svm, wallet, { decimals: 6 });
    const contributorAta = await fundAta(svm, wallet, wallet.address, mint, 10_000_000n);
    const makerAta = await ataOf(maker.address, mint);
    const [fundraiser] = await pda(d.programId, ["fundraiser", maker.address]);
    const vault = await ataOf(fundraiser, mint);
    const [contributor] = await pda(d.programId, ["contributor", fundraiser, wallet.address]);

    const initialize = (m: typeof maker, f: Address, v: Address, amount: number, duration: number) =>
      send(svm, m, [
        ix(d, "initialize", { amount: new BN(amount), duration }, [
          { address: m.address, signer: m, writable: true },
          { address: mint },
          { address: f, writable: true },
          { address: v, writable: true },
          { address: SYSTEM_PROGRAM },
          { address: TOKEN_PROGRAM },
          { address: ATA_PROGRAM },
        ]),
      ]);
    const contribute = (who: typeof wallet, whoAta: Address, f: Address, v: Address, amount: number) =>
      send(svm, who, [
        ix(d, "contribute", { amount: new BN(amount) }, [
          { address: who.address, signer: who, writable: true },
          { address: mint },
          { address: f, writable: true },
          { address: pdaSync(f, who.address), writable: true },
          { address: whoAta, writable: true },
          { address: v, writable: true },
          { address: TOKEN_PROGRAM },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    const contributorPdas = new Map<string, Address>();
    const pdaSync = (f: Address, who: Address) => contributorPdas.get(`${f}:${who}`)!;
    const remember = async (f: Address, who: Address) => contributorPdas.set(`${f}:${who}`, (await pda(d.programId, ["contributor", f, who]))[0]);
    const check = (m: typeof maker, mintToRaise: Address, f: Address, v: Address, mAta: Address) =>
      send(svm, m, [
        ix(d, "check_contributions", {}, [
          { address: m.address, signer: m, writable: true },
          { address: mintToRaise },
          { address: f, writable: true },
          { address: v, writable: true },
          { address: mAta, writable: true },
          { address: TOKEN_PROGRAM },
          { address: SYSTEM_PROGRAM },
          { address: ATA_PROGRAM },
        ]),
      ]);
    const refund = () =>
      send(svm, wallet, [
        ix(d, "refund", {}, [
          { address: wallet.address, signer: wallet, writable: true },
          { address: maker.address },
          { address: mint },
          { address: fundraiser, writable: true },
          { address: contributor, writable: true },
          { address: contributorAta, writable: true },
          { address: vault, writable: true },
          { address: TOKEN_PROGRAM },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);

    // A target below 3^decimals is refused.
    expect(customError(await initialize(maker, fundraiser, vault, 700, 1))).toBe(6007);
    expectOk(await initialize(maker, fundraiser, vault, 30_000_000, 1));
    await remember(fundraiser, wallet.address);
    expectOk(await contribute(wallet, contributorAta, fundraiser, vault, 1_000_000));
    expectOk(await contribute(wallet, contributorAta, fundraiser, vault, 1_000_000));
    expect(decodeAccount<{ amount: BN }>(d, svm, "Contributor", contributor).amount.toString()).toBe("2000000");
    // Over the 10% per-contributor cap.
    expect(customError(await contribute(wallet, contributorAta, fundraiser, vault, 2_000_000))).toBe(6004);
    expect(customError(await refund())).toBe(6005);
    expect(customError(await check(maker, mint, fundraiser, vault, makerAta))).toBe(6000);
    // check_contributions is bound to the recorded mint.
    const fakeMint = await createMint(svm, maker, { decimals: 6 });
    expect(customError(await check(maker, fakeMint, fundraiser, vault, await ataOf(maker.address, fakeMint)))).toBe(2001);
    // At the deadline contributions close and refunds open.
    const f = decodeAccount<{ time_started: BN; duration: number }>(d, svm, "Fundraiser", fundraiser);
    const clock = svm.getClock();
    clock.unixTimestamp = BigInt(f.time_started.toString()) + BigInt(f.duration) * DAY;
    svm.setClock(clock);
    expect(customError(await contribute(wallet, contributorAta, fundraiser, vault, 1_000_000))).toBe(6006);
    expectOk(await refund());
    expect(tokenBalance(svm, vault)).toBe(0n);
    expect(tokenBalance(svm, contributorAta)).toBe(10_000_000n);
    expect(svm.getAccount(contributor).exists).toBe(false);

    // A second campaign that meets its target pays the maker (whose ATA is created on the way).
    const maker2 = await fundedSigner(svm);
    const [fundraiser2] = await pda(d.programId, ["fundraiser", maker2.address]);
    const vault2 = await ataOf(fundraiser2, mint);
    expectOk(await initialize(maker2, fundraiser2, vault2, 1_000, 7));
    for (let i = 0; i < 10; i++) {
      const who = await fundedSigner(svm);
      const whoAta = await fundAta(svm, wallet, who.address, mint, 100n);
      await remember(fundraiser2, who.address);
      expectOk(await contribute(who, whoAta, fundraiser2, vault2, 100));
    }
    const maker2Ata = await ataOf(maker2.address, mint);
    expectOk(await check(maker2, mint, fundraiser2, vault2, maker2Ata));
    expect(tokenBalance(svm, maker2Ata)).toBe(1_000n);
    expect(svm.getAccount(fundraiser2).exists).toBe(false);
  });
});

describe("port: tokens/token-swap", () => {
  const SUPPLY = 100_000_000n;
  async function setup() {
    const d = await deployPort("tokens/token-swap/lib.ts", "UPxp2moQFWsGqfFd3ynqG2W9mj9CTjH68NN2bYUAqV1");
    const { svm } = d;
    const admin = await fundedSigner(svm);
    const id = (await generateKeyPairSigner()).address;
    const [amm] = await pda(d.programId, [id]);
    const mintA = await createMint(svm, admin);
    const mintB = await createMint(svm, admin);
    const holderA = await fundAta(svm, admin, admin.address, mintA, SUPPLY);
    const holderB = await fundAta(svm, admin, admin.address, mintB, SUPPLY);
    const [pool] = await pda(d.programId, [amm, mintA, mintB]);
    const [authority] = await pda(d.programId, [amm, mintA, mintB, "authority"]);
    const [mintLiquidity] = await pda(d.programId, [amm, mintA, mintB, "liquidity"]);
    const poolA = await ataOf(authority, mintA);
    const poolB = await ataOf(authority, mintB);
    const liquidityAccount = await ataOf(admin.address, mintLiquidity);
    const createAmm = (fee: number) =>
      send(svm, admin, [
        ix(d, "create_amm", { id: pk(id), fee }, [
          { address: amm, writable: true },
          { address: admin.address },
          { address: admin.address, signer: admin, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    const createPool = (b = mintB, accountB = poolB) =>
      send(svm, admin, [
        ix(d, "create_pool", {}, [
          { address: amm },
          { address: pool, writable: true },
          { address: authority },
          { address: mintLiquidity, writable: true },
          { address: mintA },
          { address: b },
          { address: poolA, writable: true },
          { address: accountB, writable: true },
          { address: admin.address, signer: admin, writable: true },
          { address: TOKEN_PROGRAM },
          { address: ATA_PROGRAM },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    const deposit = (a: bigint, b: bigint) =>
      send(svm, admin, [
        ix(d, "deposit_liquidity", { amount_a: new BN(a.toString()), amount_b: new BN(b.toString()) }, [
          { address: pool },
          { address: authority },
          { address: admin.address, signer: admin },
          { address: mintLiquidity, writable: true },
          { address: mintA },
          { address: mintB },
          { address: poolA, writable: true },
          { address: poolB, writable: true },
          { address: liquidityAccount, writable: true },
          { address: holderA, writable: true },
          { address: holderB, writable: true },
          { address: admin.address, signer: admin, writable: true },
          { address: TOKEN_PROGRAM },
          { address: ATA_PROGRAM },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    type Alt = { authority?: Address; poolA?: Address; poolB?: Address };
    const swap = (swapA: boolean, input: bigint, minOut: bigint, alt: Alt = {}) =>
      send(svm, admin, [
        ix(d, "swap_exact_tokens_for_tokens", { swap_a: swapA, input_amount: new BN(input.toString()), min_output_amount: new BN(minOut.toString()) }, [
          { address: amm },
          { address: pool },
          { address: alt.authority ?? authority },
          { address: admin.address, signer: admin },
          { address: mintA },
          { address: mintB },
          { address: alt.poolA ?? poolA, writable: true },
          { address: alt.poolB ?? poolB, writable: true },
          { address: holderA, writable: true },
          { address: holderB, writable: true },
          { address: admin.address, signer: admin, writable: true },
          { address: TOKEN_PROGRAM },
          { address: ATA_PROGRAM },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    const withdraw = (amount: bigint, alt: Alt = {}) =>
      send(svm, admin, [
        ix(d, "withdraw_liquidity", { amount: new BN(amount.toString()) }, [
          { address: amm },
          { address: pool },
          { address: alt.authority ?? authority },
          { address: admin.address, signer: admin },
          { address: mintLiquidity, writable: true },
          { address: mintA, writable: true },
          { address: mintB, writable: true },
          { address: alt.poolA ?? poolA, writable: true },
          { address: alt.poolB ?? poolB, writable: true },
          { address: liquidityAccount, writable: true },
          { address: holderA, writable: true },
          { address: holderB, writable: true },
          { address: admin.address, signer: admin, writable: true },
          { address: TOKEN_PROGRAM },
          { address: ATA_PROGRAM },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    return { d, svm, admin, amm, mintA, mintB, poolA, poolB, holderA, holderB, liquidityAccount, createAmm, createPool, deposit, swap, withdraw };
  }

  it("creates an AMM (fee below 100%) and a pool (two distinct mints)", async () => {
    const s = await setup();
    expect(customError(await s.createAmm(10_000))).toBe(6000);
    expectOk(await s.createAmm(500));
    const amm = decodeAccount<{ id: { toBase58(): string }; admin: { toBase58(): string }; fee: number }>(s.d, s.svm, "Amm", s.amm);
    expect(amm.admin.toBase58()).toBe(s.admin.address);
    expect(amm.fee).toBe(500);
    // The same mint on both sides: its pool vault would be one account.
    expect(customError(await s.createPool(s.mintA, s.poolA))).toBe(2040);
    expectOk(await s.createPool());
    expect(tokenBalance(s.svm, s.poolA)).toBe(0n);
  });

  it("deposits at the pool ratio, swaps both ways, and withdraws everything", async () => {
    const s = await setup();
    expectOk(await s.createAmm(500));
    expectOk(await s.createPool());
    // The first deposit sets the ratio and locks MINIMUM_LIQUIDITY.
    expectOk(await s.deposit(1_000_000n, 5_000_000n));
    expect(tokenBalance(s.svm, s.liquidityAccount)).toBe(isqrtBig(1_000_000n * 5_000_000n) - 100n);
    // A later deposit takes the full B amount and the matching A.
    expectOk(await s.deposit(500_000n, 500_000n));
    expect(tokenBalance(s.svm, s.poolA)).toBe(1_100_000n);
    expect(tokenBalance(s.svm, s.poolB)).toBe(5_500_000n);

    const quote = (input: bigint, reserveIn: bigint, reserveOut: bigint) => {
      const taxed = input - (input * 500n) / 10_000n;
      return (taxed * reserveOut) / (reserveIn + taxed);
    };
    // Asking for more than the curve gives reverts with OutputTooSmall.
    expect(customError(await s.swap(true, 100_000n, quote(100_000n, 1_100_000n, 5_500_000n) + 1n))).toBe(6003);
    const a0 = tokenBalance(s.svm, s.holderA)!;
    const b0 = tokenBalance(s.svm, s.holderB)!;
    const outB = quote(100_000n, 1_100_000n, 5_500_000n);
    expectOk(await s.swap(true, 100_000n, 100n));
    expect(tokenBalance(s.svm, s.holderA)).toBe(a0 - 100_000n);
    expect(tokenBalance(s.svm, s.holderB)).toBe(b0 + outB);
    const outA = quote(300_000n, 5_500_000n - outB, 1_200_000n);
    expectOk(await s.swap(false, 300_000n, 100n));
    expect(tokenBalance(s.svm, s.holderA)).toBe(a0 - 100_000n + outA);
    const [, bump] = await pda(s.d.programId, [s.amm, s.mintA, s.mintB, "authority"]);
    // A non-canonical authority PDA with vaults someone funded is refused too (Anchor's find_program_address check).
    const fake = await nonCanonicalPda(s.d.programId, [addrBytes(s.amm), addrBytes(s.mintA), addrBytes(s.mintB), Buffer.from("authority")], bump);
    const alt = {
      ...fake,
      poolA: await fundAta(s.svm, s.admin, fake.authority, s.mintA, 10n),
      poolB: await fundAta(s.svm, s.admin, fake.authority, s.mintB, 10n),
    };
    expect(customError(await s.swap(true, 1_000n, 1n, alt))).toBe(2006);
    expect(customError(await s.withdraw(1n, alt))).toBe(2006);

    const lp = tokenBalance(s.svm, s.liquidityAccount)!;
    expectOk(await s.withdraw(lp));
    expect(tokenBalance(s.svm, s.liquidityAccount)).toBe(0n);
    // Everything but the locked minimum liquidity's share comes back.
    expect(tokenBalance(s.svm, s.poolA)! > 0n && tokenBalance(s.svm, s.poolA)! < 1_000n).toBe(true);
    expect(tokenBalance(s.svm, s.holderA)! > SUPPLY - 1_000n).toBe(true);
  });
});

/** The PDA of `seeds` with the highest bump below `canonical` that is off the curve (a valid, non-canonical PDA). */
async function nonCanonicalPda(programId: Address, seeds: Uint8Array[], canonical: number): Promise<{ authority: Address; bump: number }> {
  for (let b = canonical - 1; b >= 0; b--) {
    const hash = createHash("sha256")
      .update(Buffer.concat([...seeds, Buffer.from([b]), addrBytes(programId), Buffer.from("ProgramDerivedAddress")]))
      .digest();
    const candidate = getAddressDecoder().decode(hash);
    if (isOffCurveAddress(candidate)) return { authority: candidate, bump: b };
  }
  throw new Error("no second PDA bump");
}

function isqrtBig(n: bigint): bigint {
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}

describe("port: tokens/external-delegate-token-master", () => {
  const keccak = (...parts: Uint8Array[]) => Buffer.from(keccak_256(Buffer.concat(parts)));
  const u64le = (n: bigint) => Buffer.from(le64(n));

  it("transfers with the authority or with a bound, non-replayable Ethereum signature", async () => {
    const d = await deployPort("tokens/external-delegate-token-master.ts", "FYPkt5VWMvtyWZDMGCwoKFkE3wXTzphicTpnNGuHWVbD");
    const { svm } = d;
    const authority = await fundedSigner(svm);
    const userAccount = await generateKeyPairSigner();
    expectOk(
      await send(svm, authority, [
        ix(d, "initialize", {}, [
          { address: userAccount.address, signer: userAccount, writable: true },
          { address: authority.address, signer: authority, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const ethKey = secp256k1.utils.randomSecretKey();
    const ethAddress = (key: Uint8Array) => Buffer.concat([Buffer.alloc(12), keccak(secp256k1.getPublicKey(key, false).slice(1)).subarray(12)]);
    expectOk(
      await send(svm, authority, [
        ix(d, "set_ethereum_address", { ethereum_address: [...ethAddress(ethKey)] }, [
          { address: userAccount.address, writable: true },
          { address: authority.address, signer: authority },
        ]),
      ]),
    );
    const [userPda] = await pda(d.programId, [userAccount.address]);
    const mint = await createMint(svm, authority);
    const userToken = await fundAta(svm, authority, userPda, mint, 1_000n);
    const recipient = await fundedSigner(svm, 1n);
    const recipientToken = await fundAta(svm, authority, recipient.address, mint, 0n);
    const accounts = [
      { address: userAccount.address, writable: true },
      { address: authority.address, signer: authority },
      { address: userToken, writable: true },
      { address: recipientToken, writable: true },
      { address: userPda },
      { address: TOKEN_PROGRAM },
    ];

    expectOk(await send(svm, authority, [ix(d, "authority_transfer", { amount: new BN(100) }, accounts)]));
    expect(tokenBalance(svm, recipientToken)).toBe(100n);

    const nonce = () => BigInt(decodeAccount<{ nonce: BN }>(d, svm, "UserAccount", userAccount.address).nonce.toString());
    const sign = (amount: bigint, n: bigint, key = ethKey) => {
      const digest = keccak(
        Buffer.from("external-delegate-token-master:transfer_tokens:v1"),
        addrBytes(d.programId),
        addrBytes(userAccount.address),
        addrBytes(userToken),
        addrBytes(recipientToken),
        u64le(amount),
        u64le(n),
      );
      const sig = secp256k1.sign(digest, key, { prehash: false, format: "recovered" });
      return { recovery_id: sig[0], r: [...sig.slice(1, 33)], s: [...sig.slice(33, 65)] };
    };
    const transfer = (amount: bigint, sig: ReturnType<typeof sign>) =>
      send(svm, authority, [ix(d, "transfer_tokens", { amount: new BN(amount.toString()), ...sig }, accounts)]);

    const good = sign(250n, nonce());
    expectOk(await transfer(250n, good));
    expect(tokenBalance(svm, recipientToken)).toBe(350n);
    expect(nonce()).toBe(1n);
    // The same signature after the nonce moved on.
    expect(customError(await transfer(250n, good))).toBe(6000);
    // A valid signature for another amount.
    expect(customError(await transfer(251n, sign(250n, nonce())))).toBe(6000);
    // A correctly bound digest signed by a key that is not registered.
    expect(customError(await transfer(10n, sign(10n, nonce(), secp256k1.utils.randomSecretKey())))).toBe(6000);
    expect(tokenBalance(svm, recipientToken)).toBe(350n);
    // Only the recorded authority may change the address.
    const intruder = await fundedSigner(svm);
    expect(
      customError(
        await send(svm, intruder, [
          ix(d, "set_ethereum_address", { ethereum_address: [...ethAddress(ethKey)] }, [
            { address: userAccount.address, writable: true },
            { address: intruder.address, signer: intruder },
          ]),
        ]),
      ),
    ).toBe(2001);
  });
});

describe("port: tokens/merkle-tree-token-claimer", () => {
  const sha = (...parts: Uint8Array[]) => createHash("sha256").update(Buffer.concat(parts)).digest();
  const ZERO = Buffer.alloc(32);
  /** sha256 leaves, sha256(left || right) pairs, odd levels padded with a zero hash (as the original's tests). */
  function tree(leaves: Buffer[]) {
    const levels: Buffer[][] = [leaves.map((l) => sha(l))];
    while (levels[levels.length - 1].length > 1) {
      const level = levels[levels.length - 1];
      const next: Buffer[] = [];
      for (let i = 0; i < level.length; i += 2) next.push(sha(level[i], level[i + 1] ?? ZERO));
      levels.push(next);
    }
    const proof = (index: number) => {
      const out: Buffer[] = [];
      for (let depth = 0; depth < levels.length - 1; depth++) {
        out.push(levels[depth][index % 2 === 0 ? index + 1 : index - 1] ?? ZERO);
        index = Math.floor(index / 2);
      }
      return Buffer.concat(out);
    };
    return { root: levels[levels.length - 1][0], proof };
  }

  it("locks the mint, pays proven claims once, and freezes the root after the first claim", async () => {
    const d = await deployPort("tokens/merkle-tree-token-claimer.ts", "GTCPuHiGookQVSAgGc7CzBiFYPytjVAq6vdCV3NnZoHa");
    const { svm } = d;
    const authority = await fundedSigner(svm);
    const claimants = [await fundedSigner(svm), await fundedSigner(svm), await fundedSigner(svm)];
    const amounts = [100n, 250n, 400n];
    const leaf = (i: number) => Buffer.concat([addrBytes(claimants[i].address), Buffer.from(le64(amounts[i]))]);
    const t = tree([0, 1, 2].map(leaf));
    const mint = await generateKeyPairSigner();
    const [state] = await pda(d.programId, ["merkle_tree", mint.address]);
    const vault = await ataOf(state, mint.address);

    const init = (amount: bigint) =>
      send(svm, authority, [
        ix(d, "initialize_airdrop_data", { merkle_root: [...ZERO], amount: new BN(amount.toString()) }, [
          { address: state, writable: true },
          { address: mint.address, signer: mint, writable: true },
          { address: vault, writable: true },
          { address: authority.address, signer: authority, writable: true },
          { address: SYSTEM_PROGRAM },
          { address: TOKEN_PROGRAM },
          { address: ATA_PROGRAM },
        ]),
      ]);
    expect(customError(await init(0n))).toBe(6005);
    expectOk(await init(750n));
    expect(tokenBalance(svm, vault)).toBe(750n);
    expect(getMintDecoder().decode(acct(svm, mint.address).data).mintAuthority).toEqual(none());

    const updateRoot = (root: Buffer) =>
      send(svm, authority, [
        ix(d, "update_tree", { new_root: [...root] }, [
          { address: state, writable: true },
          { address: mint.address },
          { address: authority.address, signer: authority },
        ]),
      ]);
    expectOk(await updateRoot(t.root));

    const claim = async (who: (typeof claimants)[number], amount: bigint, proof: Buffer, index: number) => {
      const [receipt] = await pda(d.programId, ["claim_receipt", state, le64(BigInt(index))]);
      return send(svm, who, [
        ix(d, "claim_airdrop", { amount: new BN(amount.toString()), hashes: proof, index: new BN(index) }, [
          { address: state, writable: true },
          { address: mint.address },
          { address: vault, writable: true },
          { address: receipt, writable: true },
          { address: await ataOf(who.address, mint.address), writable: true },
          { address: who.address, signer: who, writable: true },
          { address: SYSTEM_PROGRAM },
          { address: TOKEN_PROGRAM },
          { address: ATA_PROGRAM },
        ]),
      ]);
    };
    expectOk(await claim(claimants[0], 100n, t.proof(0), 0));
    expect(tokenBalance(svm, await ataOf(claimants[0].address, mint.address))).toBe(100n);
    const [receipt0] = await pda(d.programId, ["claim_receipt", state, le64(0n)]);
    const r = decodeAccount<{ claimer: { toBase58(): string }; amount: BN; index: BN }>(d, svm, "ClaimReceipt", receipt0);
    expect([r.claimer.toBase58(), r.amount.toString(), r.index.toString()]).toEqual([claimants[0].address, "100", "0"]);
    // Twice: the receipt exists.
    expect(customError(await claim(claimants[0], 100n, t.proof(0), 0))).toBe(6001);
    // Someone else's proof: the leaf is built from the signer.
    expect(customError(await claim(claimants[0], 400n, t.proof(2), 2))).toBe(6000);
    // The last leaf is paired with a zero hash: its proof does not verify at index 3, nor above the tree depth.
    expectOk(await claim(claimants[2], 400n, t.proof(2), 2));
    expect(customError(await claim(claimants[2], 400n, t.proof(2), 3))).toBe(6000);
    expect(customError(await claim(claimants[2], 400n, t.proof(2), 6))).toBe(6000);
    // A malformed proof length.
    expect(customError(await claim(claimants[1], 250n, t.proof(1).subarray(0, 40), 1))).toBe(6000);
    expect(customError(await updateRoot(ZERO))).toBe(6004);
    expectOk(await claim(claimants[1], 250n, t.proof(1), 1));
    expect(tokenBalance(svm, vault)).toBe(0n);
  });
});
