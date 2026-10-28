// Port of basics/account-data @ de09019; see test/ports/README.md.
//
// PORTED: the keypair `init` is `addressInfo.create(payer, null)`, and `@layout borsh` keeps Anchor's bytes (the
// `#[max_len(50)] String` fields are Borsh Strings; the account has Anchor's InitSpace, 8 + 54 + 1 + 54 + 54).
import { type FixedString, type Init, type Mut, type Signer, type SystemProgram, type u8 } from "typesol";

/** @layout borsh */
export interface AddressInfo {
  name: FixedString<50>;
  houseNumber: u8;
  street: FixedString<50>;
  city: FixedString<50>;
}

/** Strings longer than 50 bytes abort, as Anchor fails to serialize them into the account. */
export function createAddressInfo(
  payer: Mut<Signer>,
  addressInfo: Init<AddressInfo>,
  systemProgram: SystemProgram,
  name: string,
  houseNumber: u8,
  street: string,
  city: string,
): void {
  addressInfo.create(payer, null);
  addressInfo.name = name;
  addressInfo.houseNumber = houseNumber;
  addressInfo.street = street;
  addressInfo.city = city;
}
