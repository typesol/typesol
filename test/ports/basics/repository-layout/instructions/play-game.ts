import { type u32, log, require } from "typesol";
import { CarnivalError } from "../error";
import { gameTickets, isGame, logPrize } from "../state/game";

export function playGameImpl(gamerName: string, gamerTicketCount: u32, game: string): void {
  require(isGame(game), CarnivalError.UnknownAttraction);
  log(`You're about to play ${game}!`);
  if (gamerTicketCount < gameTickets(game)) {
    log(`  Sorry ${gamerName}, you need ${gameTickets(game)} tickets to play ${game}!`);
  } else {
    log("  Let's see what you got!");
    logPrize(game);
  }
}
