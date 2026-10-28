// @layout borsh structs as instruction arguments, return values and events (Anchor's Borsh bytes everywhere).
import {
  type Account,
  type FixedString,
  type FixedVec,
  type Init,
  type Mut,
  type Option,
  type Pubkey,
  type Signer,
  type SystemProgram,
  type u8,
  emit,
  u64,
} from "typesol";

/** @layout borsh */
export interface Card {
  owner: Pubkey;
  bump: u8;
  name: FixedString<16>;
  tags: FixedVec<u64, 4>;
  labels: FixedVec<FixedString<8>, 2>;
  badge: Option<u64>;
  score: u64;
}

/** @layout borsh */
export interface Note {
  title: FixedString<12>;
  amount: Option<u64>;
  at: u64;
}

export function create(owner: Mut<Signer>, card: Init<Card>, systemProgram: SystemProgram, init: Card): void {
  card.bump = card.create(owner, ["card", owner.key]);
  card.owner = owner.key;
  card.name = init.name;
  card.tags = init.tags;
  card.labels = init.labels;
  card.badge = init.badge;
  card.score = init.score;
}

/** Returns the whole account as Borsh. */
export function read(card: Account<Card>): Card {
  return card;
}

export function note(owner: Signer, title: string, amount: u64 | null): void {
  emit<Note>({ title, amount, at: 7n });
}

export function echo(n: Note, k: u64): Note {
  return { title: n.title, amount: n.amount, at: n.at + k };
}

export interface Spot {
  x: u64;
  y: u64;
  ok: boolean;
}

/** Variants carrying fixed-size structs (Borsh-identical) as instruction arguments. */
export type Move = { kind: "To"; to: Spot; tag: u8 } | { kind: "Stay" };

export function move(m: Move): u64 {
  if (m.kind === "To") return m.to.ok ? m.to.x * 10n + m.to.y + u64(m.tag) * 1000n : 1n;
  return 0n;
}
