// A growable Vec<T> pushed and popped inside helpers (the account's entry length is passed along).
import { type Init, type Mut, type Signer, type SystemProgram, type Vec, type u64 } from "typesol";
export interface Log { n: u64; items: Vec<u64> }
function add(log: Mut<Log>, payer: Mut<Signer>, x: u64): void {
  log.items.push(x, payer);
  log.n += 1n;
}
function addTwice(log: Mut<Log>, payer: Mut<Signer>, x: u64): void {
  add(log, payer, x);
  add(log, payer, x + 1n);
}
export function create(payer: Mut<Signer>, log: Init<Log>, systemProgram: SystemProgram): void {
  log.create(payer, ["log", payer.key]);
}
export function push(payer: Mut<Signer>, log: Mut<Log>, systemProgram: SystemProgram, x: u64): void {
  addTwice(log, payer, x);
}
export function drop(log: Mut<Log>): void {
  trim(log);
}
function trim(log: Mut<Log>): void {
  log.items.pop();
}
