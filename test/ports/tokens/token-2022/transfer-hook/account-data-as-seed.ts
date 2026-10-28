// Port of tokens/token-2022/transfer-hook/account-data-as-seed @ de09019; see test/ports/README.md.
//
// The ExtraAccountMetaList lists one extra account, the ["counter", owner] PDA (writable), whose second seed Token-2022
// reads from the source token account's data (bytes 32..64, its owner) on every transfer. As in the original, the hook reads the counter and logs counter + 1 without storing it,
// and only logs (does not fail) amounts above 50.
// PORTED: the source account's `transferring` flag is read with isTransferring().
import {
  isTransferring,
  type AccountInfo,
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
  initExtraAccountMetas,
  log,
  require,
  seedAccountData,
  u64,
} from "typesol";

const U64_MAX: u64 = 18446744073709551615n;

export enum TransferError {
  AmountTooBig = "The amount is too big",
  IsNotCurrentlyTransferring = "The token is not currently transferring",
}

export interface CounterAccount {
  counter: u64;
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
  initExtraAccountMetas(payer, extraAccountMetaList, mint, systemProgram, [
    { seeds: ["counter", seedAccountData(0n, 32n, 32n)], isSigner: false, isWritable: true },
  ]);
  counterAccount.create(payer, ["counter", payer.key]);
}

/** @discriminator spl-transfer-hook-interface:execute */
export function transferHook(
  sourceToken: HasOne<TokenAccount, "mint" | "owner">,
  mint: Mint,
  destinationToken: HasOne<TokenAccount, "mint">,
  owner: AccountInfo,
  extraAccountMetaList: Seeds<AccountInfo, ["extra-account-metas", "@mint"]>,
  counterAccount: Seeds<Account<CounterAccount>, ["counter", "@owner"]>,
  amount: u64,
): void {
  // Only Token-2022 sets `transferring` on the source account, for the duration of a transfer.
  require(isTransferring(sourceToken), TransferError.IsNotCurrentlyTransferring);
  if (amount > 50n) log(`The amount is too big: ${amount}`);
  require(counterAccount.counter < U64_MAX, TransferError.AmountTooBig);
  log(`This token has been transferred ${counterAccount.counter + 1n} times`);
}
