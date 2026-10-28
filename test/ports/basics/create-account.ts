// Port of basics/create-account @ de09019; see test/ports/README.md.
//
// PORTED: `AddressData` is a `@layout borsh` struct argument, so the instruction bytes and the IDL are Anchor's. Its
// Strings hold up to 512 bytes each (Anchor's are unbounded, but a transaction holds less than that anyway).
import { type FixedString, type Mut, type Signer, type SystemProgram, byteLength, log, rentExempt } from "typesol";

/** @layout borsh */
export interface AddressData {
  name: FixedString<512>;
  address: FixedString<512>;
}

export function createSystemAccount(payer: Mut<Signer>, newAccount: Mut<Signer>, systemProgram: SystemProgram, addressData: AddressData): void {
  log("Program invoked. Creating a system account...");
  log(`  New public key will be: ${newAccount.key}`);
  // The Borsh size of AddressData: two u32 length prefixes plus the UTF-8 bytes.
  const accountSpan = 4n + byteLength(addressData.name) + 4n + byteLength(addressData.address);
  const lamportsRequired = rentExempt(accountSpan);
  log(`Account span: ${accountSpan}`);
  log(`Lamports required: ${lamportsRequired}`);
  systemProgram.createAccount(payer, newAccount, lamportsRequired, accountSpan, systemProgram.key);
  log("Account created succesfully.");
}
