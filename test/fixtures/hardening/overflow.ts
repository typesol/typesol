import { type Mut, type Pubkey, type Signer, type u64, emit, log } from "typesol";

export interface Shout {
  note: string;
  a: Pubkey;
  b: Pubkey;
  c: Pubkey;
  d: Pubkey;
  e: Pubkey;
  f: Pubkey;
  g: Pubkey;
  h: Pubkey;
  amount: u64;
}

export function shout(user: Signer, vault: Mut<Signer>, piece: string, reps: u64, amount: u64, k: Pubkey): u64 {
  let s = "";
  for (let i = 0n; i < reps; i++) s += piece;
  emit<Shout>({ note: s, a: k, b: k, c: k, d: k, e: k, f: k, g: k, h: k, amount });
  log(user.key);
  log(vault.key);
  return vault.lamports;
}
