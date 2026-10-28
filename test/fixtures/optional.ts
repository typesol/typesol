// Optional accounts (Anchor Option<Account>): leave one out by passing this program's id.
import { type HasOne, type Init, type Mut, type Optional, type Pubkey, type Signer, type SystemProgram, type u64, log } from "typesol";

export interface Bank {
  owner: Pubkey;
  total: u64;
}

export function open(owner: Mut<Signer>, bank: Init<Bank>, systemProgram: SystemProgram): void {
  bank.create(owner, ["bank", owner.key]);
  bank.owner = owner.key;
}

/** Adds to the bank when one is given; returns 1 when it did. A referrer bank, when given, must belong to `owner`. */
export function maybeAdd(owner: Signer, bank: Mut<Bank> | null, referrer: Optional<HasOne<Mut<Bank>, "owner">>, amount: u64): u64 {
  let done = 0n;
  if (bank !== null) {
    bank.total += amount;
    done = 1n;
  }
  if (referrer !== null) referrer.total += 1n;
  return done;
}

/** `bank!` asserts the account was passed (left out, it fails); its owner goes into a log line. */
export function mustAdd(owner: Signer, bank: Mut<Bank> | null, amount: u64): u64 {
  bank!.total += amount;
  log(`bank of ${bank!.owner} holds ${bank!.total}`);
  return bank!.total;
}

/** A Pubkey in a template string is its base58 text. */
export function show(k: Pubkey): void {
  log(`key ${k}`);
}
