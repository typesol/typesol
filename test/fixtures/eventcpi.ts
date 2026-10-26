import { type EventAuthority, type Pubkey, type SelfProgram, type Signer, type u64, emitCpi } from "typesol";

export interface Paid {
  who: Pubkey;
  amount: u64;
  memo: string;
}

export function pay(payer: Signer, amount: u64, memo: string, eventAuthority: EventAuthority, self: SelfProgram): void {
  emitCpi<Paid>({ who: payer.key, amount, memo }, eventAuthority, self);
}
