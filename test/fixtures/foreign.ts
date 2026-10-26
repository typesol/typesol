// Reading accounts of other programs: typed (loadForeign) and raw (readData).
import { type AccountInfo, type Pubkey, type u16, loadForeign, readData, remainingAccounts, require, u64 } from "typesol";

/** Same layout as the other program's Anchor `Pool` account (after its 8-byte discriminator). */
export interface Pool {
  authority: Pubkey;
  reserve: u64;
  fee: u16;
}

/** A foreign layout with a bool, checked when loaded. */
export interface Flagged {
  on: boolean;
  n: u64;
}

export function flagged(acct: AccountInfo, owner: Pubkey): u64 {
  const f = loadForeign<Flagged>(acct, owner);
  return f.on ? f.n : 0n;
}

export function poolValue(pool: AccountInfo, owner: Pubkey): u64 {
  const p = loadForeign<Pool>(pool, owner);
  return p.reserve + u64(p.fee);
}

export function poolAuthority(owner: Pubkey): Pubkey {
  const p = loadForeign<Pool>(remainingAccounts().get(0n), owner);
  return p.authority;
}

export function rawU64(acct: AccountInfo, offset: u64): u64 {
  return readData<u64>(acct, offset);
}

export function rawKey(acct: AccountInfo): Pubkey {
  require(acct.owner !== acct.key, "never");
  return readData<Pubkey>(acct, 8n);
}
