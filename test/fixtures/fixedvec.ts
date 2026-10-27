import {
  type FixedString,
  type FixedVec,
  type Init,
  type Mut,
  type Pubkey,
  type Signer,
  type SystemProgram,
  type Vec,
  type u8,
  type u64,
  fixedVec,
  require,
} from "typesol";

export interface Member {
  who: Pubkey;
  weight: u64;
}

export interface Ballot {
  choice: u8;
  notes: FixedVec<FixedString<8>, 2>;
}

/** Two FixedVecs and a nested one before the trailing (growable) Vec. */
export interface Board {
  bump: u8;
  owners: FixedVec<Pubkey, 3>;
  members: FixedVec<Member, 4>;
  last: Ballot;
  total: u64;
  log: Vec<u64>;
}

export function create(payer: Mut<Signer>, board: Init<Board>, systemProgram: SystemProgram): void {
  board.bump = board.create(payer, ["board", payer.key]);
  board.owners.push(payer.key);
  board.last = { choice: 1n, notes: fixedVec(["hi"]) };
}

export function addOwner(payer: Mut<Signer>, board: Mut<Board>, owner: Pubkey): void {
  for (const o of board.owners) require(o !== owner, "already an owner");
  board.owners.push(owner);
}

export function addMember(payer: Mut<Signer>, board: Mut<Board>, systemProgram: SystemProgram, key: Pubkey, weight: u64): void {
  board.members.push({ who: key, weight });
  board.log.push(weight, payer);
  let total = 0n;
  for (const m of board.members) total += m.weight;
  board.total = total;
}

export function dropMember(payer: Mut<Signer>, board: Mut<Board>): u64 {
  const m = board.members.get(board.members.length - 1n);
  const w = m.weight;
  board.members.pop();
  board.total -= w;
  return board.members.length;
}

export function note(payer: Mut<Signer>, board: Mut<Board>, text: string): void {
  if (board.last.notes.length === 2n) board.last.notes.set(1n, text);
  else board.last.notes.push(text);
}

export function reset(payer: Mut<Signer>, board: Mut<Board>): void {
  board.owners = fixedVec([payer.key]);
  board.members.clear();
  board.total = 0n;
}
