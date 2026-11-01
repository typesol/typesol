import { type u32 } from "typesol";

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

export function gamePrize(name: string): string {
  if (name === "Ring Toss") return "teddy bear";
  if (name === "I Got It!") return "goldfish";
  return "popcorn bucket";
}
