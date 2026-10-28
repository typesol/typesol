// Port of tokens/token-2022/transfer-fee @ de09019; see test/ports/README.md.
//
// PARTIAL:
//  - harvest passes every remaining account to HarvestWithheldTokensToMint (`remainingAccounts()`), where the
//    original first keeps the token accounts of this mint. Token-2022 harvests what it can and skips the rest, so the
//    outcome is the same; the skipped accounts are logged by Token-2022 instead of being left out.
//  - check_mint_data finds TransferFeeConfig by walking the TLV list and requires both authorities to be the payer
//    (6000 where the original panics in `assert_eq!`); the original also logs the extension with `{:?}`.
import {
  type Init,
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
  log,
  readData,
  remainingAccounts,
  require,
  transferFee,
  u64,
} from "typesol";

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
  mintAccount: Init<Mint>,
  tokenProgram: Token2022Program,
  systemProgram: SystemProgram,
  transferFeeBasisPoints: u16,
  maximumFee: u64,
): void {
  mintAccount.create(payer, null, 2n, payer.key, payer.key, {
    transferFee: { configAuthority: payer.key, withdrawAuthority: payer.key, basisPoints: transferFeeBasisPoints, maximumFee },
  });
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
  // The fee is TransferFeeConfig::calculate_epoch_fee, as in the original.
  tokenProgram.transferCheckedWithFee(senderTokenAccount, mintAccount, recipientTokenAccount, sender, amount, fee);
  log(`transfer amount ${amount}`);
  log(`fee amount ${fee}`);
}

export function harvest(mintAccount: Mut<Mint>, tokenProgram: Token2022Program): void {
  tokenProgram.harvestWithheldTokensToMint(mintAccount, remainingAccounts());
}

export function withdraw(authority: Signer, mintAccount: Mut<Mint>, tokenAccount: Mut<TokenAccount>, tokenProgram: Token2022Program): void {
  tokenProgram.withdrawWithheldTokensFromMint(mintAccount, tokenAccount, authority);
}

export function updateFee(authority: Signer, mintAccount: Mut<Mint>, tokenProgram: Token2022Program, transferFeeBasisPoints: u16, maximumFee: u64): void {
  tokenProgram.setTransferFee(mintAccount, authority, transferFeeBasisPoints, maximumFee);
}
