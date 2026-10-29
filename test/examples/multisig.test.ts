// examples/multisig.ts against the program it ports: coral-xyz/multisig as deployed on mainnet (test/programs). Both
// run in their own LiteSVM under the same program id, fed the same transactions (the original's test flow, then
// failures), and must agree on every outcome: success or the same error, and the same account bytes afterwards.
import { type Address, type Instruction, type KeyPairSigner, AccountRole, generateKeyPairSigner, getAddressEncoder, lamports } from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { web3 } from "@anchor-lang/core";
import { BN, acct, address, deployExample, pda, send, type Deployed } from "../harness.js";

const PROGRAM = address("msigUdDBsR4zSUYqYEDrc1LcgtmuSDDM7KxpRUXNC6U");
const ORIGINAL = fileURLToPath(new URL("../programs/coral_multisig.so", import.meta.url));

type Result = TransactionMetadata | FailedTransactionMetadata;
type Meta = { address: Address; signer?: KeyPairSigner; writable?: boolean };

/** The Anchor coder takes PublicKeys: every string in these arguments is an address. */
const keys = (v: unknown): unknown =>
  typeof v === "string"
    ? new web3.PublicKey(v)
    : Array.isArray(v)
      ? v.map(keys)
      : v && typeof v === "object" && !(v instanceof BN) && !Buffer.isBuffer(v)
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, keys(x)]))
        : v;
/** What a transaction did, comparable across the two programs. */
const outcome = (r: Result) => (r instanceof FailedTransactionMetadata ? `error: ${String(r.err())}` : "ok");
const units = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r).computeUnitsConsumed();

describe("examples/multisig.ts against coral-xyz/multisig on mainnet", () => {
  let d: Deployed;
  let original: LiteSVM;
  const cu: Record<string, [bigint, bigint]> = {};
  beforeAll(async () => {
    d = await deployExample("multisig", { programId: PROGRAM });
    original = new LiteSVM();
    original.addProgramFromFile(PROGRAM, ORIGINAL);
  });
  const vms = () => [original, d.svm] as const;

  const ix = (name: string, args: Record<string, unknown>, accounts: Meta[]): Instruction => ({
    programAddress: PROGRAM,
    accounts: accounts.map((a) => ({
      address: a.address,
      role: a.signer ? (a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY,
      ...(a.signer ? { signer: a.signer } : {}),
    })) as Instruction["accounts"],
    data: new Uint8Array(d.coder.instruction.encode(name, keys(args) as Record<string, unknown>)),
  });

  /** A signer funded in both VMs. */
  const funded = async () => {
    const s = await generateKeyPairSigner();
    for (const vm of vms()) vm.airdrop(s.address, lamports(10_000_000_000n));
    return s;
  };
  /** The client-allocated account Anchor's `zero` expects: `space` zero bytes, owned by the program, rent-exempt. */
  const allocate = async (space: number, opts: { owner?: Address; lamports?: bigint } = {}) => {
    const s = await generateKeyPairSigner();
    for (const vm of vms())
      vm.setAccount({
        address: s.address,
        data: new Uint8Array(space),
        executable: false,
        lamports: lamports(opts.lamports ?? vm.minimumBalanceForRentExemption(BigInt(space))),
        programAddress: opts.owner ?? PROGRAM,
        space: BigInt(space),
      });
    return s;
  };
  const bytes = (vm: LiteSVM, a: Address) => {
    const acct = vm.getAccount(a);
    return acct.exists ? `${acct.lamports} ${acct.programAddress} ${Buffer.from(acct.data).toString("hex")}` : "missing";
  };

  /** Send to both; the outcome and the given accounts' bytes must match. Returns the outcome. */
  const both = async (label: string, payer: KeyPairSigner, ixs: Instruction[], watch: Address[] = []) => {
    const [a, b] = [await send(original, payer, ixs), await send(d.svm, payer, ixs)];
    const logs = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r).logs().join("\n");
    expect(outcome(b), `${label}\noriginal:\n${logs(a)}\nTypeSOL:\n${logs(b)}`).toBe(outcome(a));
    for (const w of watch) expect(bytes(d.svm, w), `${label}: ${w}`).toBe(bytes(original, w));
    cu[label] = [units(a), units(b)];
    return outcome(a);
  };
  const custom = (code: number, index = 0) => `error: TransactionErrorInstructionError { index: ${index}, error: InstructionErrorCustom { code: ${code} } }`;

  async function setup(owners: Address[], threshold: number) {
    const payer = await funded();
    const multisig = await allocate(200);
    const [signer, nonce] = await pda(PROGRAM, [multisig.address]);
    const create = ix("create_multisig", { owners, threshold: new BN(threshold), nonce }, [{ address: multisig.address, signer: multisig, writable: true }]);
    expect(await both("create_multisig", payer, [create], [multisig.address])).toBe("ok");
    return { payer, multisig: multisig.address, signer, nonce };
  }
  /** set_owners / change_threshold as the multisig executes them: multisig writable, its PDA signing. */
  const selfCall = (name: string, args: Record<string, unknown>, multisig: Address, signer: Address) => ({
    pid: PROGRAM,
    accs: [
      { pubkey: multisig, is_writable: true, is_signer: false },
      { pubkey: signer, is_writable: false, is_signer: true },
    ],
    data: Buffer.from(d.coder.instruction.encode(name, keys(args) as Record<string, unknown>)),
  });
  async function propose(m: Awaited<ReturnType<typeof setup>>, proposer: KeyPairSigner, call: ReturnType<typeof selfCall>, label = "create_transaction") {
    const tx = await allocate(1000);
    const res = await both(label, m.payer, [
      ix("create_transaction", call, [
        { address: m.multisig },
        { address: tx.address, signer: tx, writable: true },
        { address: proposer.address, signer: proposer },
      ]),
    ], [tx.address]);
    return { tx: tx.address, res };
  }
  const approveIx = (m: { multisig: Address }, tx: Address, owner: KeyPairSigner) =>
    ix("approve", {}, [{ address: m.multisig }, { address: tx, writable: true }, { address: owner.address, signer: owner }]);
  /** execute_transaction with the original test's remaining accounts: the self-call's accounts, then the program. */
  const executeIx = (m: { multisig: Address; signer: Address }, tx: Address, remaining?: Meta[]) =>
    ix("execute_transaction", {}, [
      { address: m.multisig },
      { address: m.signer },
      { address: tx, writable: true },
      ...(remaining ?? [{ address: m.multisig, writable: true }, { address: m.signer }, { address: PROGRAM }]),
    ]);

  it("runs the original test flow: create, propose set_owners, approve, execute", async () => {
    const [a, b, c, dd] = await Promise.all([funded(), funded(), funded(), funded()]);
    const m = await setup([a.address, b.address, c.address], 2);
    const { tx } = await propose(m, a, selfCall("set_owners", { owners: [a.address, b.address, dd.address] }, m.multisig, m.signer));
    expect(await both("approve", m.payer, [approveIx(m, tx, b)], [tx])).toBe("ok");
    expect(await both("execute_transaction (set_owners)", m.payer, [executeIx(m, tx)], [m.multisig, tx])).toBe("ok");
    // The owners changed and the sequence number moved on.
    const ms = d.coder.accounts.decode("Multisig", Buffer.from(acct(d.svm, m.multisig).data)) as { owners: Address[]; owner_set_seqno: number };
    expect(ms.owners.map(String)).toEqual([a.address, b.address, dd.address]);
    expect(ms.owner_set_seqno).toBe(1);
    // The owner set changed under it: the executed proposal no longer matches (the original's raw constraint, 2003).
    expect(await both("execute again", m.payer, [executeIx(m, tx)])).toBe(custom(2003));
    // Another multisig's proposal (has_one, 2001) whose sequence number also differs (2003): the original checks the
    // constraint on `multisig` first, so it is 2003 under both.
    const fresh = await setup([a.address, b.address], 1);
    const { tx: freshTx } = await propose(fresh, a, selfCall("change_threshold", { threshold: new BN(1) }, fresh.multisig, fresh.signer), "fresh: propose");
    expect(await both("double fault: has_one and seqno", m.payer, [approveIx(m, freshTx, a)], [freshTx])).toBe(custom(2003));
  });

  it("Assert Unique Owners (the original's second test) and the other create_multisig refusals", async () => {
    const [a, b] = await Promise.all([funded(), funded()]);
    const payer = await funded();
    const create = async (label: string, owners: Address[], threshold: number, opts: { space?: number; sign?: boolean; owner?: Address; lamports?: bigint } = {}) => {
      const multisig = await allocate(opts.space ?? 200, opts);
      const [, nonce] = await pda(PROGRAM, [multisig.address]);
      return both(label, payer, [
        ix("create_multisig", { owners, threshold: new BN(threshold), nonce }, [
          opts.sign === false ? { address: multisig.address, writable: true } : { address: multisig.address, signer: multisig, writable: true },
        ]),
      ], [multisig.address]);
    };
    expect(await create("unique owners", [a.address, b.address, a.address], 2)).toBe(custom(6008));
    expect(await create("threshold 0", [a.address, b.address], 0)).toBe(custom(6007));
    expect(await create("threshold above owners", [a.address, b.address], 3)).toBe(custom(6007));
    expect(await create("no owners", [], 0)).toBe(custom(6007));
    expect(await create("multisig did not sign", [a.address], 1, { sign: false })).toBe(custom(2002));
    expect(await create("not rent-exempt", [a.address], 1, { lamports: 1_000_000n })).toBe(custom(2005));
    expect(await create("owned by another program", [a.address], 1, { owner: address("11111111111111111111111111111111") })).toBe(custom(3007));
    expect(await create("too small for the empty value", [a.address], 1, { space: 20 })).toBe(custom(3003));
    expect(await create("too small for the owners", [a.address, b.address], 1, { space: 60 })).toBe(custom(3004));
    // An initialized account: create_multisig twice on one account.
    const m = await setup([a.address], 1);
    const [, nonce] = await pda(PROGRAM, [m.multisig]);
    const again = ix("create_multisig", { owners: [b.address], threshold: new BN(1), nonce }, [{ address: m.multisig, writable: true }]);
    expect(await both("already initialized", payer, [again], [m.multisig])).toBe(custom(2013));
  });

  it("refuses proposals, approvals and executions the original refuses", async () => {
    const [a, b, c, outsider] = await Promise.all([funded(), funded(), funded(), funded()]);
    const m = await setup([a.address, b.address, c.address], 2);
    const change = selfCall("change_threshold", { threshold: new BN(3) }, m.multisig, m.signer);
    expect((await propose(m, outsider, change, "proposer not an owner")).res).toBe(custom(6000));
    const { tx } = await propose(m, a, change);
    expect(await both("approve by an outsider", m.payer, [approveIx(m, tx, outsider)], [tx])).toBe(custom(6000));
    expect(await both("not enough signers", m.payer, [executeIx(m, tx)], [tx])).toBe(custom(6002));
    // Another multisig's transaction (has_one) and a wrong PDA (seeds).
    const other = await setup([a.address], 1);
    expect(await both("approve against another multisig", m.payer, [approveIx(other, tx, a)], [tx])).toBe(custom(2001));
    expect(await both("approve twice is fine", m.payer, [approveIx(m, tx, b), approveIx(m, tx, b)], [tx])).toBe("ok");
    expect(await both("wrong multisig signer", m.payer, [executeIx({ multisig: m.multisig, signer: other.signer }, tx)], [tx])).toBe(custom(2006));
    // The target program missing from the remaining accounts, then the CPI's own failure surfaces as the original's.
    expect(await both("program not passed", m.payer, [executeIx(m, tx, [{ address: m.multisig, writable: true }, { address: m.signer }])], [tx])).not.toBe("ok");
    expect(await both("execute change_threshold", m.payer, [executeIx(m, tx)], [m.multisig, tx])).toBe("ok");
    expect(await both("execute twice", m.payer, [executeIx(m, tx)], [m.multisig, tx])).toBe(custom(6006));
    // set_owners called directly: the multisig's PDA cannot sign a transaction.
    const direct = ix("set_owners", { owners: [a.address] }, [{ address: m.multisig, writable: true }, { address: m.signer }]);
    expect(await both("set_owners without the PDA", m.payer, [direct], [m.multisig])).toBe(custom(3010));
    // A Transaction account where the Multisig goes.
    expect(await both("wrong account type", m.payer, [approveIx({ multisig: tx }, tx, a)], [tx])).toBe(custom(3002));
  });

  it("set_owners_and_change_threshold and shrinking the owner set below the threshold", async () => {
    const [a, b, c] = await Promise.all([funded(), funded(), funded()]);
    const m = await setup([a.address, b.address, c.address], 3);
    const run = async (label: string, call: ReturnType<typeof selfCall>) => {
      const { tx } = await propose(m, a, call, `${label}: propose`);
      await both(`${label}: approve b`, m.payer, [approveIx(m, tx, b)], [tx]);
      const owners = (d.coder.accounts.decode("Multisig", Buffer.from(acct(d.svm, m.multisig).data)) as { owners: Address[] }).owners;
      if (owners.some((o) => String(o) === c.address)) await both(`${label}: approve c`, m.payer, [approveIx(m, tx, c)], [tx]);
      return both(`${label}: execute`, m.payer, [executeIx(m, tx)], [m.multisig, tx]);
    };
    // Two owners left: the threshold of 3 drops to 2 with them.
    expect(await run("shrink", selfCall("set_owners", { owners: [a.address, b.address] }, m.multisig, m.signer))).toBe("ok");
    expect(await run("both at once", selfCall("set_owners_and_change_threshold", { owners: [a.address, b.address, c.address], threshold: new BN(1) }, m.multisig, m.signer))).toBe("ok");
    // A threshold above the owner count fails inside the CPI, and the whole execution with it.
    expect(await run("threshold too high", selfCall("change_threshold", { threshold: new BN(4) }, m.multisig, m.signer))).toBe(custom(6007));
  });

  it("pays out SOL from the multisig's PDA, and the runtime refuses a signer the multisig cannot vouch for", async () => {
    const [a, b] = await Promise.all([funded(), funded()]);
    const m = await setup([a.address, b.address], 2);
    const recipient = (await generateKeyPairSigner()).address;
    for (const vm of vms()) vm.airdrop(m.signer, lamports(5_000_000_000n));
    // System Program Transfer (2) of 1.5 SOL from the PDA.
    const data = Buffer.alloc(12);
    data.writeUInt32LE(2, 0);
    data.writeBigUInt64LE(1_500_000_000n, 4);
    const system = address("11111111111111111111111111111111");
    const pay = (signers: Address[]) => ({
      pid: system,
      accs: [
        { pubkey: m.signer, is_writable: true, is_signer: true },
        { pubkey: recipient, is_writable: true, is_signer: signers.includes(recipient) },
      ],
      data,
    });
    const remaining = [{ address: m.signer, writable: true }, { address: recipient, writable: true }, { address: system }];
    const execute = async (label: string, call: ReturnType<typeof pay>) => {
      const { tx } = await propose(m, a, call as never, `${label}: propose`);
      await both(`${label}: approve`, m.payer, [approveIx(m, tx, b)], [tx]);
      // The PDA is writable here: execute_transaction's own slot for it stays read-only, the remaining one is writable.
      return both(`${label}: execute`, m.payer, [executeIx(m, tx, remaining)], [m.signer, recipient, tx]);
    };
    expect(await execute("transfer", pay([]))).toBe("ok");
    expect(acct(d.svm, recipient).lamports).toBe(1_500_000_000n);
    // A meta claiming the recipient signed: neither the transaction nor the PDA seeds vouch for it.
    expect(await execute("forged signer", pay([recipient]))).not.toBe("ok");
  });

  it("reads and runs an account the original wrote with 40 owners (more than one transaction can carry)", async () => {
    const owners = await Promise.all(Array.from({ length: 40 }, () => funded()));
    const payer = await funded();
    const multisig = await generateKeyPairSigner();
    const [signer, nonce] = await pda(PROGRAM, [multisig.address]);
    // The bytes the original would hold after set_owners calls grew the set: written into both VMs as they are.
    // Borsh: discriminator, the owners (u32 count, keys), threshold u64, nonce u8, owner_set_seqno u32.
    const disc = (d.idl.accounts ?? []).find((x) => x.name === "Multisig")!.discriminator;
    const enc = getAddressEncoder();
    const body = Buffer.concat([
      Buffer.from(disc),
      Buffer.from(Uint32Array.of(40).buffer),
      ...owners.map((o) => Buffer.from(enc.encode(o.address))),
      Buffer.from(BigUint64Array.of(2n).buffer),
      Buffer.from([nonce]),
      Buffer.from(Uint32Array.of(3).buffer),
    ]);
    const data = new Uint8Array(2000);
    data.set(body);
    for (const vm of vms())
      vm.setAccount({ address: multisig.address, data, executable: false, lamports: lamports(vm.minimumBalanceForRentExemption(2000n)), programAddress: PROGRAM, space: 2000n });
    const m = { payer, multisig: multisig.address, signer, nonce };
    const last = owners[39]!;
    const { tx } = await propose(m, last, selfCall("change_threshold", { threshold: new BN(40) }, m.multisig, m.signer), "40 owners: propose");
    expect(await both("40 owners: approve", payer, [approveIx(m, tx, owners[0]!)], [tx])).toBe("ok");
    expect(await both("40 owners: execute", payer, [executeIx(m, tx)], [m.multisig, tx])).toBe("ok");
    const ms = d.coder.accounts.decode("Multisig", Buffer.from(acct(d.svm, m.multisig).data)) as { owners: unknown[]; threshold: BN };
    expect([ms.owners.length, ms.threshold.toNumber()]).toEqual([40, 40]);
  });

  it("reports compute units side by side", () => {
    const rows = Object.entries(cu).map(([k, [o, t]]) => `${k.padEnd(48)} ${String(o).padStart(7)} ${String(t).padStart(7)}`);
    console.log(["instruction".padEnd(48) + " original TypeSOL", ...rows].join("\n"));
    expect(rows.length).toBeGreaterThan(0);
  });
});
