// Evaluation order through helpers, literals and builtins.
import { type Init, type Mut, type Signer, type SystemProgram, type Pubkey, type u64, type Vec, mulDiv, emit } from "typesol";

export interface P { x: u64; y: u64; }
export interface Holder {
  owner: Pubkey;
  c: u64;
  a: u64;
  p: P;
  q: P;
  items: Vec<u64>;
}
export interface Ev { a: u64; b: u64; }

function bump(h: Mut<Holder>): u64 { h.c += 1n; return h.c; }
function keep(old: Pubkey, h: Mut<Holder>, next: Pubkey): Pubkey { h.owner = next; return old; }
function readAfterReplace(p: P, h: Mut<Holder>): u64 { h.p = { x: 100n, y: 100n }; return p.x; }
function inc(h: Mut<Holder>): u64 { h.a += 10n; return 1n; }

export function init(payer: Mut<Signer>, h: Init<Holder>, systemProgram: SystemProgram): void {
  h.create(payer, ["h"]);
  h.owner = payer.key;
  h.a = 5n;
  h.p = { x: 1n, y: 2n };
}
export function pushLen(payer: Mut<Signer>, h: Mut<Holder>, systemProgram: SystemProgram): void {
  h.items.push(h.items.length, payer);
}
export function litOrder(h: Mut<Holder>): void {
  h.q = { y: bump(h), x: h.c };
}
export function evOrder(h: Mut<Holder>): void {
  emit<Ev>({ b: bump(h), a: h.c });
}
export function swapOwner(h: Mut<Holder>, next: Pubkey): Pubkey { return keep(h.owner, h, next); }
export function structParam(h: Mut<Holder>): u64 { return readAfterReplace(h.p, h); }
export function md(h: Mut<Holder>): u64 { return mulDiv(h.a, inc(h), 1n); }
