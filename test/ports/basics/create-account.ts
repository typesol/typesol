// Port of basics/create-account @ de09019; see test/ports/README.md.
//
// PARTIAL (interface): the Anchor instruction takes one `AddressData { name: String, address: String }` argument.
// TypeSOL struct arguments must have a fixed layout (no `string` fields), so it takes `name` and `address` as two
// arguments. The instruction data bytes are identical (a Borsh struct is its fields in order); only the IDL differs.
import { type Mut, type Signer, type SystemProgram, byteLength, log, rentExempt } from "typesol";

export function createSystemAccount(payer: Mut<Signer>, newAccount: Mut<Signer>, systemProgram: SystemProgram, name: string, address: string): void {
  log("Program invoked. Creating a system account...");
  // The Borsh size of AddressData: two u32 length prefixes plus the UTF-8 bytes.
  const accountSpan = 4n + byteLength(name) + 4n + byteLength(address);
  const lamportsRequired = rentExempt(accountSpan);
  log(`Account span: ${accountSpan}`);
  log(`Lamports required: ${lamportsRequired}`);
  systemProgram.createAccount(payer, newAccount, lamportsRequired, accountSpan, systemProgram.key);
  log("Account created succesfully.");
}
