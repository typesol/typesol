// Port of tokens/token-2022/transfer-hook/hello-world @ de09019; see test/ports/README.md.
//
// PORTED: the TransferHook authority and program are read with transferHookAuthority() / transferHookProgram(), and
// the source account's `transferring` flag with isTransferring().
// The two interface instructions use the SPL transfer-hook discriminators, like `#[instruction(discriminator = …)]`.
import {
  type Init,
  transferHookAuthority,
  isTransferring,
  type AccountInfo,
  type AssociatedTokenProgram,
  type HasOne,
  type Mint,
  type Mut,
  type Seeds,
  type Signer,
  type SystemProgram,
  type Token2022Program,
  type TokenAccount,
  initExtraAccountMetas,
  log,
  pubkey,
  require,
  transferHookProgram,
  u64,
  u8,
} from "typesol";

const PROGRAM_ID = pubkey("jY5DfVksJT8Le38LCaQhz5USeiGu4rUeVSS8QRAMoba");
/** Token-2022 extension types. */

export enum TransferError {
  IsNotCurrentlyTransferring = "The token is not currently transferring",
}

export function initialize(payer: Mut<Signer>, mintAccount: Init<Mint>, tokenProgram: Token2022Program, systemProgram: SystemProgram, decimals: u8): void {
  mintAccount.create(payer, null, decimals, payer.key, null, { transferHook: { authority: payer.key, programId: PROGRAM_ID } });
  // check_mint_data
  require(transferHookAuthority(mintAccount) === payer.key, "transfer hook authority");
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
  require(isTransferring(sourceToken), TransferError.IsNotCurrentlyTransferring);
  log("Hello Transfer Hook!");
}
