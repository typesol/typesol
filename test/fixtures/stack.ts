import { type FixedString, type Init, type Mut, type Signer, type SystemProgram, type u64, type Vec } from "typesol";

/** Vec edge cases: pop return values, the 10 KiB growth limit, shrinking. */
export interface Stack {
  owner: u64;
  items: Vec<u64>;
}

export interface Blobs {
  owner: u64;
  blobs: Vec<FixedString<1000>>;
}

export function makeStack(payer: Mut<Signer>, stack: Init<Stack>, systemProgram: SystemProgram): void {
  stack.create(payer, ["stack", payer.key]);
}

export function pushMany(payer: Mut<Signer>, stack: Mut<Stack>, systemProgram: SystemProgram, from: u64, count: u64): void {
  for (let i = 0n; i < count; i++) {
    stack.items.push(from + i, payer);
  }
}

export function popOne(stack: Mut<Stack>): u64 {
  return stack.items.pop();
}

export function makeBlobs(payer: Mut<Signer>, blobs: Init<Blobs>, systemProgram: SystemProgram, count: u64): void {
  blobs.create(payer, ["blobs", payer.key]);
  for (let i = 0n; i < count; i++) {
    blobs.blobs.push("x", payer);
  }
}
