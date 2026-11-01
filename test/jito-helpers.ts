// Shared by the Jito differential tests (test/examples/jito-mev.test.ts, written cases), the Jito fuzzer
// (test/verification/fuzz-jito.test.ts, random cases) and Marginfi's (test/examples/marginfi.test.ts): each original and
// its port side by side, compared.
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  AccountRole,
  address,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  lamports,
} from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from "litesvm";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { web3 } from "@anchor-lang/core";
import { deployFile, send, type Deployed } from "./harness.js";

export const SYSTEM = address("11111111111111111111111111111111");
export const VOTE = address("Vote111111111111111111111111111111111111111");
export const program = (file: string) => fileURLToPath(new URL(`programs/${file}`, import.meta.url));
export const port = (file: string) => fileURLToPath(new URL(`../examples/jito-mev/${file}`, import.meta.url));

export type Result = TransactionMetadata | FailedTransactionMetadata;
export type Meta = { address: Address; signer?: KeyPairSigner; writable?: boolean };

export const enc = getAddressEncoder();
export const dec = getAddressDecoder();
export const pk = (a: Address) => new web3.PublicKey(a);
export const key = (a: Address) => Buffer.from(enc.encode(a));
export const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
export const sha = (...parts: Uint8Array[]): Buffer => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};
export const outcome = (r: Result) => (r instanceof FailedTransactionMetadata ? `error: ${String(r.err())}` : "ok");
export const meta = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r);
export const events = (r: Result) =>
  meta(r)
    .logs()
    .filter((l) => l.startsWith("Program data:"));
/** The messages the programs log themselves (msg!), beyond Anchor's "Instruction: …" lines. */
export const said = (r: Result) =>
  meta(r)
    .logs()
    .filter((l) => /^Program log: (WARN|Priority fee)/.test(l));
export const custom = (code: number) => `error: TransactionErrorInstructionError { index: 0, error: InstructionErrorCustom { code: ${code} } }`;
export const errorsOf = (file: string) =>
  Object.fromEntries([...readFileSync(port(file), "utf8").matchAll(/^ {2}(\w+) = /gm)].map((m, i) => [m[1]!, 6000 + i])) as Record<string, number>;

/** A Merkle tree of (claimant, amount) leaves as Jito's tooling hashes them; `proof(i)` for leaf i. */
export function merkle(leaves: [Address, bigint][]) {
  const level0 = leaves.map(([c, a]) => sha(Uint8Array.of(0), sha(key(c), u64(a))));
  const levels: Buffer[][] = [level0];
  while (levels.at(-1)!.length > 1) {
    const prev = levels.at(-1)!;
    const next = [] as Buffer[];
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

/** One original and its port side by side: send to both and compare. `source`: a file of examples/jito-mev, or an absolute path. */
export function pairOf(so: string, source: string, programId: Address) {
  const s = {
    d: undefined as unknown as Deployed,
    original: undefined as unknown as LiteSVM,
    cu: {} as Record<string, [bigint, bigint]>,
    compared: 0,
    async load() {
      s.d = await deployFile(isAbsolute(source) ? source : port(source), { programId });
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
        vm.setAccount({
          address: v,
          data: new Uint8Array(data),
          executable: false,
          lamports: lamports(27_074_400n),
          programAddress: VOTE,
          space: BigInt(data.length),
        });
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
    /**
     * Send to both: the same outcome, account bytes and events. `failing`: the original panics, so only both failing is
     * required; "if-panics": that, when the original fails without an error code (a fuzzer's input that hits a panic).
     */
    async both(label: string, payer: KeyPairSigner, ixs: Instruction[], watch: Address[], failing: boolean | "if-panics" = false) {
      const [a, b] = [await send(s.original, payer, ixs), await send(s.d.svm, payer, ixs)];
      s.compared++;
      const logs = (r: Result) => meta(r).logs().join("\n");
      if (failing === "if-panics") failing = a instanceof FailedTransactionMetadata && !outcome(a).includes("InstructionErrorCustom");
      if (failing) {
        expect(a instanceof FailedTransactionMetadata && b instanceof FailedTransactionMetadata, `${label}\noriginal:\n${logs(a)}\nTypeSOL:\n${logs(b)}`).toBe(
          true,
        );
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

export const report = (name: string, s: ReturnType<typeof pairOf>) => {
  const rows = Object.entries(s.cu).map(
    ([k, [a, b]]) => `  ${k.padEnd(56)} ${String(a).padStart(7)} ${String(b).padStart(7)}  ${((1 - Number(b) / Number(a)) * 100).toFixed(0)}%`,
  );
  console.log(`${name}: ${s.compared} transactions compared\n  ${"".padEnd(56)} original TypeSOL  less\n${rows.join("\n")}`);
};

/** Tip distribution and priority fee distribution: the same program, apart from names and the priority fee transfer. */
export const DISTRIBUTIONS = [
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
