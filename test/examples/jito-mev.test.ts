// examples/jito-mev against Jito's tip payment, tip distribution and priority fee distribution programs as deployed on
// mainnet (test/programs/jito_*.so). Each original and its port run in their own LiteSVM under the same program id with
// the same clock; validators' vote accounts are written in both (owned by the Vote program, the node key at bytes
// 4..36), and Merkle trees are built here the way Jito's tooling builds them. Every transaction must have the same
// outcome, the same account bytes and the same events ("Program data:" lines).
import { type Address, type Instruction, type KeyPairSigner, AccountRole, address, generateKeyPairSigner, getAddressDecoder, getAddressEncoder, lamports } from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from "litesvm";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { web3 } from "@anchor-lang/core";
import { BN, deployFile, pda, send, type Deployed } from "../harness.js";

const SYSTEM = address("11111111111111111111111111111111");
const VOTE = address("Vote111111111111111111111111111111111111111");
const program = (file: string) => fileURLToPath(new URL(`../programs/${file}`, import.meta.url));
const port = (file: string) => fileURLToPath(new URL(`../../examples/jito-mev/${file}`, import.meta.url));

type Result = TransactionMetadata | FailedTransactionMetadata;
type Meta = { address: Address; signer?: KeyPairSigner; writable?: boolean };

const enc = getAddressEncoder();
const dec = getAddressDecoder();
const pk = (a: Address) => new web3.PublicKey(a);
const key = (a: Address) => Buffer.from(enc.encode(a));
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const sha = (...parts: Uint8Array[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};
const outcome = (r: Result) => (r instanceof FailedTransactionMetadata ? `error: ${String(r.err())}` : "ok");
const meta = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r);
const events = (r: Result) =>
  meta(r)
    .logs()
    .filter((l) => l.startsWith("Program data:"));
/** The messages the programs log themselves (msg!), beyond Anchor's "Instruction: …" lines. */
const said = (r: Result) =>
  meta(r)
    .logs()
    .filter((l) => /^Program log: (WARN|Priority fee)/.test(l));
const custom = (code: number) => `error: TransactionErrorInstructionError { index: 0, error: InstructionErrorCustom { code: ${code} } }`;
const errorsOf = (file: string) =>
  Object.fromEntries([...readFileSync(port(file), "utf8").matchAll(/^ {2}(\w+) = /gm)].map((m, i) => [m[1]!, 6000 + i])) as Record<string, number>;

/** A Merkle tree of (claimant, amount) leaves as Jito's tooling hashes them; `proof(i)` for leaf i. */
function merkle(leaves: [Address, bigint][]) {
  const level0 = leaves.map(([c, a]) => sha(Uint8Array.of(0), sha(key(c), u64(a))));
  const levels = [level0];
  while (levels.at(-1)!.length > 1) {
    const prev = levels.at(-1)!;
    const next: Buffer[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      const [a, b] = [prev[i]!, prev[i + 1] ?? prev[i]!];
      next.push(Buffer.compare(a, b) <= 0 ? sha(Uint8Array.of(1), a, b) : sha(Uint8Array.of(1), b, a));
    }
    levels.push(next);
  }
  return {
    root: [...levels.at(-1)![0]!],
    proof: (i: number) =>
      levels.slice(0, -1).map((level, depth) => {
        const at = i >> depth;
        return [...(level[at ^ 1] ?? level[at]!)];
      }),
  };
}

/** One original and its port side by side: send to both and compare. */
function pairOf(so: string, source: string, programId: Address) {
  const s = {
    d: undefined as unknown as Deployed,
    original: undefined as unknown as LiteSVM,
    cu: {} as Record<string, [bigint, bigint]>,
    compared: 0,
    async load() {
      s.d = await deployFile(port(source), { programId });
      s.original = new LiteSVM();
      s.original.addProgramFromFile(programId, program(so));
      s.epoch(900n);
    },
    vms: () => [s.original, s.d.svm] as const,
    epoch(epoch: bigint) {
      for (const vm of s.vms()) {
        const clock = vm.getClock();
        clock.epoch = epoch;
        clock.slot = epoch * 432_000n + 7n;
        clock.unixTimestamp = 1_800_000_000n + epoch;
        vm.setClock(clock);
      }
    },
    ix(name: string, args: Record<string, unknown>, accounts: Meta[]): Instruction {
      return {
        programAddress: programId,
        accounts: accounts.map((a) => ({
          address: a.address,
          role: a.signer ? (a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY,
          ...(a.signer ? { signer: a.signer } : {}),
        })) as Instruction["accounts"],
        data: new Uint8Array(s.d.coder.instruction.encode(name, args)),
      };
    },
    async funded(sol = 100n) {
      const k = await generateKeyPairSigner();
      for (const vm of s.vms()) vm.airdrop(k.address, lamports(sol * 1_000_000_000n));
      return k;
    },
    /** A vote account whose node key is `node`. */
    async voteAccount(node: Address) {
      const v = (await generateKeyPairSigner()).address;
      const data = Buffer.alloc(3762);
      data.writeUInt32LE(2, 0);
      key(node).copy(data, 4);
      for (const vm of s.vms())
        vm.setAccount({ address: v, data: new Uint8Array(data), executable: false, lamports: lamports(27_074_400n), programAddress: VOTE, space: BigInt(data.length) });
      return v;
    },
    /** Lamports straight into an account (tips, as searchers send them), in both. */
    tip(to: Address, amount: bigint) {
      for (const vm of s.vms()) {
        const a = vm.getAccount(to);
        if (!a.exists) throw new Error(`no account ${to}`);
        vm.setAccount({ ...a, address: to, lamports: lamports(a.lamports + amount) });
      }
    },
    /** An account (some data, rent-exempt) owned by `owner`, in both. */
    async ownedBy(owner: Address) {
      const a = (await generateKeyPairSigner()).address;
      for (const vm of s.vms())
        vm.setAccount({ address: a, data: new Uint8Array(64), executable: false, lamports: lamports(10_000_000n), programAddress: owner, space: 64n });
      return a;
    },
    /** A fresh, empty system account: one a payout would leave below rent. */
    async empty() {
      return (await generateKeyPairSigner()).address;
    },
    lamportsOf(a: Address) {
      return s.original.getAccount(a).exists ? (s.original.getAccount(a) as { lamports: bigint }).lamports : 0n;
    },
    bytes(vm: LiteSVM, a: Address) {
      const info = vm.getAccount(a);
      return info.exists ? `${info.lamports} ${info.programAddress} ${Buffer.from(info.data).toString("hex")}` : "missing";
    },
    /** Send to both: the same outcome, account bytes and events. `failing`: the original panics, so only both failing is required. */
    async both(label: string, payer: KeyPairSigner, ixs: Instruction[], watch: Address[], failing = false) {
      const [a, b] = [await send(s.original, payer, ixs), await send(s.d.svm, payer, ixs)];
      s.compared++;
      const logs = (r: Result) => meta(r).logs().join("\n");
      if (failing) {
        expect(a instanceof FailedTransactionMetadata && b instanceof FailedTransactionMetadata, `${label}\noriginal:\n${logs(a)}\nTypeSOL:\n${logs(b)}`).toBe(true);
        for (const w of watch) expect(s.bytes(s.d.svm, w), `${label}: ${w}`).toBe(s.bytes(s.original, w));
        return "failed";
      }
      expect(outcome(b), `${label}\noriginal:\n${logs(a)}\nTypeSOL:\n${logs(b)}`).toBe(outcome(a));
      for (const w of watch) expect(s.bytes(s.d.svm, w), `${label}: ${w}`).toBe(s.bytes(s.original, w));
      if (!(a instanceof FailedTransactionMetadata)) {
        expect(events(b), `${label}: events`).toEqual(events(a));
        expect(said(b), `${label}: logs`).toEqual(said(a));
      }
      s.cu[label] = [meta(a).computeUnitsConsumed(), meta(b).computeUnitsConsumed()];
      return outcome(a);
    },
  };
  return s;
}

const report = (name: string, s: ReturnType<typeof pairOf>) => {
  const rows = Object.entries(s.cu).map(([k, [a, b]]) => `  ${k.padEnd(56)} ${String(a).padStart(7)} ${String(b).padStart(7)}  ${((1 - Number(b) / Number(a)) * 100).toFixed(0)}%`);
  console.log(`${name}: ${s.compared} transactions compared\n  ${"".padEnd(56)} original TypeSOL  less\n${rows.join("\n")}`);
};

describe.skipIf(!existsSync(program("jito_tip_payment.so")))("examples/jito-mev tip payment against mainnet", () => {
  const ID = address("T1pyyaTNZsKv2WcRAB8oVnk93mLJw2XzjtVYqCsaHqt");
  const s = pairOf("jito_tip_payment.so", "tip_payment.ts", ID);
  const errors = errorsOf("tip_payment.ts");
  let config: Address;
  let bumps: Record<string, number>;
  const tips: Address[] = [];
  beforeAll(async () => {
    await s.load();
    let bump: number;
    [config, bump] = await pda(ID, ["CONFIG_ACCOUNT"]);
    bumps = { config: bump };
    for (let i = 0; i < 8; i++) {
      const [t, b] = await pda(ID, [`TIP_ACCOUNT_${i}`]);
      tips.push(t);
      bumps[`tip_payment_account_${i}`] = b;
    }
  });
  const tipAccounts = () => tips.map((t) => ({ address: t, writable: true }));
  /** The tip receiver and block builder in the config (the same in both, as compared). */
  const configKeys = () => {
    const c = s.original.getAccount(config);
    if (!c.exists) throw new Error("config");
    return [dec.decode(c.data.subarray(8, 40)), dec.decode(c.data.subarray(40, 72))] as const;
  };

  it("initializes once; not over a tip account that already holds lamports", async () => {
    const payer = await s.funded();
    const init = (ts: Meta[]) =>
      s.ix("initialize", { _bumps: bumps }, [{ address: config, writable: true }, ...ts, { address: SYSTEM }, { address: payer.address, signer: payer, writable: true }]);
    const wrong = [...tipAccounts()];
    wrong[2] = { address: (await generateKeyPairSigner()).address, writable: true };
    expect(await s.both("initialize: a tip account at the wrong PDA", payer, [init(wrong)], [config, ...tips])).toBe(custom(2006));
    // A searcher's tip sent before the program was set up: the original refuses it (ConstraintSeeds, "simplifies the CPIs").
    for (const vm of s.vms()) vm.setAccount({ address: tips[5]!, data: new Uint8Array(), executable: false, lamports: lamports(1_000n), programAddress: SYSTEM, space: 0n });
    expect(await s.both("initialize: a tip account already holding lamports", payer, [init(tipAccounts())], [config, ...tips])).toBe(custom(2006));
    for (const vm of s.vms()) vm.setAccount({ address: tips[5]!, data: new Uint8Array(), executable: false, lamports: lamports(0n), programAddress: SYSTEM, space: 0n });
    expect(await s.both("initialize", payer, [init(tipAccounts())], [config, ...tips, payer.address])).toBe("ok");
    expect(await s.both("initialize: again", payer, [init(tipAccounts())], [config])).not.toBe("ok");
  });

  it("pays tips out when the tip receiver or the block builder changes, with the builder's commission", async () => {
    const payer = await s.funded();
    const [receiver, builder] = [await s.funded(1n), await s.funded(1n)];
    // initialize made its payer both tip receiver and block builder: one account in two writable slots.
    const [firstReceiver, firstBuilder] = configKeys();
    expect(firstReceiver).toBe(firstBuilder);
    const change = (name: string, front: Address[], args: Record<string, unknown> = {}) =>
      s.ix(name, args, [
        { address: config, writable: true },
        ...front.map((address) => ({ address, writable: true })),
        ...tipAccounts(),
        { address: payer.address, signer: payer, writable: true },
      ]);
    const toReceiver = (oldR: Address, newR: Address, b: Address) => change("change_tip_receiver", [oldR, newR, b]);
    const toBuilder = (r: Address, oldB: Address, newB: Address, pct: bigint) =>
      change("change_block_builder", [r, oldB, newB], { block_builder_commission: new BN(pct.toString()) });
    const watch = () => [config, ...tips, receiver.address, builder.address, firstReceiver, ...configKeys()];

    s.tip(tips[0]!, 1_000_000n);
    s.tip(tips[7]!, 2_345_679n);
    expect(await s.both("change_tip_receiver: wrong old receiver", payer, [toReceiver(receiver.address, builder.address, firstBuilder)], watch())).toBe(custom(2003));
    expect(await s.both("change_tip_receiver: wrong block builder", payer, [toReceiver(firstReceiver, builder.address, receiver.address)], watch())).toBe(custom(2003));
    // A builtin program or sysvar is never writable (the runtime demotes it): Anchor's mut check refuses it.
    expect(await s.both("change_tip_receiver: to a builtin program", payer, [toReceiver(firstReceiver, SYSTEM, firstBuilder)], watch())).toBe(custom(2000));
    for (const [what, owner] of [
      ["an account of the upgradeable loader", "BPFLoaderUpgradeab1e11111111111111111111111"],
      ["an account of loader v4", "LoaderV411111111111111111111111111111111111"],
      ["an account owned by the Sysvar program", "Sysvar1111111111111111111111111111111111111"],
      ["a Config program account", "Config1111111111111111111111111111111111111"],
    ] as const)
      expect(await s.both(`change_tip_receiver: to ${what}`, payer, [toReceiver(firstReceiver, await s.ownedBy(address(owner)), firstBuilder)], watch())).toBe(
        custom(errors.InvalidTipReceiver!),
      );
    expect(await s.both("change_tip_receiver (receiver = builder; 3.3M paid out)", payer, [toReceiver(firstReceiver, receiver.address, firstBuilder)], watch())).toBe("ok");

    expect(await s.both("change_block_builder: 101%", payer, [toBuilder(receiver.address, firstBuilder, builder.address, 101n)], watch())).toBe(custom(errors.InvalidFee!));
    expect(await s.both("change_block_builder: to a Sysvar-owned account", payer, [toBuilder(receiver.address, firstBuilder, await s.ownedBy(address("Sysvar1111111111111111111111111111111111111")), 7n)], watch())).toBe(
      custom(errors.InvalidBlockBuilder!),
    );
    expect(await s.both("change_block_builder: 7% (no tips)", payer, [toBuilder(receiver.address, firstBuilder, builder.address, 7n)], watch())).toBe("ok");
    for (let i = 0; i < 8; i++) s.tip(tips[i]!, 1_000_003n * BigInt(i + 1));
    expect(await s.both("change_block_builder: pays 7% (rounded down) first", payer, [toBuilder(receiver.address, builder.address, builder.address, 7n)], watch())).toBe("ok");
    expect(await s.both("change_tip_receiver: nothing to pay (no event)", payer, [toReceiver(receiver.address, receiver.address, builder.address)], watch())).toBe("ok");

    // A receiver a payout would leave below rent (an empty account): its share goes back into tip account 0, with a warning.
    const fresh = await s.empty();
    expect(await s.both("change_tip_receiver: to an empty account", payer, [toReceiver(receiver.address, fresh, builder.address)], watch())).toBe("ok");
    s.tip(tips[3]!, 400_000n);
    expect(await s.both("change_tip_receiver: share below the empty receiver's rent stays in tip account 0", payer, [toReceiver(fresh, receiver.address, builder.address)], [...watch(), fresh])).toBe("ok");
    expect(s.lamportsOf(fresh)).toBe(0n);
    s.tip(tips[3]!, 1_000_000n);
    const freshBuilder = await s.empty();
    expect(await s.both("change_block_builder: 100% to an empty account", payer, [toBuilder(receiver.address, builder.address, freshBuilder, 100n)], watch())).toBe("ok");
    expect(await s.both("change_block_builder: the empty builder's 100% stays in tip account 0", payer, [toBuilder(receiver.address, freshBuilder, builder.address, 0n)], [...watch(), freshBuilder])).toBe("ok");
    s.tip(tips[6]!, 77_777n);
    expect(await s.both("change_block_builder: 0% (all to the receiver), then 50%", payer, [toBuilder(receiver.address, builder.address, builder.address, 50n)], watch())).toBe("ok");
    s.tip(tips[1]!, 5_000_001n);
    expect(await s.both("change_tip_receiver: 50% commission; to tip account 0", payer, [toReceiver(receiver.address, tips[0]!, builder.address)], watch())).toBe("ok");
    // Tip account 0 as the tip receiver: drained, then paid its own share back.
    s.tip(tips[2]!, 3_000_000n);
    expect(await s.both("change_tip_receiver: tip account 0 as the receiver", payer, [toReceiver(tips[0]!, receiver.address, builder.address)], watch())).toBe("ok");
  });

  it("refuses a tip account below rent (one drained by hand)", async () => {
    const payer = await s.funded();
    // Only a test can do this: one lamport below rent-exempt in tip account 1.
    for (const vm of s.vms()) {
      const a = vm.getAccount(tips[1]!);
      if (!a.exists) throw new Error("tip account 1");
      vm.setAccount({ ...a, address: tips[1]!, lamports: lamports(vm.minimumBalanceForRentExemption(8n) - 1n) });
    }
    const [r, b] = configKeys();
    const ix = s.ix("change_tip_receiver", {}, [
      { address: config, writable: true },
      { address: r, writable: true },
      { address: r, writable: true },
      { address: b, writable: true },
      ...tipAccounts(),
      { address: payer.address, signer: payer, writable: true },
    ]);
    expect(await s.both("change_tip_receiver: tip account below rent", payer, [ix], [config, ...tips])).toBe(custom(2005));
  });

  it("compares", () => {
    expect(s.compared).toBeGreaterThan(20);
    report("tip payment", s);
  });
});

/** Tip distribution and priority fee distribution: the same program, apart from names and the priority fee transfer. */
const DISTRIBUTIONS = [
  {
    name: "tip distribution",
    so: "jito_tip_distribution.so",
    source: "tip_distribution.ts",
    errors: "tip_distribution_errors.ts",
    id: address("4R3gSG8BpU4t19KYj8CfnbtRpnT8gtk4dvTHxVRwc2r7"),
    seed: "TIP_DISTRIBUTION_ACCOUNT",
    account: "TipDistributionAccount",
    priority: false,
  },
  {
    name: "priority fee distribution",
    so: "jito_priority_fee_distribution.so",
    source: "priority_fee_distribution.ts",
    errors: "priority_fee_distribution_errors.ts",
    id: address("Priority6weCZ5HwDn29NxLFpb7TDp2iLZ6XKc5e8d3"),
    seed: "PF_DISTRIBUTION_ACCOUNT",
    account: "PriorityFeeDistributionAccount",
    priority: true,
  },
] as const;

for (const P of DISTRIBUTIONS)
  describe.skipIf(!existsSync(program(P.so)))(`examples/jito-mev ${P.name} against mainnet`, () => {
    const s = pairOf(P.so, P.source, P.id);
    const errors = errorsOf(P.errors);
    const snake = P.priority ? "priority_fee_distribution_account" : "tip_distribution_account";
    let config: Address;
    let configBump: number;
    let authority: KeyPairSigner;
    let expired: KeyPairSigner;
    beforeAll(async () => {
      await s.load();
      [config, configBump] = await pda(P.id, ["CONFIG_ACCOUNT"]);
      authority = await s.funded();
      expired = await s.funded(1n);
    });
    const da = async (vote: Address, epoch: bigint) => pda(P.id, [P.seed, vote, u64(epoch)]);
    const configArgs = (o: { epochs?: bigint; max?: number; goLive?: bigint; auth?: Address; exp?: Address } = {}) => ({
      authority: pk(o.auth ?? authority.address),
      expired_funds_account: pk(o.exp ?? expired.address),
      num_epochs_valid: new BN((o.epochs ?? 3n).toString()),
      max_validator_commission_bps: o.max ?? 1_000,
      ...(P.priority ? { go_live_epoch: new BN((o.goLive ?? 18446744073709551615n).toString()) } : {}),
      bump: configBump,
    });
    const initialize = (payer: KeyPairSigner, o: Parameters<typeof configArgs>[0] = {}) => {
      const { go_live_epoch: _, ...args } = configArgs(o) as Record<string, unknown>;
      return s.ix("initialize", args, [{ address: config, writable: true }, { address: SYSTEM }, { address: payer.address, signer: payer, writable: true }]);
    };
    const open = async (signer: KeyPairSigner, vote: Address, commission: number, uploader: Address) => {
      const [at, bump] = await da(vote, s.d.svm.getClock().epoch);
      return {
        at,
        ix: s.ix(
          P.priority ? "initialize_priority_fee_distribution_account" : "initialize_tip_distribution_account",
          { merkle_root_upload_authority: pk(uploader), validator_commission_bps: commission, bump },
          [{ address: config }, { address: at, writable: true }, { address: vote }, { address: signer.address, signer, writable: true }, { address: SYSTEM }],
        ),
      };
    };
    const upload = (at: Address, uploader: KeyPairSigner, root: number[], maxTotal: bigint, maxNodes: bigint) =>
      s.ix("upload_merkle_root", { root, max_total_claim: new BN(maxTotal.toString()), max_num_nodes: new BN(maxNodes.toString()) }, [
        { address: config },
        { address: at, writable: true },
        { address: uploader.address, signer: uploader, writable: true },
      ]);
    const claimStatus = (claimant: Address, at: Address) => pda(P.id, ["CLAIM_STATUS", claimant, at]);
    const claim = async (at: Address, uploader: KeyPairSigner, claimant: Address, payer: KeyPairSigner, amount: bigint, proof: number[][]) => {
      const [status, bump] = await claimStatus(claimant, at);
      return s.ix("claim", { [P.priority ? "_bump" : "bump"]: bump, amount: new BN(amount.toString()), proof }, [
        { address: config },
        { address: at, writable: true },
        { address: uploader.address, signer: uploader },
        { address: status, writable: true },
        { address: claimant, writable: true },
        { address: payer.address, signer: payer, writable: true },
        { address: SYSTEM },
      ]);
    };

    it("initializes the config once, validated", async () => {
      const payer = await s.funded();
      for (const [label, o] of [
        ["0 epochs valid", { epochs: 0n }],
        ["11 epochs valid", { epochs: 11n }],
        ["a commission cap above 100%", { max: 10_001 }],
        ["the default key as authority", { auth: SYSTEM }],
        ["the default key as expired funds account", { exp: SYSTEM }],
      ] as const)
        expect(await s.both(`initialize: ${label}`, payer, [initialize(payer, o)], [config])).toBe(custom(errors.AccountValidationFailure!));
      expect(await s.both("initialize", payer, [initialize(payer)], [config, payer.address])).toBe("ok");
      expect(await s.both("initialize: again", payer, [initialize(payer)], [config])).not.toBe("ok");
    });

    it("opens a validator's account for the epoch, its node key signing", async () => {
      s.epoch(900n);
      const node = await s.funded();
      const vote = await s.voteAccount(node.address);
      const other = await s.funded();
      const uploader = await s.funded(1n);
      let o = await open(node, vote, 1_001, uploader.address);
      expect(await s.both("open: commission above the cap", node, [o.ix], [o.at])).toBe(custom(errors.MaxValidatorCommissionFeeBpsExceeded!));
      o = await open(other, vote, 500, uploader.address);
      expect(await s.both("open: not the vote account's node key", other, [o.ix], [o.at])).toBe(custom(errors.Unauthorized!));
      const notVote = await s.ownedBy(SYSTEM);
      o = await open(node, notVote, 500, uploader.address);
      expect(await s.both("open: not a vote account", node, [o.ix], [o.at])).toBe(custom(2004));
      o = await open(node, vote, 500, SYSTEM);
      expect(await s.both("open: the default key as upload authority", node, [o.ix], [o.at])).toBe(custom(errors.AccountValidationFailure!));
      o = await open(node, vote, 500, uploader.address);
      expect(await s.both("open", node, [o.ix], [o.at, node.address])).toBe("ok");
      expect(await s.both("open: again", node, [o.ix], [o.at])).not.toBe("ok");
    });

    it("pays out with Merkle proofs after the epoch, and closes what expired", async () => {
      s.epoch(1000n);
      const node = await s.funded();
      const vote = await s.voteAccount(node.address);
      const uploader = await s.funded();
      const payer = await s.funded();
      const { at, ix } = await open(node, vote, 800, uploader.address);
      expect(await s.both("open (epoch 1000)", node, [ix], [at])).toBe("ok");
      const claimants = await Promise.all([1, 2, 3, 4, 5].map(() => s.funded(1n)));
      const amounts = [1_000_000n, 2_500_000n, 333_333n, 7_000_000n, 42n];
      const tree = merkle(claimants.map((c, i) => [c.address, amounts[i]!]));
      const total = amounts.reduce((a, b) => a + b, 0n);
      s.tip(at, total + 123_456n);
      const watch = [at, config, ...claimants.map((c) => c.address), payer.address];

      expect(await s.both("upload_merkle_root: during the epoch", uploader, [upload(at, uploader, tree.root, total, 5n)], watch)).toBe(custom(errors.PrematureMerkleRootUpload!));
      s.epoch(1001n);
      expect(await s.both("upload_merkle_root: not the upload authority", payer, [upload(at, payer, tree.root, total, 5n)], watch)).toBe(custom(errors.Unauthorized!));
      expect(await s.both("upload_merkle_root: a first root", uploader, [upload(at, uploader, [...Buffer.alloc(32, 7)], total, 5n)], watch)).toBe("ok");
      expect(await s.both("upload_merkle_root: replaced before any claim", uploader, [upload(at, uploader, tree.root, total - 42n, 4n)], watch)).toBe("ok");

      const c = (i: number, by = uploader, amount = amounts[i]!, proof = tree.proof(i)) => claim(at, by, claimants[i]!.address, payer, amount, proof);
      expect(await s.both("claim: not signed by the upload authority", payer, [await c(0, payer)], watch)).toBe(custom(errors.Unauthorized!));
      expect(await s.both("claim: the wrong amount", payer, [await c(0, uploader, amounts[0]! + 1n)], watch)).toBe(custom(errors.InvalidProof!));
      expect(await s.both("claim: another leaf's proof", payer, [await c(0, uploader, amounts[0]!, tree.proof(1))], watch)).toBe(custom(errors.InvalidProof!));
      expect(await s.both("claim 0", payer, [await c(0)], watch)).toBe("ok");
      expect(await s.both("claim 0: again", payer, [await c(0)], watch)).not.toBe("ok");
      expect(await s.both("upload_merkle_root: after a claim", uploader, [upload(at, uploader, tree.root, total, 5n)], watch)).toBe(custom(errors.Unauthorized!));
      expect(await s.both("claim 1", payer, [await c(1)], watch)).toBe("ok");
      expect(await s.both("claim 3", payer, [await c(3)], watch)).toBe("ok");
      // A claimant paying for its own claim record: one account in two writable slots.
      const own = await claim(at, uploader, claimants[2]!.address, claimants[2]!, amounts[2]!, tree.proof(2));
      expect(await s.both("claim 2, paid by the claimant", claimants[2]!, [own], watch)).toBe("ok");
      // The root allows 4 nodes and total - 42: the fifth claim is over both caps (the claim total is checked first).
      expect(await s.both("claim 4: over the max total claim", payer, [await c(4)], watch)).toBe(custom(errors.ExceedsMaxClaim!));

      // Expired after epoch 1000 + 3.
      s.epoch(1004n);
      expect(await s.both("claim 4: expired", payer, [await c(4)], watch)).toBe(custom(P.priority ? errors.ExpiredPriorityFeeDistributionAccount! : errors.ExpiredTipDistributionAccount!));
      const [status0] = await claimStatus(claimants[0]!.address, at);
      const closeStatus = (status: Address, to: Address) =>
        s.ix("close_claim_status", {}, [...(P.priority ? [] : [{ address: config }]), { address: status, writable: true }, { address: to, writable: true }]);
      s.epoch(1003n);
      expect(await s.both("close_claim_status: not yet expired", payer, [closeStatus(status0, payer.address)], [status0])).toBe(custom(errors.PrematureCloseClaimStatus!));
      s.epoch(1004n);
      expect(await s.both("close_claim_status: rent to someone else", payer, [closeStatus(status0, uploader.address)], [status0])).toBe(custom(2003));
      expect(await s.both("close_claim_status", payer, [closeStatus(status0, payer.address)], [status0, payer.address])).toBe("ok");

      const closeAccount = (fundsTo: Address, epoch: bigint, signer = payer) =>
        s.ix(P.priority ? "close_priority_fee_distribution_account" : "close_tip_distribution_account", { _epoch: new BN(epoch.toString()) }, [
          { address: config },
          { address: fundsTo, writable: true },
          { address: at, writable: true },
          { address: vote, writable: true },
          { address: signer.address, signer, writable: true },
        ]);
      expect(await s.both("close account: wrong expired funds account", payer, [closeAccount(uploader.address, 1000n)], [at, expired.address])).toBe(custom(errors.Unauthorized!));
      expect(await s.both("close account: wrong epoch seed", payer, [closeAccount(expired.address, 1001n)], [at, expired.address])).toBe(custom(2006));
      s.epoch(1003n);
      expect(await s.both("close account: not yet expired", payer, [closeAccount(expired.address, 1000n)], [at, expired.address])).toBe(
        custom(P.priority ? errors.PrematureClosePriorityFeeDistributionAccount! : errors.PrematureCloseTipDistributionAccount!),
      );
      s.epoch(1004n);
      // The expired funds account signs itself (one account in two writable slots, as Anchor allows).
      expect(await s.both("close account: what was not claimed to the expired funds account, rent to the vote account", expired, [closeAccount(expired.address, 1000n, expired)], [at, expired.address, vote])).toBe("ok");
    });

    it("updates the config and hands uploads over to the override authority", async () => {
      s.epoch(1100n);
      const payer = await s.funded();
      const update = (by: KeyPairSigner, o: Parameters<typeof configArgs>[0]) =>
        s.ix("update_config", { new_config: configArgs(o) }, [{ address: config, writable: true }, { address: by.address, signer: by, writable: true }]);
      expect(await s.both("update_config: not the authority", payer, [update(payer, { epochs: 5n })], [config])).toBe(custom(errors.Unauthorized!));
      expect(await s.both("update_config: invalid", authority, [update(authority, { epochs: 0n })], [config])).toBe(custom(errors.AccountValidationFailure!));
      expect(await s.both("update_config", authority, [update(authority, { epochs: 5n, max: 2_000 })], [config])).toBe("ok");

      const [rootConfig] = await pda(P.id, ["ROOT_UPLOAD_CONFIG"]);
      const original = await s.funded(1n);
      const override = await s.funded(1n);
      const initRoot = (by: KeyPairSigner, o: Address, orig: Address) =>
        s.ix("initialize_merkle_root_upload_config", { authority: pk(o), original_authority: pk(orig) }, [
          { address: config, writable: true },
          { address: rootConfig, writable: true },
          { address: by.address, signer: by },
          { address: payer.address, signer: payer, writable: true },
          { address: SYSTEM },
        ]);
      expect(await s.both("initialize_merkle_root_upload_config: not the authority", payer, [initRoot(payer, override.address, original.address)], [rootConfig])).toBe(custom(errors.Unauthorized!));
      expect(await s.both("initialize_merkle_root_upload_config", payer, [initRoot(authority, payer.address, original.address)], [rootConfig, payer.address])).toBe("ok");
      const updateRoot = (by: KeyPairSigner, o: Address, orig: Address) =>
        s.ix("update_merkle_root_upload_config", { authority: pk(o), original_authority: pk(orig) }, [
          { address: config },
          { address: rootConfig, writable: true },
          { address: by.address, signer: by },
          { address: SYSTEM },
        ]);
      expect(await s.both("update_merkle_root_upload_config: not the authority", payer, [updateRoot(payer, override.address, original.address)], [rootConfig])).toBe(custom(errors.Unauthorized!));
      expect(await s.both("update_merkle_root_upload_config", authority, [updateRoot(authority, override.address, original.address)], [rootConfig])).toBe("ok");

      const node = await s.funded();
      const vote = await s.voteAccount(node.address);
      const a = await open(node, vote, 100, original.address);
      const node2 = await s.funded();
      const b = await open(node2, await s.voteAccount(node2.address), 100, payer.address);
      expect(await s.both("open two accounts", node, [a.ix, b.ix], [a.at, b.at])).toBe("ok");
      const migrate = (at: Address) => s.ix("migrate_tda_merkle_root_upload_authority", {}, [{ address: at, writable: true }, { address: rootConfig }]);
      expect(await s.both("migrate: another upload authority", payer, [migrate(b.at)], [b.at])).toBe(custom(errors.InvalidTdaForMigration!));
      expect(await s.both("migrate", payer, [migrate(a.at)], [a.at])).toBe("ok");
      s.epoch(1101n);
      expect(await s.both("upload by the override authority", override, [upload(a.at, override, [...Buffer.alloc(32, 1)], 1n, 1n)], [a.at])).toBe("ok");
      expect(await s.both("migrate: a root already uploaded", payer, [migrate(a.at)], [a.at])).toBe(custom(errors.InvalidTdaForMigration!));
    });

    it.runIf(P.priority)("takes priority fees in only from the go-live epoch", async () => {
      s.epoch(1200n);
      const node = await s.funded();
      const vote = await s.voteAccount(node.address);
      const { at, ix } = await open(node, vote, 100, node.address);
      expect(await s.both("open (epoch 1200)", node, [ix], [at])).toBe("ok");
      const transfer = (amount: bigint) =>
        s.ix("transfer_priority_fee_tips", { lamports: new BN(amount.toString()) }, [{ address: config }, { address: at, writable: true }, { address: node.address, signer: node, writable: true }, { address: SYSTEM }]);
      const update = (goLive: bigint) => s.ix("update_config", { new_config: configArgs({ epochs: 5n, max: 2_000, goLive }) }, [{ address: config, writable: true }, { address: authority.address, signer: authority, writable: true }]);
      // Before going live only the total is counted (and logged in SOL, to five decimals).
      for (const amount of [0n, 1n, 4_999n, 5_000n, 15_000n, 25_000n, 35_000n, 45_000n, 55_000n, 65_000n, 75_000n, 85_000n, 95_000n, 125_000n, 15_625_000n, 46_875_000n, 78_125_000n, 1_234_565_000n, 12_340_000n, 1_234_567_891n, 7_000_000_001n, 18_000_000_000_000_000_000n])
        expect(await s.both(`transfer ${amount}: not live`, node, [transfer(amount)], [at, node.address])).toBe("ok");
      expect(await s.both("update_config: live from epoch 1201", authority, [update(1201n)], [config])).toBe("ok");
      expect(await s.both("transfer: still not live", node, [transfer(5_000_000n)], [at, node.address])).toBe("ok");
      expect(await s.both("update_config: live from epoch 1200", authority, [update(1200n)], [config])).toBe("ok");
      expect(await s.both("transfer: live", node, [transfer(5_000_000n)], [at, node.address])).toBe("ok");
      s.epoch(1201n);
      expect(await s.both("transfer: into last epoch's account", node, [transfer(1n)], [at, node.address])).toBe(custom(errors.AccountValidationFailure!));
    });

    it("compares", () => {
      expect(s.compared).toBeGreaterThan(20);
      report(P.name, s);
    });
  });
