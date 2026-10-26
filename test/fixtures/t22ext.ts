import { type Mint, type Pubkey, type u64, hasExtension, mintCloseAuthority, permanentDelegate, require, transferFee, transferHookProgram } from "typesol";

export function fee(mint: Mint, amount: u64): u64 {
  return transferFee(mint, amount);
}

/** 1 hook, 2 permanent delegate, 4 close authority, 8 non-transferable — each matching `who` where it holds a key. */
export function flags(mint: Mint, who: Pubkey): u64 {
  let f = 0n;
  const hook = transferHookProgram(mint);
  if (hook !== null) {
    require(hook === who, "hook");
    f += 1n;
  }
  if (permanentDelegate(mint) === who) f += 2n;
  if (mintCloseAuthority(mint) === who) f += 4n;
  if (hasExtension(mint, 9n)) f += 8n;
  return f;
}
