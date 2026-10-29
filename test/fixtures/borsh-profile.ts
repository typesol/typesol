// The Profile program with `@layout borsh`: Anchor's account bytes (test/anchor-twins/programs/profile is its Anchor twin).
import {
  type Account,
  type FixedString,
  type FixedVec,
  type HasOne,
  type Init,
  type Mut,
  type Option,
  type Pubkey,
  type Signer,
  type SystemProgram,
  type i64,
  type u8,
  type u64,
  require,
} from "typesol";

/** @layout borsh */
export interface Profile {
  owner: Pubkey;
  bump: u8;
  name: FixedString<32>;
  tags: FixedVec<u64, 8>;
  badge: Option<u64>;
  score: u64;
  updated: i64;
}

export function create(owner: Mut<Signer>, profile: Init<Profile>, systemProgram: SystemProgram, name: string): void {
  profile.bump = profile.create(owner, ["profile", owner.key]);
  profile.owner = owner.key;
  profile.name = name;
}

/** Fields after every variable-size one. */
export function bump(owner: Signer, profile: HasOne<Mut<Profile>, "owner">, by: u64): void {
  profile.score += by;
  profile.updated = profile.updated + 1n;
}

export function rename(owner: Signer, profile: HasOne<Mut<Profile>, "owner">, name: string): void {
  profile.name = name;
}

export function addTag(owner: Signer, profile: HasOne<Mut<Profile>, "owner">, tag: u64): void {
  require(profile.tags.length < 8n, "full");
  profile.tags.push(tag);
}

export function setBadge(owner: Signer, profile: HasOne<Mut<Profile>, "owner">, badge: u64 | null): void {
  profile.badge = badge;
}

/** Read everything: sum of tags + score. */
export function total(profile: Account<Profile>): u64 {
  let t = profile.score;
  for (const x of profile.tags) t += x;
  return t;
}
