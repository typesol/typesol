import { type Account, type Init, type Mut, type Pubkey, type Signer, type SystemProgram, type u8, type u64, require } from "typesol";

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
