// Port of tokens/token-2022/transfer-hook/hello-world @ de09019; see test/ports/README.md.
//
// PORTED: the TransferHook authority and program are read with transferHookAuthority() / transferHookProgram(), and
// the source account's `transferring` flag with isTransferring().
// The two interface instructions use the SPL transfer-hook discriminators, like `#[instruction(discriminator = …)]`.
import {
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
  rentExempt,
  require,
  transferHookProgram,
  u64,
  u8,
} from "typesol";

const PROGRAM_ID = pubkey("jY5DfVksJT8Le38LCaQhz5USeiGu4rUeVSS8QRAMoba");
/** Base mint (padded to 165) + account type + TransferHook TLV (2 + 2 + 64). */
const MINT_WITH_TRANSFER_HOOK = 234n;
/** Token-2022 extension types. */

export enum TransferError {
  IsNotCurrentlyTransferring = "The token is not currently transferring",
}

export function initialize(payer: Mut<Signer>, mintAccount: Mut<Signer>, tokenProgram: Token2022Program, systemProgram: SystemProgram, decimals: u8): void {
  systemProgram.createAccount(payer, mintAccount, rentExempt(MINT_WITH_TRANSFER_HOOK), MINT_WITH_TRANSFER_HOOK, tokenProgram.key);
  tokenProgram.initializeTransferHook(mintAccount, payer.key, PROGRAM_ID);
  tokenProgram.initializeMint2(mintAccount, decimals, payer.key, null);
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
