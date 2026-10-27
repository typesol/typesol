import { type u32, log, require } from "typesol";
import { CarnivalError } from "../error";
import { isRide, rideMinHeight, rideTickets, rideUpsideDown } from "../state/ride";

export function getOnRideImpl(riderName: string, riderHeight: u32, riderTicketCount: u32, ride: string): void {
  require(isRide(ride), CarnivalError.UnknownAttraction);
  log(`You're about to ride the ${ride}!`);
  if (riderTicketCount < rideTickets(ride)) {
    log(`  Sorry ${riderName}, you need ${rideTickets(ride)} tickets to ride the ${ride}!`);
    return;
  }
  if (riderHeight < rideMinHeight(ride)) {
    log(`  Sorry ${riderName}, you need to be ${rideMinHeight(ride)}" tall to ride the ${ride}!`);
    return;
  }
  log(`  Welcome aboard the ${ride}!`);
  if (rideUpsideDown(ride)) log("  Btw, this ride goes upside down. Hold on tight!");
}
