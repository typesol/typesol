// Stake program CPIs with this program's PDA ["authority"] as staker and withdrawer.
import { type AccountInfo, type Mut, type Pubkey, type StakeProgram, type u8, type u64 } from "typesol";

export function setup(stake: Mut<AccountInfo>, rent: AccountInfo, authority: AccountInfo, stakeProgram: StakeProgram): void {
  stakeProgram.initialize(stake, rent, authority.key, authority.key);
}

export function delegate(
  stake: Mut<AccountInfo>,
  vote: AccountInfo,
  clock: AccountInfo,
  history: AccountInfo,
  config: AccountInfo,
  authority: AccountInfo,
  stakeProgram: StakeProgram,
  bump: u8,
): void {
  stakeProgram.delegate(stake, vote, clock, history, config, authority, ["authority", bump]);
}

export function deactivate(stake: Mut<AccountInfo>, clock: AccountInfo, authority: AccountInfo, stakeProgram: StakeProgram, bump: u8): void {
  stakeProgram.deactivate(stake, clock, authority, ["authority", bump]);
}

export function withdraw(
  stake: Mut<AccountInfo>,
  to: Mut<AccountInfo>,
  clock: AccountInfo,
  history: AccountInfo,
  authority: AccountInfo,
  stakeProgram: StakeProgram,
  bump: u8,
  lamports: u64,
): void {
  stakeProgram.withdraw(stake, to, clock, history, authority, lamports, ["authority", bump]);
}

/** Give the staker role to `next`. */
export function handOver(stake: Mut<AccountInfo>, clock: AccountInfo, authority: AccountInfo, stakeProgram: StakeProgram, bump: u8, next: Pubkey): void {
  stakeProgram.authorize(stake, clock, authority, next, "staker", ["authority", bump]);
}
