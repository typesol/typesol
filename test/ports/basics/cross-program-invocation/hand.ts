// Port of basics/cross-program-invocation (programs/hand) @ de09019; see test/ports/README.md.
//
// PORTED. Anchor's `declare_program!(lever)` becomes a pinned Program<…> plus the Anchor instruction encoding
// (sighash + Borsh string); `Account<PowerStatus>` of the lever program is checked with loadForeign (owner,
// discriminator, size).
import { type AccountInfo, type Mut, type Program, invoke, loadForeign, pubkey, sighash, writable } from "typesol";

const LEVER = pubkey("A6GUsa5Ej8iWzMMP3B6otFVB5aaUckVm8a31Y5TMLYRV");

/** The lever program's account, declared with the same layout. */
export interface PowerStatus {
  isOn: boolean;
}

export function pullLever(power: Mut<AccountInfo>, leverProgram: Program<"A6GUsa5Ej8iWzMMP3B6otFVB5aaUckVm8a31Y5TMLYRV">, name: string): void {
  const status = loadForeign<PowerStatus>(power, LEVER);
  invoke(leverProgram, [writable(power)], [sighash("switch_power"), name]);
}
