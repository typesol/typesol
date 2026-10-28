/**
 * A kit RPC and subscriptions pair answered by LiteSVM, so generated clients run in tests as they run against a
 * cluster: `sendInstructions`, `simulate`, `views`, `accounts.<Name>.fetch*` and `watch`, `resolve`, `eventsOf` and
 * `watchEvents`. Only the methods those helpers call are answered.
 *
 *   const { rpc, rpcSubscriptions } = svmConnection(svm);
 *   await counter.sendInstructions({ rpc, rpcSubscriptions }, alice, [await counter.initialize({ authority: alice })]);
 *   await counter.accounts.Counter.fetch(rpc, address);
 *
 * Transactions run as they are sent (confirmed at once). LiteSVM cannot list accounts, so `getProgramAccounts` scans
 * the accounts transactions sent through this connection named, plus those passed to `track`.
 */
import {
  type Address,
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  getAddressDecoder,
  getBase58Decoder,
  getBase58Encoder,
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import { FailedTransactionMetadata, type LiteSVM, type TransactionMetadata } from "litesvm";

export interface SvmConnection {
  rpc: Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  /** Every transaction sent through `rpc` that succeeded, in order. */
  transactions: { signature: string; meta: TransactionMetadata }[];
  /** Add accounts for `getProgramAccounts` to scan (accounts the transactions named are scanned already). */
  track(...addresses: Address[]): void;
}

const b64 = (bytes: Uint8Array) => getBase64Decoder().decode(bytes);
const reply = <T>(value: T) => ({ send: async () => value });

export function svmConnection(svm: LiteSVM): SvmConnection {
  const transactions: SvmConnection["transactions"] = [];
  const known = new Set<Address>();
  const decode = (wire: string) => {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
    return { tx, keys: getCompiledTransactionMessageDecoder().decode(tx.messageBytes).staticAccounts };
  };
  const encoded = (a: Address) => {
    const acct = svm.getAccount(a);
    if (!acct.exists) return null;
    return {
      data: [b64(acct.data), "base64"],
      executable: acct.executable,
      lamports: acct.lamports,
      owner: acct.programAddress,
      space: BigInt(acct.data.length),
      rentEpoch: 0n,
    };
  };
  const rpc = {
    getLatestBlockhash: () => reply({ context: { slot: 0n }, value: { blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1_000_000n } }),
    getEpochInfo: () => reply({ absoluteSlot: 0n, blockHeight: 0n, epoch: 0n, slotIndex: 0n, slotsInEpoch: 432_000n, transactionCount: null }),
    getSignatureStatuses: (sigs: string[]) =>
      reply({
        context: { slot: 0n },
        value: sigs.map((s) =>
          transactions.some((t) => t.signature === s)
            ? { confirmationStatus: "confirmed", confirmations: null, err: null, slot: 0n, status: { Ok: null } }
            : null,
        ),
      }),
    getMinimumBalanceForRentExemption: (space: bigint) => reply(svm.minimumBalanceForRentExemption(space)),
    getBalance: (a: Address) => reply({ context: { slot: 0n }, value: svm.getBalance(a) ?? 0n }),
    sendTransaction: (wire: string) => ({
      send: async () => {
        const { tx, keys } = decode(wire);
        const res = svm.sendTransaction(tx as never);
        svm.expireBlockhash();
        if (res instanceof FailedTransactionMetadata) throw new Error(`transaction failed: ${String(res.err())}\n${res.meta().logs().join("\n")}`);
        for (const k of keys) known.add(k);
        const signature = getBase58Decoder().decode(res.signature());
        transactions.push({ signature, meta: res });
        return signature;
      },
    }),
    simulateTransaction: (wire: string, config: { sigVerify?: boolean } = {}) => ({
      send: async () => {
        // Simulations are usually unsigned (sigVerify: false): turn LiteSVM's check off for this one only.
        const inner = (svm as unknown as { inner?: { getSigverify?: () => boolean } }).inner;
        const restore = config.sigVerify === false && inner?.getSigverify?.() === true;
        if (restore) svm.withSigverify(false);
        let res;
        try {
          res = svm.simulateTransaction(decode(wire).tx as never);
        } finally {
          if (restore) svm.withSigverify(true);
        }
        if (res instanceof FailedTransactionMetadata)
          return {
            context: { slot: 0n },
            value: { err: String(res.err()), logs: res.meta().logs(), unitsConsumed: res.meta().computeUnitsConsumed(), returnData: null },
          };
        const meta = res.meta();
        const ret = meta.returnData();
        return {
          context: { slot: 0n },
          value: {
            err: null,
            logs: meta.logs(),
            unitsConsumed: meta.computeUnitsConsumed(),
            returnData: ret.data().length ? { programId: getAddressDecoder().decode(ret.programId()), data: [b64(ret.data()), "base64"] } : null,
          },
        };
      },
    }),
    getAccountInfo: (a: Address) => reply({ context: { slot: 0n }, value: encoded(a) }),
    getMultipleAccounts: (addresses: Address[]) => reply({ context: { slot: 0n }, value: addresses.map(encoded) }),
    getProgramAccounts: (program: Address, config: { filters?: { memcmp?: { offset: bigint; bytes: string }; dataSize?: bigint }[] } = {}) =>
      reply(
        [...known]
          .map((a) => ({ pubkey: a, account: encoded(a) }))
          .filter(({ account }) => account && account.owner === program)
          .filter(({ account }) => {
            const data = getBase64Encoder().encode(account!.data[0] as string);
            return (config.filters ?? []).every(({ memcmp, dataSize }) => {
              if (dataSize !== undefined) return BigInt(data.length) === BigInt(dataSize);
              if (!memcmp) return true;
              const want = getBase58Encoder().encode(memcmp.bytes);
              return want.every((b, i) => data[Number(memcmp.offset) + i] === b);
            });
          }),
      ),
    // The json shape: log messages, and inner instructions with base58 data (what `eventsOf` reads).
    getTransaction: (signature: string) => {
      const t = transactions.find((x) => x.signature === signature);
      return reply(
        t
          ? {
              slot: 0n,
              blockTime: null,
              meta: {
                err: null,
                logMessages: t.meta.logs(),
                computeUnitsConsumed: t.meta.computeUnitsConsumed(),
                innerInstructions: t.meta
                  .innerInstructions()
                  .map((group, index) => ({ index, instructions: group.map((i) => ({ data: getBase58Decoder().decode(i.instruction().data()) })) })),
              },
            }
          : null,
      );
    },
  };
  /** Notifications that end when the subscriber aborts. */
  const stream = <T>(items: () => T[]) => ({
    subscribe: async ({ abortSignal }: { abortSignal: AbortSignal }) =>
      (async function* () {
        for (const item of items()) yield item;
        await new Promise((resolve) => abortSignal.addEventListener("abort", resolve, { once: true }));
      })(),
  });
  const rpcSubscriptions = {
    signatureNotifications: () => stream(() => [{ context: { slot: 0n }, value: { err: null } }]),
    slotNotifications: () => stream(() => []),
    logsNotifications: () =>
      stream(() => transactions.map((t) => ({ context: { slot: 0n }, value: { signature: t.signature, logs: t.meta.logs(), err: null } }))),
    accountNotifications: (a: Address) => stream(() => [{ context: { slot: 0n }, value: encoded(a) ?? { data: ["", "base64"], lamports: 0n } }]),
  };
  return {
    rpc: rpc as unknown as Rpc<SolanaRpcApi>,
    rpcSubscriptions: rpcSubscriptions as unknown as RpcSubscriptions<SolanaRpcSubscriptionsApi>,
    transactions,
    track: (...addresses) => addresses.forEach((a) => known.add(a)),
  };
}
