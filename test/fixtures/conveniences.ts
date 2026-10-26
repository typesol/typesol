import { type CloseTo, type HasOne, type InitIfNeeded, type Mut, type Pubkey, type Seeds, type Signer, type SystemProgram, type u8, type u64 } from "typesol";

/** Anchor-style conveniences: init_if_needed, has_one, seeds + bump, close, and switch. */
export interface Stash {
  owner: Pubkey;
  amount: u64;
  visits: u64;
  bump: u8;
}

export enum Op {
  Add,
  Sub,
  Reset,
  Double,
}

/** Opens the stash on first deposit, adds to it afterwards. Returns whether it was created now. */
export function deposit(owner: Mut<Signer>, stash: InitIfNeeded<Stash>, systemProgram: SystemProgram, amount: u64): boolean {
  const created = stash.createIfNeeded(owner, ["stash", owner.key]);
  if (created) {
    stash.owner = owner.key;
    stash.bump = stash.pdaBump;
  }
  stash.amount += amount;
  stash.visits += 1n;
  return created;
}

/** The type checks the PDA (with the stored bump) and the owner relation before the body runs. */
export function apply(owner: Signer, stash: HasOne<Seeds<Mut<Stash>, ["stash", "@owner"], "bump">, "owner">, op: Op, n: u64): u64 {
  switch (op) {
    case Op.Add:
      stash.amount += n;
      break;
    case Op.Sub:
      stash.amount -= n;
      break;
    case Op.Double:
      stash.amount *= 2n;
    // falls through to also count the visit twice
    case Op.Reset:
      if (op === Op.Reset) {
        stash.amount = 0n;
      }
      stash.visits += 1n;
      break;
    default:
      break;
  }
  return stash.amount;
}

export function withdrawAll(owner: Mut<Signer>, stash: CloseTo<HasOne<Mut<Stash>, "owner">, "owner">): u64 {
  return stash.amount;
}
