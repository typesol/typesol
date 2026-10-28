// Port of basics/cross-program-invocation (programs/lever) @ de09019; see test/ports/README.md.
//
// PORTED: `power` is a keypair account created in `initialize` with Anchor's `space = 8 + 8`.
import { type Init, type Mut, type Signer, type SystemProgram, log } from "typesol";

export interface PowerStatus {
  isOn: boolean;
}

export function initialize(power: Init<PowerStatus>, user: Mut<Signer>, systemProgram: SystemProgram): void {
  power.create(user, null, 8n + 8n);
}

export function switchPower(power: Mut<PowerStatus>, name: string): void {
  power.isOn = !power.isOn;
  log(`${name} is pulling the power switch!`);
  if (power.isOn) log("The power is now on.");
  else log("The power is now off!");
}
