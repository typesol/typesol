// Programs and tests that `typesol init --template <name>` writes. Each test runs its program in LiteSVM and covers its
// main flow and at least one refused call, so a new project starts from something that passes and shows how to test.
// The programs are copies of examples/ (test/cli/workspace.test.ts checks they still match).

export const TEMPLATE_NAMES = ["counter", "vault", "escrow"] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

export interface Template {
  program: string;
  test: (name: string) => string;
  /** devDependencies beyond the ones every project gets. */
  devDependencies?: Record<string, string>;
}

/** Every test starts the same way: build the project's program into a LiteSVM with `typesol/testing`. */
const testFile = (name: string, o: { imports?: string; body: string }) => `// Runs the program in LiteSVM (an in-process Solana runtime): \`npm test\`.
${o.imports ?? ""}import { testProgram, type TestProgram } from "typesol/testing";
import { beforeAll, describe, expect, it } from "vitest";

describe("${name}", () => {
  let t: TestProgram;
  beforeAll(async () => {
    t = await testProgram("${name}", import.meta.url);
  });
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
        body: `
  it("initializes and increments the caller's counter; refuses anyone else", async () => {
    const alice = await t.wallet();
    const mallory = await t.wallet();
    const counter = await t.pda("counter", alice);
    t.ok(await t.send(alice, t.ix("initialize", {}, { authority: alice, counter })));
    t.ok(await t.send(alice, t.ix("increment", { by: 5n }, { authority: alice, counter })));
    expect((await t.account<{ count: bigint }>("Counter", counter))?.count).toBe(5n);

    // CounterError.Unauthorized is the enum's first member: 6000.
    expect(t.errorCode(await t.send(mallory, t.ix("increment", { by: 1n }, { authority: mallory, counter })))).toBe(6000);
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
        body: `
  it("deposits and withdraws SOL, keeps the rent reserve, then closes", async () => {
    const owner = await t.wallet();
    const vault = await t.pda("vault", owner);
    t.ok(await t.send(owner, t.ix("open", {}, { owner, vault })));
    const rent = t.balance(vault);
    t.ok(await t.send(owner, t.ix("deposit", { amount: 3_000_000_000n }, { owner, vault })));
    t.ok(await t.send(owner, t.ix("withdraw", { amount: 1_000_000_000n }, { owner, vault })));
    expect(t.balance(vault)).toBe(rent + 2_000_000_000n);

    // VaultError.InsufficientFunds (third member, 6002): the rent reserve stays.
    expect(t.errorCode(await t.send(owner, t.ix("withdraw", { amount: 2_000_000_001n }, { owner, vault })))).toBe(6002);

    t.ok(await t.send(owner, t.ix("shut", {}, { owner, vault })));
    expect(await t.account("Vault", vault)).toBeNull();
  });

  it("refuses a stranger", async () => {
    const owner = await t.wallet();
    const thief = await t.wallet();
    const vault = await t.pda("vault", owner);
    t.ok(await t.send(owner, t.ix("open", {}, { owner, vault })));
    // VaultError.NotOwner: 6000.
    expect(t.errorCode(await t.send(thief, t.ix("shut", {}, { owner: thief, vault })))).toBe(6000);
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
        imports: `import { AccountState, getMintEncoder, getMintSize, getTokenDecoder, getTokenEncoder, getTokenSize } from "@solana-program/token";\nimport { type Address, type KeyPairSigner, generateKeyPairSigner, lamports } from "@solana/kit";\n`,
        body: `
  const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
  /** A mint, written straight into the VM (a real client sends System CreateAccount + InitializeMint2). */
  const mint = async (authority: Address) => {
    const address = (await generateKeyPairSigner()).address;
    const data = getMintEncoder().encode({ mintAuthority: authority, supply: 0n, decimals: 6, isInitialized: true, freezeAuthority: null });
    t.svm.setAccount({ address, data: new Uint8Array(data), executable: false, lamports: lamports(1_461_600n), programAddress: TOKEN, space: BigInt(getMintSize()) });
    return address;
  };
  /** A token account of owner for mint holding amount, written straight into the VM. */
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
    t.svm.setAccount({ address, data: new Uint8Array(data), executable: false, lamports: lamports(2_039_280n), programAddress: TOKEN, space: BigInt(getTokenSize()) });
    return address;
  };
  const balance = (address: Address) => {
    const account = t.svm.getAccount(address);
    return account.exists ? getTokenDecoder().decode(account.data).amount : null;
  };

  it("escrows mint A for mint B; the taker swaps, the maker can refund", async () => {
    const maker = await t.wallet();
    const taker = await t.wallet();
    const mintA = await mint(maker.address);
    const mintB = await mint(taker.address);
    const makerTokenA = await tokenAccount(maker.address, mintA, 1_000n);
    const makerTokenB = await tokenAccount(maker.address, mintB, 0n);
    const takerTokenA = await tokenAccount(taker.address, mintA, 0n);
    const takerTokenB = await tokenAccount(taker.address, mintB, 500n);

    const open = async (seed: bigint) => {
      const offer = await t.pda("offer", maker, seed);
      // The client creates the vault: an empty token account for mint A owned by the offer PDA.
      const vault = await tokenAccount(offer, mintA, 0n);
      t.ok(await t.send(maker, t.ix("make", { seed, amountA: 400n, wantB: 300n, mintB }, { maker, offer, makerTokenA, vault })));
      return { offer, vault };
    };

    const first = await open(1n);
    expect(balance(first.vault)).toBe(400n);
    t.ok(await t.send(taker, t.ix("take", {}, { taker, maker: maker.address, offer: first.offer, takerTokenA, takerTokenB, makerTokenB, vault: first.vault })));
    expect([balance(takerTokenA), balance(makerTokenB), balance(first.vault)]).toEqual([400n, 300n, null]);

    const second = await open(2n);
    const refund = (who: KeyPairSigner) => t.ix("refund", {}, { maker: who, offer: second.offer, makerTokenA, vault: second.vault });
    // EscrowError.WrongMaker (third member, 6002): only the maker refunds.
    expect(t.errorCode(await t.send(taker, refund(taker)))).toBe(6002);
    t.ok(await t.send(maker, refund(maker)));
    expect([balance(makerTokenA), await t.account("Offer", second.offer)]).toEqual([600n, null]);
  });
`,
      }),
    devDependencies: { "@solana-program/token": "~0.18.0" },
  },
};
