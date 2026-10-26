import { type u64, rentExempt } from "typesol";

export function rent(space: u64): u64 {
  return rentExempt(space);
}
