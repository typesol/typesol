import { type Init, type Mut, type Signer, type SystemProgram, type u64, i64, now, u8, u16, u32, require } from "typesol";

/** Exercises integer widths, casts, signed math and aliasing checks. */
export interface Ledger {
  a: u64;
  b: u64;
  small: u8;
  mid: u16;
  wide: u32;
  delta: i64;
  stamp: i64;
  flag: boolean;
}

export function make(payer: Mut<Signer>, ledger: Init<Ledger>, systemProgram: SystemProgram, id: u64): void {
  ledger.create(payer, ["ledger", payer.key, id]);
  ledger.a = 100n;
  ledger.stamp = now();
}

/** Moves `amount` from a to b on two ledgers. Must refuse the same ledger twice. */
export function move(from: Mut<Ledger>, to: Mut<Ledger>, amount: u64): void {
  from.a -= amount;
  to.a += amount;
}

export function narrow(ledger: Mut<Ledger>, value: u64): void {
  ledger.small = u8(value);
  ledger.mid = u16(value);
  ledger.wide = u32(value);
}

export function signed(ledger: Mut<Ledger>, x: i64, y: i64, flag: boolean): void {
  let d = x - y;
  if (flag && d < 0n) {
    d = -d;
  } else if (!flag) {
    d = d * 2n;
  }
  ledger.delta = d;
  ledger.flag = flag;
  require(i64(ledger.a) + d >= 0n, "balance would go negative");
}

export function divide(ledger: Mut<Ledger>, by: u64): void {
  ledger.b = ledger.a / by;
  ledger.a = ledger.a % by;
}
