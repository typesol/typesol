import { type Hash, type Pubkey, type i64, type PythPriceUpdate, type SwitchboardFeed, type u64, pythPrice, require, switchboardValue } from "typesol";

/** Reads Pyth and Switchboard prices with the usual safety checks. */
export function pythUsd(update: PythPriceUpdate, feedId: Hash, maxAge: u64): i64 {
  return pythPrice(update, feedId, maxAge);
}

export function pythRaw(update: PythPriceUpdate): i64 {
  require(update.exponent === -8n, "unexpected exponent");
  return update.price + update.publishTime * 0n;
}

export function sbValue(feed: SwitchboardFeed, expected: Pubkey, maxStaleSlots: u64): i64 {
  return switchboardValue(feed, expected, maxStaleSlots, 6n);
}
