// Port of tokens/token-swap (state, constants, errors) @ de09019; see lib.ts and test/ports/README.md.
import {
  type AccountMeta,
  type Mut,
  type Pubkey,
  type SignerSeeds,
  type TokenProgram,
  type u16,
  type u64,
  invoke,
  readonlySigner,
  u8,
  writable,
} from "typesol";

export const MINIMUM_LIQUIDITY: u64 = 100n;
export const AUTHORITY_SEED = "authority";
export const LIQUIDITY_SEED = "liquidity";

export interface Amm {
  /** The primary key of the AMM. */
  id: Pubkey;
  /** Account that has admin authority over the AMM. */
  admin: Pubkey;
  /** The LP fee taken on each trade, in basis points. */
  fee: u16;
}

export interface Pool {
  amm: Pubkey;
  mintA: Pubkey;
  mintB: Pubkey;
}

export enum TutorialError {
  InvalidFee = "Invalid fee value",
  InvalidMint = "Invalid mint for the pool",
  DepositTooSmall = "Depositing too little liquidity",
  OutputTooSmall = "Output is below the minimum expected",
  InvariantViolated = "Invariant does not hold",
  MathOverflow = "Math overflowed",
  /** Not in the original: the pool authority is not the liquidity mint's authority (the canonical PDA). */
  WrongPoolAuthority = "The pool authority is not the canonical PDA",
}
