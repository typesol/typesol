// Struct, FixedArray and Vec<struct> instruction arguments, struct locals, and sending them through CPI.
import {
  type FixedArray,
  type FixedString,
  type Init,
  type Mut,
  type Option,
  type Signer,
  type SystemProgram,
  type UncheckedProgram,
  type Vec,
  type u8,
  u64,
  invoke,
  sighash,
  writable,
} from "typesol";

export enum Side {
  Bid,
  Ask,
}

export interface Order {
  side: Side;
  price: u64;
  qty: u64;
  tag: FixedString<8>;
  flags: FixedArray<boolean, 2>;
  note: Option<u64>;
}

export interface Book {
  count: u64;
  total: u64;
  last: Order;
  ids: FixedArray<u8, 4>;
}

export function init(payer: Mut<Signer>, book: Init<Book>, systemProgram: SystemProgram): void {
  book.create(payer, ["book", payer.key]);
}

export function place(book: Mut<Book>, order: Order): void {
  book.last = order;
  book.count += 1n;
  book.total += order.price * order.qty;
}

export function placeMany(book: Mut<Book>, orders: Vec<Order>): u64 {
  for (let i = 0n; i < orders.length; i++) {
    const o = orders.get(i);
    book.total += o.qty;
  }
  book.count += orders.length;
  return orders.length;
}

export function setIds(book: Mut<Book>, ids: FixedArray<u8, 4>): u64 {
  book.ids = ids;
  return u64(ids.get(3n));
}

/** A struct local: built from a literal, edited, then stored (structs are copied on assignment). */
export function local(book: Mut<Book>): u64 {
  const o: Order = { side: Side.Ask, price: 5n, qty: 2n, tag: "loc", flags: book.last.flags, note: null };
  o.qty = o.qty + 1n;
  book.last = o;
  return book.last.qty;
}

/** Forward an Order and a Vec<Order> to this same program through CPI. */
export function forward(book: Mut<Book>, self: UncheckedProgram, order: Order, orders: Vec<Order>): void {
  invoke(self, [writable(book)], [sighash("place"), order]);
  invoke(self, [writable(book)], [sighash("placeMany"), orders]);
}
