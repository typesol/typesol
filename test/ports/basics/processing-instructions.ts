// Port of basics/processing-instructions @ de09019; see test/ports/README.md.
//
// PORTED.
import { type u32, log } from "typesol";

export function goToPark(name: string, height: u32): void {
  log(`Welcome to the park, ${name}!`);
  if (height > 5n) log("You are tall enough to ride this ride. Congratulations.");
  else log("You are NOT tall enough to ride this ride. Sorry mate.");
}
