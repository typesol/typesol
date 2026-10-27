// Ports of the transfer-hook examples whose ExtraAccountMetaList holds extra accounts. Each test makes a Token-2022 mint
// with the TransferHook extension pointing at the port, and transfers with the extra accounts appended the way
// spl-transfer-hook-interface's offchain helper does (extra accounts, hook program, validation account): Token-2022
// checks them against the list the port wrote before calling the hook.
import { getCreateAccountInstruction } from "@solana-program/system";
import * as t22 from "@solana-program/token-2022";
import {
  AccountRole,
  type Address,
  type Instruction,
  type KeyPairSigner,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  lamports,
} from "@solana/kit";
import { type LiteSVM } from "litesvm";

import { TOKEN_2022, expectOk, send } from "./harness.js";
import { fundAta } from "./ports-helpers.js";

export const enc = getAddressEncoder();

/** A Token-2022 mint (decimals 2) whose TransferHook extension names `hook`; returns its address. */
export async function hookMint(svm: LiteSVM, payer: KeyPairSigner, hook: Address): Promise<Address> {
  const mint = await generateKeyPairSigner();
  const space = t22.getMintSize([t22.extension("TransferHook", { authority: payer.address, programId: hook })]);
  expectOk(
    await send(svm, payer, [
      getCreateAccountInstruction({
        payer,
        newAccount: mint,
        lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(space))),
        space,
        programAddress: TOKEN_2022,
      }),
      t22.getInitializeTransferHookInstruction({ mint: mint.address, authority: payer.address, programId: hook }),
      t22.getInitializeMint2Instruction({ mint: mint.address, decimals: 2, mintAuthority: payer.address, freezeAuthority: null }),
    ]),
  );
  return mint.address;
}

export const validationAccount = async (hook: Address, mint: Address) =>
  (await getProgramDerivedAddress({ programAddress: hook, seeds: ["extra-account-metas", enc.encode(mint)] }))[0];

/** TransferChecked with the hook's extra accounts appended (then the hook program and the validation account). */
export async function hookedTransfer(
  hook: Address,
  o: { source: Address; mint: Address; destination: Address; authority: KeyPairSigner; amount: bigint },
  extra: { address: Address; writable?: boolean; signer?: boolean }[],
): Promise<Instruction> {
  const ix = t22.getTransferCheckedInstruction({ ...o, decimals: 2 });
  return {
    ...ix,
    accounts: [
      ...ix.accounts,
      ...extra.map((e) => ({ address: e.address, role: e.writable ? AccountRole.WRITABLE : AccountRole.READONLY })),
      { address: hook, role: AccountRole.READONLY },
      { address: await validationAccount(hook, o.mint), role: AccountRole.READONLY },
    ],
  } as Instruction;
}

export async function ataFor(svm: LiteSVM, payer: KeyPairSigner, owner: Address, mint: Address, amount: bigint) {
  return fundAta(svm, payer, owner, mint, amount, { tokenProgram: TOKEN_2022 });
}
