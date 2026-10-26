// Helpers that take accounts and signer seeds.
import {
  type Account,
  type FixedString,
  type Init,
  type Mut,
  type Signer,
  type SignerSeeds,
  type SystemProgram,
  type TokenAccount,
  type TokenInterface,
  type u8,
  type u64,
  require,
  signer,
} from "typesol";

export interface Tally {
  total: u64;
  label: FixedString<8>;
  bump: u8;
}

export function init(payer: Mut<Signer>, tally: Init<Tally>, systemProgram: SystemProgram): void {
  tally.bump = tally.create(payer, ["tally"]);
  tally.label = "start";
}

/** Changes account data, and takes a string that may point into it. */
function add(t: Mut<Tally>, by: u64, note: string): u64 {
  t.label = "changed";
  require(note === "start", "note must keep its value");
  t.total += by;
  return t.total;
}

function peek(t: Account<Tally>): u64 {
  return t.total;
}

/** Moves tokens out of a vault owned by the tally PDA, signing with the seeds it is given. */
function payOut(tokenProgram: TokenInterface, from: Mut<TokenAccount>, to: Mut<TokenAccount>, authority: Account<Tally>, amount: u64, seeds: SignerSeeds): void {
  tokenProgram.transfer(from, to, authority, amount, seeds);
}

export function bump(tally: Mut<Tally>, by: u64): u64 {
  const n = add(tally, by, tally.label);
  require(peek(tally) === n, "peek");
  return n;
}

export function pay(tally: Account<Tally>, tokenProgram: TokenInterface, from: Mut<TokenAccount>, to: Mut<TokenAccount>, amount: u64): void {
  payOut(tokenProgram, from, to, tally, amount, signer(["tally", tally.bump]));
}
