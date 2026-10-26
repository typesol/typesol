import { type u64 } from "typesol";

/** Shared helpers: imported by orderbook.ts. Exported functions in non-entry files are helpers, not instructions. */
export enum Side {
  Bid,
  Ask,
}

export function min(a: u64, b: u64): u64 {
  if (a < b) {
    return a;
  }
  return b;
}

/** Does a bid at `bid` cross an ask at `ask`? */
export function crosses(bid: u64, ask: u64): boolean {
  return bid >= ask;
}
