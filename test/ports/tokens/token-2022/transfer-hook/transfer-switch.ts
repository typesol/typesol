// Port of tokens/token-2022/transfer-hook/transfer-switch @ de09019; see test/ports/README.md.
//
// An admin turns transfers on or off per wallet; the hook's extra account is the sender's switch, the PDA [sender]
// (Seed::AccountKey { index: 3 }: the owner account of the execute instruction).
// PARTIAL:
//  - interface: the `switch` instruction is named `switch_` in the IDL (a reserved word in TypeScript); its
//    discriminator is the original's, so the instruction bytes are the same.
//  - configure_admin: `admin` and `new_admin` are both writable, so naming yourself is refused by TypeSOL's aliasing
//    check (2040) — on the first configuration too, where the original lets the caller become the admin. The
//    `require_keys_neq!` case cannot be reached (2040 comes first).
import {
  AnchorError,
  isTransferring,
  type Account,
  type AccountInfo,
  type HasOne,
  type InitIfNeeded,
  type Mint,
  type Mut,
  type Pubkey,
  type Seeds,
  type Signer,
  type SystemProgram,
  initExtraAccountMetas,
  require,
  seedAccountKey,
  u64,
} from "typesol";

export enum TransferError {
  IsNotCurrentlyTransferring = "The token is not currently transferring",
  SwitchNotOn = "The transfer switch is currently not on",
}

export interface TransferSwitch {
  wallet: Pubkey;
  on: boolean;
}

export interface AdminConfig {
  isInitialised: boolean;
  admin: Pubkey;
}

export function configureAdmin(admin: Mut<Signer>, newAdmin: Mut<AccountInfo>, adminConfig: InitIfNeeded<AdminConfig>, systemProgram: SystemProgram): void {
  adminConfig.createIfNeeded(admin, ["admin-config"]);
  if (adminConfig.isInitialised) {
    require(admin.key === adminConfig.admin, AnchorError.RequireKeysEqViolated);
    require(admin.key !== newAdmin.key, AnchorError.RequireKeysNeqViolated);
  }
  adminConfig.admin = newAdmin.key;
  adminConfig.isInitialised = true;
}

/** @discriminator spl-transfer-hook-interface:initialize-extra-account-metas */
export function initializeExtraAccountMetasList(
  payer: Mut<Signer>,
  tokenMint: Mint,
  extraAccountMetasList: Seeds<Mut<AccountInfo>, ["extra-account-metas", "@tokenMint"]>,
  systemProgram: SystemProgram,
): void {
  // The sender's switch: the PDA [owner of the source account] (account index 3 of the execute instruction).
  initExtraAccountMetas(payer, extraAccountMetasList, tokenMint, systemProgram, [{ seeds: [seedAccountKey(3n)], isSigner: false, isWritable: false }]);
}

/**
 * `switch` is a reserved word in TypeScript; the discriminator is Anchor's for `switch`.
 * @discriminator global:switch
 */
export function switch_(
  admin: Mut<Signer>,
  wallet: Mut<AccountInfo>,
  adminConfig: HasOne<Seeds<Account<AdminConfig>, ["admin-config"]>, "admin">,
  walletSwitch: InitIfNeeded<TransferSwitch>,
  systemProgram: SystemProgram,
  on: boolean,
): void {
  walletSwitch.createIfNeeded(admin, [wallet.key]);
  walletSwitch.wallet = wallet.key;
  walletSwitch.on = on;
}

/** @discriminator spl-transfer-hook-interface:execute */
export function transferHook(
  sourceTokenAccount: AccountInfo,
  tokenMint: Mint,
  receiverTokenAccount: AccountInfo,
  wallet: AccountInfo,
  extraAccountMetasList: Seeds<AccountInfo, ["extra-account-metas", "@tokenMint"]>,
  walletSwitch: Seeds<Account<TransferSwitch>, ["@wallet"]>,
  amount: u64,
): void {
  require(isTransferring(sourceTokenAccount), TransferError.IsNotCurrentlyTransferring);
  require(walletSwitch.on, TransferError.SwitchNotOn);
}
