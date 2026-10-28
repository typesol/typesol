// Port of basics/favorites @ de09019; see test/ports/README.md.
//
// PORTED: `hobbies: Vec<String>` is a `Vec<string>` argument (Borsh, as Anchor sends it), and the account keeps
// Anchor's bytes (`@layout borsh`: the `#[max_len(5, 50)] Vec<String>` is a FixedVec<FixedString<50>, 5>) and size,
// 8 + 8 + 54 + 4 + 5 * 54 = 344 bytes. A sixth hobby, or one longer than 50 bytes, does not fit and fails, as Anchor
// fails to serialize the account. The hobbies log line prints them as Rust's `{:?}` does for plain text (quotes and
// backslashes inside a hobby are not escaped).
import {
  type FixedString,
  type FixedVec,
  type InitIfNeeded,
  type Mut,
  type Signer,
  type SystemProgram,
  type Vec,
  type u64,
  fixedVec,
  log,
  pubkey,
  require,
} from "typesol";

const PROGRAM_ID = pubkey("ww9C83noARSQVBnqmCUmaVdbJjmiwcV9j2LkXYMoUCV");

/** @layout borsh */
export interface Favorites {
  number: u64;
  color: FixedString<50>;
  hobbies: FixedVec<FixedString<50>, 5>;
}

export enum FavoritesError {
  TooManyHobbies = "At most 5 hobbies fit in the account",
}

export function setFavorites(
  user: Mut<Signer>,
  favorites: InitIfNeeded<Favorites>,
  systemProgram: SystemProgram,
  number: u64,
  color: string,
  hobbies: Vec<string>,
): void {
  favorites.createIfNeeded(user, ["favorites", user.key]);
  require(hobbies.length <= 5n, FavoritesError.TooManyHobbies);
  log(`Greetings from ${PROGRAM_ID}`);
  let list = "[";
  let first = true;
  for (const h of hobbies) {
    if (!first) list += ", ";
    list += `"${h}"`;
    first = false;
  }
  list += "]";
  log(`User ${user.key}'s favorite number is ${number}, favorite color is: ${color}, and their hobbies are ${list}`);
  favorites.number = number;
  favorites.color = color;
  favorites.hobbies = fixedVec([]);
  for (const h of hobbies) favorites.hobbies.push(h);
}
