// Closures: local functions that read and write the enclosing function's variables, expanded where they are called.
import { type Init, type Mut, type Signer, type SystemProgram, type Vec, type u64, require } from "typesol";

export interface Item {
  qty: u64;
  price: u64;
}

export interface Cart {
  owner: u64;
  total: u64;
  items: Vec<Item>;
}

export function setup(payer: Mut<Signer>, cart: Init<Cart>, systemProgram: SystemProgram): void {
  cart.create(payer, ["cart", payer.key]);
  cart.items.push({ qty: 2n, price: 10n }, payer);
  cart.items.push({ qty: 1n, price: 7n }, payer);
}

/** A counter closure writes the enclosing let; a block at the call site declaring `inc` does not change what it reads. */
export function counter(start: u64, step: u64): u64 {
  let n = start;
  const inc = step;
  const bump = (): void => {
    n += inc;
  };
  bump();
  {
    const inc = 1000n;
    bump();
    n += inc - 1000n;
  }
  const twice = (k: u64): u64 => {
    bump();
    return k * 2n + n;
  };
  return twice(1n);
}

/** Early returns from a block body, and a closure calling another one. */
export function classify(x: u64, limit: u64): u64 {
  const over = (v: u64): boolean => v > limit;
  const grade = (v: u64): u64 => {
    if (v === 0n) return 0n;
    if (over(v)) return 2n;
    for (let i = 0n; i < 3n; i++) if (v === i) return 9n;
    return 1n;
  };
  return grade(x) * 10n + grade(x + limit);
}

/** Closures over accounts and struct references: writes reach the account. */
export function checkout(payer: Signer, cart: Mut<Cart>, discount: u64): u64 {
  const lineTotal = (it: Item): u64 => it.qty * it.price - discount;
  const add = (v: u64): void => {
    cart.total += v;
  };
  for (const it of cart.items) add(lineTotal(it));
  const first = cart.items.get(0n);
  const restock = (k: u64): void => {
    first.qty += k;
  };
  restock(3n);
  require(cart.total > 0n, "empty");
  return cart.total;
}

/** Helpers taking functions: an instance per function passed. */
function applyTwice(f: (x: u64) => u64, v: u64): u64 {
  return f(f(v));
}
function compose(f: (x: u64) => u64, g: (x: u64) => u64, v: u64): u64 {
  return applyTwice(f, g(v));
}
const inc = (x: u64): u64 => x + 1n;

export function higher(x: u64): u64 {
  const dbl = (v: u64): u64 => v * 2n;
  return applyTwice(inc, x) * 1000n + compose(dbl, inc, x);
}

/** Arrows written as helper arguments, typed by the parameter they are passed for or by their own annotations. */
export function lambdas(x: u64): u64 {
  const a = applyTwice((v) => v * 3n, x);
  const b = compose((v: u64): u64 => v + 10n, function (v) { return v - 1n; }, x);
  return a * 1000n + b;
}
