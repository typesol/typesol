// Port of tokens/token-2022/group @ de09019; see test/ports/README.md.
//
// PARTIAL:
//  - check_mint_data reads the GroupPointer extension by walking the TLV list with readData (what
//    StateWithExtensions::get_extension does) and requires it to name the mint; the original logs it with `{:?}`.
import {
  type Mint,
  type Init,
  type AccountMeta,
  type Mut,
  type Pubkey,
  type Signer,
  type SystemProgram,
  type Token2022Program,
  type u16,
  log,
  readData,
  require,
  u64,
} from "typesol";

const GROUP_POINTER: u16 = 20n;

export enum GroupError {
  MissingGroupPointer = "The mint has no GroupPointer extension naming it",
}

/** Offset of the value of extension `ext` in a Token-2022 account (TLV entries after byte 166), or 0 when absent. */
function extensionOffset(account: AccountMeta, ext: u16): u64 {
  let off = 166n;
  while (off + 4n <= account.dataLen) {
    const t = readData<u16>(account, off);
    const len = readData<u16>(account, off + 2n);
    if (t === ext) return off + 4n;
    if (t === 0n) return 0n;
    off += 4n + u64(len);
  }
  return 0n;
}

export function testInitializeGroup(payer: Mut<Signer>, mintAccount: Init<Mint>, tokenProgram: Token2022Program, systemProgram: SystemProgram): void {
  // `init, seeds = [b"group"], mint::*, extensions::group_pointer::*`
  mintAccount.create(payer, ["group"], 2n, mintAccount.key, mintAccount.key, {
    groupPointer: { authority: mintAccount.key, groupAddress: mintAccount.key },
  });
  // check_mint_data
  const at = extensionOffset(mintAccount, GROUP_POINTER);
  require(at > 0n && readData<Pubkey>(mintAccount, at + 32n) === mintAccount.key, GroupError.MissingGroupPointer);
  log("GroupPointer: authority and group address are the mint");
}
