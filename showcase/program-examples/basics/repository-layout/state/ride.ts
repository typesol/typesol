import { type u32 } from "typesol";

// get_rides(): the carnival's rides — Tilt-a-Whirl, Scrambler, Ferris Wheel, Zero Gravity — looked up by name.

export function isRide(name: string): boolean {
  return name === "Tilt-a-Whirl" || name === "Scrambler" || name === "Ferris Wheel" || name === "Zero Gravity";
}

export function rideTickets(name: string): u32 {
  return name === "Ferris Wheel" || name === "Zero Gravity" ? 5n : 3n;
}

export function rideMinHeight(name: string): u32 {
  if (name === "Ferris Wheel") return 55n;
  if (name === "Zero Gravity") return 60n;
  return 48n;
}

export function rideUpsideDown(name: string): boolean {
  return name === "Zero Gravity";
}
