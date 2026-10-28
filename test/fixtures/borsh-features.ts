// @layout borsh with the rest of the language: nested fixed structs, enums, bools, lists of strings, an Option of a
// struct, helpers, InitIfNeeded, struct references, for…of and closing.
import {
  type CloseTo,
  type FixedArray,
  type FixedString,
  type FixedVec,
  type InitIfNeeded,
  type Mut,
  type Option,
  type Signer,
  type SystemProgram,
  type u16,
  require,
  u8,
  u64,
} from "typesol";

export enum Mood {
  Calm,
  Busy,
}

export interface Point {
  x: u16;
  y: u16;
}

/** @layout borsh */
export interface Book {
  bump: u8;
  title: FixedString<16>;
  open: boolean;
  mood: Mood;
  pages: FixedVec<Point, 4>;
  tags: FixedVec<FixedString<8>, 3>;
  home: Option<Point>;
  code: FixedArray<u8, 4>;
  count: u64;
}

function touch(book: Mut<Book>, by: u64): void {
  book.count += by;
}

export function upsert(payer: Mut<Signer>, book: InitIfNeeded<Book>, systemProgram: SystemProgram, title: string, tag: string): void {
  const created = book.createIfNeeded(payer, ["book", payer.key]);
  if (created) book.bump = book.pdaBump;
  book.title = title;
  if (book.tags.length < 3n) book.tags.push(tag);
  book.open = !book.open;
  book.mood = book.open ? Mood.Busy : Mood.Calm;
  touch(book, 1n);
}

export function page(payer: Signer, book: Mut<Book>, x: u16, y: u16): void {
  book.pages.push({ x, y });
  let sum = 0n;
  for (const p of book.pages) sum += u64(p.x) + u64(p.y);
  const first = book.pages.get(0n);
  first.y = first.y + 1n;
  if (sum > 10n) book.home = { x: first.x, y: first.y };
  else book.home = null;
  book.code.set(0n, u8(book.pages.length));
}

export function done(payer: Mut<Signer>, book: CloseTo<Mut<Book>, "payer">): void {
  require(book.count > 0n, "nothing done");
}
