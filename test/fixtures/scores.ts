import { type FixedArray, type Init, type Mut, type Pubkey, type Signer, type SystemProgram, type u8, type u64, require } from "typesol";

/** A leaderboard with fixed slots: exercises arrays, loops and helpers. */
export interface Board {
  admin: Pubkey;
  scores: FixedArray<u64, 8>;
  players: FixedArray<Pubkey, 8>;
  used: FixedArray<boolean, 8>;
  count: u8;
}

function max(a: u64, b: u64): u64 {
  if (a > b) {
    return a;
  }
  return b;
}

/** Sum 1..n with a loop that skips multiples of `skip` and stops past `cap`. */
function sumTo(n: u64, skip: u64, cap: u64): u64 {
  let total = 0n;
  for (let i = 1n; i <= n; i++) {
    if (i % skip === 0n) {
      continue;
    }
    total += i;
    if (total > cap) {
      break;
    }
  }
  return total;
}

function isAdmin(who: Pubkey, admin: Pubkey): boolean {
  return who === admin;
}

export function setup(admin: Mut<Signer>, board: Init<Board>, systemProgram: SystemProgram): void {
  board.create(admin, ["board", admin.key]);
  board.admin = admin.key;
}

export function submit(admin: Signer, board: Mut<Board>, player: Pubkey, score: u64): void {
  require(isAdmin(admin.key, board.admin), "admin only");
  // Update the player's slot if present, else take the first free one.
  let slot = board.scores.length;
  let i = 0n;
  while (i < board.scores.length) {
    if (board.used.get(i) && board.players.get(i) === player) {
      slot = i;
      break;
    }
    if (!board.used.get(i) && slot === board.scores.length) {
      slot = i;
    }
    i += 1n;
  }
  require(slot < board.scores.length, "board is full");
  if (!board.used.get(slot)) {
    board.used.set(slot, true);
    board.players.set(slot, player);
    board.count++;
  }
  board.scores.set(slot, max(board.scores.get(slot), score));
}

export function poke(board: Mut<Board>, index: u64, n: u64, skip: u64, cap: u64): void {
  board.scores.set(index, sumTo(n, skip, cap));
}
