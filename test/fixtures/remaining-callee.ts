import { type Signer, type u64, remainingAccounts } from "typesol";

/** The accounts after `payer`: total + 100 × writable + 10000 × signer. */
export function count(payer: Signer): u64 {
  const rest = remainingAccounts();
  let writable = 0n;
  let signers = 0n;
  for (let i = 0n; i < rest.length; i++) {
    if (rest.get(i).isWritable) writable += 1n;
    if (rest.get(i).isSigner) signers += 1n;
  }
  return rest.length + 100n * writable + 10000n * signers;
}
