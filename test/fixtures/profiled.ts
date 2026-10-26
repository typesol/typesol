import { type Mut, type Signer, type u64, require } from "typesol";

export interface Acc {
  total: u64;
}

export function work(acc: Mut<Acc>, n: u64): u64 {
  let s = 0n;
  for (let i = 0n; i < n; i++) {
    s += i * i;
  }
  acc.total += s;
  require(acc.total < 1000000n, "too big");
  return s;
}

export function noop(who: Signer): void {}
