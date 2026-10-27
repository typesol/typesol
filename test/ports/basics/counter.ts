// Port of basics/counter @ de09019; see test/ports/README.md.
//
// PARTIAL: Anchor creates the keypair account inside `initialize_counter` (`#[account(init, payer, space)]`
// without seeds). TypeSOL's Init<T> only creates PDAs, so the counter is a Zeroed<Counter>: the client allocates it
// with System CreateAccount (owner: this program) earlier in the same transaction and the program initializes it.
import { type Mut, type Signer, type SystemProgram, type Zeroed, type u64 } from "typesol";

export interface Counter {
  count: u64;
}

export function initializeCounter(payer: Mut<Signer>, counter: Zeroed<Counter>, systemProgram: SystemProgram): void {
  counter.count = 0n;
}

/** Checked add: overflow aborts, like `checked_add(1).unwrap()`. */
export function increment(counter: Mut<Counter>): void {
  counter.count += 1n;
}
