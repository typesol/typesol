import { type Account, type AccountInfo, type Init, type Mut, type Pubkey, type Seeds, type Signer, type SystemProgram, type u8 } from "typesol";

export interface Vault {
  owner: Pubkey;
  bump: u8;
}

export function make(payer: Mut<Signer>, vault: Init<Vault>, systemProgram: SystemProgram): void {
  vault.bump = vault.create(payer, ["vault", payer.key]);
  vault.owner = payer.key;
}

/** The canonical bump the Seeds<> check found (Anchor `ctx.bumps.auth`). */
export function found(payer: Signer, auth: Seeds<AccountInfo, ["auth", "@payer"]>): u8 {
  return auth.pdaBump;
}

/** The stored bump field the Seeds<> check verified with. */
export function stored(payer: Signer, vault: Seeds<Account<Vault>, ["vault", "@payer"], "bump">): u8 {
  return vault.pdaBump;
}
