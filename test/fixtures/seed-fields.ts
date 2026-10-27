import { type Account, type AccountInfo, type Init, type Mut, type Pubkey, type Seeds, type Signer, type SystemProgram, type u8, type u64 } from "typesol";

export enum Tier {
  Basic,
  Pro,
}

export interface Book {
  owner: Pubkey;
  id: u64;
  tier: Tier;
  bump: u8;
}

export function open(payer: Mut<Signer>, book: Init<Book>, systemProgram: SystemProgram, id: u64, tier: Tier): void {
  book.bump = book.create(payer, ["book", payer.key, id]);
  book.owner = payer.key;
  book.id = id;
  book.tier = tier;
}

/** The book checks itself from its own fields (Anchor `seeds = [b"book", book.owner, book.id]`). */
export function touch(book: Seeds<Account<Book>, ["book", "@book.owner", "@book.id"], "bump">): u8 {
  return book.pdaBump;
}

/** Another account's PDA, seeded from the book's fields; returns the canonical bump found. */
export function vault(book: Account<Book>, vault: Seeds<AccountInfo, ["vault", "@book.owner", "@book.tier"]>): u8 {
  return vault.pdaBump;
}
