// Port of tokens/token-2022/transfer-fee @ de09019; see test/ports/README.md.
//
// PARTIAL:
//  - builtin gap: no Token-2022 extension instructions, so TransferFee Initialize, TransferCheckedWithFee,
//    WithdrawWithheldTokensFromMint, HarvestWithheldTokensToMint and SetTransferFee are hand-encoded (`invoke`). The fee
//    comes from `transferFee(mint, amount)` (TransferFeeConfig::calculate_epoch_fee).
//  - harvest passes every remaining account to HarvestWithheldTokensToMint (`...remainingAccounts()`), where the
//    original first keeps the token accounts of this mint. Token-2022 harvests what it can and skips the rest, so the
//    outcome is the same; the skipped accounts are logged by Token-2022 instead of being left out.
//  - check_mint_data finds TransferFeeConfig by walking the TLV list and requires both authorities to be the payer
//    (6000 where the original panics in `assert_eq!`); the original also logs the extension with `{:?}`.
import {
  type AccountMeta,
  type AssociatedTokenProgram,
  type Ata,
  type InitIfNeeded,
  type Mint,
  type Mut,
  type Owner,
  type AccountInfo,
  type Pubkey,
  type Signer,
  type SystemProgram,
  type Token2022Program,
  type TokenAccount,
  type u16,
  invoke,
  log,
  readData,
  readonly,
  readonlySigner,
  remainingAccounts,
  rentExempt,
  require,
  transferFee,
  u64,
  u8,
  writable,
} from "typesol";

/** Base mint (padded to 165) + account type (1) + TransferFeeConfig TLV (2 + 2 + 108). */
const MINT_SIZE_TRANSFER_FEE = 278n;
const TRANSFER_FEE_CONFIG: u16 = 1n;

export enum TransferFeeError {
  WrongAuthority = "The mint's transfer fee authorities are not the payer",
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

export function initialize(
  payer: Mut<Signer>,
  mintAccount: Mut<Signer>,
  tokenProgram: Token2022Program,
  systemProgram: SystemProgram,
  transferFeeBasisPoints: u16,
  maximumFee: u64,
): void {
  systemProgram.createAccount(payer, mintAccount, rentExempt(MINT_SIZE_TRANSFER_FEE), MINT_SIZE_TRANSFER_FEE, tokenProgram.key);
  // TransferFeeExtension (26) / InitializeTransferFeeConfig (0): config authority and withdraw authority as
  // COption<Pubkey> (a tag byte, then the key), basis points, maximum fee.
  invoke(tokenProgram, [writable(mintAccount)], [u8(26n), u8(0n), u8(1n), payer.key, u8(1n), payer.key, transferFeeBasisPoints, maximumFee]);
  tokenProgram.initializeMint2(mintAccount, 2n, payer.key, payer.key);
  // check_mint_data
  const at = extensionOffset(mintAccount, TRANSFER_FEE_CONFIG);
  require(at > 0n && readData<Pubkey>(mintAccount, at) === payer.key && readData<Pubkey>(mintAccount, at + 32n) === payer.key, TransferFeeError.WrongAuthority);
}

export function transfer(
  sender: Mut<Signer>,
  recipient: Owner<AccountInfo, "11111111111111111111111111111111">,
  mintAccount: Mut<Mint>,
  senderTokenAccount: Ata<Mut<TokenAccount>, "sender", "mintAccount">,
  recipientTokenAccount: Ata<InitIfNeeded<TokenAccount>, "recipient", "mintAccount">,
  tokenProgram: Token2022Program,
  associatedTokenProgram: AssociatedTokenProgram,
  systemProgram: SystemProgram,
  amount: u64,
): void {
  recipientTokenAccount.createIfNeeded(sender);
  const fee = transferFee(mintAccount, amount);
  // TransferFeeExtension (26) / TransferCheckedWithFee (1): amount, decimals, fee.
  invoke(
    tokenProgram,
    [writable(senderTokenAccount), readonly(mintAccount), writable(recipientTokenAccount), readonlySigner(sender)],
    [u8(26n), u8(1n), amount, mintAccount.decimals, fee],
  );
  log(`transfer amount ${amount}`);
  log(`fee amount ${fee}`);
}

export function harvest(mintAccount: Mut<Mint>, tokenProgram: Token2022Program): void {
  // TransferFeeExtension (26) / HarvestWithheldTokensToMint (4): the mint, then the source token accounts.
  invoke(tokenProgram, [writable(mintAccount), ...remainingAccounts()], [u8(26n), u8(4n)]);
}

export function withdraw(authority: Signer, mintAccount: Mut<Mint>, tokenAccount: Mut<TokenAccount>, tokenProgram: Token2022Program): void {
  // TransferFeeExtension (26) / WithdrawWithheldTokensFromMint (2).
  invoke(tokenProgram, [writable(mintAccount), writable(tokenAccount), readonlySigner(authority)], [u8(26n), u8(2n)]);
}

export function updateFee(authority: Signer, mintAccount: Mut<Mint>, tokenProgram: Token2022Program, transferFeeBasisPoints: u16, maximumFee: u64): void {
  // TransferFeeExtension (26) / SetTransferFee (5): basis points, maximum fee.
  invoke(tokenProgram, [writable(mintAccount), readonlySigner(authority)], [u8(26n), u8(5n), transferFeeBasisPoints, maximumFee]);
}
