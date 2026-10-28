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
 * the accounts transactions sent through this connection named, plus those passed to `track`. Subscriptions see the
 * transactions sent through this connection: `logsNotifications` replays those sent so far (failed ones too, with
 * `err` set), then each new one, as `{ mentions: [address] }` filters them; `accountNotifications` yields the account
 * after each later transaction that names it. Errors are in the JSON shape RPC nodes return
 * (`{ InstructionError: [0, { Custom: 6000 }] }`).
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

// LiteSVM's fieldless error enums by value (const enums: their names are not there at run time).
const TX_ERRORS = (
  "AccountInUse AccountLoadedTwice AccountNotFound ProgramAccountNotFound InsufficientFundsForFee InvalidAccountForFee " +
  "AlreadyProcessed BlockhashNotFound CallChainTooDeep MissingSignatureForFee InvalidAccountIndex SignatureFailure " +
  "InvalidProgramForExecution SanitizeFailure ClusterMaintenance AccountBorrowOutstanding WouldExceedMaxBlockCostLimit " +
  "UnsupportedVersion InvalidWritableAccount WouldExceedMaxAccountCostLimit WouldExceedAccountDataBlockLimit " +
  "TooManyAccountLocks AddressLookupTableNotFound InvalidAddressLookupTableOwner InvalidAddressLookupTableData " +
  "InvalidAddressLookupTableIndex InvalidRentPayingAccount WouldExceedMaxVoteCostLimit WouldExceedAccountDataTotalLimit " +
  "MaxLoadedAccountsDataSizeExceeded ResanitizationNeeded InvalidLoadedAccountsDataSizeLimit UnbalancedTransaction " +
  "ProgramCacheHitMaxLimit CommitCancelled"
).split(" ");
const IX_ERRORS = (
  "GenericError InvalidArgument InvalidInstructionData InvalidAccountData AccountDataTooSmall InsufficientFunds " +
  "IncorrectProgramId MissingRequiredSignature AccountAlreadyInitialized UninitializedAccount UnbalancedInstruction " +
  "ModifiedProgramId ExternalAccountLamportSpend ExternalAccountDataModified ReadonlyLamportChange ReadonlyDataModified " +
  "DuplicateAccountIndex ExecutableModified RentEpochModified NotEnoughAccountKeys AccountDataSizeChanged " +
  "AccountNotExecutable AccountBorrowFailed AccountBorrowOutstanding DuplicateAccountOutOfSync InvalidError " +
  "ExecutableDataModified ExecutableLamportChange ExecutableAccountNotRentExempt UnsupportedProgramId CallDepth " +
  "MissingAccount ReentrancyNotAllowed MaxSeedLengthExceeded InvalidSeeds InvalidRealloc ComputationalBudgetExceeded " +
  "PrivilegeEscalation ProgramEnvironmentSetupFailure ProgramFailedToComplete ProgramFailedToCompile Immutable " +
  "IncorrectAuthority AccountNotRentExempt InvalidAccountOwner ArithmeticOverflow UnsupportedSysvar IllegalOwner " +
  "MaxAccountsDataAllocationsExceeded MaxAccountsExceeded MaxInstructionTraceLengthExceeded " +
  "BuiltinProgramsMustConsumeComputeUnits BorshIoError"
).split(" ");

/** A LiteSVM transaction error in the JSON shape RPC nodes return: `{ InstructionError: [0, { Custom: 6000 }] }`. */
export function rpcError(err: unknown): unknown {
  if (typeof err === "number") return TX_ERRORS[err] ?? String(err);
  if (typeof err !== "object" || err === null) return String(err);
  const o = err as { index?: unknown; accountIndex?: unknown; err?: unknown };
  if (typeof o.err === "function" && typeof o.index === "number") {
    const inner = (o.err as () => unknown).call(err);
    const fields = (typeof inner === "object" && inner !== null ? inner : {}) as { code?: unknown; msg?: unknown };
    const ix =
      typeof inner === "number"
        ? (IX_ERRORS[inner] ?? String(inner))
        : typeof fields.code === "number"
          ? { Custom: fields.code }
          : typeof fields.msg === "string"
            ? { BorshIoError: fields.msg }
            : String(inner);
    return { InstructionError: [o.index, ix] };
  }
  if (typeof o.index === "number") return { DuplicateInstruction: o.index };
  if (typeof o.accountIndex === "number")
    return /Restricted/.test(String(err))
      ? { ProgramExecutionTemporarilyRestricted: { account_index: o.accountIndex } }
      : { InsufficientFundsForRent: { account_index: o.accountIndex } };
  return String(err);
}

interface Sent {
  signature: string;
  logs: string[];
  err: unknown;
  keys: readonly Address[];
}

export function svmConnection(svm: LiteSVM): SvmConnection {
  const transactions: SvmConnection["transactions"] = [];
  const known = new Set<Address>();
  // Every transaction sent (failed ones too) for log subscriptions, the account keys of each, and live subscribers.
  const sent: Sent[] = [];
  const accountKeys = new Map<string, readonly Address[]>();
  const logListeners = new Set<(n: Sent) => void>();
  const accountListeners = new Map<Address, Set<() => void>>();
  const record = (n: Sent) => {
    sent.push(n);
    for (const l of [...logListeners]) l(n);
    for (const k of new Set(n.keys)) for (const l of [...(accountListeners.get(k) ?? [])]) l();
  };
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
        if (res instanceof FailedTransactionMetadata) {
          const meta = res.meta();
          record({ signature: getBase58Decoder().decode(meta.signature()), logs: meta.logs(), err: rpcError(res.err()), keys });
          throw new Error(`transaction failed: ${String(res.err())}\n${meta.logs().join("\n")}`);
        }
        for (const k of keys) known.add(k);
        const signature = getBase58Decoder().decode(res.signature());
        transactions.push({ signature, meta: res });
        accountKeys.set(signature, keys);
        record({ signature, logs: res.logs(), err: null, keys });
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
            value: { err: rpcError(res.err()), logs: res.meta().logs(), unitsConsumed: res.meta().computeUnitsConsumed(), returnData: null },
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
    // The json shape: account keys, log messages, and inner instructions with their program and base58 data (what
    // `eventsOf` reads).
    getTransaction: (signature: string) => {
      const t = transactions.find((x) => x.signature === signature);
      return reply(
        t
          ? {
              slot: 0n,
              blockTime: null,
              transaction: { signatures: [signature], message: { accountKeys: accountKeys.get(signature) ?? [] } },
              meta: {
                err: null,
                logMessages: t.meta.logs(),
                computeUnitsConsumed: t.meta.computeUnitsConsumed(),
                innerInstructions: t.meta.innerInstructions().map((group, index) => ({
                  index,
                  instructions: group.map((i) => ({
                    programIdIndex: i.instruction().programIdIndex(),
                    accounts: [...i.instruction().accounts()],
                    data: getBase58Decoder().decode(i.instruction().data()),
                    stackHeight: i.stackHeight(),
                  })),
                })),
              },
            }
          : null,
      );
    },
  };
  /**
   * Notifications: `backlog` first, then each item `listen` pushes, until the subscriber aborts. The listener is in
   * place once `subscribe` is called, so nothing sent after that call is missed.
   */
  const stream = <T>(backlog: () => T[], listen: (push: (item: T) => void) => () => void) => ({
    subscribe: async ({ abortSignal }: { abortSignal: AbortSignal }) => {
      const queue: T[] = [...backlog()];
      let wake: (() => void) | undefined;
      const stop = listen((item) => {
        queue.push(item);
        wake?.();
      });
      const aborted = new Promise<void>((resolve) => abortSignal.addEventListener("abort", () => resolve(), { once: true }));
      void aborted.then(stop);
      return (async function* () {
        while (!abortSignal.aborted) {
          if (queue.length) {
            yield queue.shift()!;
            continue;
          }
          await Promise.race([aborted, new Promise<void>((resolve) => (wake = resolve))]);
          wake = undefined;
        }
      })();
    },
  });
  const none = () => () => undefined;
  const rpcSubscriptions = {
    signatureNotifications: () => stream(() => [{ context: { slot: 0n }, value: { err: null } }], none),
    slotNotifications: () => stream<unknown>(() => [], none),
    logsNotifications: (filter: "all" | "allWithVotes" | { mentions: readonly Address[] } = "all") => {
      const wanted = (n: Sent) => typeof filter !== "object" || filter.mentions.every((a) => n.keys.includes(a));
      const shape = (n: Sent) => ({ context: { slot: 0n }, value: { signature: n.signature, logs: n.logs, err: n.err } });
      return stream(
        () => sent.filter(wanted).map(shape),
        (push) => {
          const l = (n: Sent) => {
            if (wanted(n)) push(shape(n));
          };
          logListeners.add(l);
          return () => logListeners.delete(l);
        },
      );
    },
    accountNotifications: (a: Address) =>
      stream<unknown>(
        () => [],
        (push) => {
          const l = () => push({ context: { slot: 0n }, value: encoded(a) ?? { data: ["", "base64"], lamports: 0n } });
          const set = accountListeners.get(a) ?? new Set<() => void>();
          accountListeners.set(a, set.add(l));
          return () => set.delete(l);
        },
      ),
  };
  return {
    rpc: rpc as unknown as Rpc<SolanaRpcApi>,
    rpcSubscriptions: rpcSubscriptions as unknown as RpcSubscriptions<SolanaRpcSubscriptionsApi>,
    transactions,
    track: (...addresses) => addresses.forEach((a) => known.add(a)),
  };
}
