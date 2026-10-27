// Programs and tests that `typesol init --template <name>` writes. Each test runs its program in LiteSVM and covers its
// main flow and at least one refused call, so a new project starts from something that passes and shows how to test.
// The programs are copies of examples/ (test/workspace.test.ts checks they still match).

export const TEMPLATE_NAMES = ["counter", "vault", "escrow"] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

export interface Template {
  program: string;
  test: (name: string) => string;
  /** devDependencies beyond the ones every project gets. */
  devDependencies?: Record<string, string>;
}

/** The part every test shares: build the project's program into a LiteSVM, encode instructions with its IDL, send. */
const testFile = (
  name: string,
  o: { imports: string; kit: string[]; body: string },
) => `// Runs the program in LiteSVM (an in-process Solana runtime): \`npm test\`.
import { BN, BorshCoder, type Idl } from "@anchor-lang/core";
${o.imports}import {
${[
  "AccountRole",
  "appendTransactionMessageInstructions",
  "createTransactionMessage",
  ...o.kit,
  "pipe",
  "setTransactionMessageFeePayerSigner",
  "signTransactionMessageWithSigners",
  "type Address",
  "type Instruction",
  "type KeyPairSigner",
]
  .map((x) => `  ${x},`)
  .join("\n")}
} from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM, TransactionMetadata } from "litesvm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkspace, findWorkspace } from "typesol/workspace";
import { beforeAll, describe, expect, it } from "vitest";

const SYSTEM = "11111111111111111111111111111111" as Address;
const ws = findWorkspace(path.dirname(fileURLToPath(import.meta.url)))!;

describe("${name}", () => {
  const svm = new LiteSVM();
  let programId: Address;
  let coder: BorshCoder;
  beforeAll(() => {
    const [built] = buildWorkspace(ws, ["${name}"]);
    programId = built.address as Address;
    svm.addProgramFromFile(programId, built.result.soPath);
    coder = new BorshCoder(built.result.idl as unknown as Idl);
  });

  const ix = (name: string, args: object, accounts: { address: Address; signer?: KeyPairSigner; writable?: boolean }[]): Instruction => ({
    programAddress: programId,
    accounts: accounts.map((a) => ({
      address: a.address,
      role: a.signer ? (a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY,
      ...(a.signer ? { signer: a.signer } : {}),
    })) as Instruction["accounts"],
    data: new Uint8Array(coder.instruction.encode(name, args)),
  });
  const send = async (payer: KeyPairSigner, ixs: Instruction[]) => {
    const tx = await pipe(
      createTransactionMessage({ version: 0 }),
      (t) => setTransactionMessageFeePayerSigner(payer, t),
      (t) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(t),
      (t) => appendTransactionMessageInstructions(ixs, t),
      (t) => signTransactionMessageWithSigners(t),
    );
    const res = svm.sendTransaction(tx);
    svm.expireBlockhash();
    return res;
  };
  /** The custom error code of a failed transaction: 6000 + the member's index in the program's error enum. */
  const errorCode = (res: TransactionMetadata | FailedTransactionMetadata) => {
    if (!(res instanceof FailedTransactionMetadata)) throw new Error("expected the transaction to fail");
    return Number(/Custom\\D*(\\d+)/.exec(String(res.err()))?.[1]);
  };
${o.body}});
`;

export const TEMPLATES: Record<TemplateName, Template> = {
  counter: {
    program: `import { type Account, type Init, type Mut, type Pubkey, type Signer, type SystemProgram, type u8, type u64, require } from "typesol";

export interface Counter {
  authority: Pubkey;
  count: u64;
  bump: u8;
}

export enum CounterError {
  Unauthorized = "Only the counter's authority can change it",
}

/** Create the caller's counter at PDA ["counter", authority]. */
export function initialize(authority: Mut<Signer>, counter: Init<Counter>, systemProgram: SystemProgram): void {
  counter.bump = counter.create(authority, ["counter", authority.key]);
  counter.authority = authority.key;
  counter.count = 0n;
}

export function increment(authority: Signer, counter: Mut<Counter>, by: u64): void {
  require(counter.authority === authority.key, CounterError.Unauthorized);
  counter.count += by;
}

/** Read-only check that callers can simulate. */
export function assertAtLeast(counter: Account<Counter>, min: u64): void {
  require(counter.count >= min, "counter is below the expected minimum");
}
`,
    test: (name) =>
      testFile(name, {
        imports: "",
        kit: ["generateKeyPairSigner", "getAddressEncoder", "getProgramDerivedAddress", "lamports"],
        body: `
  it("initializes and increments the caller's counter; refuses anyone else", async () => {
    const alice = await generateKeyPairSigner();
    const mallory = await generateKeyPairSigner();
    svm.airdrop(alice.address, lamports(1_000_000_000n));
    svm.airdrop(mallory.address, lamports(1_000_000_000n));
    const [counter] = await getProgramDerivedAddress({ programAddress: programId, seeds: ["counter", getAddressEncoder().encode(alice.address)] });
    const me = { address: alice.address, signer: alice, writable: true };
    expect(await send(alice, [ix("initialize", {}, [me, { address: counter, writable: true }, { address: SYSTEM }])])).toBeInstanceOf(TransactionMetadata);
    expect(await send(alice, [ix("increment", { by: new BN(5) }, [{ address: alice.address, signer: alice }, { address: counter, writable: true }])])).toBeInstanceOf(TransactionMetadata);
    const account = svm.getAccount(counter);
    if (!account.exists) throw new Error("counter was not created");
    expect(coder.accounts.decode("Counter", Buffer.from(account.data)).count.toString()).toBe("5");

    // CounterError.Unauthorized is the enum's first member: 6000.
    const stranger = ix("increment", { by: new BN(1) }, [{ address: mallory.address, signer: mallory }, { address: counter, writable: true }]);
    expect(errorCode(await send(mallory, [stranger]))).toBe(6000);
  });
`,
      }),
  },
  vault: {
    program: `import {
  type Init,
  type Mut,
  type Pubkey,
  type Signer,
  type SystemProgram,
  type u8,
  type u64,
  close,
  minimumBalance,
  require,
} from "typesol";

/** A personal SOL vault at PDA ["vault", owner]. Lamports above rent are the balance. */
export interface Vault {
  owner: Pubkey;
  deposited: u64;
  withdrawn: u64;
  bump: u8;
}

export enum VaultError {
  NotOwner = "Only the vault owner can do this",
  ZeroAmount = "Amount must be greater than zero",
  InsufficientFunds = "Withdrawal would dip below the rent-exempt minimum",
}

export function open(owner: Mut<Signer>, vault: Init<Vault>, systemProgram: SystemProgram): void {
  vault.bump = vault.create(owner, ["vault", owner.key]);
  vault.owner = owner.key;
}

export function deposit(owner: Mut<Signer>, vault: Mut<Vault>, systemProgram: SystemProgram, amount: u64): void {
  require(amount > 0n, VaultError.ZeroAmount);
  require(vault.owner === owner.key, VaultError.NotOwner);
  systemProgram.transfer(owner, vault, amount);
  vault.deposited += amount;
}

export function withdraw(owner: Mut<Signer>, vault: Mut<Vault>, amount: u64): void {
  require(amount > 0n, VaultError.ZeroAmount);
  require(vault.owner === owner.key, VaultError.NotOwner);
  const floor = minimumBalance(vault);
  require(vault.lamports - amount >= floor, VaultError.InsufficientFunds);
  // The vault is owned by this program, so it can move lamports directly.
  vault.lamports -= amount;
  owner.lamports += amount;
  vault.withdrawn += amount;
}

/** Close the vault and return everything, rent included, to the owner. */
export function shut(owner: Mut<Signer>, vault: Mut<Vault>): void {
  require(vault.owner === owner.key, VaultError.NotOwner);
  close(vault, owner);
}
`,
    test: (name) =>
      testFile(name, {
        imports: "",
        kit: ["generateKeyPairSigner", "getAddressEncoder", "getProgramDerivedAddress", "lamports"],
        body: `
  it("deposits and withdraws SOL, keeps the rent reserve, then closes", async () => {
    const owner = await generateKeyPairSigner();
    svm.airdrop(owner.address, lamports(10_000_000_000n));
    const [vault] = await getProgramDerivedAddress({ programAddress: programId, seeds: ["vault", getAddressEncoder().encode(owner.address)] });
    const me = { address: owner.address, signer: owner, writable: true };
    const v = { address: vault, writable: true };

    expect(await send(owner, [ix("open", {}, [me, v, { address: SYSTEM }])])).toBeInstanceOf(TransactionMetadata);
    const rent = svm.getBalance(vault)!;
    expect(await send(owner, [ix("deposit", { amount: new BN(3_000_000_000) }, [me, v, { address: SYSTEM }])])).toBeInstanceOf(TransactionMetadata);
    expect(await send(owner, [ix("withdraw", { amount: new BN(1_000_000_000) }, [me, v])])).toBeInstanceOf(TransactionMetadata);
    expect(svm.getBalance(vault)).toBe(rent + 2_000_000_000n);

    // VaultError.InsufficientFunds (third member, 6002): the rent reserve stays.
    expect(errorCode(await send(owner, [ix("withdraw", { amount: new BN(2_000_000_001) }, [me, v])]))).toBe(6002);

    expect(await send(owner, [ix("shut", {}, [me, v])])).toBeInstanceOf(TransactionMetadata);
    expect(svm.getAccount(vault).exists).toBe(false);
  });

  it("refuses a stranger", async () => {
    const owner = await generateKeyPairSigner();
    const thief = await generateKeyPairSigner();
    svm.airdrop(owner.address, lamports(2_000_000_000n));
    svm.airdrop(thief.address, lamports(1_000_000_000n));
    const [vault] = await getProgramDerivedAddress({ programAddress: programId, seeds: ["vault", getAddressEncoder().encode(owner.address)] });
    const v = { address: vault, writable: true };
    expect(await send(owner, [ix("open", {}, [{ address: owner.address, signer: owner, writable: true }, v, { address: SYSTEM }])])).toBeInstanceOf(
      TransactionMetadata,
    );
    // VaultError.NotOwner: 6000.
    expect(errorCode(await send(thief, [ix("shut", {}, [{ address: thief.address, signer: thief, writable: true }, v])]))).toBe(6000);
  });
`,
      }),
  },
  escrow: {
    program: `import {
  type AccountInfo,
  type Init,
  type Mut,
  type Pubkey,
  type Signer,
  type SystemProgram,
  type TokenAccount,
  type TokenProgram,
  type u8,
  type u64,
  close,
  require,
} from "typesol";

/**
 * A maker escrows \`amountA\` of mint A and asks for \`wantB\` of mint B.
 * Anyone can take the offer atomically; the maker can refund while it is open.
 *
 * The client creates \`vault\` beforehand as a token account for mint A whose
 * owner is the offer PDA ["offer", maker, seed].
 */
export interface Offer {
  maker: Pubkey;
  mintA: Pubkey;
  mintB: Pubkey;
  vault: Pubkey;
  amountA: u64;
  wantB: u64;
  seed: u64;
  bump: u8;
}

export enum EscrowError {
  ZeroAmount = "Amounts must be greater than zero",
  BadVault = "Vault must be an empty token account owned by the offer",
  WrongMaker = "Maker does not match the offer",
  WrongVault = "Vault does not match the offer",
  WrongMint = "Token account has the wrong mint",
  WrongRecipient = "Maker's token account is not owned by the maker",
}

export function make(
  maker: Mut<Signer>,
  offer: Init<Offer>,
  makerTokenA: Mut<TokenAccount>,
  vault: Mut<TokenAccount>,
  systemProgram: SystemProgram,
  tokenProgram: TokenProgram,
  seed: u64,
  amountA: u64,
  wantB: u64,
  mintB: Pubkey,
): void {
  offer.bump = offer.create(maker, ["offer", maker.key, seed]);
  require(amountA > 0n && wantB > 0n, EscrowError.ZeroAmount);
  require(vault.owner === offer.key && vault.mint === makerTokenA.mint && vault.amount === 0n, EscrowError.BadVault);

  tokenProgram.transfer(makerTokenA, vault, maker, amountA);

  offer.maker = maker.key;
  offer.mintA = makerTokenA.mint;
  offer.mintB = mintB;
  offer.vault = vault.key;
  offer.amountA = amountA;
  offer.wantB = wantB;
  offer.seed = seed;
}

export function take(
  taker: Mut<Signer>,
  maker: Mut<AccountInfo>,
  offer: Mut<Offer>,
  takerTokenA: Mut<TokenAccount>,
  takerTokenB: Mut<TokenAccount>,
  makerTokenB: Mut<TokenAccount>,
  vault: Mut<TokenAccount>,
  tokenProgram: TokenProgram,
): void {
  require(offer.maker === maker.key, EscrowError.WrongMaker);
  require(offer.vault === vault.key, EscrowError.WrongVault);
  require(takerTokenA.mint === offer.mintA && takerTokenB.mint === offer.mintB, EscrowError.WrongMint);
  require(makerTokenB.mint === offer.mintB, EscrowError.WrongMint);
  require(makerTokenB.owner === offer.maker, EscrowError.WrongRecipient);

  tokenProgram.transfer(takerTokenB, makerTokenB, taker, offer.wantB);
  tokenProgram.transfer(vault, takerTokenA, offer, offer.amountA, ["offer", offer.maker, offer.seed, offer.bump]);
  tokenProgram.closeAccount(vault, maker, offer, ["offer", offer.maker, offer.seed, offer.bump]);
  close(offer, maker);
}

export function refund(
  maker: Mut<Signer>,
  offer: Mut<Offer>,
  makerTokenA: Mut<TokenAccount>,
  vault: Mut<TokenAccount>,
  tokenProgram: TokenProgram,
): void {
  require(offer.maker === maker.key, EscrowError.WrongMaker);
  require(offer.vault === vault.key, EscrowError.WrongVault);
  require(makerTokenA.mint === offer.mintA, EscrowError.WrongMint);

  tokenProgram.transfer(vault, makerTokenA, offer, offer.amountA, ["offer", offer.maker, offer.seed, offer.bump]);
  tokenProgram.closeAccount(vault, maker, offer, ["offer", offer.maker, offer.seed, offer.bump]);
  close(offer, maker);
}
`,
    test: (name) =>
      testFile(name, {
        imports: `import { AccountState, getMintEncoder, getMintSize, getTokenDecoder, getTokenEncoder, getTokenSize } from "@solana-program/token";\n`,
        kit: ["generateKeyPairSigner", "getAddressEncoder", "getProgramDerivedAddress", "lamports"],
        body: `
  const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
  /** A mint, written straight into the VM (a real client sends System CreateAccount + InitializeMint2). */
  const mint = async (authority: Address) => {
    const address = (await generateKeyPairSigner()).address;
    const data = getMintEncoder().encode({ mintAuthority: authority, supply: 0n, decimals: 6, isInitialized: true, freezeAuthority: null });
    svm.setAccount({ address, data: new Uint8Array(data), executable: false, lamports: lamports(1_461_600n), programAddress: TOKEN, space: BigInt(getMintSize()) });
    return address;
  };
  /** A token account of \`owner\` for \`mint\` holding \`amount\`, written straight into the VM. */
  const tokenAccount = async (owner: Address, mintAddress: Address, amount: bigint) => {
    const address = (await generateKeyPairSigner()).address;
    const data = getTokenEncoder().encode({
      mint: mintAddress,
      owner,
      amount,
      delegate: null,
      state: AccountState.Initialized,
      isNative: null,
      delegatedAmount: 0n,
      closeAuthority: null,
    });
    svm.setAccount({ address, data: new Uint8Array(data), executable: false, lamports: lamports(2_039_280n), programAddress: TOKEN, space: BigInt(getTokenSize()) });
    return address;
  };
  const balance = (address: Address) => {
    const account = svm.getAccount(address);
    return account.exists ? getTokenDecoder().decode(account.data).amount : null;
  };

  it("escrows mint A for mint B; the taker swaps, the maker can refund", async () => {
    const maker = await generateKeyPairSigner();
    const taker = await generateKeyPairSigner();
    svm.airdrop(maker.address, lamports(1_000_000_000n));
    svm.airdrop(taker.address, lamports(1_000_000_000n));
    const mintA = await mint(maker.address);
    const mintB = await mint(taker.address);
    const makerA = await tokenAccount(maker.address, mintA, 1_000n);
    const makerB = await tokenAccount(maker.address, mintB, 0n);
    const takerA = await tokenAccount(taker.address, mintA, 0n);
    const takerB = await tokenAccount(taker.address, mintB, 500n);

    const open = async (seed: number) => {
      const [offer] = await getProgramDerivedAddress({
        programAddress: programId,
        seeds: ["offer", getAddressEncoder().encode(maker.address), new Uint8Array(new BN(seed).toArray("le", 8))],
      });
      // The client creates the vault: an empty token account for mint A owned by the offer PDA.
      const vault = await tokenAccount(offer, mintA, 0n);
      const make = ix("make", { seed: new BN(seed), amount_a: new BN(400), want_b: new BN(300), mint_b: { toBuffer: () => Buffer.from(getAddressEncoder().encode(mintB)) } }, [
        { address: maker.address, signer: maker, writable: true },
        { address: offer, writable: true },
        { address: makerA, writable: true },
        { address: vault, writable: true },
        { address: SYSTEM },
        { address: TOKEN },
      ]);
      expect(await send(maker, [make])).toBeInstanceOf(TransactionMetadata);
      return { offer, vault };
    };

    const first = await open(1);
    expect(balance(first.vault)).toBe(400n);
    const take = ix("take", {}, [
      { address: taker.address, signer: taker, writable: true },
      { address: maker.address, writable: true },
      { address: first.offer, writable: true },
      { address: takerA, writable: true },
      { address: takerB, writable: true },
      { address: makerB, writable: true },
      { address: first.vault, writable: true },
      { address: TOKEN },
    ]);
    expect(await send(taker, [take])).toBeInstanceOf(TransactionMetadata);
    expect([balance(takerA), balance(makerB), balance(first.vault)]).toEqual([400n, 300n, null]);

    const second = await open(2);
    const refund = (signer: KeyPairSigner) =>
      ix("refund", {}, [
        { address: signer.address, signer, writable: true },
        { address: second.offer, writable: true },
        { address: makerA, writable: true },
        { address: second.vault, writable: true },
        { address: TOKEN },
      ]);
    // EscrowError.WrongMaker (third member, 6002): only the maker refunds.
    expect(errorCode(await send(taker, [refund(taker)]))).toBe(6002);
    expect(await send(maker, [refund(maker)])).toBeInstanceOf(TransactionMetadata);
    expect([balance(makerA), svm.getAccount(second.offer).exists]).toEqual([600n, false]);
  });
`,
      }),
    devDependencies: { "@solana-program/token": "~0.18.0" },
  },
};
