// Port of tokens/token-swap @ de09019; see test/ports/README.md.
//
// PARTIAL:
//  - interface: Anchor signs for `pool_authority` with `ctx.bumps.pool_authority` (the canonical bump found by
//    `seeds = [...], bump`) and checks `mint_liquidity` against seeds built from `pool.amm` (a field). TypeSOL Seeds<>
//    constraints can name parameters and arguments but not another account's fields, and do not expose the bump they
//    find, so `deposit_liquidity`, `withdraw_liquidity` and `swap_exact_tokens_for_tokens` take `authority_bump` /
//    `liquidity_bump` arguments checked with requirePda. The authority stays the canonical PDA in every instruction:
//    `create_pool` and `swap` check it with Seeds<> (swap's pool has `has_one = amm`); in `deposit` and `withdraw` it
//    must be the liquidity mint's mint authority, and the only liquidity mint at that PDA is the one `create_pool`
//    made, with the canonical authority (only this program can sign for its PDAs).
//  - Anchor also re-derives `amm` (seeds = [amm.id]) and `pool` (seeds = [pool.amm, pool.mint_a, pool.mint_b]) with
//    find_program_address; every Amm/Pool account is created at exactly that canonical address by create_amm /
//    create_pool, so those re-derivations can never fail and are not repeated.
//  - builtin gap: the trader's / depositor's associated token accounts are `init_if_needed`. Accounts created in the
//    body are AccountInfo to TypeSOL, so transfers / mints into them are hand-encoded (`invoke`) and the trader's
//    balances are read with readData at the SPL Token `amount` offset.
// Token amounts are re-read after the CPIs (TypeSOL reads account data live), like Anchor's `reload()`.
import {
  type AccountInfo,
  type Account,
  type AssociatedTokenProgram,
  type Ata,
  type HasOne,
  type Init,
  type Mint,
  type Mut,
  type Pubkey,
  type Seeds,
  type Signer,
  type SystemProgram,
  type TokenAccount,
  type TokenProgram,
  type u16,
  type u8,
  MINT_SIZE,
  isqrt,
  log,
  readData,
  rentExempt,
  require,
  requirePda,
  signer,
  u128,
  u64,
} from "typesol";
import { type Amm, type Pool, AUTHORITY_SEED, LIQUIDITY_SEED, MINIMUM_LIQUIDITY, TutorialError, mintTo, transfer } from "./state";

export function createAmm(amm: Init<Amm>, admin: AccountInfo, payer: Mut<Signer>, systemProgram: SystemProgram, id: Pubkey, fee: u16): void {
  amm.create(payer, [id]);
  require(fee < 10000n, TutorialError.InvalidFee);
  amm.id = id;
  amm.admin = admin.key;
  amm.fee = fee;
}

export function createPool(
  amm: Account<Amm>,
  pool: Init<Pool>,
  poolAuthority: Seeds<AccountInfo, ["@amm", "@mintA", "@mintB", "authority"]>,
  mintLiquidity: Seeds<Mut<AccountInfo>, ["@amm", "@mintA", "@mintB", "liquidity"]>,
  mintA: Mint,
  mintB: Mint,
  poolAccountA: Ata<Mut<AccountInfo>, "poolAuthority", "mintA">,
  poolAccountB: Ata<Mut<AccountInfo>, "poolAuthority", "mintB">,
  payer: Mut<Signer>,
  tokenProgram: TokenProgram,
  associatedTokenProgram: AssociatedTokenProgram,
  systemProgram: SystemProgram,
  liquidityBump: u8,
): void {
  pool.create(payer, [amm.key, mintA.key, mintB.key]);
  requirePda(mintLiquidity, [amm.key, mintA.key, mintB.key, LIQUIDITY_SEED], liquidityBump);
  systemProgram.createAccount(payer, mintLiquidity, rentExempt(MINT_SIZE), MINT_SIZE, tokenProgram.key, [
    amm.key,
    mintA.key,
    mintB.key,
    LIQUIDITY_SEED,
    liquidityBump,
  ]);
  tokenProgram.initializeMint2(mintLiquidity, 6n, poolAuthority.key, null);
  associatedTokenProgram.create(payer, poolAccountA, poolAuthority, mintA, systemProgram, tokenProgram);
  associatedTokenProgram.create(payer, poolAccountB, poolAuthority, mintB, systemProgram, tokenProgram);
  pool.amm = amm.key;
  pool.mintA = mintA.key;
  pool.mintB = mintB.key;
}

export function depositLiquidity(
  pool: HasOne<Account<Pool>, "mintA" | "mintB">,
  poolAuthority: AccountInfo,
  depositor: Signer,
  mintLiquidity: Mut<Mint>,
  mintA: Mint,
  mintB: Mint,
  poolAccountA: Ata<Mut<TokenAccount>, "poolAuthority", "mintA">,
  poolAccountB: Ata<Mut<TokenAccount>, "poolAuthority", "mintB">,
  depositorAccountLiquidity: Ata<Mut<AccountInfo>, "depositor", "mintLiquidity">,
  depositorAccountA: Ata<Mut<TokenAccount>, "depositor", "mintA">,
  depositorAccountB: Ata<Mut<TokenAccount>, "depositor", "mintB">,
  payer: Mut<Signer>,
  tokenProgram: TokenProgram,
  associatedTokenProgram: AssociatedTokenProgram,
  systemProgram: SystemProgram,
  amountA: u64,
  amountB: u64,
  authorityBump: u8,
  liquidityBump: u8,
): void {
  requirePda(poolAuthority, [pool.amm, mintA.key, mintB.key, AUTHORITY_SEED], authorityBump);
  requirePda(mintLiquidity, [pool.amm, mintA.key, mintB.key, LIQUIDITY_SEED], liquidityBump);
  require(mintLiquidity.mintAuthority === poolAuthority.key, TutorialError.WrongPoolAuthority);
  associatedTokenProgram.createIdempotent(payer, depositorAccountLiquidity, depositor, mintLiquidity, systemProgram, tokenProgram);

  // Never more than the depositor holds.
  let a = amountA > depositorAccountA.amount ? depositorAccountA.amount : amountA;
  let b = amountB > depositorAccountB.amount ? depositorAccountB.amount : amountB;
  const poolCreation = poolAccountA.amount === 0n && poolAccountB.amount === 0n;
  // Later deposits keep the pool ratio: take the full amount of one side and what the ratio requires of the other.
  if (!poolCreation) {
    const bRequired = (u128(a) * u128(poolAccountB.amount)) / u128(poolAccountA.amount);
    if (bRequired <= u128(b)) {
      b = u64(bRequired);
    } else {
      a = u64((u128(b) * u128(poolAccountA.amount)) / u128(poolAccountB.amount));
    }
  }
  // Liquidity is the geometric mean; the first deposit locks MINIMUM_LIQUIDITY forever.
  let liquidity = u64(isqrt(u128(a) * u128(b)));
  if (poolCreation) {
    require(liquidity >= MINIMUM_LIQUIDITY, TutorialError.DepositTooSmall);
    liquidity -= MINIMUM_LIQUIDITY;
  }
  tokenProgram.transfer(depositorAccountA, poolAccountA, depositor, a);
  tokenProgram.transfer(depositorAccountB, poolAccountB, depositor, b);
  mintTo(
    tokenProgram,
    mintLiquidity,
    depositorAccountLiquidity,
    poolAuthority,
    liquidity,
    signer([pool.amm, mintA.key, mintB.key, AUTHORITY_SEED, authorityBump]),
  );
}

export function withdrawLiquidity(
  amm: Account<Amm>,
  pool: HasOne<Account<Pool>, "mintA" | "mintB">,
  poolAuthority: AccountInfo,
  depositor: Signer,
  mintLiquidity: Mut<Mint>,
  mintA: Mut<Mint>,
  mintB: Mut<Mint>,
  poolAccountA: Ata<Mut<TokenAccount>, "poolAuthority", "mintA">,
  poolAccountB: Ata<Mut<TokenAccount>, "poolAuthority", "mintB">,
  depositorAccountLiquidity: Ata<Mut<TokenAccount>, "depositor", "mintLiquidity">,
  depositorAccountA: Ata<Mut<AccountInfo>, "depositor", "mintA">,
  depositorAccountB: Ata<Mut<AccountInfo>, "depositor", "mintB">,
  payer: Mut<Signer>,
  tokenProgram: TokenProgram,
  associatedTokenProgram: AssociatedTokenProgram,
  systemProgram: SystemProgram,
  amount: u64,
  authorityBump: u8,
  liquidityBump: u8,
): void {
  requirePda(poolAuthority, [pool.amm, mintA.key, mintB.key, AUTHORITY_SEED], authorityBump);
  requirePda(mintLiquidity, [pool.amm, mintA.key, mintB.key, LIQUIDITY_SEED], liquidityBump);
  require(mintLiquidity.mintAuthority === poolAuthority.key, TutorialError.WrongPoolAuthority);
  associatedTokenProgram.createIdempotent(payer, depositorAccountA, depositor, mintA, systemProgram, tokenProgram);
  associatedTokenProgram.createIdempotent(payer, depositorAccountB, depositor, mintB, systemProgram, tokenProgram);
  const amountA = u64((u128(amount) * u128(poolAccountA.amount)) / (u128(mintLiquidity.supply) + u128(MINIMUM_LIQUIDITY)));
  transfer(tokenProgram, poolAccountA, depositorAccountA, poolAuthority, amountA, signer([pool.amm, mintA.key, mintB.key, AUTHORITY_SEED, authorityBump]));
  const amountB = u64((u128(amount) * u128(poolAccountB.amount)) / (u128(mintLiquidity.supply) + u128(MINIMUM_LIQUIDITY)));
  transfer(tokenProgram, poolAccountB, depositorAccountB, poolAuthority, amountB, signer([pool.amm, mintA.key, mintB.key, AUTHORITY_SEED, authorityBump]));
  tokenProgram.burn(depositorAccountLiquidity, mintLiquidity, depositor, amount);
}

/** The SPL Token `amount` of a token account created (or found) in this instruction. */
function balance(account: AccountInfo): u64 {
  return readData<u64>(account, 64n);
}

export function swapExactTokensForTokens(
  amm: Account<Amm>,
  pool: HasOne<Account<Pool>, "amm" | "mintA" | "mintB">,
  poolAuthority: Seeds<AccountInfo, ["@amm", "@mintA", "@mintB", "authority"]>,
  trader: Signer,
  mintA: Mint,
  mintB: Mint,
  poolAccountA: Ata<Mut<TokenAccount>, "poolAuthority", "mintA">,
  poolAccountB: Ata<Mut<TokenAccount>, "poolAuthority", "mintB">,
  traderAccountA: Ata<Mut<AccountInfo>, "trader", "mintA">,
  traderAccountB: Ata<Mut<AccountInfo>, "trader", "mintB">,
  payer: Mut<Signer>,
  tokenProgram: TokenProgram,
  associatedTokenProgram: AssociatedTokenProgram,
  systemProgram: SystemProgram,
  swapA: boolean,
  inputAmount: u64,
  minOutputAmount: u64,
  authorityBump: u8,
): void {
  requirePda(poolAuthority, [pool.amm, mintA.key, mintB.key, AUTHORITY_SEED], authorityBump);
  associatedTokenProgram.createIdempotent(payer, traderAccountA, trader, mintA, systemProgram, tokenProgram);
  associatedTokenProgram.createIdempotent(payer, traderAccountB, trader, mintB, systemProgram, tokenProgram);

  // Never more than the trader holds.
  let input = inputAmount;
  if (swapA && inputAmount > balance(traderAccountA)) input = balance(traderAccountA);
  else if (!swapA && inputAmount > balance(traderAccountB)) input = balance(traderAccountB);

  const feeAmount = u64((u128(input) * u128(amm.fee)) / 10000n);
  const taxedInput = input - feeAmount;
  // Constant product: output = taxed * reserveOut / (reserveIn + taxed).
  const output = swapA
    ? u64((u128(taxedInput) * u128(poolAccountB.amount)) / (u128(poolAccountA.amount) + u128(taxedInput)))
    : u64((u128(taxedInput) * u128(poolAccountA.amount)) / (u128(poolAccountB.amount) + u128(taxedInput)));
  require(output >= minOutputAmount, TutorialError.OutputTooSmall);

  const invariant = u128(poolAccountA.amount) * u128(poolAccountB.amount);
  if (swapA) {
    transfer(tokenProgram, traderAccountA, poolAccountA, trader, input, signer([]));
    transfer(tokenProgram, poolAccountB, traderAccountB, poolAuthority, output, signer([pool.amm, mintA.key, mintB.key, AUTHORITY_SEED, authorityBump]));
  } else {
    transfer(tokenProgram, poolAccountA, traderAccountA, poolAuthority, output, signer([pool.amm, mintA.key, mintB.key, AUTHORITY_SEED, authorityBump]));
    transfer(tokenProgram, traderAccountB, poolAccountB, trader, input, signer([]));
  }
  log(`Traded ${input} tokens (${taxedInput} after fees) for ${output}`);
  // The pool balances are read again after the transfers.
  require(invariant <= u128(poolAccountA.amount) * u128(poolAccountB.amount), TutorialError.InvariantViolated);
}
