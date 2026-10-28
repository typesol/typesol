// Port of basics/counter @ de09019; see test/ports/README.md.
//
// PORTED: `#[account(init, payer, space)]` without seeds is `counter.create(payer, null)`: a new keypair account that
// signs the transaction.
import { type Init, type Mut, type Signer, type SystemProgram, type u64 } from "typesol";

export interface Counter {
  count: u64;
}

export function initializeCounter(payer: Mut<Signer>, counter: Init<Counter>, systemProgram: SystemProgram): void {
  counter.create(payer, null);
}

/** Checked add: overflow aborts, like `checked_add(1).unwrap()`. */
export function increment(counter: Mut<Counter>): void {
  counter.count += 1n;
}
