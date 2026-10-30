// SPL Memo CPIs (signed by a wallet and by this program's PDA), the SlotHashes sysvar, Token-2022 token groups, and a
// @fallback for data no instruction matches.
import {
  type AccountInfo,
  type Hash,
  type MemoProgram,
  type Mut,
  type Pubkey,
  type Signer,
  type SlotHashesSysvar,
  type SystemProgram,
  type Token2022Program,
  type u8,
  instructionData,
  log,
  remainingAccounts,
  rentExempt,
  require,
  u64,
} from "typesol";

export function note(author: Signer, memoProgram: MemoProgram, text: string): void {
  memoProgram.memo(text, [author]);
}

/** A memo signed by the PDA ["desk"] and nobody else. */
export function deskNote(desk: AccountInfo, memoProgram: MemoProgram, bump: u8): void {
  memoProgram.memo("from the desk", [desk], ["desk", bump]);
}

export function unsigned(memoProgram: MemoProgram): void {
  memoProgram.memo("anyone");
}

/** The newest slot SlotHashes lists, plus its entry count. */
export function recent(slotHashes: SlotHashesSysvar): u64 {
  return slotHashes.latestSlot * 1000n + slotHashes.count;
}

export function recentHash(slotHashes: SlotHashesSysvar): Hash {
  return slotHashes.latestHash;
}

/**
 * A collection mint: GroupPointer to itself, then InitializeMint2, then the group. The account holds the pointer; its
 * lamports cover the group too, which Token-2022 adds to it.
 */
export function collection(payer: Mut<Signer>, mint: Mut<Signer>, token: Token2022Program, systemProgram: SystemProgram, space: u64, full: u64, maxSize: u64): void {
  systemProgram.createAccount(payer, mint, rentExempt(full), space, token.key);
  token.initializeGroupPointer(mint, payer.key, mint.key);
  token.initializeMint2(mint, 0n, payer.key, null);
  token.initializeTokenGroup(mint, mint, payer, payer.key, maxSize);
}

/** A member mint of `group`: GroupMemberPointer to itself, then the membership. */
export function member(payer: Mut<Signer>, mint: Mut<Signer>, group: Mut<AccountInfo>, token: Token2022Program, systemProgram: SystemProgram, space: u64, full: u64): void {
  systemProgram.createAccount(payer, mint, rentExempt(full), space, token.key);
  token.initializeGroupMemberPointer(mint, payer.key, mint.key);
  token.initializeMint2(mint, 0n, payer.key, null);
  token.initializeGroupMember(mint, mint, payer, group, payer);
}

export function resize(group: Mut<AccountInfo>, authority: Signer, token: Token2022Program, maxSize: u64): void {
  token.updateGroupMaxSize(group, authority, maxSize);
}

export function handOver(group: Mut<AccountInfo>, authority: Signer, token: Token2022Program, next: Pubkey | null): void {
  token.updateGroupAuthority(group, authority, next);
}

/** Anchor's fallback: any data no instruction matches, logged as its length, first byte and the accounts passed. */
/** @fallback */
export function legacy(): void {
  const data = instructionData();
  require(data.length > 0n, "empty data");
  log(data.length);
  log(u64(data.get(0n)));
  log(remainingAccounts().length);
}
