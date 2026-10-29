import {
  type Mint,
  type Pubkey,
  extensionsWithin,
  hasExtension,
  mintCloseAuthority,
  permanentDelegate,
  require,
  transferFee,
  transferFeeBasisPoints,
  transferFeeInverse,
  transferFeeMaximum,
  transferHookProgram,
  u64,
} from "typesol";

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

/** The fee on what the recipient is to get. */
export function inverse(mint: Mint, received: u64): u64 {
  return transferFeeInverse(mint, received);
}
/** This epoch's basis points × 10^12 + maximum fee. */
export function rate(mint: Mint): u64 {
  return u64(transferFeeBasisPoints(mint)) * 1_000_000_000_000n + transferFeeMaximum(mint);
}
/** Only TransferFeeConfig, MetadataPointer, TokenMetadata, InterestBearingConfig, ScaledUiAmount (Raydium's list). */
export function within(mint: Mint): u64 {
  return extensionsWithin(mint, [1n, 18n, 19n, 10n, 25n]) ? 1n : 0n;
}
