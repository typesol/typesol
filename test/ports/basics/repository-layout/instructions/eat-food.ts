import { type u32, log, require } from "typesol";
import { CarnivalError } from "../error";
import { foodTickets, foodType, isFoodStand } from "../state/food";

export function eatFoodImpl(eaterName: string, eaterTicketCount: u32, foodStand: string): void {
  require(isFoodStand(foodStand), CarnivalError.UnknownAttraction);
  log(`Welcome to ${foodStand}! What can I get you?`);
  if (eaterTicketCount < foodTickets(foodStand)) {
    log(`  Sorry ${eaterName}, our ${foodType(foodStand)} is ${foodTickets(foodStand)} tickets!`);
  } else {
    log(`  Enjoy your ${foodType(foodStand)}!`);
  }
}
