import { type Account, type Init, type Mut, type Option, type Pubkey, type Signer, type SystemProgram, type u16, type u64, type u8, type FixedString } from "typesol";

export interface Quote {
  owner: Pubkey;
  price: u64;
  fee: u16;
  open: boolean;
  limit: Option<u64>;
  label: FixedString<8>;
}

export interface Market {
  bump: u8;
  last: Quote;
}

function quote(owner: Pubkey, price: u64, limit: Option<u64>): Quote {
  return { owner, price, fee: 30n, open: true, limit, label: "spot" };
}

export function setup(admin: Mut<Signer>, market: Init<Market>, systemProgram: SystemProgram, price: u64): void {
  market.bump = market.create(admin, ["market", admin.key]);
  market.last = quote(admin.key, price, null);
}

/** A literal built in the instruction. */
export function preview(owner: Signer, price: u64, limit: Option<u64>): Quote {
  return { owner: owner.key, price: price * 2n, fee: 5n, open: false, limit, label: "preview" };
}

/** A stored struct, and a helper's result. */
export function last(market: Account<Market>): Quote {
  return market.last;
}

export function fresh(owner: Signer, price: u64): Quote {
  return quote(owner.key, price, 9n);
}
