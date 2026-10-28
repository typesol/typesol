// some / every / find / findIndex / reduce / includes / indexOf / forEach on Vec, FixedArray, FixedVec and Vec arguments.
import {
  type Account,
  type FixedVec,
  type Init,
  type Mut,
  type Pubkey,
  type Signer,
  type SystemProgram,
  type Vec,


  fixedArray,
  fixedVec,
  i64,
  require,
  u64,
} from "typesol";

export interface Order {
  qty: u64;
  open: boolean;
}

export interface Book {
  orders: FixedVec<Order, 8>;
  admins: FixedVec<Pubkey, 4>;
  log: Vec<u64>;
}

export function setup(payer: Mut<Signer>, book: Init<Book>, systemProgram: SystemProgram): void {
  book.create(payer, ["book", payer.key]);
  book.orders = fixedVec([
    { qty: 5n, open: true },
    { qty: 0n, open: false },
    { qty: 7n, open: true },
  ]);
  book.admins.push(payer.key);
  book.log.push(3n, payer);
  book.log.push(4n, payer);
}

/** Struct elements by reference: forEach closes the open orders it finds; a captured let counts them. */
export function sweep(payer: Signer, book: Mut<Book>, limit: u64): u64 {
  let closed = 0n;
  book.orders.forEach((o) => {
    if (o.open && o.qty > limit) {
      o.open = false;
      closed += 1n;
    }
  });
  const anyOpen = book.orders.some((o) => o.open);
  const allSmall = book.orders.every((o, i) => o.qty < 10n || i > 5n);
  const firstEmpty = book.orders.findIndex((o) => o.qty === 0n);
  const total = book.orders.reduce((acc: u64, o) => acc + o.qty, 0n);
  return closed * 1_000_000n + (anyOpen ? 100_000n : 0n) + (allSmall ? 10_000n : 0n) + u64(firstEmpty + 1n) * 1000n + total;
}

/** Scalar lists: find gives an Option, includes / indexOf compare. */
export function scan(payer: Signer, book: Account<Book>, xs: Vec<u64>, who: Pubkey): i64 {
  const big = xs.find((x) => x > 10n) ?? 0n;
  const arr = fixedArray<u64, 4>(2n);
  arr.set(3n, 9n);
  const where = arr.indexOf(9n);
  const missing = arr.indexOf(5n);
  const isAdmin = book.admins.includes(who);
  const logSum = book.log.reduce((a, x) => a + x, 0n);
  require(missing === -1n, "missing");
  return i64(big) * 1000n + where * 100n + (isAdmin ? 10n : 0n) + i64(logSum);
}
