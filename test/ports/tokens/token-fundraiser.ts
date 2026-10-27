// Port of tokens/token-fundraiser @ de09019; see test/ports/README.md.
//
// PORTED: `check_contributions` pays into `maker_ata`, created with Ata<InitIfNeeded<TokenAccount>, …>. The fundraiser
// PDA seeded with its own `maker` field is checked declaratively in `contribute` ("@fundraiser.maker"). The elapsed-days value is converted
// with a checked u16() where Rust uses a wrapping `as u16` (they differ only after ~179 years).
import {
  type AccountInfo,
  type AssociatedTokenProgram,
  type Ata,
  type CloseTo,
  type HasOne,
  type Init,
  type InitIfNeeded,
  type Mint,
  type Mut,
  type Owner,
  type Pubkey,
  type Seeds,
  type Signer,
  type SystemProgram,
  type TokenAccount,
  type TokenProgram,
  type i64,
  invoke,
  now,
  readonlySigner,
  require,
  u16,
  u64,
  u8,
  writable,
} from "typesol";

const MIN_AMOUNT_TO_RAISE: u64 = 3n;
const SECONDS_TO_DAYS: i64 = 86400n;
const MAX_CONTRIBUTION_PERCENTAGE: u64 = 10n;
const PERCENTAGE_SCALER: u64 = 100n;

export interface Fundraiser {
  maker: Pubkey;
  mintToRaise: Pubkey;
  amountToRaise: u64;
  currentAmount: u64;
  timeStarted: i64;
  duration: u16;
  bump: u8;
}

export interface Contributor {
  amount: u64;
}

export enum FundraiserError {
  TargetNotMet = "The amount to raise has not been met",
  TargetMet = "The amount to raise has been achieved",
  ContributionTooBig = "The contribution is too big",
  ContributionTooSmall = "The contribution is too small",
  MaximumContributionsReached = "The maximum amount to contribute has been reached",
  FundraiserNotEnded = "The fundraiser has not ended yet",
  FundraiserEnded = "The fundraiser has ended",
  InvalidAmount = "Invalid total amount. i should be bigger than 3",
}

/** base ** exp, checked. */
function pow(base: u64, exp: u8): u64 {
  let r = 1n;
  for (let i = 0n; i < u64(exp); i++) r *= base;
  return r;
}

/** Whole days since the fundraiser started. */
function elapsedDays(fundraiser: Mut<Fundraiser>): u16 {
  return u16((now() - fundraiser.timeStarted) / SECONDS_TO_DAYS);
}

export function initialize(
  maker: Mut<Signer>,
  mintToRaise: Owner<Mint, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">,
  fundraiser: Init<Fundraiser>,
  vault: Ata<Mut<AccountInfo>, "fundraiser", "mintToRaise">,
  systemProgram: SystemProgram,
  tokenProgram: TokenProgram,
  associatedTokenProgram: AssociatedTokenProgram,
  amount: u64,
  duration: u16,
): void {
  fundraiser.bump = fundraiser.create(maker, ["fundraiser", maker.key]);
  associatedTokenProgram.create(maker, vault, fundraiser, mintToRaise, systemProgram, tokenProgram);
  require(amount >= pow(MIN_AMOUNT_TO_RAISE, mintToRaise.decimals), FundraiserError.InvalidAmount);
  fundraiser.maker = maker.key;
  fundraiser.mintToRaise = mintToRaise.key;
  fundraiser.amountToRaise = amount;
  fundraiser.currentAmount = 0n;
  fundraiser.timeStarted = now();
  fundraiser.duration = duration;
}

export function contribute(
  contributor: Mut<Signer>,
  mintToRaise: Owner<Mint, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">,
  fundraiser: Seeds<HasOne<Mut<Fundraiser>, "mintToRaise">, ["fundraiser", "@fundraiser.maker"], "bump">,
  contributorAccount: InitIfNeeded<Contributor>,
  contributorAta: Ata<Mut<TokenAccount>, "contributor", "mintToRaise">,
  vault: Ata<Mut<TokenAccount>, "fundraiser", "mintToRaise">,
  tokenProgram: TokenProgram,
  systemProgram: SystemProgram,
  amount: u64,
): void {
  contributorAccount.createIfNeeded(contributor, ["contributor", fundraiser.key, contributor.key]);
  const cap = (fundraiser.amountToRaise * MAX_CONTRIBUTION_PERCENTAGE) / PERCENTAGE_SCALER;
  require(amount >= pow(1n, mintToRaise.decimals), FundraiserError.ContributionTooSmall);
  require(amount <= cap, FundraiserError.ContributionTooBig);
  require(fundraiser.duration > elapsedDays(fundraiser), FundraiserError.FundraiserEnded);
  require(contributorAccount.amount <= cap && contributorAccount.amount + amount <= cap, FundraiserError.MaximumContributionsReached);
  tokenProgram.transfer(contributorAta, vault, contributor, amount);
  fundraiser.currentAmount += amount;
  contributorAccount.amount += amount;
}

export function checkContributions(
  maker: Mut<Signer>,
  mintToRaise: Owner<Mint, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">,
  fundraiser: CloseTo<HasOne<Seeds<Mut<Fundraiser>, ["fundraiser", "@maker"], "bump">, "mintToRaise">, "maker">,
  vault: Ata<Mut<TokenAccount>, "fundraiser", "mintToRaise">,
  makerAta: Ata<InitIfNeeded<TokenAccount>, "maker", "mintToRaise">,
  tokenProgram: TokenProgram,
  systemProgram: SystemProgram,
  associatedTokenProgram: AssociatedTokenProgram,
): void {
  makerAta.createIfNeeded(maker);
  require(vault.amount >= fundraiser.amountToRaise, FundraiserError.TargetNotMet);
  tokenProgram.transfer(vault, makerAta, fundraiser, vault.amount, ["fundraiser", maker.key, fundraiser.bump]);
}

export function refund(
  contributor: Mut<Signer>,
  maker: Owner<AccountInfo, "11111111111111111111111111111111">,
  mintToRaise: Owner<Mint, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">,
  fundraiser: HasOne<Seeds<Mut<Fundraiser>, ["fundraiser", "@maker"], "bump">, "mintToRaise">,
  contributorAccount: CloseTo<Seeds<Mut<Contributor>, ["contributor", "@fundraiser", "@contributor"]>, "contributor">,
  contributorAta: Ata<Mut<TokenAccount>, "contributor", "mintToRaise">,
  vault: Ata<Mut<TokenAccount>, "fundraiser", "mintToRaise">,
  tokenProgram: TokenProgram,
  systemProgram: SystemProgram,
): void {
  require(fundraiser.duration <= elapsedDays(fundraiser), FundraiserError.FundraiserNotEnded);
  require(vault.amount < fundraiser.amountToRaise, FundraiserError.TargetMet);
  tokenProgram.transfer(vault, contributorAta, fundraiser, contributorAccount.amount, ["fundraiser", maker.key, fundraiser.bump]);
  fundraiser.currentAmount -= contributorAccount.amount;
}
