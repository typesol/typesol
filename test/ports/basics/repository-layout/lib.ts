// Port of basics/repository-layout @ de09019; see test/ports/README.md.
//
// The same layout as the Rust crate: instructions/ (one file per instruction), state/ (the carnival's rides, games
// and food stands) and error.ts, imported by this entry file.
// PARTIAL:
//  - the attraction lists (Vec<Ride> etc. of structs with String fields) are lookups by name in state/, since
//    TypeSOL has no constant tables of strings; the logged messages are the same.
//  - an unknown attraction fails with this program's error (6000), where the original returns
//    ProgramError::InvalidInstructionData.
import { type Mut, type Signer, type u32 } from "typesol";
import { eatFoodImpl } from "./instructions/eat-food";
import { getOnRideImpl } from "./instructions/get-on-ride";
import { playGameImpl } from "./instructions/play-game";

export function goOnRide(payer: Mut<Signer>, name: string, height: u32, ticketCount: u32, rideName: string): void {
  getOnRideImpl(name, height, ticketCount, rideName);
}

export function playGame(payer: Mut<Signer>, name: string, ticketCount: u32, gameName: string): void {
  playGameImpl(name, ticketCount, gameName);
}

export function eatFood(payer: Mut<Signer>, name: string, ticketCount: u32, foodStandName: string): void {
  eatFoodImpl(name, ticketCount, foodStandName);
}
