// LiteSVM standing in for a cluster: an RPC-shaped Chain over the VM, and programs installed the way the loaders store them.
import { type Address, type Blockhash, getAddressEncoder, getBase64Encoder, getProgramDerivedAddress, getTransactionDecoder, lamports } from "@solana/kit";
import { FailedTransactionMetadata, type LiteSVM } from "litesvm";
import { readFileSync } from "node:fs";
import type { Chain } from "../src/tools/idlpublish.js";

/** A Chain over LiteSVM: RPC-shaped account reads, sends through the VM. */
export function svmChain(svm: LiteSVM): Chain {
  const info = (a: Address) => {
    const acct = svm.getAccount(a);
    if (!acct?.exists) return null;
    return {
      data: [Buffer.from(acct.data).toString("base64"), "base64"],
      executable: acct.executable,
      lamports: acct.lamports,
      owner: acct.programAddress,
      space: BigInt(acct.data.length),
      rentEpoch: 0n,
    };
  };
  return {
    rpc: {
      getAccountInfo: (a: Address) => ({ send: async () => ({ context: { slot: 0n }, value: info(a) }) }),
      getMultipleAccounts: (as: Address[]) => ({ send: async () => ({ context: { slot: 0n }, value: as.map(info) }) }),
    } as never,
    minimumBalance: async (space) => svm.minimumBalanceForRentExemption(BigInt(space)),
    latestBlockhash: async () => ({ blockhash: svm.latestBlockhash() as Blockhash, lastValidBlockHeight: 1_000_000n }),
    sendAndConfirm: async (wire) => {
      const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
      // Writes of one plan run concurrently on the same blockhash: do not expire it between them.
      const res = svm.sendTransaction(tx as never);
      if (res instanceof FailedTransactionMetadata) throw new Error(`${String(res.err())}\n${res.meta().logs().join("\n")}`);
    },
  };
}

/** Install `so` as an upgradeable (loader v3) program whose upgrade authority is `authority` (null: frozen); deployed in slot 123. */
export async function upgradeable(svm: LiteSVM, program: Address, so: string, authority: Address | null) {
  const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111" as Address;
  const enc = getAddressEncoder();
  const [programData] = await getProgramDerivedAddress({ programAddress: LOADER, seeds: [enc.encode(program)] });
  const elf = readFileSync(so);
  const pd = Buffer.alloc(45 + elf.length);
  pd.writeUInt32LE(3, 0);
  pd.writeBigUInt64LE(123n, 4); // deploy slot
  if (authority) {
    pd[12] = 1;
    Buffer.from(enc.encode(authority)).copy(pd, 13);
  }
  elf.copy(pd, 45);
  const prog = Buffer.alloc(36);
  prog.writeUInt32LE(2, 0);
  Buffer.from(enc.encode(programData)).copy(prog, 4);
  svm.setAccount({
    address: programData,
    data: new Uint8Array(pd),
    executable: false,
    lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(pd.length))),
    programAddress: LOADER,
    space: BigInt(pd.length),
  });
  svm.setAccount({
    address: program,
    data: new Uint8Array(prog),
    executable: true,
    lamports: lamports(svm.minimumBalanceForRentExemption(36n)),
    programAddress: LOADER,
    space: 36n,
  });
}

/** Install raw program-account data owned by `loader` (loader v2: the ELF; loader v4: header + ELF). */
export function rawProgram(svm: LiteSVM, program: Address, loader: Address, data: Buffer) {
  svm.setAccount({
    address: program,
    data: new Uint8Array(data),
    executable: true,
    lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(data.length))),
    programAddress: loader,
    space: BigInt(data.length),
  });
}
