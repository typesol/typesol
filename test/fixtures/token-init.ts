// Anchor's `init` with `mint::` / `token::` constraints: mints and token accounts created as PDAs (or new keypair
// accounts) in the body, `init_if_needed` forms, and SystemAccount.
import {
  type AccountInfo,
  type Init,
  type InitIfNeeded,
  type Mint,
  type MintOf,
  type Mut,
  type Signer,
  type SystemAccount,
  type SystemProgram,
  type TokenAccount,
  type TokenOf,
  type Token2022Program,
  type TokenInterface,
  type u8,
  type u64,
  require,
} from "typesol";

/** A PDA mint whose authority is `auth` (e.g. a PDA of this program); no freeze authority. */
export function makeMint(payer: Mut<Signer>, mint: Init<Mint>, auth: AccountInfo, tokenProgram: TokenInterface, systemProgram: SystemProgram, decimals: u8): u8 {
  const bump = mint.create(payer, ["mint", payer.key], decimals, auth.key, null);
  require(mint.decimals === decimals, "decimals");
  require(mint.supply === 0n, "supply");
  return bump;
}

/** A new keypair mint (it signs), the payer holding both authorities. */
export function keypairMint(payer: Mut<Signer>, mint: Init<Mint>, tokenProgram: TokenInterface, systemProgram: SystemProgram): u8 {
  const bump = mint.create(payer, null, 9n, payer.key, payer.key);
  return bump;
}

/** A vault: a token account at PDA ["vault", mint] that owns itself (token::authority = vault). */
export function makeVault(payer: Mut<Signer>, mint: Mint, vault: Init<TokenAccount>, tokenProgram: TokenInterface, systemProgram: SystemProgram): void {
  vault.create(payer, ["vault", mint.key], mint, vault.key);
  require(vault.amount === 0n && vault.mint === mint.key && vault.owner === vault.key, "vault");
}

export function ensureVault(payer: Mut<Signer>, mint: Mint, vault: InitIfNeeded<TokenAccount>, owner: AccountInfo, tokenProgram: TokenInterface, systemProgram: SystemProgram): boolean {
  const created = vault.createIfNeeded(payer, ["vault", mint.key], mint, owner.key);
  return created;
}

export function ensureMint(payer: Mut<Signer>, mint: InitIfNeeded<Mint>, auth: AccountInfo, tokenProgram: TokenInterface, systemProgram: SystemProgram, decimals: u8): boolean {
  const created = mint.createIfNeeded(payer, ["mint", payer.key], decimals, auth.key, null);
  return created;
}

/** The same mint, expected with the payer as freeze authority (an existing one without it fails, 2017). */
export function ensureFrozenMint(payer: Mut<Signer>, mint: InitIfNeeded<Mint>, auth: AccountInfo, tokenProgram: TokenInterface, systemProgram: SystemProgram, decimals: u8): boolean {
  const created = mint.createIfNeeded(payer, ["mint", payer.key], decimals, auth.key, payer.key);
  return created;
}

/** Anchor SystemAccount: the recipient must be a System-owned account. */
export function tip(from: Mut<Signer>, to: Mut<SystemAccount>, systemProgram: SystemProgram, amount: u64): void {
  systemProgram.transfer(from, to, amount);
}


/** Anchor `init_if_needed` + `extensions::metadata_pointer::…` + `extensions::close_authority::…` on a PDA mint. */
export function extMint(payer: Mut<Signer>, mint: InitIfNeeded<Mint>, pointsTo: AccountInfo, tokenProgram: Token2022Program, systemProgram: SystemProgram): boolean {
  const created = mint.createIfNeeded(payer, ["ext", payer.key], 6n, payer.key, null, {
    metadataPointer: { authority: payer.key, metadataAddress: pointsTo.key },
    closeAuthority: payer.key,
  });
  return created;
}

/** The same PDA mint without extensions. */
export function plainExtMint(payer: Mut<Signer>, mint: Init<Mint>, tokenProgram: Token2022Program, systemProgram: SystemProgram): void {
  mint.create(payer, ["ext", payer.key], 6n, payer.key, null);
}

/** `mint::authority = auth` on an existing mint, naming the parameter. */
export function checkMint(mint: MintOf<Mint, "auth">, auth: AccountInfo): void {}

/** Anchor's mint::token_program = tokenProgram (2022) and token::token_program (2021). */
export function checkTokenProgram(
  mint: MintOf<Mint, never, never, "tokenProgram">,
  account: TokenOf<TokenAccount, never, never, "tokenProgram">,
  tokenProgram: TokenInterface,
): void {}
