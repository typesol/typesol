// A client-side Metaplex Core TransferV1 (no collection), for tests that move an asset outside the program under test.
import { AccountRole, type Address, type Instruction, address } from "@solana/kit";

const CORE = address("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");

export function getTransferV1Instruction(asset: Address, owner: Address, newOwner: Address): Instruction {
  return {
    programAddress: CORE,
    accounts: [
      { address: asset, role: AccountRole.WRITABLE },
      { address: CORE, role: AccountRole.READONLY }, // collection: none
      { address: owner, role: AccountRole.WRITABLE_SIGNER }, // payer and authority
      { address: CORE, role: AccountRole.READONLY },
      { address: newOwner, role: AccountRole.READONLY },
      { address: CORE, role: AccountRole.READONLY }, // system program: none
      { address: CORE, role: AccountRole.READONLY }, // log wrapper: none
    ],
    data: new Uint8Array([14, 0]),
  };
}
