// Token program coverage beyond transfers: account creation, authorities, delegation, freezing,
// declarative token constraints, extra TokenAccount/Mint fields and Pubkey constants.
import {
  type Account,
  type AccountInfo,
  type Address,
  type Ata,
  type HasOne,
  type Init,
  type Mint,
  type Mut,
  type Pubkey,
  type Signer,
  type SystemProgram,
  type TokenAccount,
  type TokenInterface,
  type u8,
  type u64,
  AuthorityType,
  MINT_SIZE,
  TOKEN_ACCOUNT_SIZE,
  pubkey,
  rentExempt,
  require,
} from "typesol";

/** Anyone may read this constant; it doubles as the fixed treasury for Address<…>. */
const TREASURY = pubkey("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T");

/** The program's authority PDA ["config"]: mint and freeze authority, vault owner. */
export interface Config {
  bump: u8;
}

export function setup(payer: Mut<Signer>, config: Init<Config>, systemProgram: SystemProgram): void {
  config.bump = config.create(payer, ["config"]);
}

/** A new mint (a keypair the client generated) with the config PDA as mint and freeze authority. */
export function createMint(payer: Mut<Signer>, mint: Mut<Signer>, config: Account<Config>, systemProgram: SystemProgram, tokenProgram: TokenInterface): void {
  systemProgram.createAccount(payer, mint, rentExempt(MINT_SIZE), MINT_SIZE, tokenProgram.key);
  tokenProgram.initializeMint2(mint, 6n, config.key, config.key);
  // The account was created by a CPI in this instruction: its length must be current.
  require(mint.dataLen === MINT_SIZE, "data length refreshed after the CPI");
}

/** A program-owned token vault at PDA ["vault", mint], owned by the config PDA. */
export function createVault(
  payer: Mut<Signer>,
  vault: Mut<AccountInfo>,
  mint: Mint,
  config: Account<Config>,
  systemProgram: SystemProgram,
  tokenProgram: TokenInterface,
  bump: u8,
): void {
  systemProgram.createAccount(payer, vault, rentExempt(TOKEN_ACCOUNT_SIZE), TOKEN_ACCOUNT_SIZE, tokenProgram.key, ["vault", mint.key, bump]);
  tokenProgram.initializeAccount3(vault, mint, config.key);
}

export function mintTo(mint: HasOne<Mut<Mint>, "mintAuthority">, to: Mut<TokenAccount>, mintAuthority: Account<Config>, tokenProgram: TokenInterface, amount: u64): void {
  tokenProgram.mintTo(mint, to, mintAuthority, amount, ["config", mintAuthority.bump]);
}

/** The vault must hold `mint` and belong to `owner` (the config PDA). */
export function delegate(
  vault: HasOne<Mut<TokenAccount>, "mint" | "owner">,
  mint: Mint,
  owner: Account<Config>,
  spender: AccountInfo,
  tokenProgram: TokenInterface,
  amount: u64,
): void {
  tokenProgram.approve(vault, spender, owner, amount, ["config", owner.bump]);
}

export function undelegate(vault: HasOne<Mut<TokenAccount>, "owner">, owner: Account<Config>, tokenProgram: TokenInterface): void {
  tokenProgram.revoke(vault, owner, ["config", owner.bump]);
}

export function freeze(account: Mut<TokenAccount>, mint: HasOne<Mint, "freezeAuthority">, freezeAuthority: Account<Config>, tokenProgram: TokenInterface, on: boolean): void {
  if (on) tokenProgram.freezeAccount(account, mint, freezeAuthority, ["config", freezeAuthority.bump]);
  else tokenProgram.thawAccount(account, mint, freezeAuthority, ["config", freezeAuthority.bump]);
}

/** Hand the mint authority to `next` (or drop it) and remove the freeze authority. */
export function handOver(mint: Mut<Mint>, config: Account<Config>, tokenProgram: TokenInterface, next: Pubkey, keep: boolean): void {
  tokenProgram.setAuthority(mint, config, AuthorityType.FreezeAccount, null, ["config", config.bump]);
  tokenProgram.setAuthority(mint, config, AuthorityType.MintTokens, keep ? next : null, ["config", config.bump]);
}

/** Packs the extra fields: delegatedAmount * 1000 + isFrozen * 100 + hasDelegate * 10 + hasCloseAuthority. */
export function inspect(account: TokenAccount, mint: Mint): u64 {
  let v = account.delegatedAmount * 1000n;
  if (account.isFrozen) v += 100n;
  if (account.delegate !== null) v += 10n;
  if (account.closeAuthority !== null) v += 1n;
  require(!account.isNative, "not wrapped SOL");
  require(account.tokenProgram === mint.tokenProgram, "same token program");
  return v;
}

/** 1 when the mint has a mint authority equal to `who`, 2 when none, 0 otherwise; +10 when it still has a freeze authority. */
export function authorities(mint: Mint, who: Pubkey): u64 {
  let v = 0n;
  const a = mint.mintAuthority;
  if (a === null) v = 2n;
  else if (a === who) v = 1n;
  if (mint.freezeAuthority !== null) v += 10n;
  return v;
}

/** The token account must be the owner's associated token account. */
export function checkAta(account: Ata<TokenAccount, "owner", "mint">, owner: AccountInfo, mint: Mint): u64 {
  return account.amount;
}

/** Fees may only go to the fixed treasury. */
export function payFee(payer: Mut<Signer>, treasury: Address<Mut<AccountInfo>, "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T">, systemProgram: SystemProgram, amount: u64): void {
  require(treasury.key === TREASURY, "treasury");
  systemProgram.transfer(payer, treasury, amount);
}

/** Wrapped SOL: after lamports arrive, syncNative updates the token amount. */
export function wrap(payer: Mut<Signer>, account: Mut<TokenAccount>, systemProgram: SystemProgram, tokenProgram: TokenInterface, lamports: u64): u64 {
  systemProgram.transfer(payer, account, lamports);
  tokenProgram.syncNative(account);
  require(account.isNative, "wrapped SOL");
  return account.amount;
}
