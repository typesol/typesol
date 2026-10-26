// Regression fixture: account text copies, operand order, Option equality, Vec statements, argument validation.
import {
  type FixedString,
  type Init,
  type Mut,
  type Option,
  type Signer,
  type SystemProgram,
  type Vec,
  type u64,
  byteLength,
  remainingAccounts,
} from "typesol";

export enum Mode {
  Off,
  On,
  Auto,
}
export type Cmd = { kind: "Set"; mode: Mode } | { kind: "Noop" };

export interface P {
  x: u64;
  y: u64;
}

export interface Box {
  name: FixedString<16>;
  n: u64;
  best: Option<u64>;
  other: Option<u64>;
  home: Option<P>;
  spare: Option<P>;
  mode: Mode;
  items: Vec<u64>;
}

export interface Pts {
  pts: Vec<P>;
}

function h(a: u64, b: u64): u64 {
  return a * 100n + b;
}

export function make(payer: Mut<Signer>, box: Init<Box>, pts: Init<Pts>, systemProgram: SystemProgram): void {
  box.create(payer, ["box", payer.key]);
  pts.create(payer, ["pts", payer.key]);
  box.name = "alice";
  box.best = null;
  box.other = null;
  box.home = null;
  box.spare = null;
  box.items.push(10n, payer);
  box.items.push(20n, payer);
  box.items.push(30n, payer);
  pts.pts.push({ x: 1n, y: 1n }, payer);
  pts.pts.push({ x: 2n, y: 2n }, payer);
}

/** C1: a local keeps the text it was given ("alice"), as in JS. */
export function strAlias(box: Mut<Box>): u64 {
  const s = box.name;
  box.name = "bob";
  if (s === "alice") return 1n;
  if (s === "bob") return 2n;
  return 3n;
}

/** C1 through a ternary branch. */
export function strTernary(box: Mut<Box>, flag: boolean): u64 {
  const s = flag ? box.name : "x";
  box.name = "zz";
  return s === "bob" ? 1n : 2n;
}

/** C2: `length` is read before pop() runs: 3 + 30. */
export function lenPlusPop(box: Mut<Box>): u64 {
  return box.items.length + box.items.pop();
}

/** C2 in a comparison: 2 === 20 is false. */
export function cmpPop(box: Mut<Box>): u64 {
  if (box.items.length === box.items.pop()) return 99n;
  return box.items.length;
}

/** C2 in helper arguments: h(length before, popped) = 1 * 100 + 10. */
export function helperArgs(box: Mut<Box>): u64 {
  return h(box.items.length, box.items.pop());
}

/** C2 in compound assignment: n += pop() reads n first. */
export function compoundPop(payer: Mut<Signer>, box: Mut<Box>, systemProgram: SystemProgram): u64 {
  box.items.push(7n, payer);
  box.n = 5n;
  box.n += box.items.pop();
  return box.n;
}

/** Strings support +=, on locals and on FixedString fields. */
export function strPlusEq(box: Mut<Box>): u64 {
  let s = "a";
  s += 1n;
  s += "b";
  box.name = "ab";
  box.name += "!";
  return byteLength(s) * 100n + byteLength(box.name);
}

/** M1: Option equality follows JS. Returns a bit set. */
export function optEq(box: Mut<Box>): u64 {
  let bits = 0n;
  if (box.best === box.other) bits += 1n; // null === null
  if (box.best === 5n) bits += 2n; // null === 5 -> false
  if (box.best !== 5n) bits += 4n;
  box.best = 5n;
  if (box.best === 5n) bits += 8n;
  if (box.best === box.other) bits += 16n; // 5 vs null -> false
  box.other = 5n;
  if (box.best === box.other) bits += 32n;
  if (6n !== box.best) bits += 64n;
  box.best = null;
  box.other = null;
  return bits;
}

/** Option values in template strings print the value or "null". */
export function tplOpt(box: Mut<Box>): u64 {
  const a = `${box.best}`;
  box.best = 12345n;
  const b = `v=${box.best}`;
  box.best = null;
  return byteLength(a) * 100n + byteLength(b);
}

/** Option<struct> copies whole (tag and value), including from another Option<struct>. */
export function optStructCopy(box: Mut<Box>): u64 {
  box.spare = { x: 4n, y: 9n };
  box.home = box.spare;
  box.home = box.home;
  if (box.home === null) return 0n;
  return box.home.x * 10n + box.home.y;
}

/** M4: Vec.get() as the value of an assignment. */
export function vecGetAssign(box: Mut<Box>): u64 {
  box.n = box.items.get(0n);
  return box.n;
}

/** M4: pop() of a Vec of structs as a statement drops the last element. */
export function dropLast(pts: Mut<Pts>): u64 {
  pts.pts.pop();
  return pts.pts.length * 100n + pts.pts.get(0n).x;
}

/** S2: enum fields inside a data-enum argument are range-checked. */
export function apply(box: Mut<Box>, cmd: Cmd): void {
  if (cmd.kind === "Set") box.mode = cmd.mode;
}

/** S3: crediting a remaining account that is also a declared account would double-count lamports. */
export function skim(box: Mut<Box>): void {
  const r = remainingAccounts().get(0n);
  box.lamports = box.lamports - 1n;
  r.lamports = r.lamports + 1n;
}
