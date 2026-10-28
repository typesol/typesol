// Strings built with templates and +=: one join per template, in-place growth for the newest heap string. The results
// must be exactly JS's, including views taken before a string grows and account text read before it changes.
import { type FixedString, type Mut, type Pubkey, type u64, log, pubkey } from "typesol";

const KEY = pubkey("ww9C83noARSQVBnqmCUmaVdbJjmiwcV9j2LkXYMoUCV");

export interface Note {
  name: FixedString<16>;
}

function rename(note: Mut<Note>, to: string): string {
  note.name = to;
  return "!";
}

export function build(n: u64, word: string, key: Pubkey): void {
  let s = "a";
  const before = s;
  s += "b";
  s += `${n}-${word}`;
  const mid = s;
  for (let i = 0n; i < 3n; i++) s += `[${i}]`;
  let other = mid;
  other += "x";
  s += "y";
  log(`${before}|${mid}|${s}|${other}`);
  log(`${KEY}|${key}|${true}|${7n}`);
}

/** Account text read by an earlier piece keeps its old value when a later piece changes it. */
export function reread(note: Mut<Note>, to: string): void {
  log(`${note.name}${rename(note, to)}${note.name}`);
  let s = `${note.name}`;
  s += `${rename(note, "z")}${note.name}`;
  log(s);
}
