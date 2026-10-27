// Port of basics/close-account @ de09019; see test/ports/README.md.
//
// PARTIAL (account layout): Anchor stores `name: String` (#[max_len(50)]) Borsh-encoded, so the bytes after it move
// with its length. TypeSOL account strings are FixedString<50> (u32 length + 50 bytes, fixed offsets). The account
// size (8 + 1 + 32 + 4 + 50) and every field value are the same; only the byte positions of shorter names differ.
import { type CloseTo, type FixedString, type Init, type Mut, type Pubkey, type Seeds, type Signer, type SystemProgram, type u8 } from "typesol";

export interface UserState {
  bump: u8;
  user: Pubkey;
  name: FixedString<50>;
}

export function createUser(user: Mut<Signer>, userAccount: Init<UserState>, systemProgram: SystemProgram, name: string): void {
  userAccount.bump = userAccount.create(user, ["USER", user.key]);
  userAccount.user = user.key;
  userAccount.name = name;
}

/** `close = user`: the rent goes back to the user when the instruction succeeds. */
export function closeUser(user: Mut<Signer>, userAccount: CloseTo<Seeds<Mut<UserState>, ["USER", "@user"], "bump">, "user">): void {}
