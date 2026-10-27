// Port of tokens/token-2022/group @ de09019; see test/ports/README.md.
//
// PARTIAL:
//  - builtin gap: no Token-2022 extension initializers, so the PDA mint (["group"]) Anchor makes with `init`,
//    `mint::*` and `extensions::group_pointer::*` is created in the body: CreateAccount sized for the extension (signed
//    with the PDA's seeds), GroupPointer Initialize hand-encoded (`invoke`), then InitializeMint2.
//  - check_mint_data reads the GroupPointer extension by walking the TLV list with readData (what
//    StateWithExtensions::get_extension does) and requires it to name the mint; the original logs it with `{:?}`.
import {
  type AccountInfo,
  type AccountMeta,
  type Mut,
  type Pubkey,
  type Seeds,
  type Signer,
  type SystemProgram,
  type Token2022Program,
  type u16,
  invoke,
  log,
  readData,
  rentExempt,
  require,
  u64,
  u8,
  writable,
} from "typesol";

/** Base mint (padded to 165) + account type (1) + GroupPointer TLV (2 + 2 + 64). */
const MINT_SIZE_GROUP_POINTER = 234n;
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

export function testInitializeGroup(
  payer: Mut<Signer>,
  mintAccount: Seeds<Mut<AccountInfo>, ["group"]>,
  tokenProgram: Token2022Program,
  systemProgram: SystemProgram,
): void {
  systemProgram.createAccount(payer, mintAccount, rentExempt(MINT_SIZE_GROUP_POINTER), MINT_SIZE_GROUP_POINTER, tokenProgram.key, [
    "group",
    mintAccount.pdaBump,
  ]);
  // GroupPointerExtension (40) / Initialize (0): authority, group address.
  invoke(tokenProgram, [writable(mintAccount)], [u8(40n), u8(0n), mintAccount.key, mintAccount.key]);
  tokenProgram.initializeMint2(mintAccount, 2n, mintAccount.key, mintAccount.key);
  // check_mint_data
  const at = extensionOffset(mintAccount, GROUP_POINTER);
  require(at > 0n && readData<Pubkey>(mintAccount, at + 32n) === mintAccount.key, GroupError.MissingGroupPointer);
  log("GroupPointer: authority and group address are the mint");
}
