import { type u32 } from "typesol";

// get_food_stands(): the carnival's food stands — Larry's Pizza, Taco Shack, Dough Boy's — looked up by name.

export function isFoodStand(name: string): boolean {
  return name === "Larry's Pizza" || name === "Taco Shack" || name === "Dough Boy's";
}

export function foodTickets(name: string): u32 {
  if (name === "Larry's Pizza") return 3n;
  if (name === "Taco Shack") return 2n;
  return 1n;
}

export function foodType(name: string): string {
  if (name === "Larry's Pizza") return "pizza";
  if (name === "Taco Shack") return "taco";
  return "fried dough";
}
