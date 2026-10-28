// Vec<string> instruction arguments (Anchor's Vec<String>): read, iterated, searched, stored and sent on through CPI.
import { type FixedString, type FixedVec, type Mut, type UncheckedProgram, type Vec, type u64, byteLength, invoke, log, require, sighash } from "typesol";

/** @layout borsh */
export interface Shelf {
  titles: FixedVec<FixedString<16>, 4>;
}

/** Total bytes; logs the first and refuses "bad". */
export function words(xs: Vec<string>, tail: u64): u64 {
  require(!xs.includes("bad"), "bad word");
  if (xs.length > 0n) log(`first ${xs.get(0n)}`);
  let n = 0n;
  for (const x of xs) n += byteLength(x);
  return n * 1000n + tail;
}

/** The same words sent to `words` on this program, re-encoded as Borsh. */
export function relay(self: UncheckedProgram, xs: Vec<string>): void {
  invoke(self, [], [sighash("words"), xs, 7n]);
}

export function shelve(shelf: Mut<Shelf>, xs: Vec<string>): void {
  for (const x of xs) shelf.titles.push(x);
}

/** A helper returning a string: a copy the caller owns. */
function label(shelf: Mut<Shelf>, i: u64): string {
  if (i >= shelf.titles.length) return "none";
  return `#${i} ${shelf.titles.get(i)}`;
}

/** Returns a string (Borsh String return data); the helper's copy survives the shelf changing. */
export function describe(shelf: Mut<Shelf>, i: u64): string {
  const before = label(shelf, i);
  shelf.titles.clear();
  return `${before} / ${label(shelf, i)}`;
}
