// Port of basics/realloc @ de09019; see test/ports/README.md.
//
// PARTIAL:
//  - keypair init: Anchor creates `message_account` as a keypair account sized to the input. TypeSOL's Init<T> only
//    creates PDAs and Zeroed<T> refuses Vec-ending (resizable) accounts, so the account is the PDA
//    ["message", payer].
//  - interface: `input: String` is taken as `Vec<u8>` (the same Borsh bytes: u32 length + data) because TypeSOL
//    strings cannot be read byte by byte. The account stores `message: Vec<u8>`, byte-identical to Anchor's Borsh
//    String; the account is exactly 8 + 4 + len bytes, as `Message::required_space` computes.
// Lamports follow Anchor's `realloc::payer`: growing tops the account up to the new rent-exempt minimum from the payer
// (a surplus already in the account counts), shrinking refunds the payer everything above the new minimum. TypeSOL's
// Vec clear()/push() keep freed rent in the account and charge every regrown byte, so the program settles the
// difference explicitly (builtin gap: no Anchor-style realloc for Vec-ending accounts).
import { type Init, type Mut, type Signer, type SystemProgram, type Vec, type u8, max, minimumBalance } from "typesol";

export interface Message {
  message: Vec<u8>;
}

export function initialize(payer: Mut<Signer>, messageAccount: Init<Message>, systemProgram: SystemProgram, input: Vec<u8>): void {
  messageAccount.create(payer, ["message", payer.key]);
  for (let i = 0n; i < input.length; i++) messageAccount.message.push(input.get(i), payer);
}

export function update(payer: Mut<Signer>, messageAccount: Mut<Message>, systemProgram: SystemProgram, input: Vec<u8>): void {
  const sizeBefore = messageAccount.dataLen;
  const lamportsBefore = messageAccount.lamports;
  messageAccount.message.clear();
  for (let i = 0n; i < input.length; i++) messageAccount.message.push(input.get(i), payer);
  // clear() keeps the lamports and each push charges the payer for its byte, so give back what Anchor would not
  // have taken: on growth the account only needs topping up to the new minimum; on shrink the payer gets everything
  // above it.
  const minimum = minimumBalance(messageAccount);
  const target = messageAccount.dataLen < sizeBefore ? minimum : max(lamportsBefore, minimum);
  const refund = messageAccount.lamports - target;
  messageAccount.lamports -= refund;
  payer.lamports += refund;
}
