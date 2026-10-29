/**
 * Publish a program's IDL on chain with the Program Metadata program (ProgM6JC…), the store Anchor 1.x and
 * explorers read IDLs from. Canonical metadata (seed "idl") must be written by the program's upgrade authority;
 * anyone can write non-canonical metadata, which is derived from their own address too.
 *
 * Works against an RPC (`rpcChain`) or anything else that can read accounts and send transactions (tests use LiteSVM).
 */
import { createHash } from "node:crypto";
import { gunzipSync, inflateSync } from "node:zlib";
import {
  Compression,
  DataSource,
  Encoding,
  Format,
  decodeData,
  fetchMaybeMetadata,
  findMetadataPda,
  packDirectData,
  writeMetadata,
} from "@solana-program/program-metadata";
import {
  type Address,
  type Base64EncodedWireTransaction,
  type Blockhash,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSigner,
  createAddressWithSeed,
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
  try {
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
  } catch (e) {
    throw new Error(planFailure(e));
  }
  return metadataAddress(opts.program, canonical ? null : authority.address);
}

/**
 * The transaction planner reports a failed write as "The provided transaction plan failed to execute" and keeps the
 * reason inside: name the first failed transaction's own error instead.
 */
function planFailure(e: unknown): string {
  const seen = new Set<unknown>();
  const messages: string[] = [];
  let logs: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (!v || typeof v !== "object" || seen.has(v) || depth > 8) return;
    seen.add(v);
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.logs) && !logs.length) logs = (o.logs as unknown[]).map(String);
    if (v instanceof Error && v.message && !/transaction plan failed to execute/.test(v.message)) messages.push(v.message);
    for (const k of ["transactionPlanResult", "plans", "error", "cause", "context"]) {
      const c = o[k];
      if (Array.isArray(c)) c.forEach((x) => walk(x, depth + 1));
      else walk(c, depth + 1);
    }
  };
  walk(e, 0);
  const tail = logs.length ? `\n  ${logs.slice(-6).join("\n  ")}` : "";
  return messages.length ? `IDL write failed: ${messages[0]}${tail}` : e instanceof Error ? e.message : String(e);
}

export async function metadataAddress(program: Address, authority: Address | null): Promise<Address> {
  return (await findMetadataPda({ program, authority, seed: "idl" }))[0];
}

/** The most an IDL read from the chain may inflate to: compressed data can expand far past the account's size. */
export const MAX_IDL_BYTES = 16 * 1024 * 1024;

/** Decompress `data` (zlib or gzip), refusing output past MAX_IDL_BYTES. */
function inflateCapped(data: Uint8Array, gzip: boolean, what: string): Buffer {
  try {
    return (gzip ? gunzipSync : inflateSync)(data, { maxOutputLength: MAX_IDL_BYTES });
  } catch (e) {
    if ((e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" || e instanceof RangeError)
      throw new Error(`${what} inflates to more than ${MAX_IDL_BYTES / 1024 / 1024} MiB; refusing it`);
    throw new Error(`${what} is not valid compressed data: ${(e as Error).message}`);
  }
}

/**
 * Read an IDL back (canonical, or the one `authority` wrote). Only an IDL stored in the metadata account itself is
 * read: one that links to a URL or points at another account is refused (nothing is fetched from where it points).
 */
export async function fetchIdl(rpc: Chain["rpc"], program: Address, authority: Address | null = null): Promise<object> {
  const at = await metadataAddress(program, authority);
  const account = await fetchMaybeMetadata(rpc as never, at);
  if (!account.exists) throw new Error(`no IDL metadata account at ${at}`);
  const m = account.data;
  if (m.dataLength > m.data.length) throw new Error(`the IDL metadata at ${at} is truncated`);
  const content = (what: string) => {
    const raw = new Uint8Array(m.data.subarray(0, m.dataLength));
    const bytes = m.compression === Compression.None ? raw : inflateCapped(raw, m.compression === Compression.Gzip, what);
    // Base58 decodes in quadratic time: only small contents.
    if (m.encoding === Encoding.Base58 && bytes.length > 64 * 1024) throw new Error(`${what} is too large for base58`);
    return decodeData(bytes, m.encoding);
  };
  if (m.dataSource === DataSource.Url) {
    const url = content(`the IDL link at ${at}`);
    throw new Error(
      `the IDL at ${at} is not stored on chain but linked: ${JSON.stringify(url.slice(0, 200))}. Fetch it yourself and pass the file (typesol client <idl.json>)`,
    );
  }
  if (m.dataSource !== DataSource.Direct) throw new Error(`the IDL at ${at} is stored in another account (external data), which is not read`);
  return JSON.parse(content(`the IDL at ${at}`)) as object;
}

/** Where `anchor idl init` keeps a program's IDL: an account derived with seed "anchor:idl" from the program's base PDA. */
export async function anchorIdlAddress(program: Address): Promise<Address> {
  const [base] = await getProgramDerivedAddress({ programAddress: program, seeds: [] });
  return createAddressWithSeed({ baseAddress: base, programAddress: program, seed: "anchor:idl" });
}

/** Anchor's account discriminator for IdlAccount: sha256("account:IdlAccount")[0..8]. */
const IDL_ACCOUNT_DISCRIMINATOR = createHash("sha256").update("account:IdlAccount").digest().subarray(0, 8);

/** The IDL in Anchor's IDL account (`anchor idl init`), or null when the program has none. */
export async function fetchAnchorIdl(rpc: Chain["rpc"], program: Address): Promise<object | null> {
  const { value } = await rpc.getAccountInfo(await anchorIdlAddress(program), { encoding: "base64" }).send();
  if (!value) return null;
  const data = Buffer.from(value.data[0], "base64");
  // IdlAccount: 8-byte discriminator, authority (32 bytes), a u32 length, then the zlib-compressed JSON.
  if (data.length < 44) throw new Error("Anchor IDL account is too short");
  if (!data.subarray(0, 8).equals(IDL_ACCOUNT_DISCRIMINATOR)) throw new Error("the account at Anchor's IDL address is not an IdlAccount");
  const len = data.readUInt32LE(40);
  if (44 + len > data.length) throw new Error("Anchor IDL account is truncated");
  return JSON.parse(inflateCapped(data.subarray(44, 44 + len), false, "the Anchor IDL").toString("utf8")) as object;
}

/**
 * A program's IDL from the chain: the canonical Program Metadata IDL (`typesol idl publish`, Codama) first, else
 * Anchor's IDL account (`anchor idl init`).
 */
export async function fetchProgramIdl(rpc: Chain["rpc"], program: Address): Promise<{ idl: object; source: "program-metadata" | "anchor" }> {
  let metadataError: unknown;
  try {
    return { idl: await fetchIdl(rpc, program), source: "program-metadata" };
  } catch (e) {
    metadataError = e;
  }
  const anchor = await fetchAnchorIdl(rpc, program);
  if (anchor) return { idl: anchor, source: "anchor" };
  throw new Error(
    `no IDL on chain for ${program}: none in the Program Metadata program (${metadataError instanceof Error ? metadataError.message : String(metadataError)}) and no Anchor IDL account at ${await anchorIdlAddress(program)}`,
  );
}
