import { BN, BorshCoder, type Idl } from "@anchor-lang/core";
import {
  AccountRole,
  type Address,
  type Instruction,
  type KeyPairSigner,
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM, TransactionMetadata } from "litesvm";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../src/compiler/index.js";

export { BN, address, lamports };
export const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
export const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022 = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const EXAMPLES = fileURLToPath(new URL("../examples/", import.meta.url));

export interface Deployed {
  svm: LiteSVM;
  programId: Address;
  coder: BorshCoder;
  idl: Idl;
}

/** Compile `examples/<name>.ts`, load it into a fresh LiteSVM, return a coder built from the emitted IDL. */
export async function deployExample(name: string, opts: { svm?: LiteSVM; programId?: Address } = {}): Promise<Deployed> {
  return deployFile(path.join(EXAMPLES, `${name}.ts`), opts);
}

/** Build and load a program. Pass `svm` to load several programs into one VM, `programId` to pin its address. */
export async function deployFile(file: string, opts: { svm?: LiteSVM; programId?: Address } = {}): Promise<Deployed> {
  const programId = opts.programId ?? (await generateKeyPairSigner()).address;
  const out = mkdtempSync(path.join(os.tmpdir(), `typesol-${path.basename(file, ".ts")}-`));
  const res = build(file, out, programId);
  const svm = opts.svm ?? new LiteSVM();
  svm.addProgramFromFile(programId, res.soPath);
  const idl = res.idl as unknown as Idl;
  return { svm, programId, coder: new BorshCoder(idl), idl };
}

export async function fundedSigner(svm: LiteSVM, sol = 10n): Promise<KeyPairSigner> {
  const s = await generateKeyPairSigner();
  svm.airdrop(s.address, lamports(sol * 1_000_000_000n));
  return s;
}

export async function pda(programId: Address, seeds: (string | Address | Uint8Array)[]): Promise<[Address, number]> {
  const enc = getAddressEncoder();
  const bytes = seeds.map((s) =>
    s instanceof Uint8Array ? s : typeof s === "string" && s.length < 32 ? new TextEncoder().encode(s) : enc.encode(s as Address),
  );
  const [address, bump] = await getProgramDerivedAddress({ programAddress: programId, seeds: bytes as Uint8Array[] });
  return [address, bump];
}

/** An account that must exist (throws otherwise), with its data, owner and lamports typed. */
export function acct(svm: LiteSVM, address: Address): { data: Uint8Array; programAddress: Address; lamports: bigint } {
  const a = svm.getAccount(address);
  if (!a.exists) throw new Error(`account ${address} does not exist`);
  return { data: a.data, programAddress: a.programAddress, lamports: a.lamports };
}

export type Meta = { address: Address; signer?: KeyPairSigner; writable?: boolean };

export function ix(d: Deployed, name: string, args: Record<string, unknown>, accounts: Meta[]): Instruction {
  const data = d.coder.instruction.encode(name, args);
  return {
    programAddress: d.programId,
    accounts: accounts.map((a) => ({
      address: a.address,
      role: a.signer ? (a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY,
      ...(a.signer ? { signer: a.signer } : {}),
    })) as Instruction["accounts"],
    data: new Uint8Array(data),
  };
}

export async function send(svm: LiteSVM, payer: KeyPairSigner, ixs: Instruction[]): Promise<TransactionMetadata | FailedTransactionMetadata> {
  const tx = await pipe(
    createTransactionMessage({ version: 0 }),
    (t) => setTransactionMessageFeePayerSigner(payer, t),
    (t) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(t),
    (t) => appendTransactionMessageInstructions(ixs, t),
    (t) => signTransactionMessageWithSigners(t),
  );
  const res = svm.sendTransaction(tx);
  svm.expireBlockhash();
  return res;
}

export function expectOk(res: TransactionMetadata | FailedTransactionMetadata): TransactionMetadata {
  if (res instanceof FailedTransactionMetadata) throw new Error(`transaction failed: ${String(res.err())}\n${res.meta().logs().join("\n")}`);
  return res;
}

/** Returns the custom program error code, or throws if the tx succeeded / failed differently. */
export function customError(res: TransactionMetadata | FailedTransactionMetadata): number {
  if (!(res instanceof FailedTransactionMetadata)) throw new Error("expected the transaction to fail");
  const text = String(res.err());
  const m = /Custom\D*(\d+)/.exec(text);
  if (!m) throw new Error(`not a custom error: ${text}\n${res.meta().logs().join("\n")}`);
  return Number(m[1]);
}

export function decodeAccount<T>(d: Deployed, svm: LiteSVM, name: string, addr: Address): T {
  const acct = svm.getAccount(addr);
  if (!acct.exists) throw new Error(`account ${addr} does not exist`);
  return d.coder.accounts.decode(name, Buffer.from(acct.data)) as T;
}
