// Port of tokens/token-2022/transfer-hook/hello-world @ de09019; see test/ports/README.md.
//
// PARTIAL (builtin gaps):
//  - no Token-2022 extension initializers: InitializeTransferHook is hand-encoded (`invoke`).
//  - TypeSOL reads a few extensions (transferHookProgram(), hasExtension()) but not arbitrary extension fields, so the
//    TransferHook authority and the source account's TransferHookAccount `transferring` flag are found by walking
//    the TLV extension list with readData (what StateWithExtensions::get_extension does in the original).
// The two interface instructions use the SPL transfer-hook discriminators, like `#[instruction(discriminator = …)]`.
import {
  type AccountInfo,
  type AccountMeta,
  type AssociatedTokenProgram,
  type HasOne,
  type Mint,
  type Mut,
  type Pubkey,
  type Seeds,
  type Signer,
  type SystemProgram,
  type Token2022Program,
  type TokenAccount,
  initExtraAccountMetas,
  invoke,
  log,
  pubkey,
  readData,
  rentExempt,
  require,
  transferHookProgram,
  u16,
  u64,
  u8,
  writable,
} from "typesol";

const PROGRAM_ID = pubkey("jY5DfVksJT8Le38LCaQhz5USeiGu4rUeVSS8QRAMoba");
/** Base mint (padded to 165) + account type + TransferHook TLV (2 + 2 + 64). */
const MINT_WITH_TRANSFER_HOOK = 234n;
/** Token-2022 extension types. */
const TRANSFER_HOOK: u16 = 14n;
const TRANSFER_HOOK_ACCOUNT: u16 = 15n;

export enum TransferError {
  IsNotCurrentlyTransferring = "The token is not currently transferring",
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

export function initialize(payer: Mut<Signer>, mintAccount: Mut<Signer>, tokenProgram: Token2022Program, systemProgram: SystemProgram, decimals: u8): void {
  systemProgram.createAccount(payer, mintAccount, rentExempt(MINT_WITH_TRANSFER_HOOK), MINT_WITH_TRANSFER_HOOK, tokenProgram.key);
  // TransferHookExtension (36) / Initialize (0): authority, hook program.
  invoke(tokenProgram, [writable(mintAccount)], [u8(36n), u8(0n), payer.key, PROGRAM_ID]);
  tokenProgram.initializeMint2(mintAccount, decimals, payer.key, null);
  // check_mint_data
  const at = extensionOffset(mintAccount, TRANSFER_HOOK);
  require(at > 0n && readData<Pubkey>(mintAccount, at) === payer.key, "transfer hook authority");
  require(transferHookProgram(mintAccount) === PROGRAM_ID, "transfer hook program");
}

/** @discriminator spl-transfer-hook-interface:initialize-extra-account-metas */
export function initializeExtraAccountMetaList(
  payer: Mut<Signer>,
  extraAccountMetaList: Mut<AccountInfo>,
  mint: Mint,
  tokenProgram: Token2022Program,
  associatedTokenProgram: AssociatedTokenProgram,
  systemProgram: SystemProgram,
): void {
  // No extra accounts in this example.
  initExtraAccountMetas(payer, extraAccountMetaList, mint, systemProgram);
}

/** @discriminator spl-transfer-hook-interface:execute */
export function transferHook(
  sourceToken: HasOne<TokenAccount, "mint" | "owner">,
  mint: Mint,
  destinationToken: HasOne<TokenAccount, "mint">,
  owner: AccountInfo,
  extraAccountMetaList: Seeds<AccountInfo, ["extra-account-metas", "@mint"]>,
  amount: u64,
): void {
  // Only Token-2022 sets `transferring` on the source account, for the duration of a transfer.
  const at = extensionOffset(sourceToken, TRANSFER_HOOK_ACCOUNT);
  require(at > 0n && readData<u8>(sourceToken, at) !== 0n, TransferError.IsNotCurrentlyTransferring);
  log("Hello Transfer Hook!");
}
