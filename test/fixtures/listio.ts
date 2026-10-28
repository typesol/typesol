// Lists in and out: FixedVec arguments (a Borsh Vec of at most N), FixedVec and Vec fields in events.
import { type Account, type FixedVec, type Init, type Mut, type Signer, type SystemProgram, type Vec, type u64, emit, fixedVec } from "typesol";

export interface Holder {
  xs: FixedVec<u64, 4>;
}

export interface Listed {
  n: u64;
  xs: FixedVec<u64, 4>;
  tags: Vec<u64>;
}

export function setup(payer: Mut<Signer>, holder: Init<Holder>, systemProgram: SystemProgram): void {
  holder.create(payer, ["holder", payer.key]);
  holder.xs = fixedVec([5n, 6n]);
}

export function fire(payer: Signer, holder: Account<Holder>, ids: FixedVec<u64, 3>, tags: Vec<u64>): u64 {
  emit<Listed>({ n: ids.length, xs: holder.xs, tags });
  emit<Listed>({ n: 0n, xs: fixedVec([9n]), tags: tags });
  return ids.reduce((a: u64, x) => a + x, 0n);
}
