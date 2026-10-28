// some / every / find / findIndex / reduce / includes / indexOf / forEach on Vec, FixedArray, FixedVec and Vec arguments.
import {
  type Account,
  type FixedString,
  type FixedVec,
  type Init,
  type Mut,
  type Pubkey,
  type Signer,
  type SystemProgram,
  type Vec,


  byteLength,
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

export interface ChainOut {
  openCount: u64;
  doubled: u64;
  postFilterIndex: u64;
  forOfTotal: u64;
  bigLength: u64;
  bigSecond: u64;
  mappedSecond: u64;
  qtysAfterPush: u64;
  qtysSum: u64;
  openSecondQty: u64;
}

/** map / filter: fused into one loop when used right away, stored as local lists when bound. */
export function chains(payer: Signer, book: Account<Book>, xs: Vec<u64>): ChainOut {
  const openCount = book.orders.filter((o) => o.open).length;
  const doubled = book.orders
    .filter((o) => o.open)
    .map((o) => o.qty * 2n)
    .reduce((a: u64, q) => a + q, 0n);
  const postFilterIndex = book.orders.filter((o) => o.open).findIndex((o) => o.qty === 7n);
  let forOfTotal = 0n;
  for (const v of xs.filter((x) => x > 5n).map((x, i) => x * 10n + i)) {
    if (v > 200n) continue;
    forOfTotal += v;
  }
  const big: FixedVec<u64, 4> = xs.filter((x) => x > 5n);
  const mapped: FixedVec<u64, 4> = xs.filter((x) => x > 5n).map((x, i) => x * 10n + i);
  const qtys = book.orders.map((o) => o.qty);
  qtys.push(1n);
  const open = book.orders.filter((o) => o.open);
  return {
    openCount,
    doubled,
    postFilterIndex: u64(postFilterIndex),
    forOfTotal,
    bigLength: big.length,
    bigSecond: big.get(1n),
    mappedSecond: mapped.get(1n),
    qtysAfterPush: qtys.length,
    qtysSum: qtys.reduce((a: u64, q) => a + q, 0n),
    openSecondQty: open.get(1n).qty,
  };
}

/** A stored list one element too small aborts (5104), like push() on a full FixedVec. */
export function tooSmall(payer: Signer, xs: Vec<u64>): u64 {
  const ys: FixedVec<u64, 1> = xs.filter((x) => x > 0n);
  return ys.length;
}

export interface Pair {
  qty: u64;
  doubled: u64;
}

/** map to structs and to text, stored as annotated FixedVecs (each result written into its slot). */
export function pairs(payer: Signer, book: Account<Book>): u64 {
  const ps: FixedVec<Pair, 8> = book.orders.filter((o) => o.open).map((o) => ({ qty: o.qty, doubled: o.qty * 2n }));
  const names: FixedVec<FixedString<8>, 4> = book.orders.map((o) => (o.open ? "open" : "closed"));
  return ps.length * 1000n + ps.get(1n).doubled * 10n + byteLength(names.get(1n));
}
