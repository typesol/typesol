import { type Pubkey, type u64 } from "typesol";

/** An order slot. qty == 0 marks an empty slot. */
export interface Order {
  id: u64;
  owner: Pubkey;
  price: u64;
  qty: u64;
}

export interface Fill {
  maker: u64;
  taker: u64;
  price: u64;
  qty: u64;
}

export enum BookError {
  NotAdmin = "Only the admin can do this",
  ZeroQty = "Quantity and price must be positive",
  Full = "No free slot on this side of the book",
  NotFound = "No such order of yours",
}
