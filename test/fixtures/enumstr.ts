import { type FixedString, type Init, type Mut, type Pubkey, type Signer, type SystemProgram, type u8, byteLength, emit, u64 } from "typesol";

/** A data enum whose variants carry strings: Borsh in arguments and events, a value in code. */
export type Command = { kind: "Say"; text: string; times: u8 } | { kind: "Rename"; to: string } | { kind: "Nop" };

export interface Said {
  who: Pubkey;
  cmd: Command;
}

export interface Board {
  bump: u8;
  title: FixedString<16>;
  said: u64;
}

export function setup(owner: Mut<Signer>, board: Init<Board>, systemProgram: SystemProgram): void {
  board.bump = board.create(owner, ["board", owner.key]);
  board.title = "start";
}

export function run(owner: Signer, board: Mut<Board>, cmd: Command): u64 {
  switch (cmd.kind) {
    case "Say":
      emit<Said>({ who: owner.key, cmd });
      board.said += byteLength(cmd.text) * u64(cmd.times);
      return board.said;
    case "Rename": {
      // A local enum built from account text keeps its own copy: renaming afterwards does not change it.
      const before: Command = { kind: "Say", text: board.title, times: 1n };
      board.title = cmd.to;
      emit<Said>({ who: owner.key, cmd: before });
      return byteLength(board.title);
    }
    default:
      return 0n;
  }
}

/** A variable enum nested in another one's variant: Borsh all the way down in the IDL and on the wire. */
export type Wrap = { kind: "Wrap"; c: Command; tail: u8 } | { kind: "Empty" };

export interface Wrapped {
  w: Wrap;
}

export function nest(owner: Signer, text: string, times: u8, tail: u8): void {
  const w: Wrap = { kind: "Wrap", c: { kind: "Say", text, times }, tail };
  emit<Wrapped>({ w });
}

/** Assigning account text into a local enum's string field takes a copy, like building it does. */
export function assignField(owner: Signer, board: Mut<Board>): void {
  const c: Command = { kind: "Say", text: "x", times: 1n };
  if (c.kind === "Say") c.text = board.title;
  board.title = "zzz";
  emit<Said>({ who: owner.key, cmd: c });
}

