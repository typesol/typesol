// Random sequences of honest and hostile transactions against Jito's three MEV programs as deployed on mainnet
// (test/programs/jito_*.so) and their ports (showcase/mainnet/jito-mev), side by side. Every transaction must have the same
// outcome, account bytes, events and program log lines in both (showcase/test/jito-helpers.ts). Keys, amounts and choices all
// come from the seed: reproduce a failure with FUZZ_SEED=<seed>; lengthen with FUZZ_STEPS=<n>.
//
// One fault is injected per transaction at most (a wrong signer, account, amount or proof). Faults the state brings on
// its own (premature, expired, already claimed, over a cap) combine freely with it.
import { type Address, type KeyPairSigner, address, createKeyPairSignerFromPrivateKeyBytes, lamports } from "@solana/kit";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BN, pda } from "../../test/harness.js";
import { DISTRIBUTIONS, SYSTEM, VOTE, dec, key, merkle, pairOf, pk, program, u64 } from "./jito-helpers.js";
import { Rng } from "./fuzz-rng.js";

const SEED = BigInt(process.env.FUZZ_SEED ?? Date.now());
const STEPS = Number(process.env.FUZZ_STEPS ?? 150);
const U64_MAX = 18446744073709551615n;

/** Counts each instruction's outcomes (the label's first words), to show what a run covered. */
function tally(s: ReturnType<typeof pairOf>) {
  const counts: Record<string, Record<string, number>> = {};
  const both = s.both;
  const short = (o: string) => (o === "ok" ? "ok" : (/code: (\d+)/.exec(o)?.[1] ?? o.slice(0, 40)));
  s.both = async (label, ...rest) => {
    const o = await both(label, ...rest);
    const name = label.replace(/^step \d+ \([^)]*\): /, "").split(" ")[0]!;
    (counts[name] ??= {})[short(o)] = ((counts[name] ??= {})[short(o)] ?? 0) + 1;
    return o;
  };
  return Object.assign(s, { counts });
}

/** A keypair from the seed (the same keys on every run with that seed). */
const signerOf = (rng: Rng) => createKeyPairSignerFromPrivateKeyBytes(rng.bytes(32));

describe.skipIf(!existsSync(program("jito_tip_payment.so")))(`fuzz: Jito tip payment against mainnet (seed ${SEED}, ${STEPS} steps)`, () => {
  it("pays tips out the same through random receiver and block builder changes", async () => {
    const rng = new Rng(SEED);
    const ID = address("T1pyyaTNZsKv2WcRAB8oVnk93mLJw2XzjtVYqCsaHqt");
    const s = tally(pairOf("jito_tip_payment.so", "tip_payment.ts", ID));
    await s.load();
    const fund = async (sol: bigint) => {
      const k = await signerOf(rng);
      for (const vm of s.vms()) vm.airdrop(k.address, lamports(sol * 1_000_000_000n));
      return k;
    };
    const [config, configBump] = await pda(ID, ["CONFIG_ACCOUNT"]);
    const tips: Address[] = [];
    const bumps: Record<string, number> = { config: configBump };
    for (let i = 0; i < 8; i++) {
      const [t, b] = await pda(ID, [`TIP_ACCOUNT_${i}`]);
      tips.push(t);
      bumps[`tip_payment_account_${i}`] = b;
    }
    const payer = await fund(1_000n);
    const tipAccounts = tips.map((address) => ({ address, writable: true }));
    expect(
      await s.both(
        "initialize",
        payer,
        [
          s.ix("initialize", { _bumps: bumps }, [
            { address: config, writable: true },
            ...tipAccounts,
            { address: SYSTEM },
            { address: payer.address, signer: payer, writable: true },
          ]),
        ],
        [config, ...tips],
      ),
    ).toBe("ok");

    // Who can receive: funded wallets, empty accounts, accounts a payout must refuse, the tip accounts and the config.
    const owned = async (owner: Address) => {
      const a = (await signerOf(rng)).address;
      for (const vm of s.vms())
        vm.setAccount({ address: a, data: new Uint8Array(64), executable: false, lamports: lamports(10_000_000n), programAddress: owner, space: 64n });
      return a;
    };
    const pool: Address[] = [
      payer.address,
      ...(await Promise.all([1n, 1n, 50n].map(fund))).map((k) => k.address),
      (await signerOf(rng)).address,
      (await signerOf(rng)).address,
      await owned(address("BPFLoaderUpgradeab1e11111111111111111111111")),
      await owned(address("Sysvar1111111111111111111111111111111111111")),
      await owned(address("Config1111111111111111111111111111111111111")),
      tips[0]!,
      tips[5]!,
      config,
    ];
    const current = () => {
      const c = s.original.getAccount(config);
      if (!c.exists) throw new Error("config");
      return [dec.decode(c.data.subarray(8, 40)), dec.decode(c.data.subarray(40, 72))] as const;
    };
    const watch = [config, ...tips, ...pool];
    const front = (accounts: Address[]) => [{ address: config, writable: true }, ...accounts.map((address) => ({ address, writable: true }))];
    const tail = [...tipAccounts, { address: payer.address, signer: payer, writable: true }];

    for (let step = 0; step < STEPS; step++) {
      const [receiver, builder] = current();
      const label = (what: string) => `step ${step} (seed ${SEED}): ${what}`;
      const op = rng.int(10);
      if (op < 4) {
        const t = rng.pick(tips);
        const amount = rng.lamports();
        s.tip(t, amount);
        continue;
      }
      // At most one fault: the wrong current receiver or builder.
      const fault = rng.chance(15) ? rng.int(2) : -1;
      const r = fault === 0 ? rng.pick(pool) : receiver;
      const b = fault === 1 ? rng.pick(pool) : builder;
      const next = rng.pick(pool);
      if (op < 7) {
        await s.both(
          label(`change_tip_receiver ${r} → ${next}, builder ${b}`),
          payer,
          [s.ix("change_tip_receiver", {}, [...front([r, next, b]), ...tail])],
          watch,
        );
      } else {
        const pct = rng.chance(10) ? BigInt(101 + rng.int(50)) : BigInt(rng.int(101));
        await s.both(
          label(`change_block_builder ${b} → ${next} at ${pct}%, receiver ${r}`),
          payer,
          [s.ix("change_block_builder", { block_builder_commission: new BN(pct.toString()) }, [...front([r, b, next]), ...tail])],
          watch,
        );
      }
    }
    expect(s.compared).toBeGreaterThan(STEPS / 4);
    console.log(`fuzz tip payment (seed ${SEED}): ${s.compared} transactions`, JSON.stringify(s.counts));
  });
});

for (const P of DISTRIBUTIONS)
  describe.skipIf(!existsSync(program(P.so)))(`fuzz: Jito ${P.name} against mainnet (seed ${SEED}, ${STEPS} steps)`, () => {
    it("opens, uploads, claims and closes the same over random epochs", async () => {
      const rng = new Rng(SEED + (P.priority ? 2n : 1n));
      const s = tally(pairOf(P.so, P.source, P.id));
      await s.load();
      const fund = async (sol: bigint) => {
        const k = await signerOf(rng);
        for (const vm of s.vms()) vm.airdrop(k.address, lamports(sol * 1_000_000_000n));
        return k;
      };
      let epoch = 500n;
      s.epoch(epoch);
      const [config, configBump] = await pda(P.id, ["CONFIG_ACCOUNT"]);
      const [rootConfig] = await pda(P.id, ["ROOT_UPLOAD_CONFIG"]);
      const authority = await fund(100n);
      const expired = await fund(1n);
      const payer = await fund(10_000n);
      const others = await Promise.all([1n, 1n].map(fund));
      const uploaders = await Promise.all([10n, 10n].map(fund));
      const claimants = await Promise.all([1n, 1n, 1n, 1n, 1n, 1n].map(fund));
      const nodes = await Promise.all([10n, 10n, 10n].map(fund));
      const votes: Address[] = [];
      for (const n of nodes) {
        const v = (await signerOf(rng)).address;
        const data = Buffer.alloc(3762);
        data.writeUInt32LE(2, 0);
        key(n.address).copy(data, 4);
        for (const vm of s.vms())
          vm.setAccount({
            address: v,
            data: new Uint8Array(data),
            executable: false,
            lamports: lamports(27_074_400n),
            programAddress: VOTE,
            space: BigInt(data.length),
          });
        votes.push(v);
      }
      const configArgs = (o: { epochs: bigint; max: number; goLive: bigint }) => ({
        authority: pk(authority.address),
        expired_funds_account: pk(expired.address),
        num_epochs_valid: new BN(o.epochs.toString()),
        max_validator_commission_bps: o.max,
        ...(P.priority ? { go_live_epoch: new BN(o.goLive.toString()) } : {}),
        bump: configBump,
      });
      const initArgs = { ...configArgs({ epochs: BigInt(1 + rng.int(10)), max: rng.int(10_001), goLive: 0n }) } as Record<string, unknown>;
      delete initArgs.go_live_epoch;
      expect(
        await s.both(
          "initialize",
          payer,
          [s.ix("initialize", initArgs, [{ address: config, writable: true }, { address: SYSTEM }, { address: payer.address, signer: payer, writable: true }])],
          [config],
        ),
      ).toBe("ok");
      expect(
        await s.both(
          "initialize_merkle_root_upload_config",
          payer,
          [
            s.ix("initialize_merkle_root_upload_config", { authority: pk(uploaders[1]!.address), original_authority: pk(uploaders[0]!.address) }, [
              { address: config, writable: true },
              { address: rootConfig, writable: true },
              { address: authority.address, signer: authority },
              { address: payer.address, signer: payer, writable: true },
              { address: SYSTEM },
            ]),
          ],
          [rootConfig],
        ),
      ).toBe("ok");

      type Leaf = { claimant: KeyPairSigner; amount: bigint };
      type Account = { at: Address; vote: Address; epoch: bigint; tree?: ReturnType<typeof merkle>; leaves: Leaf[] };
      const accounts: Account[] = [];
      const statuses: { at: Address; claimant: Address }[] = [];
      const everyone = [config, rootConfig, expired.address, payer.address, ...votes, ...claimants.map((c) => c.address)];
      const opName = P.priority ? "priority_fee_distribution_account" : "tip_distribution_account";

      for (let step = 0; step < STEPS; step++) {
        const label = (what: string) => `step ${step} (seed ${SEED}, epoch ${epoch}): ${what}`;
        // Mostly accounts that still exist (with a root, for claims); now and then a closed one.
        const live = accounts.filter((x) => s.original.getAccount(x.at).exists);
        const rooted = live.filter((x) => x.tree && x.leaves.length);
        const a = live.length && rng.chance(90) ? rng.pick(live) : accounts.length ? rng.pick(accounts) : undefined;
        const watch = [...everyone, ...accounts.map((x) => x.at)];
        const op = rng.int(P.priority ? 13 : 12);
        if (op === 0) {
          epoch += BigInt(rng.int(4));
          s.epoch(epoch);
        } else if (op === 1 || !a) {
          // Open this epoch's account for a validator: its node key signs (or, as the fault, someone else).
          const i = rng.int(nodes.length);
          const signer = rng.chance(10) ? rng.pick(others) : nodes[i]!;
          const [at, bump] = await pda(P.id, [P.seed, votes[i]!, u64(epoch)]);
          const cfg = s.original.getAccount(config);
          const max = cfg.exists ? Buffer.from(cfg.data).readUInt16LE(80) : 10_000;
          const commission = rng.chance(10) ? max + 1 + rng.int(2_000) : rng.int(max + 1);
          const uploader = rng.pick(uploaders).address;
          const r = await s.both(
            label(`open for validator ${i} at ${commission} bps`),
            signer,
            [
              s.ix(
                P.priority ? "initialize_priority_fee_distribution_account" : "initialize_tip_distribution_account",
                { merkle_root_upload_authority: pk(uploader), validator_commission_bps: commission, bump },
                [
                  { address: config },
                  { address: at, writable: true },
                  { address: votes[i]! },
                  { address: signer.address, signer, writable: true },
                  { address: SYSTEM },
                ],
              ),
            ],
            [...watch, at],
          );
          if (r === "ok") accounts.push({ at, vote: votes[i]!, epoch, leaves: [] });
        } else if (op < 4) {
          if (s.original.getAccount(a.at).exists) s.tip(a.at, rng.lamports());
        } else if (op < 6) {
          // A new root: 1–6 claimants with random amounts, caps around their totals.
          const n = 1 + rng.int(claimants.length);
          const shuffled = [...claimants];
          for (let j = shuffled.length - 1; j > 0; j--) {
            const k = rng.int(j + 1);
            [shuffled[j], shuffled[k]] = [shuffled[k]!, shuffled[j]!];
          }
          const chosen = shuffled.slice(0, n);
          const leaves = chosen.map((claimant) => ({ claimant, amount: rng.lamports() }));
          const tree = merkle(leaves.map((l) => [l.claimant.address, l.amount]));
          const total = leaves.reduce((x, l) => x + l.amount, 0n);
          const maxTotal = rng.chance(20) ? total - (total > 0n ? rng.next() % total : 0n) : total + rng.lamports();
          const maxNodes = rng.chance(20) ? BigInt(rng.int(n)) : BigInt(n + rng.int(3));
          const tda = s.original.getAccount(a.at);
          const uploader = tda.exists ? dec.decode(tda.data.subarray(40, 72)) : uploaders[0]!.address;
          const by = rng.chance(10) ? rng.pick(uploaders) : (uploaders.find((u) => u.address === uploader) ?? uploaders[0]!);
          const r = await s.both(
            label(`upload_merkle_root (${n} leaves, total ${total}, caps ${maxTotal}/${maxNodes})`),
            by,
            [
              s.ix("upload_merkle_root", { root: tree.root, max_total_claim: new BN(maxTotal.toString()), max_num_nodes: new BN(maxNodes.toString()) }, [
                { address: config },
                { address: a.at, writable: true },
                { address: by.address, signer: by, writable: true },
              ]),
            ],
            watch,
          );
          if (r === "ok") {
            Object.assign(a, { tree, leaves });
            // Usually the tips are there by now; sometimes not all of them.
            if (rng.chance(70)) s.tip(a.at, rng.chance(80) ? total : total / 2n);
          }
        } else if (op < 9) {
          const c = rooted.length && rng.chance(90) ? rng.pick(rooted) : a;
          if (!c.tree || !c.leaves.length) continue;
          const i = rng.int(c.leaves.length);
          const leaf = c.leaves[i]!;
          const fault = rng.chance(20) ? rng.int(3) : -1;
          const amount = fault === 0 ? leaf.amount + 1n + (rng.next() % 1000n) : leaf.amount;
          const proof = fault === 1 ? c.tree.proof((i + 1) % c.leaves.length) : c.tree.proof(i);
          const tda = s.original.getAccount(c.at);
          const uploader = tda.exists ? dec.decode(tda.data.subarray(40, 72)) : uploaders[0]!.address;
          const by = fault === 2 ? rng.pick(others) : (uploaders.find((u) => u.address === uploader) ?? uploaders[0]!);
          const funder = rng.chance(30) ? leaf.claimant : payer;
          const [status, bump] = await pda(P.id, ["CLAIM_STATUS", leaf.claimant.address, c.at]);
          const r = await s.both(
            label(`claim leaf ${i} (${amount}) paid by ${funder === payer ? "payer" : "claimant"}`),
            funder,
            [
              s.ix("claim", { [P.priority ? "_bump" : "bump"]: bump, amount: new BN(amount.toString()), proof }, [
                { address: config },
                { address: c.at, writable: true },
                { address: by.address, signer: by },
                { address: status, writable: true },
                { address: leaf.claimant.address, writable: true },
                { address: funder.address, signer: funder, writable: true },
                { address: SYSTEM },
              ]),
            ],
            [...watch, status],
          );
          if (r === "ok") statuses.push({ at: c.at, claimant: leaf.claimant.address });
        } else if (op === 9) {
          if (!statuses.length) continue;
          const st = rng.pick(statuses);
          const [status] = await pda(P.id, ["CLAIM_STATUS", st.claimant, st.at]);
          const c = s.original.getAccount(status);
          const rentPayer = c.exists ? dec.decode(c.data.subarray(P.priority ? 8 : 41, P.priority ? 40 : 73)) : payer.address;
          const to = rng.chance(10) ? rng.pick(claimants).address : rentPayer;
          await s.both(
            label("close_claim_status"),
            payer,
            [
              s.ix("close_claim_status", {}, [
                ...(P.priority ? [] : [{ address: config }]),
                { address: status, writable: true },
                { address: to, writable: true },
              ]),
            ],
            [...watch, status, to],
          );
        } else if (op === 10) {
          const fault = rng.chance(15) ? rng.int(2) : -1;
          const to = fault === 0 ? payer.address : expired.address;
          const seedEpoch = fault === 1 ? a.epoch + 1n : a.epoch;
          const signer = rng.chance(30) ? expired : payer;
          await s.both(
            label(`close account of epoch ${a.epoch}`),
            signer,
            [
              s.ix(P.priority ? "close_priority_fee_distribution_account" : "close_tip_distribution_account", { _epoch: new BN(seedEpoch.toString()) }, [
                { address: config },
                { address: to, writable: true },
                { address: a.at, writable: true },
                { address: a.vote, writable: true },
                { address: signer.address, signer, writable: true },
              ]),
            ],
            watch,
          );
        } else if (op === 11) {
          const by = rng.chance(10) ? rng.pick(others) : authority;
          const o = {
            epochs: rng.chance(10) ? BigInt(rng.pick([0, 11, 12])) : BigInt(1 + rng.int(10)),
            max: rng.chance(10) ? 10_001 + rng.int(100) : rng.int(10_001),
            goLive: rng.chance(30) ? U64_MAX : epoch - 2n + BigInt(rng.int(5)),
          };
          await s.both(
            label(`update_config ${o.epochs} epochs, max ${o.max}, live ${o.goLive}`),
            by,
            [
              s.ix("update_config", { new_config: configArgs(o) }, [
                { address: config, writable: true },
                { address: by.address, signer: by, writable: true },
              ]),
            ],
            [config],
          );
          if (rng.chance(30))
            await s.both(
              label(`migrate ${opName}`),
              payer,
              [s.ix("migrate_tda_merkle_root_upload_authority", {}, [{ address: a.at, writable: true }, { address: rootConfig }])],
              [a.at],
            );
        } else {
          // Priority fees moved in by the validator (only into this epoch's account; only once live).
          const now = live.filter((x) => x.epoch === epoch);
          const t = now.length && rng.chance(80) ? rng.pick(now) : a;
          const i = votes.indexOf(t.vote);
          const from = rng.chance(10) ? rng.pick(others) : nodes[i]!;
          const amount = rng.chance(5) ? U64_MAX - (rng.next() % 1000n) : rng.lamports() % 2_000_000_000_000n;
          await s.both(
            label(`transfer_priority_fee_tips ${amount}`),
            from,
            [
              s.ix("transfer_priority_fee_tips", { lamports: new BN(amount.toString()) }, [
                { address: config },
                { address: a.at, writable: true },
                { address: from.address, signer: from, writable: true },
                { address: SYSTEM },
              ]),
            ],
            [...watch, from.address],
          );
        }
      }
      expect(s.compared).toBeGreaterThan(STEPS / 4);
      console.log(`fuzz ${P.name} (seed ${SEED}): ${s.compared} transactions`, JSON.stringify(s.counts));
    });
  });
