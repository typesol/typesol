import { type Account, type FixedArray, type Init, type Mut, type Signer, type SystemProgram, type u64, type u8, require } from "typesol";

export interface Point {
  x: u64;
  y: u64;
}

export interface Board {
  bump: u8;
  home: Point;
  path: FixedArray<Point, 3>;
}

function at(x: u64, y: u64): Point {
  return { x, y };
}

/** A struct result from another helper's, changed before it is returned. */
function shifted(p: Point, by: u64): Point {
  const q: Point = moved(p, by);
  q.y += 1n;
  return q;
}

function moved(p: Point, by: u64): Point {
  return at(p.x + by, p.y + by);
}

/** Returns a place: a copy of the account's stored Point. */
function homeOf(board: Account<Board>): Point {
  return board.home;
}

function farther(a: Point, b: Point): Point {
  if (a.x + a.y >= b.x + b.y) return a;
  return b;
}

export function setup(admin: Mut<Signer>, board: Init<Board>, systemProgram: SystemProgram): void {
  board.bump = board.create(admin, ["board", admin.key]);
  board.home = at(3n, 4n);
  board.path.set(0n, shifted(board.home, 10n));
  board.path.set(1n, farther(at(1n, 1n), at(0n, 5n)));
}

/** Field access on a call, a copy that the account keeps after it changes, and a const from a helper. */
export function check(board: Mut<Board>): u64 {
  const before: Point = homeOf(board);
  board.home = at(100n, 200n);
  require(before.x === 3n && homeOf(board).y === 200n, "copies, not references");
  const p = moved(before, 1n);
  board.path.set(2n, p);
  return at(7n, 9n).y + p.x;
}
