import {
  type AccountInfo,
  type Mut,
  type Program,
  type Signer,
  type SystemProgram,
  type u8,
  type u64,
  invoke,
  readonlySigner,
  requirePda,
  sighash,
  u32,
  writable,
  writableSigner,
} from "typesol";

/**
 * Cross-program invocation examples.
 *
 * The counter address below is where examples/counter.ts is deployed; change it to your own deployment.
 */

/** Bump a counter in another program, passing the caller's signature through. */
export function relayIncrement(
  authority: Signer,
  counter: Mut<AccountInfo>,
  counterProgram: Program<"JD2vmEKDb8mhNZBUdeRHixfQNnFCrf9psTfaDchS99Y2">,
  by: u64,
): void {
  invoke(counterProgram, [readonlySigner(authority), writable(counter)], [sighash("increment"), by]);
}

/**
 * Pay out of the admin's treasury PDA ["treasury", admin] by building a raw System Program
 * Transfer (u32 tag 2, u64 lamports) and signing for the PDA.
 */
export function payout(
  admin: Signer,
  treasury: Mut<AccountInfo>,
  recipient: Mut<AccountInfo>,
  systemProgram: SystemProgram,
  amount: u64,
  bump: u8,
): void {
  requirePda(treasury, ["treasury", admin.key], bump);
  invoke(systemProgram, [writableSigner(treasury), writable(recipient)], [u32(2n), amount], ["treasury", admin.key, bump]);
}
