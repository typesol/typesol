import { AccountState, getMintEncoder, getMintSize, getTokenDecoder, getTokenEncoder, getTokenSize } from "@solana-program/token";
import { type Address, generateKeyPairSigner, getU64Encoder, lamports, none, some } from "@solana/kit";
import type { LiteSVM } from "litesvm";
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
} from "./harness.js";

const RENT = lamports(10_000_000n);

async function mint(svm: LiteSVM): Promise<Address> {
  const addr = (await generateKeyPairSigner()).address;
  const data = getMintEncoder().encode({ mintAuthority: none(), supply: 10n ** 12n, decimals: 6, isInitialized: true, freezeAuthority: none() });
  svm.setAccount({ address: addr, data: new Uint8Array(data), executable: false, lamports: RENT, programAddress: TOKEN_PROGRAM, space: BigInt(getMintSize()) });
  return addr;
}

async function tokenAccount(svm: LiteSVM, mintAddr: Address, owner: Address, amount: bigint): Promise<Address> {
  const addr = (await generateKeyPairSigner()).address;
  const data = getTokenEncoder().encode({
    mint: mintAddr,
    owner,
    amount,
    delegate: none(),
    state: AccountState.Initialized,
    isNative: none(),
    delegatedAmount: 0n,
    closeAuthority: none(),
  });
  svm.setAccount({
    address: addr,
    data: new Uint8Array(data),
    executable: false,
    lamports: RENT,
    programAddress: TOKEN_PROGRAM,
    space: BigInt(getTokenSize()),
  });
  return addr;
}

const balance = (svm: LiteSVM, a: Address) => {
  const acct = svm.getAccount(a);
  return acct.exists ? getTokenDecoder().decode(acct.data).amount : undefined;
};

describe("examples/escrow.ts", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployExample("escrow");
  });

  async function setup(seed: bigint) {
    const { svm } = d;
    const maker = await fundedSigner(svm);
    const taker = await fundedSigner(svm);
    const [mintA, mintB] = [await mint(svm), await mint(svm)];
    const [offer] = await pda(d.programId, ["offer", maker.address, new Uint8Array(getU64Encoder().encode(seed))]);
    const accts = {
      makerA: await tokenAccount(svm, mintA, maker.address, 1_000n),
      makerB: await tokenAccount(svm, mintB, maker.address, 0n),
      takerA: await tokenAccount(svm, mintA, taker.address, 0n),
      takerB: await tokenAccount(svm, mintB, taker.address, 500n),
      vault: await tokenAccount(svm, mintA, offer, 0n),
    };
    const makeIx = (over: Partial<{ vault: Address; amountA: number }> = {}) =>
      ix(
        d,
        "make",
        {
          seed: new BN(seed.toString()),
          amount_a: new BN(over.amountA ?? 400),
          want_b: new BN(250),
          mint_b: { toBuffer: () => Buffer.from(addrBytes(mintB)) },
        },
        [
          { address: maker.address, signer: maker, writable: true },
          { address: offer, writable: true },
          { address: accts.makerA, writable: true },
          { address: over.vault ?? accts.vault, writable: true },
          { address: SYSTEM_PROGRAM },
          { address: TOKEN_PROGRAM },
        ],
      );
    return { svm, maker, taker, mintA, mintB, offer, ...accts, makeIx };
  }

  it("escrows, swaps atomically, and cleans up", async () => {
    const s = await setup(1n);
    expectOk(await send(s.svm, s.maker, [s.makeIx()]));
    expect(balance(s.svm, s.vault)).toBe(400n);
    expect(balance(s.svm, s.makerA)).toBe(600n);
    const offerState = decodeAccount<{ amount_a?: BN; amountA?: BN; want_b?: BN; wantB?: BN }>(d, s.svm, "Offer", s.offer);
    expect((offerState.amountA ?? offerState.amount_a)!.toString()).toBe("400");

    const makerLamports = s.svm.getBalance(s.maker.address)!;
    expectOk(
      await send(s.svm, s.taker, [
        ix(d, "take", {}, [
          { address: s.taker.address, signer: s.taker, writable: true },
          { address: s.maker.address, writable: true },
          { address: s.offer, writable: true },
          { address: s.takerA, writable: true },
          { address: s.takerB, writable: true },
          { address: s.makerB, writable: true },
          { address: s.vault, writable: true },
          { address: TOKEN_PROGRAM },
        ]),
      ]),
    );
    expect(balance(s.svm, s.takerA)).toBe(400n);
    expect(balance(s.svm, s.takerB)).toBe(250n);
    expect(balance(s.svm, s.makerB)).toBe(250n);
    expect(s.svm.getAccount(s.vault).exists).toBe(false);
    expect(s.svm.getAccount(s.offer).exists).toBe(false);
    // Maker got the offer's and the vault's rent back.
    expect(s.svm.getBalance(s.maker.address)! - makerLamports).toBeGreaterThan(RENT);
  });

  it("refunds the maker", async () => {
    const s = await setup(2n);
    expectOk(await send(s.svm, s.maker, [s.makeIx()]));
    expectOk(
      await send(s.svm, s.maker, [
        ix(d, "refund", {}, [
          { address: s.maker.address, signer: s.maker, writable: true },
          { address: s.offer, writable: true },
          { address: s.makerA, writable: true },
          { address: s.vault, writable: true },
          { address: TOKEN_PROGRAM },
        ]),
      ]),
    );
    expect(balance(s.svm, s.makerA)).toBe(1_000n);
    expect(s.svm.getAccount(s.offer).exists).toBe(false);
  });

  it("rejects a vault the offer does not own", async () => {
    const s = await setup(3n);
    const stolen = await tokenAccount(s.svm, s.mintA, s.taker.address, 0n);
    expect(customError(await send(s.svm, s.maker, [s.makeIx({ vault: stolen })]))).toBe(6001);
  });

  it("stops a taker from redirecting the maker's payment or the vault", async () => {
    const s = await setup(4n);
    expectOk(await send(s.svm, s.maker, [s.makeIx()]));
    const takeWith = (over: Partial<{ maker: Address; makerB: Address; vault: Address }>) =>
      ix(d, "take", {}, [
        { address: s.taker.address, signer: s.taker, writable: true },
        { address: over.maker ?? s.maker.address, writable: true },
        { address: s.offer, writable: true },
        { address: s.takerA, writable: true },
        { address: s.takerB, writable: true },
        { address: over.makerB ?? s.makerB, writable: true },
        { address: over.vault ?? s.vault, writable: true },
        { address: TOKEN_PROGRAM },
      ]);
    // Pay "the maker" into an account the taker controls.
    const takerOwnedB = await tokenAccount(s.svm, s.mintB, s.taker.address, 0n);
    expect(customError(await send(s.svm, s.taker, [takeWith({ makerB: takerOwnedB })]))).toBe(6005);
    // Point "maker" at another wallet to collect the rent.
    const accomplice = await fundedSigner(s.svm);
    expect(customError(await send(s.svm, s.taker, [takeWith({ maker: accomplice.address })]))).toBe(6002);
    // Reusing the taker's own account as the maker trips the aliasing check first.
    expect(customError(await send(s.svm, s.taker, [takeWith({ maker: s.taker.address })]))).toBe(2040);
    // Swap in a different vault.
    const otherVault = await tokenAccount(s.svm, s.mintA, s.offer, 0n);
    expect(customError(await send(s.svm, s.taker, [takeWith({ vault: otherVault })]))).toBe(6003);
    // Nothing moved.
    expect(balance(s.svm, s.vault)).toBe(400n);
    expect(balance(s.svm, s.takerB)).toBe(500n);
  });
});

function addrBytes(a: Address): Uint8Array {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const c of a) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}
void some;
