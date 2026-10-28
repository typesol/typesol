// Port of basics/favorites @ de09019; see test/ports/README.md.
//
// PARTIAL:
//  - interface: `hobbies: Vec<String>` cannot be an argument (Vec argument elements must have a fixed size, and
//    FixedString is only allowed inside a struct), so it is `Vec<Hobby>` with `Hobby { text: FixedString<50> }`: each
//    hobby is sent as u32 length + 50 bytes instead of a Borsh string.
//  - Anchor rejects a sixth hobby when it cannot serialize the account; here it is an explicit require.
//  - logs: hobbies are printed as `["a", "b"]` without Rust's Debug escaping of quotes and backslashes.
// The account keeps Anchor's bytes (`@layout borsh`: the `#[max_len(5, 50)] Vec<String>` is a
// FixedVec<FixedString<50>, 5>) and Anchor's size, 8 + 8 + 54 + 4 + 5 * 54 = 344 bytes.
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

export interface Hobby {
  text: FixedString<50>;
}

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
  hobbies: Vec<Hobby>,
): void {
  favorites.createIfNeeded(user, ["favorites", user.key]);
  require(hobbies.length <= 5n, FavoritesError.TooManyHobbies);
  log(`Greetings from ${PROGRAM_ID}`);
  let list = "[";
  let first = true;
  for (const h of hobbies) {
    if (!first) list += ", ";
    list += `"${h.text}"`;
    first = false;
  }
  list += "]";
  log(`User ${user.key}'s favorite number is ${number}, favorite color is: ${color}, and their hobbies are ${list}`);
  favorites.number = number;
  favorites.color = color;
  favorites.hobbies = fixedVec([]);
  for (const h of hobbies) favorites.hobbies.push(h.text);
}
