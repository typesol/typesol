// A coin flip on Switchboard On-Demand randomness: commit to a randomness account the oracle has not revealed yet,
// then settle on its revealed value.
import { type Init, type Mut, type Pubkey, type Signer, type SwitchboardRandomness, type SystemProgram, type u64, currentSlot, require } from "typesol";

export interface Bet {
  randomness: Pubkey;
  seedSlot: u64;
  guess: u64;
  settled: boolean;
  won: boolean;
}

export enum FlipError {
  NotFresh = "randomness already revealed or stale",
  WrongRandomness = "not the committed randomness",
  Settled = "already settled",
}

export function commit(player: Mut<Signer>, bet: Init<Bet>, randomness: SwitchboardRandomness, systemProgram: SystemProgram, guess: u64): void {
  bet.create(player, ["bet", player.key]);
  // Committed in the previous slot and not revealed yet: nobody, the player included, knows the value.
  require(randomness.seedSlot === currentSlot() - 1n, FlipError.NotFresh);
  bet.randomness = randomness.key;
  bet.seedSlot = randomness.seedSlot;
  bet.guess = guess % 2n;
}

export function settle(player: Signer, bet: Mut<Bet>, randomness: SwitchboardRandomness): void {
  require(!bet.settled, FlipError.Settled);
  require(bet.randomness === randomness.key && randomness.seedSlot === bet.seedSlot, FlipError.WrongRandomness);
  bet.won = randomness.valueU64() % 2n === bet.guess;
  bet.settled = true;
}
