import { type Init, type Mut, type Signer, type SystemProgram, type Pubkey, type u64, type Vec, associatedTokenAddress, requirePda } from "typesol";
export interface Holder { owner: Pubkey; items: Vec<u64>; }
function setOwner(h: Mut<Holder>, next: Pubkey): Pubkey { h.owner = next; return next; }
export function init(payer: Mut<Signer>, h: Init<Holder>, systemProgram: SystemProgram): void {
  h.create(payer, ["h"]);
  h.owner = payer.key;
}
export function ata(h: Mut<Holder>, next: Pubkey, mint: Pubkey, tp: Pubkey): Pubkey {
  return associatedTokenAddress(h.owner, setOwner(h, next), tp);
}
export function ata2(owner: Pubkey, mint: Pubkey, tp: Pubkey): Pubkey {
  return associatedTokenAddress(owner, mint, tp);
}
export function push(payer: Mut<Signer>, h: Mut<Holder>, systemProgram: SystemProgram, v: u64): void { h.items.push(v, payer); }
export function swapRemove(h: Mut<Holder>, i: u64): u64 { h.items.set(i, h.items.pop()); return h.items.length; }
