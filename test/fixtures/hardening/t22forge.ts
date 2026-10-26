import { type AccountInfo, type Mint, type Pubkey, type TokenAccount, type Ata, type u64, hasExtension, permanentDelegate, transferFee } from "typesol";

/** Fee a Token-2022 mint charges on `amount` (mint taken loosely as AccountInfo). */
export function quote(mint: AccountInfo, amount: u64): u64 {
  return transferFee(mint, amount);
}

/** Returns the permanent delegate (or the mint's key when none). */
export function delegateOf(mint: AccountInfo): Pubkey {
  const d = permanentDelegate(mint);
  if (d !== null) return d;
  return mint.key;
}

export function hasPd(mint: AccountInfo): boolean {
  return hasExtension(mint, 12n);
}

/** ATA constraint: returns the token account's owner field. */
export function ataOwner(account: Ata<TokenAccount, "owner", "mint">, owner: AccountInfo, mint: Mint): Pubkey {
  return account.owner;
}
