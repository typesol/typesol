// Port of tokens/token-2022/transfer-hook/transfer-cost @ de09019; see test/ports/README.md.
//
// Every transfer of the hooked token also moves `amount` wrapped SOL from the sender's WSOL account to the ["delegate"]
// PDA's, signed by that PDA (the sender approved it as delegate beforehand). The ExtraAccountMetaList lists seven extra
// accounts: three fixed addresses (WSOL mint, SPL Token, ATA program), the delegate PDA, the two WSOL ATAs as PDAs of the
// ATA program (account index 7) and the counter PDA.
// PARTIAL:
//  - `token::mint = wsol_mint` / `token::authority = delegate|owner` on the WSOL accounts are checked in the body (6002 /
//    6003), where Anchor raises ConstraintTokenMint / ConstraintTokenOwner (2014 / 2015): HasOne<…> names the parameter
//    after the field.
//  - builtin gap: the source account's TransferHookAccount `transferring` flag is found by walking the TLV list.
import {
  type Account,
  type AccountInfo,
  type AccountMeta,
  type AssociatedTokenProgram,
  type HasOne,
  type Init,
  type Mint,
  type Mut,
  type Owner,
  type Seeds,
  type Signer,
  type SystemProgram,
  type TokenAccount,
  type TokenProgram,
  type u16,
  initExtraAccountMetas,
  log,
  pubkey,
  readData,
  require,
  seedAccountKey,
  u64,
  u8,
} from "typesol";

const TRANSFER_HOOK_ACCOUNT: u16 = 15n;
const WSOL_MINT = pubkey("So11111111111111111111111111111111111111112");
const TOKEN_PROGRAM_ID = pubkey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM_ID = pubkey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export enum TransferError {
  AmountTooBig = "Amount Too big",
  IsNotCurrentlyTransferring = "The token is not currently transferring",
  WrongWsolMint = "A WSOL account is not of the WSOL mint",
  WrongWsolOwner = "A WSOL account has the wrong owner",
}

export interface CounterAccount {
  counter: u8;
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
  systemProgram: SystemProgram,
): void {
  initExtraAccountMetas(payer, extraAccountMetaList, mint, systemProgram, [
    { address: WSOL_MINT, isSigner: false, isWritable: false },
    { address: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { address: ATA_PROGRAM_ID, isSigner: false, isWritable: false },
    { seeds: ["delegate"], isSigner: false, isWritable: true },
    // The delegate's and the sender's WSOL ATAs: PDAs of the ATA program (index 7) from owner, token program, mint.
    { seeds: [seedAccountKey(8n), seedAccountKey(6n), seedAccountKey(5n)], program: 7n, isSigner: false, isWritable: true },
    { seeds: [seedAccountKey(3n), seedAccountKey(6n), seedAccountKey(5n)], program: 7n, isSigner: false, isWritable: true },
    { seeds: ["counter"], isSigner: false, isWritable: true },
  ]);
  counterAccount.create(payer, ["counter"]);
}

/** @discriminator spl-transfer-hook-interface:execute */
export function transferHook(
  sourceToken: HasOne<TokenAccount, "mint" | "owner">,
  mint: Mint,
  destinationToken: HasOne<TokenAccount, "mint">,
  owner: AccountInfo,
  extraAccountMetaList: Seeds<AccountInfo, ["extra-account-metas", "@mint"]>,
  wsolMint: Mint,
  tokenProgram: TokenProgram,
  associatedTokenProgram: AssociatedTokenProgram,
  delegate: Seeds<Owner<Mut<AccountInfo>, "11111111111111111111111111111111">, ["delegate"]>,
  delegateWsolTokenAccount: Mut<TokenAccount>,
  senderWsolTokenAccount: Mut<TokenAccount>,
  counterAccount: Seeds<Mut<CounterAccount>, ["counter"]>,
  amount: u64,
): void {
  require(delegateWsolTokenAccount.mint === wsolMint.key && senderWsolTokenAccount.mint === wsolMint.key, TransferError.WrongWsolMint);
  require(delegateWsolTokenAccount.owner === delegate.key && senderWsolTokenAccount.owner === owner.key, TransferError.WrongWsolOwner);
  const at = extensionOffset(sourceToken, TRANSFER_HOOK_ACCOUNT);
  require(at > 0n && readData<u8>(sourceToken, at) !== 0n, TransferError.IsNotCurrentlyTransferring);
  if (amount > 50n) log(`The amount is too big ${amount}`);
  counterAccount.counter += 1n;
  log(`This token has been transferred ${counterAccount.counter} times`);
  log(mint.isWritable ? "Is writable mint true" : "Is writable mint false");
  log(destinationToken.isWritable ? "Is destination mint true" : "Is destination mint false");
  log(sourceToken.isWritable ? "Is source mint true" : "Is source mint false");
  tokenProgram.transferChecked(senderWsolTokenAccount, wsolMint, delegateWsolTokenAccount, delegate, amount, ["delegate", delegate.pdaBump]);
}
