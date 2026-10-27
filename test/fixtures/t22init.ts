import { type Mut, type Pubkey, type Signer, type SystemProgram, type Token2022Program, type TokenProgram, type i16, type u16, type u64, rentExempt } from "typesol";

/** A mint with most extensions at once (they are compatible), then InitializeMint2. */
export function rich(
  payer: Mut<Signer>,
  mint: Mut<Signer>,
  token: Token2022Program,
  systemProgram: SystemProgram,
  space: u64,
  admin: Pubkey,
  hook: Pubkey,
  bps: u16,
  maxFee: u64,
  rate: i16,
): void {
  systemProgram.createAccount(payer, mint, rentExempt(space), space, token.key);
  token.initializeTransferFeeConfig(mint, admin, null, bps, maxFee);
  token.initializeMintCloseAuthority(mint, admin);
  token.initializePermanentDelegate(mint, admin);
  token.initializeDefaultAccountState(mint, true);
  token.initializeMetadataPointer(mint, admin, mint.key);
  token.initializeGroupPointer(mint, null, mint.key);
  token.initializeGroupMemberPointer(mint, admin, null);
  token.initializeTransferHook(mint, admin, hook);
  token.initializeInterestBearingMint(mint, admin, rate);
  token.initializeMint2(mint, 6n, admin, admin);
}

/** A soul-bound mint, and an immutable-owner account for it. */
export function soulbound(
  payer: Mut<Signer>,
  mint: Mut<Signer>,
  account: Mut<Signer>,
  token: Token2022Program,
  systemProgram: SystemProgram,
  mintSpace: u64,
  accountSpace: u64,
  owner: Pubkey,
): void {
  systemProgram.createAccount(payer, mint, rentExempt(mintSpace), mintSpace, token.key);
  token.initializeNonTransferableMint(mint);
  token.initializeMint2(mint, 0n, payer.key, null);
  systemProgram.createAccount(payer, account, rentExempt(accountSpace), accountSpace, token.key);
  token.initializeImmutableOwner(account);
  token.initializeAccount3(account, mint, owner);
}

