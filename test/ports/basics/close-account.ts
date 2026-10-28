// Port of basics/close-account @ de09019; see test/ports/README.md.
//
// PORTED: `@layout borsh` keeps Anchor's bytes (`name: String` with #[max_len(50)] is a FixedString<50>) and its size,
// 8 + 1 + 32 + 4 + 50.
import { type CloseTo, type FixedString, type Init, type Mut, type Pubkey, type Seeds, type Signer, type SystemProgram, type u8 } from "typesol";

/** @layout borsh */
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
