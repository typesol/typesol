// Port of tokens/token-2022/transfer-hook/transfer-cost @ de09019; see test/ports/README.md.
//
// Every transfer of the hooked token also moves `amount` wrapped SOL from the sender's WSOL account to the ["delegate"]
// PDA's, signed by that PDA (the sender approved it as delegate beforehand). The ExtraAccountMetaList lists seven extra
// accounts: three fixed addresses (WSOL mint, SPL Token, ATA program), the delegate PDA, the two WSOL ATAs as PDAs of the
// ATA program (account index 7) and the counter PDA.
// PORTED: `token::mint` / `token::authority` on the WSOL accounts are TokenOf<…> (2014 / 2015, as Anchor).
import {
  isTransferring,
  type AccountInfo,
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
  type TokenOf,
  type TokenProgram,
  initExtraAccountMetas,
  log,
  pubkey,
  require,
  seedAccountKey,
  u64,
  u8,
} from "typesol";

const WSOL_MINT = pubkey("So11111111111111111111111111111111111111112");
const TOKEN_PROGRAM_ID = pubkey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM_ID = pubkey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export enum TransferError {
  AmountTooBig = "Amount Too big",
  IsNotCurrentlyTransferring = "The token is not currently transferring",
}

export interface CounterAccount {
  counter: u8;
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
  delegateWsolTokenAccount: TokenOf<Mut<TokenAccount>, "wsolMint", "delegate">,
  senderWsolTokenAccount: TokenOf<Mut<TokenAccount>, "wsolMint", "owner">,
  counterAccount: Seeds<Mut<CounterAccount>, ["counter"]>,
  amount: u64,
): void {
  require(isTransferring(sourceToken), TransferError.IsNotCurrentlyTransferring);
  if (amount > 50n) log(`The amount is too big ${amount}`);
  counterAccount.counter += 1n;
  log(`This token has been transferred ${counterAccount.counter} times`);
  log(mint.isWritable ? "Is writable mint true" : "Is writable mint false");
  log(destinationToken.isWritable ? "Is destination mint true" : "Is destination mint false");
  log(sourceToken.isWritable ? "Is source mint true" : "Is source mint false");
  tokenProgram.transferChecked(senderWsolTokenAccount, wsolMint, delegateWsolTokenAccount, delegate, amount, ["delegate", delegate.pdaBump]);
}
