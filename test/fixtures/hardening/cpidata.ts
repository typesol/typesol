import { type Mut, type AccountInfo, type Program, type u64, invoke, readonly, sighash, writable } from "typesol";

export function relay(target: Mut<AccountInfo>, prog: Program<"11111111111111111111111111111111">, memo: string, amount: u64): void {
  invoke(prog, [writable(target)], [sighash("note"), memo, amount]);
}
