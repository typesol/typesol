import { type u32, log } from "typesol";

// get_food_stands(): the carnival's food stands — Larry's Pizza, Taco Shack, Dough Boy's — looked up by name.

export function isFoodStand(name: string): boolean {
  return name === "Larry's Pizza" || name === "Taco Shack" || name === "Dough Boy's";
}

export function foodTickets(name: string): u32 {
  if (name === "Larry's Pizza") return 3n;
  if (name === "Taco Shack") return 2n;
  return 1n;
}

/** Logs `before + food type + after` (the food type is a string, which helpers cannot return). */
export function logWithFood(name: string, before: string, after: string): void {
  if (name === "Larry's Pizza") log(before + "pizza" + after);
  else if (name === "Taco Shack") log(before + "taco" + after);
  else log(before + "fried dough" + after);
}
