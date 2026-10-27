// Port of tokens/token-2022/transfer-hook/counter @ de09019; see test/ports/README.md.
//
// The ExtraAccountMetaList lists one extra account, the ["counter"] PDA (writable), which Token-2022 checks and passes to
// the hook on every transfer. As in the original, the hook reads the counter and logs counter + 1 without storing it,
// and only logs (does not fail) amounts above 50.
// PARTIAL (builtin gap): the source account's TransferHookAccount `transferring` flag is found by walking the TLV list
// with readData (what PodStateWithExtensionsMut::get_extension does in the original).
import {
  type AccountInfo,
  type AccountMeta,
  type Account,
  type AssociatedTokenProgram,
  type HasOne,
  type Init,
  type Mint,
  type Mut,
  type Seeds,
  type Signer,
  type SystemProgram,
  type Token2022Program,
  type TokenAccount,
  type u16,
  initExtraAccountMetas,
  log,
  readData,
  require,
  u64,
  u8,
} from "typesol";

const TRANSFER_HOOK_ACCOUNT: u16 = 15n;
const U64_MAX: u64 = 18446744073709551615n;

export enum TransferError {
  AmountTooBig = "The amount is too big",
  IsNotCurrentlyTransferring = "The token is not currently transferring",
}

export interface CounterAccount {
  counter: u64;
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

/** @discriminator spl-transfer-hook-interface:initialize-extra-account-metas */
export function initializeExtraAccountMetaList(
  payer: Mut<Signer>,
  extraAccountMetaList: Mut<AccountInfo>,
  mint: Mint,
  counterAccount: Init<CounterAccount>,
  tokenProgram: Token2022Program,
  associatedTokenProgram: AssociatedTokenProgram,
  systemProgram: SystemProgram,
): void {
  initExtraAccountMetas(payer, extraAccountMetaList, mint, systemProgram, [{ seeds: ["counter"], isSigner: false, isWritable: true }]);
  counterAccount.create(payer, ["counter"]);
}

/** @discriminator spl-transfer-hook-interface:execute */
export function transferHook(
  sourceToken: HasOne<TokenAccount, "mint" | "owner">,
  mint: Mint,
  destinationToken: HasOne<TokenAccount, "mint">,
  owner: AccountInfo,
  extraAccountMetaList: Seeds<AccountInfo, ["extra-account-metas", "@mint"]>,
  counterAccount: Seeds<Account<CounterAccount>, ["counter"]>,
  amount: u64,
): void {
  // Only Token-2022 sets `transferring` on the source account, for the duration of a transfer.
  const at = extensionOffset(sourceToken, TRANSFER_HOOK_ACCOUNT);
  require(at > 0n && readData<u8>(sourceToken, at) !== 0n, TransferError.IsNotCurrentlyTransferring);
  if (amount > 50n) log(`The amount is too big: ${amount}`);
  require(counterAccount.counter < U64_MAX, TransferError.AmountTooBig);
  log(`This token has been transferred ${counterAccount.counter + 1n} times`);
}
