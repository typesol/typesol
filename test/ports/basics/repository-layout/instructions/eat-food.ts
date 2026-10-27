import { type u32, log, require } from "typesol";
import { CarnivalError } from "../error";
import { foodTickets, isFoodStand, logWithFood } from "../state/food";

export function eatFoodImpl(eaterName: string, eaterTicketCount: u32, foodStand: string): void {
  require(isFoodStand(foodStand), CarnivalError.UnknownAttraction);
  log(`Welcome to ${foodStand}! What can I get you?`);
  if (eaterTicketCount < foodTickets(foodStand)) {
    logWithFood(foodStand, `  Sorry ${eaterName}, our `, ` is ${foodTickets(foodStand)} tickets!`);
  } else {
    logWithFood(foodStand, "  Enjoy your ", "!");
  }
}
