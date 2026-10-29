// Shared helpers for the ports of solana-developers/program-examples (test/ports/**/*.ts, test/porting/ports-*.test.ts).
import { getCreateAccountInstruction } from "@solana-program/system";
import * as t22 from "@solana-program/token-2022";
import { getTokenDecoder } from "@solana-program/token";
import { type Address, type Instruction, type KeyPairSigner, address, generateKeyPairSigner, getAddressEncoder } from "@solana/kit";
import type { LiteSVM } from "litesvm";
import { fileURLToPath } from "node:url";
import { TOKEN_PROGRAM, deployFile, expectOk, send, type Deployed } from "./harness.js";

export const METADATA_PROGRAM = address("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

/** Compile `test/ports/<file>` and load it at the original program's declared address. */
export function deployPort(file: string, programId: string, opts: { svm?: LiteSVM } = {}): Promise<Deployed> {
  return deployFile(fileURLToPath(new URL(`./ports/${file}`, import.meta.url)), { programId: address(programId), svm: opts.svm });
}

/** A System CreateAccount instruction: how a client allocates a Zeroed<T> account (or a keypair-signed mint). */
export function allocate(svm: LiteSVM, payer: KeyPairSigner, account: KeyPairSigner, space: number, owner: Address): Instruction {
  return getCreateAccountInstruction({ payer, newAccount: account, lamports: svm.minimumBalanceForRentExemption(BigInt(space)), space, programAddress: owner });
}

export function addrBytes(a: Address): Uint8Array {
  return new Uint8Array(getAddressEncoder().encode(a));
}

/** An Anchor-coder Pubkey argument. */
export function pk(a: Address): { toBuffer: () => Buffer } {
  return { toBuffer: () => Buffer.from(addrBytes(a)) };
}

/** A FixedString<N> as the Anchor coder decodes it from a TypeSOL IDL (u32 length + N bytes). */
export function fixedString(v: unknown): string {
  const o = v as Record<string, unknown>;
  const len = Number(Object.values(o).find((x) => typeof x === "number" || (typeof x === "object" && x !== null && "toNumber" in x)) as number);
  const bytes = Object.values(o).find((x) => Array.isArray(x) || x instanceof Uint8Array) as number[];
  return Buffer.from(bytes.slice(0, len)).toString("utf8");
}

/** A FixedString<N> as an Anchor-coder argument value. */
export function toFixedString(s: string, cap: number): unknown {
  const b = Buffer.from(s, "utf8");
  const data = Buffer.alloc(cap);
  b.copy(data);
  return { len: b.length, bytes: [...data] };
}

/** Token balance (legacy or Token-2022 base layout), or undefined when the account does not exist. */
export function tokenBalance(svm: LiteSVM, a: Address): bigint | undefined {
  const acct = svm.getAccount(a);
  return acct.exists ? getTokenDecoder().decode(acct.data.subarray(0, 165)).amount : undefined;
}

/** The associated token account of `owner` for `mint` under `tokenProgram`. */
export async function ataOf(owner: Address, mint: Address, tokenProgram: Address = TOKEN_PROGRAM): Promise<Address> {
  const [a] = await t22.findAssociatedTokenPda({ owner, mint, tokenProgram });
  return a;
}

/** A new mint (keypair) of `tokenProgram` whose mint authority is `authority` (default: the payer). */
export async function createMint(
  svm: LiteSVM,
  payer: KeyPairSigner,
  o: { tokenProgram?: Address; decimals?: number; authority?: Address; freeze?: Address } = {},
): Promise<Address> {
  const mint = await generateKeyPairSigner();
  const tokenProgram = o.tokenProgram ?? TOKEN_PROGRAM;
  const res = await send(svm, payer, [
    allocate(svm, payer, mint, 82, tokenProgram),
    t22.getInitializeMint2Instruction(
      { mint: mint.address, decimals: o.decimals ?? 6, mintAuthority: o.authority ?? payer.address, freezeAuthority: o.freeze ?? null },
      { programAddress: tokenProgram as never },
    ),
  ]);
  expectOk(res);
  return mint.address;
}

/** Create `owner`'s ATA for `mint` (idempotent) and mint `amount` into it with `authority` (default: the payer). */
export async function fundAta(
  svm: LiteSVM,
  payer: KeyPairSigner,
  owner: Address,
  mint: Address,
  amount: bigint,
  o: { tokenProgram?: Address; authority?: KeyPairSigner } = {},
): Promise<Address> {
  const tokenProgram = o.tokenProgram ?? TOKEN_PROGRAM;
  const ata = await ataOf(owner, mint, tokenProgram);
  const ixs: Instruction[] = [t22.getCreateAssociatedTokenIdempotentInstruction({ payer, ata, owner, mint, tokenProgram })];
  if (amount > 0n)
    ixs.push(t22.getMintToInstruction({ mint, token: ata, mintAuthority: o.authority ?? payer, amount }, { programAddress: tokenProgram as never }));
  expectOk(await send(svm, payer, ixs));
  return ata;
}
