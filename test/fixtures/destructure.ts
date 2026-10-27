import { type Account, type Init, type Mut, type Pubkey, type Signer, type SystemProgram, type u64, type u8, require } from "typesol";

export interface Point {
  x: u64;
  y: u64;
}

export interface Player {
  bump: u8;
  owner: Pubkey;
  score: u64;
  pos: Point;
}

export function join(owner: Mut<Signer>, player: Init<Player>, systemProgram: SystemProgram): void {
  player.bump = player.create(owner, ["player", owner.key]);
  player.owner = owner.key;
  player.pos = { x: 2n, y: 3n };
}

/** Scalars are copies (let ones can change), nested structs are references, renaming works. */
export function play(owner: Signer, player: Mut<Player>, points: u64): u64 {
  const { key } = owner;
  const { owner: who, pos } = player;
  require(who === key, "not your player");
  let { score } = player;
  score += points;
  player.score = score;
  pos.x += points; // a reference into the account
  const { x, y: height } = player.pos;
  return x * 100n + height;
}
