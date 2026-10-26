/**
 * Publish a program's IDL on chain with the Program Metadata program (ProgM6JC…), the store Anchor 1.x and
 * explorers read IDLs from. Canonical metadata (seed "idl") must be written by the program's upgrade authority;
 * anyone can write non-canonical metadata, which is derived from their own address too.
 *
 * Works against an RPC (`rpcChain`) or anything else that can read accounts and send transactions (tests use LiteSVM).
 */
import { Compression, Encoding, Format, fetchMetadataContent, findMetadataPda, packDirectData, writeMetadata } from "@solana-program/program-metadata";
import {
  type Address,
  type Base64EncodedWireTransaction,
  type Blockhash,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSigner,
  createClient,
  createTransactionMessage,
  createTransactionPlanExecutor,
  createTransactionPlanner,
  extendClient,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";

export const PROGRAM_METADATA_ID = "ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S" as Address;

/** What publishing needs from a chain. */
export interface Chain {
  /** An RPC-shaped `getAccountInfo` (base64), used to look up existing metadata. */
  rpc: Pick<Rpc<SolanaRpcApi>, "getAccountInfo" | "getMultipleAccounts">;
  minimumBalance(space: number): Promise<bigint>;
  latestBlockhash(): Promise<{ blockhash: Blockhash; lastValidBlockHeight: bigint }>;
  /** Send a signed transaction and wait until it is confirmed; throw if it failed. */
  sendAndConfirm(wire: Base64EncodedWireTransaction, signature: string): Promise<void>;
}

/** A Chain over an RPC endpoint (polls signature status: no websocket needed). */
export function rpcChain(rpc: Rpc<SolanaRpcApi>): Chain {
  return {
    rpc,
    minimumBalance: async (space) => rpc.getMinimumBalanceForRentExemption(BigInt(space)).send(),
    latestBlockhash: async () => (await rpc.getLatestBlockhash({ commitment: "confirmed" }).send()).value,
    sendAndConfirm: async (wire, signature) => {
      await rpc.sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" }).send();
      for (let i = 0; i < 90; i++) {
        const st = (await rpc.getSignatureStatuses([signature as never]).send()).value[0];
        if (st?.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(st.err, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
        if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return;
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error(`transaction ${signature} was not confirmed in time`);
    },
  };
}

export interface PublishOptions {
  program: Address;
  idl: object;
  payer: TransactionSigner;
  /** Canonical metadata: the program's upgrade authority. Non-canonical: any signer (defaults to the payer). */
  authority?: TransactionSigner;
  canonical?: boolean;
}

/** Write (create or update) the IDL metadata account; returns its address. */
export async function publishIdl(chain: Chain, opts: PublishOptions): Promise<Address> {
  const authority = opts.authority ?? opts.payer;
  const canonical = opts.canonical ?? true;
  const planner = createTransactionPlanner({
    createTransactionMessage: () => pipe(createTransactionMessage({ version: 0 }), (tx) => setTransactionMessageFeePayerSigner(opts.payer, tx)),
  });
  const executor = createTransactionPlanExecutor({
    executeTransactionMessage: async (context, message) => {
      const blockhash = await chain.latestBlockhash();
      const signed = await signTransactionMessageWithSigners(setTransactionMessageLifetimeUsingBlockhash(blockhash, message));
      const signature = getSignatureFromTransaction(signed);
      await chain.sendAndConfirm(getBase64EncodedWireTransaction(signed), signature);
      return { ...context, transaction: signed, signature };
    },
  });
  const client = createClient().use((c) =>
    extendClient(c, {
      rpc: chain.rpc,
      payer: opts.payer,
      getMinimumBalance: async (space: number, config?: { withoutHeader?: boolean }) =>
        // Without the 128-byte account header: the per-byte rent only, as the Program Metadata client expects.
        lamports(config?.withoutHeader ? ((await chain.minimumBalance(0)) / 128n) * BigInt(space) : await chain.minimumBalance(space)),
      planTransactions: (plan: never) => planner(plan),
      planTransaction: async (plan: never) => planner(plan),
      sendTransactions: async (plan: never) => executor(await planner(plan)),
    }),
  );
  const packed = packDirectData({ content: JSON.stringify(opts.idl), compression: Compression.Zlib, encoding: Encoding.Utf8 });
  // Canonical metadata is tied to the program through its ProgramData account (the upgrade authority signs).
  const programData = canonical
    ? (
        await getProgramDerivedAddress({
          programAddress: "BPFLoaderUpgradeab1e11111111111111111111111" as Address,
          seeds: [getAddressEncoder().encode(opts.program)],
        })
      )[0]
    : undefined;
  await writeMetadata(
    client as never,
    {
      payer: opts.payer,
      authority,
      program: opts.program,
      ...(programData ? { programData } : {}),
      seed: "idl",
      format: Format.Json,
      ...packed,
    } as never,
  );
  return metadataAddress(opts.program, canonical ? null : authority.address);
}

export async function metadataAddress(program: Address, authority: Address | null): Promise<Address> {
  return (await findMetadataPda({ program, authority, seed: "idl" }))[0];
}

/** Read an IDL back (canonical, or the one `authority` wrote). */
export async function fetchIdl(rpc: Chain["rpc"], program: Address, authority: Address | null = null): Promise<object> {
  return JSON.parse(await fetchMetadataContent(rpc as never, program, "idl", authority));
}
