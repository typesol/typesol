import { type u32, log } from "typesol";

// get_games(): the carnival's games — Ring Toss, I Got It!, Ladder Climb — looked up by name.
const DEFAULT_TICKETS_TO_PLAY: u32 = 3n;

export function isGame(name: string): boolean {
  return name === "Ring Toss" || name === "I Got It!" || name === "Ladder Climb";
}

export function gameTickets(name: string): u32 {
  return DEFAULT_TICKETS_TO_PLAY;
}

export function gameTries(name: string): u32 {
  if (name === "Ring Toss") return 5n;
  if (name === "I Got It!") return 12n;
  return 1n;
}

/** Logs the attempts-and-prize line (the prize is a string, which helpers cannot return). */
export function logPrize(name: string): void {
  const tries = gameTries(name);
  if (name === "Ring Toss") log(`  You get ${tries} attempts and the prize is a teddy bear!`);
  else if (name === "I Got It!") log(`  You get ${tries} attempts and the prize is a goldfish!`);
  else log(`  You get ${tries} attempts and the prize is a popcorn bucket!`);
}
