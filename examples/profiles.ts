import {
  type Account,
  type FixedArray,
  type FixedString,
  type Init,
  type Mut,
  type Pubkey,
  type Signer,
  type SystemProgram,
  type u32,
  byteLength,
  emit,
  fixedArray,
  i64,
  require,
  u64,
} from "typesol";

/** Nested structs, fixed strings, local arrays, events and return data in one program. */
export interface Point {
  x: i64;
  y: i64;
}

export interface Profile {
  owner: Pubkey;
  name: FixedString<32>;
  home: Point;
  /** The last four homes, newest first. */
  trail: FixedArray<Point, 4>;
  tags: FixedArray<FixedString<8>, 3>;
  moves: u32;
}

/** Events may carry variable-length strings. */
export interface Renamed {
  owner: Pubkey;
  from: string;
  to: string;
}

export interface Moved {
  owner: Pubkey;
  home: Point;
  moves: u32;
}

export enum ProfileError {
  NotOwner = "Only the profile owner can do this",
  SameName = "That is already the name",
  EmptyName = "Names cannot be empty",
}

/** Profiles live at PDA ["profile", owner, name]. */
export function register(owner: Mut<Signer>, profile: Init<Profile>, systemProgram: SystemProgram, name: string): void {
  require(byteLength(name) > 0n, ProfileError.EmptyName);
  profile.create(owner, ["profile", owner.key, name]);
  profile.owner = owner.key;
  profile.name = name;
}

export function rename(owner: Signer, profile: Mut<Profile>, name: string): void {
  require(profile.owner === owner.key, ProfileError.NotOwner);
  require(name !== profile.name, ProfileError.SameName);
  emit<Renamed>({ owner: owner.key, from: profile.name, to: name });
  profile.name = name;
}

export function move(owner: Signer, profile: Mut<Profile>, dx: i64, dy: i64): void {
  require(profile.owner === owner.key, ProfileError.NotOwner);
  for (let i = 3n; i > 0n; i--) {
    profile.trail.set(i, profile.trail.get(i - 1n));
  }
  profile.trail.set(0n, profile.home);
  profile.home.x += dx;
  profile.home.y += dy;
  profile.moves++;
  emit<Moved>({ owner: owner.key, home: profile.home, moves: profile.moves });
}

export function tag(owner: Signer, profile: Mut<Profile>, slot: u64, label: string): void {
  require(profile.owner === owner.key, ProfileError.NotOwner);
  profile.tags.set(slot, label);
}

/** Manhattan distance walked along the trail, as return data. */
export function distance(profile: Account<Profile>): u64 {
  const xs = fixedArray<i64, 5>(0n);
  const ys = fixedArray<i64, 5>(0n);
  xs.set(0n, profile.home.x);
  ys.set(0n, profile.home.y);
  for (let i = 0n; i < 4n; i++) {
    xs.set(i + 1n, profile.trail.get(i).x);
    ys.set(i + 1n, profile.trail.get(i).y);
  }
  let total: i64 = 0n;
  for (let i = 0n; i < 4n; i++) {
    total += abs(xs.get(i) - xs.get(i + 1n)) + abs(ys.get(i) - ys.get(i + 1n));
  }
  return u64(total);
}

function abs(v: i64): i64 {
  if (v < 0n) {
    return -v;
  }
  return v;
}
