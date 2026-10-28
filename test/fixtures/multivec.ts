// Several growable Vecs in one account, declared anywhere: stored after the fixed-size fields, in the order declared.
import { type Account, type Init, type Mut, type Pubkey, type Signer, type SystemProgram, type Vec, type u32, type u8, u64 } from "typesol";

export interface Entry {
  id: u32;
  score: u64;
}

export interface Bag {
  owner: Pubkey;
  tags: Vec<u64>;
  count: u64;
  entries: Vec<Entry>;
  marks: Vec<u8>;
}

export function open(payer: Mut<Signer>, bag: Init<Bag>, systemProgram: SystemProgram): void {
  bag.create(payer, ["bag", payer.key]);
  bag.owner = payer.key;
}

export function add(payer: Mut<Signer>, bag: Mut<Bag>, systemProgram: SystemProgram, tag: u64, id: u32, mark: u8): void {
  bag.tags.push(tag, payer);
  bag.entries.push({ id, score: tag * 2n }, payer);
  bag.marks.push(mark, payer);
  bag.count += 1n;
}

export function dropTag(payer: Signer, bag: Mut<Bag>): u64 {
  return bag.tags.pop();
}

export function clearEntries(payer: Signer, bag: Mut<Bag>): void {
  bag.entries.clear();
}

/** Reads every Vec after the others moved. */
export function total(bag: Account<Bag>): u64 {
  let t = bag.count * 1000n;
  for (const x of bag.tags) t += x;
  for (const e of bag.entries) t += e.score * 100n;
  for (const m of bag.marks) t += u64(m) * 10_000n;
  return t;
}
