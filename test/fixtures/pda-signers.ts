// PDAs of this program signing CPIs: a system-owned SOL vault paying out through systemProgram.transfer, and two PDAs
// signing one CPI (a System CreateAccount whose payer and new account are both PDAs, one through a const seed list).
import { type AccountInfo, type Mut, type Signer, type SystemProgram, type u8, type u32, type u64, invoke, programId, signer, writableSigner } from "typesol";

/** Pay `amount` out of the SOL vault PDA ["sol", owner]. Only the owner may. */
export function withdraw(owner: Signer, vault: Mut<AccountInfo>, to: Mut<AccountInfo>, systemProgram: SystemProgram, bump: u8, amount: u64): void {
  systemProgram.transfer(vault, to, amount, ["sol", owner.key, bump]);
}

/** The vault ["sol", owner] pays for a new 8-byte account at the PDA ["box", owner], owned by this program. */
export function boxUp(
  owner: Signer,
  vault: Mut<AccountInfo>,
  box: Mut<AccountInfo>,
  systemProgram: SystemProgram,
  vaultBump: u8,
  boxBump: u8,
  lamports: u64,
): void {
  const tag: u32 = 0n; // CreateAccount
  const payer = signer(["sol", owner.key, vaultBump]);
  invoke(
    systemProgram,
    [writableSigner(vault), writableSigner(box)],
    [tag, lamports, 8n, programId()],
    [
      payer,
      ["box", owner.key, boxBump],
    ],
  );
}
