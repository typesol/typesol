import { type AccountInfo, type Pubkey, masterEditionAddress } from "typesol";

export function addresses(mint: AccountInfo): Pubkey {
  return masterEditionAddress(mint.key);
}
