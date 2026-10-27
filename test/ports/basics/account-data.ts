// Port of basics/account-data @ de09019; see test/ports/README.md.
//
// PARTIAL:
//  - keypair `init`: Anchor creates `address_info` (a keypair account, no seeds) in the instruction; TypeSOL's Init<T>
//    only creates PDAs, so it is a Zeroed<AddressInfo> the client allocates (System CreateAccount, owner: this program)
//    in the same transaction.
//  - account layout: `#[max_len(50)] String` fields are Borsh (later fields shift with the length); TypeSOL stores
//    FixedString<50> at fixed offsets. Same account size (8 + 54 + 1 + 54 + 54) and values.
import { type FixedString, type Mut, type Signer, type SystemProgram, type Zeroed, type u8 } from "typesol";

export interface AddressInfo {
  name: FixedString<50>;
  houseNumber: u8;
  street: FixedString<50>;
  city: FixedString<50>;
}

/** Strings longer than 50 bytes abort, as Anchor fails to serialize them into the account. */
export function createAddressInfo(
  payer: Mut<Signer>,
  addressInfo: Zeroed<AddressInfo>,
  systemProgram: SystemProgram,
  name: string,
  houseNumber: u8,
  street: string,
  city: string,
): void {
  addressInfo.name = name;
  addressInfo.houseNumber = houseNumber;
  addressInfo.street = street;
  addressInfo.city = city;
}
