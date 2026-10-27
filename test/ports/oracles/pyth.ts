// Port of oracles/pyth @ de09019; see test/ports/README.md.
//
// PARTIAL (logs only): Anchor prints each field with `{:?}` (the feed id as a Debug byte array); TypeSOL logs the
// label and the value on separate lines, and a Hash in its own format. The account checks (Pyth receiver owner,
// PriceUpdateV2 discriminator) are the same.
import { type PythPriceUpdate, log } from "typesol";

export function readPrice(priceUpdate: PythPriceUpdate): void {
  log("Price feed id:");
  log(priceUpdate.feedId);
  log(`Price: ${priceUpdate.price}`);
  log(`Confidence: ${priceUpdate.conf}`);
  log(`Exponent: ${priceUpdate.exponent}`);
  log(`Publish Time: ${priceUpdate.publishTime}`);
}
