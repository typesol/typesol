import { type Account, type FixedArray, type Mut, type Pubkey, type Signer, type u64, type Zeroed, emit, require } from "typesol";
import { Side, crosses, min } from "./math";
import { type Fill, type Order, BookError } from "./types";

/**
 * A ~28 KiB central limit order book in one account: too big for Init<T> (10 KiB), so the client
 * allocates it and the program takes it as Zeroed<Book>. Split over three files.
 */
export interface Book {
  admin: Pubkey;
  nextId: u64;
  fills: u64;
  bids: FixedArray<Order, 256>;
  asks: FixedArray<Order, 256>;
}

const MAX_MATCHES = 4n;

export function init(admin: Signer, book: Zeroed<Book>): void {
  book.admin = admin.key;
  book.nextId = 1n;
}

/** Match against the opposite side (best price first, at most 4 fills), then rest the remainder. Returns the order id. */
export function place(trader: Signer, book: Mut<Book>, side: Side, price: u64, qty: u64): u64 {
  require(price > 0n && qty > 0n, BookError.ZeroQty);
  const id = book.nextId;
  book.nextId += 1n;
  let left = qty;
  let matches = 0n;
  while (left > 0n && matches < MAX_MATCHES) {
    // Best opposite order: lowest ask for a bid, highest bid for an ask; ties go to the older order.
    let best = 256n;
    for (let i = 0n; i < 256n; i++) {
      const o = side === Side.Bid ? book.asks.get(i) : book.bids.get(i);
      if (o.qty > 0n) {
        const ok = side === Side.Bid ? crosses(price, o.price) : crosses(o.price, price);
        if (ok) {
          if (best === 256n) {
            best = i;
          } else {
            const b = side === Side.Bid ? book.asks.get(best) : book.bids.get(best);
            const better = side === Side.Bid ? o.price < b.price : o.price > b.price;
            if (better || (o.price === b.price && o.id < b.id)) {
              best = i;
            }
          }
        }
      }
    }
    if (best === 256n) {
      break;
    }
    if (side === Side.Bid) {
      const take = min(left, book.asks.get(best).qty);
      book.asks.get(best).qty -= take;
      left -= take;
      emit<Fill>({ maker: book.asks.get(best).id, taker: id, price: book.asks.get(best).price, qty: take });
    } else {
      const take = min(left, book.bids.get(best).qty);
      book.bids.get(best).qty -= take;
      left -= take;
      emit<Fill>({ maker: book.bids.get(best).id, taker: id, price: book.bids.get(best).price, qty: take });
    }
    book.fills += 1n;
    matches += 1n;
  }
  if (left > 0n) {
    let slot = 256n;
    for (let i = 0n; i < 256n; i++) {
      const free = side === Side.Bid ? book.bids.get(i).qty === 0n : book.asks.get(i).qty === 0n;
      if (free) {
        slot = i;
        break;
      }
    }
    require(slot < 256n, BookError.Full);
    if (side === Side.Bid) {
      book.bids.set(slot, { id, owner: trader.key, price, qty: left });
    } else {
      book.asks.set(slot, { id, owner: trader.key, price, qty: left });
    }
  }
  return id;
}

export function cancel(trader: Signer, book: Mut<Book>, side: Side, id: u64): void {
  for (let i = 0n; i < 256n; i++) {
    const o = side === Side.Bid ? book.bids.get(i) : book.asks.get(i);
    if (o.id === id && o.qty > 0n) {
      require(o.owner === trader.key, BookError.NotFound);
      if (side === Side.Bid) {
        book.bids.get(i).qty = 0n;
      } else {
        book.asks.get(i).qty = 0n;
      }
      return;
    }
  }
  require(false, BookError.NotFound);
}

/** Best resting price on a side, or 0 when empty. */
export function best(book: Account<Book>, side: Side): u64 {
  let p = 0n;
  for (let i = 0n; i < 256n; i++) {
    const o = side === Side.Bid ? book.bids.get(i) : book.asks.get(i);
    if (o.qty > 0n) {
      if (p === 0n || (side === Side.Bid ? o.price > p : o.price < p)) {
        p = o.price;
      }
    }
  }
  return p;
}
