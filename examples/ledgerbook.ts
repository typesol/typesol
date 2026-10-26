import {
  type Account,
  type FixedString,
  type Init,
  type Mut,
  type Option,
  type Pubkey,
  type Signer,
  type SystemProgram,
  type u64,
  type Vec,
  emit,
  require,
} from "typesol";

/** A filing book: enums, Option, and a Vec that grows the account as entries are filed. */
export enum Status {
  Pending,
  Approved,
  Rejected,
}

export interface Entry {
  who: Pubkey;
  amount: u64;
  status: Status;
  note: FixedString<16>;
}

export interface Book {
  admin: Pubkey;
  title: FixedString<24>;
  approver: Option<Pubkey>;
  lastAmount: Option<u64>;
  /** Must be last: the account grows by one Entry per push. */
  entries: Vec<Entry>;
}

export interface Filed {
  index: u64;
  who: Pubkey;
  amount: u64;
  memo: Option<u64>;
}

export enum BookError {
  NotAdmin = "Only the admin can do this",
  NoApprover = "This book has no approver",
  NotApprover = "Only the approver can decide",
  AlreadyDecided = "Entry was already decided",
}

export function create(admin: Mut<Signer>, book: Init<Book>, systemProgram: SystemProgram, title: string, approver: Option<Pubkey>): void {
  book.create(admin, ["book", admin.key, title]);
  book.admin = admin.key;
  book.title = title;
  book.approver = approver;
}

export function file(who: Mut<Signer>, book: Mut<Book>, systemProgram: SystemProgram, amount: u64, note: string, memo: Option<u64>): void {
  emit<Filed>({ index: book.entries.length, who: who.key, amount, memo });
  book.entries.push({ who: who.key, amount, status: Status.Pending, note }, who);
  book.lastAmount = amount;
}

export function decide(approver: Signer, book: Mut<Book>, index: u64, approve: boolean): void {
  const current = book.approver;
  require(current !== null, BookError.NoApprover);
  require(approver.key === current, BookError.NotApprover);
  require(book.entries.get(index).status === Status.Pending, BookError.AlreadyDecided);
  if (approve) {
    book.entries.get(index).status = Status.Approved;
  } else {
    book.entries.get(index).status = Status.Rejected;
  }
}

/** Approve many entries at once from a Vec<u64> argument. */
export function approveMany(approver: Signer, book: Mut<Book>, indices: Vec<u64>): void {
  require(book.approver !== null && approver.key === book.approver, BookError.NotApprover);
  for (let i = 0n; i < indices.length; i++) {
    const at = indices.get(i);
    if (book.entries.get(at).status === Status.Pending) {
      book.entries.get(at).status = Status.Approved;
    }
  }
}

export function setApprover(admin: Signer, book: Mut<Book>, approver: Option<Pubkey>): void {
  require(admin.key === book.admin, BookError.NotAdmin);
  book.approver = approver;
}

/** Shrinks the account back to its fixed part. */
export function reset(admin: Signer, book: Mut<Book>): void {
  require(admin.key === book.admin, BookError.NotAdmin);
  book.entries.clear();
  book.lastAmount = null;
}

export function total(book: Account<Book>, status: Status): u64 {
  let sum = 0n;
  for (let i = 0n; i < book.entries.length; i++) {
    if (book.entries.get(i).status === status) {
      sum += book.entries.get(i).amount;
    }
  }
  return sum;
}
