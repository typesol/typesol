import { type AccountInfo, type Mint, type Mut, type Signer, type SystemProgram, type TokenAccount, type u64, initExtraAccountMetas, require } from "typesol";

/**
 * A Token-2022 transfer hook: Token-2022 calls `execute` on every transfer of a mint whose TransferHook
 * extension points here. This one blocks transfers above 1000 base units.
 */
const LIMIT = 1000n;

/** @discriminator spl-transfer-hook-interface:initialize-extra-account-metas */
export function initializeExtraAccountMetaList(payer: Mut<Signer>, extraMetas: Mut<AccountInfo>, mint: Mint, systemProgram: SystemProgram): void {
  initExtraAccountMetas(payer, extraMetas, mint, systemProgram);
}

/** @discriminator spl-transfer-hook-interface:execute */
export function execute(source: TokenAccount, mint: Mint, destination: TokenAccount, owner: AccountInfo, extraMetas: AccountInfo, amount: u64): void {
  require(amount <= LIMIT, "transfers above 1000 are blocked by the hook");
  require(source.mint === mint.key && destination.mint === mint.key, "wrong mint");
}
