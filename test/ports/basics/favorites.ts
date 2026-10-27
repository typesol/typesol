// Port of basics/favorites @ de09019; see test/ports/README.md.
//
// PARTIAL:
//  - interface: `hobbies: Vec<String>` cannot be an argument (Vec argument elements must have a fixed size, and
//    FixedString is only allowed inside a struct), so it is `Vec<Hobby>` with `Hobby { text: FixedString<50> }`: each
//    hobby is sent as u32 length + 50 bytes instead of a Borsh string.
//  - account layout: an InitIfNeeded account cannot end in a Vec yet, and account strings are FixedString<N>, so the
//    `#[max_len(5, 50)] Vec<String>` is a u32 count plus FixedArray<FixedString<50>, 5>. The account has Anchor's
//    size (8 + 8 + 54 + 4 + 5 * 54 = 344 bytes) but fields sit at fixed offsets instead of being Borsh-packed.
//    Anchor rejects a sixth hobby when it cannot serialize the account; here it is an explicit require.
//  - logs: the user's address and the Debug-formatted `{hobbies:?}` list are not printed (no Pubkeys in templates).
import {
  type FixedArray,
  type FixedString,
  type InitIfNeeded,
  type Mut,
  type Signer,
  type SystemProgram,
  type Vec,
  type u64,
  log,
  require,
  u32,
} from "typesol";

export interface Hobby {
  text: FixedString<50>;
}

export interface Favorites {
  number: u64;
  color: FixedString<50>;
  hobbyCount: u32;
  hobbies: FixedArray<FixedString<50>, 5>;
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
  log(`favorite number is ${number}, favorite color is: ${color}`);
  favorites.number = number;
  favorites.color = color;
  favorites.hobbyCount = u32(hobbies.length);
  for (let i = 0n; i < 5n; i++) favorites.hobbies.set(i, i < hobbies.length ? hobbies.get(i).text : "");
}
