import { type Signer, type UncheckedProgram, type u64, invoke, readonly, readonlySigner, remainingAccounts, returnData, sighash, writable } from "typesol";

export function asPassed(payer: Signer, callee: UncheckedProgram): u64 {
  invoke(callee, [readonlySigner(payer), ...remainingAccounts()], [sighash("count")]);
  return returnData<u64>(callee);
}

export function allReadonly(payer: Signer, callee: UncheckedProgram): u64 {
  const rest = remainingAccounts();
  invoke(callee, [readonlySigner(payer), ...readonly(rest)], [sighash("count")]);
  return returnData<u64>(callee);
}

export function allWritable(payer: Signer, callee: UncheckedProgram): u64 {
  invoke(callee, [readonlySigner(payer), ...writable(remainingAccounts())], [sighash("count")]);
  return returnData<u64>(callee);
}

/** The remaining accounts twice, then the payer again: entries after a spread keep their order. */
export function twice(payer: Signer, callee: UncheckedProgram): u64 {
  const rest = remainingAccounts();
  invoke(callee, [readonlySigner(payer), ...readonly(rest), ...rest, readonly(payer)], [sighash("count")]);
  return returnData<u64>(callee);
}

/** Indexes from..to of the remaining accounts, read-only (how cnft-vault splits two proofs). */
export function sliced(payer: Signer, callee: UncheckedProgram, from: u64, to: u64): u64 {
  invoke(callee, [readonlySigner(payer), ...readonly(remainingAccounts().slice(from, to))], [sighash("count")]);
  return returnData<u64>(callee);
}
