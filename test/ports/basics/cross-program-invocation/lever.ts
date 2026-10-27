// Port of basics/cross-program-invocation (programs/lever) @ de09019; see test/ports/README.md.
//
// PARTIAL (keypair init): Anchor creates `power` (a keypair account, space 8 + 8) in `initialize`; TypeSOL's Init<T>
// only creates PDAs, so it is a Zeroed<PowerStatus> the client allocates in the same transaction.
import { type Mut, type Signer, type SystemProgram, type Zeroed, log } from "typesol";

export interface PowerStatus {
  isOn: boolean;
}

export function initialize(power: Zeroed<PowerStatus>, user: Mut<Signer>, systemProgram: SystemProgram): void {
  power.isOn = false;
}

export function switchPower(power: Mut<PowerStatus>, name: string): void {
  power.isOn = !power.isOn;
  log(`${name} is pulling the power switch!`);
  if (power.isOn) log("The power is now on.");
  else log("The power is now off!");
}
