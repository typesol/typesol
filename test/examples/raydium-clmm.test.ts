// examples/raydium-clmm against Raydium CLMM as deployed on mainnet (test/programs/raydium_clmm.so, CAMMCzo5…). Both run
// in their own LiteSVM under the same program id with the same clock. Mints and token accounts are made by the same
// token-program instructions in both; AmmConfig accounts are written in both (creating one needs Raydium's admin key):
// the mainnet config of the USDC/CC pool as cloned, and others laid out as the original lays them out. Every
// transaction must then have the same outcome, the same account bytes and the same events ("Program data:" lines).
import { getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import * as token from "@solana-program/token";
import * as t22 from "@solana-program/token-2022";
import { type Address, type Instruction, type KeyPairSigner, AccountRole, address, generateKeyPairSigner, getAddressEncoder, lamports } from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from "litesvm";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, deployFile, pda, send, type Deployed } from "../harness.js";

const PROGRAM = address("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const ORIGINAL = fileURLToPath(new URL("../programs/raydium_clmm.so", import.meta.url));
const PORT = fileURLToPath(new URL("../../examples/raydium-clmm/raydium_clmm.ts", import.meta.url));
const MAINNET_CONFIG = fileURLToPath(new URL("../fixtures/clmm/mainnet/9iFER3bpjf1PTTCQCfTRu17EJgvsxo9pVyA9QWwEuX4x.json", import.meta.url));
const TOKEN = address(token.TOKEN_PROGRAM_ADDRESS);
const TOKEN_2022 = address(t22.TOKEN_2022_PROGRAM_ADDRESS);
const SYSTEM = address("11111111111111111111111111111111");
const RENT = address("SysvarRent111111111111111111111111111111111");
const ADMIN = address("GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ");

type Result = TransactionMetadata | FailedTransactionMetadata;
type Meta = { address: Address; signer?: KeyPairSigner; writable?: boolean };

const enc = getAddressEncoder();
const key = (a: Address) => Buffer.from(enc.encode(a));
const disc = (name: string) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
const u16 = (n: number) => Buffer.from(Uint16Array.of(n).buffer);
const u32 = (n: number) => Buffer.from(Uint32Array.of(n).buffer);
const be16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);
const outcome = (r: Result) => (r instanceof FailedTransactionMetadata ? `error: ${String(r.err())}` : "ok");
const meta = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r);
const events = (r: Result) =>
  meta(r)
    .logs()
    .filter((l) => l.startsWith("Program data:"));
const custom = (code: number) => `error: TransactionErrorInstructionError { index: 0, error: InstructionErrorCustom { code: ${code} } }`;

describe.skipIf(!existsSync(ORIGINAL))("examples/raydium-clmm against Raydium CLMM on mainnet", () => {
  let d: Deployed;
  let original: LiteSVM;
  const cu: Record<string, [bigint, bigint]> = {};
  let compared = 0;
  const errors = Object.fromEntries(
    [...readFileSync(fileURLToPath(new URL("../../examples/raydium-clmm/errors.ts", import.meta.url)), "utf8").matchAll(/^ {2}(\w+) = /gm)].map((m, i) => [m[1]!, 6000 + i]),
  ) as Record<string, number>;
  beforeAll(async () => {
    d = await deployFile(PORT, { programId: PROGRAM });
    original = new LiteSVM();
    original.addProgramFromFile(PROGRAM, ORIGINAL);
    for (const vm of [original, d.svm]) {
      const clock = vm.getClock();
      clock.unixTimestamp = 1_800_000_000n;
      clock.epoch = 900n;
      vm.setClock(clock);
    }
  });
  const vms = () => [original, d.svm] as const;

  const ix = (name: string, args: Record<string, unknown>, accounts: Meta[]): Instruction => ({
    programAddress: PROGRAM,
    accounts: accounts.map((a) => ({
      address: a.address,
      role: a.signer ? (a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY,
      ...(a.signer ? { signer: a.signer } : {}),
    })) as Instruction["accounts"],
    data: new Uint8Array(d.coder.instruction.encode(name, args)),
  });
  const funded = async () => {
    const s = await generateKeyPairSigner();
    for (const vm of vms()) vm.airdrop(s.address, lamports(100_000_000_000n));
    return s;
  };
  const bytes = (vm: LiteSVM, a: Address) => {
    const acct = vm.getAccount(a);
    return acct.exists ? `${acct.lamports} ${acct.programAddress} ${Buffer.from(acct.data).toString("hex")}` : "missing";
  };
  const setup = async (payer: KeyPairSigner, ixs: Instruction[]) => {
    for (const vm of vms()) {
      const r = await send(vm, payer, ixs);
      if (r instanceof FailedTransactionMetadata) throw new Error(`setup failed: ${String(r.err())}\n${r.meta().logs().join("\n")}`);
    }
  };
  /** Send to both: the same outcome, account bytes and events. */
  const both = async (label: string, payer: KeyPairSigner, ixs: Instruction[], watch: Address[]) => {
    const [a, b] = [await send(original, payer, ixs), await send(d.svm, payer, ixs)];
    compared++;
    const logs = (r: Result) => meta(r).logs().join("\n");
    expect(outcome(b), `${label}\noriginal:\n${logs(a)}\nTypeSOL:\n${logs(b)}`).toBe(outcome(a));
    for (const w of watch) expect(bytes(d.svm, w), `${label}: ${w}`).toBe(bytes(original, w));
    if (!(a instanceof FailedTransactionMetadata)) expect(events(b), `${label}: events`).toEqual(events(a));
    cu[label] = [meta(a).computeUnitsConsumed(), meta(b).computeUnitsConsumed()];
    return outcome(a);
  };

  /** A mint of `program`, authority `payer`; Token-2022 extensions by name. */
  async function mint(payer: KeyPairSigner, program: Address, decimals: number, ext?: "fee" | "closeAuthority") {
    const m = await generateKeyPairSigner();
    const exts =
      ext === "fee"
        ? [
            {
              __kind: "TransferFeeConfig" as const,
              transferFeeConfigAuthority: payer.address,
              withdrawWithheldAuthority: payer.address,
              withheldAmount: 0n,
              olderTransferFee: { epoch: 0n, maximumFee: 1_000_000n, transferFeeBasisPoints: 100 },
              newerTransferFee: { epoch: 0n, maximumFee: 1_000_000n, transferFeeBasisPoints: 100 },
            },
          ]
        : ext === "closeAuthority"
          ? [{ __kind: "MintCloseAuthority" as const, closeAuthority: payer.address }]
          : [];
    const space = exts.length ? t22.getMintSize(exts as never) : 82;
    await setup(payer, [
      getCreateAccountInstruction({ payer, newAccount: m, lamports: original.minimumBalanceForRentExemption(BigInt(space)), space, programAddress: program }),
      ...(ext === "fee"
        ? [
            t22.getInitializeTransferFeeConfigInstruction({
              mint: m.address,
              transferFeeConfigAuthority: payer.address,
              withdrawWithheldAuthority: payer.address,
              transferFeeBasisPoints: 100,
              maximumFee: 1_000_000n,
            }),
          ]
        : ext === "closeAuthority"
          ? [t22.getInitializeMintCloseAuthorityInstruction({ mint: m.address, closeAuthority: payer.address })]
          : []),
      (program === TOKEN ? token.getInitializeMint2Instruction : t22.getInitializeMint2Instruction)({ mint: m.address, decimals, mintAuthority: payer.address }) as Instruction,
    ]);
    return { address: m.address, program };
  }
  type MintInfo = Awaited<ReturnType<typeof mint>>;
  /** Two mints, ordered as a pool wants them (token_mint_0 < token_mint_1). */
  async function pair(payer: KeyPairSigner, p0: Address = TOKEN, p1: Address = TOKEN, ext1?: "fee" | "closeAuthority") {
    const [a, b] = [await mint(payer, p0, 6), await mint(payer, p1, 9, ext1)];
    return Buffer.compare(key(a.address), key(b.address)) < 0 ? [a, b] : [b, a];
  }

  /** An AmmConfig laid out as the original lays it out (Borsh), at its PDA ["amm_config", index BE]. */
  async function config(index: number, tickSpacing: number, tradeFee: number) {
    const [at, bump] = await pda(PROGRAM, ["amm_config", be16(index)]);
    const data = Buffer.concat([
      disc("AmmConfig"),
      Buffer.from([bump]),
      u16(index),
      key(address("projjosVCPQH49d5em7VYS7fJZzaqKixqKtus7yk416")),
      u32(120_000),
      u32(tradeFee),
      u16(tickSpacing),
      u32(40_000),
      u32(0),
      key(address("FundHfY8oo8J9KYGyfXFFuQCHe7Z1VBNmsj84eMcdYs4")),
      Buffer.alloc(24),
    ]);
    for (const vm of vms())
      vm.setAccount({ address: at, data: new Uint8Array(data), executable: false, lamports: lamports(10_000_000n), programAddress: PROGRAM, space: BigInt(data.length) });
    return at;
  }

  /** The create_pool accounts for a pair under a config. */
  async function poolAccounts(cfg: Address, m0: MintInfo, m1: MintInfo) {
    const [pool] = await pda(PROGRAM, ["pool", cfg, m0.address, m1.address]);
    const [vault0] = await pda(PROGRAM, ["pool_vault", pool, m0.address]);
    const [vault1] = await pda(PROGRAM, ["pool_vault", pool, m1.address]);
    const [observation] = await pda(PROGRAM, ["observation", pool]);
    const [bitmap] = await pda(PROGRAM, [Buffer.from("pool_tick_array_bitmap_extension"), pool]);
    return { pool, vault0, vault1, observation, bitmap };
  }
  const createPool = (creator: KeyPairSigner, cfg: Address, m0: MintInfo, m1: MintInfo, p: Awaited<ReturnType<typeof poolAccounts>>, sqrt: bigint, openTime = 0n) =>
    ix("create_pool", { sqrt_price_x64: new BN(sqrt.toString()), open_time: new BN(openTime.toString()) }, [
      { address: creator.address, signer: creator, writable: true },
      { address: cfg },
      { address: p.pool, writable: true },
      { address: m0.address },
      { address: m1.address },
      { address: p.vault0, writable: true },
      { address: p.vault1, writable: true },
      { address: p.observation, writable: true },
      { address: p.bitmap, writable: true },
      { address: m0.program },
      { address: m1.program },
      { address: SYSTEM },
      { address: RENT },
    ]);
  const watchPool = (p: Awaited<ReturnType<typeof poolAccounts>>) => [p.pool, p.vault0, p.vault1, p.observation, p.bitmap];

  it("refuses create_amm_config from anyone but Raydium's admin", async () => {
    const someone = await funded();
    const [cfg] = await pda(PROGRAM, ["amm_config", be16(77)]);
    const create = ix("create_amm_config", { index: 77, tick_spacing: 10, trade_fee_rate: 2500, protocol_fee_rate: 120_000, fund_fee_rate: 40_000 }, [
      { address: someone.address, signer: someone, writable: true },
      { address: cfg, writable: true },
      { address: SYSTEM },
    ]);
    expect(await both("create_amm_config, not the admin", someone, [create], [cfg])).toBe(custom(errors.NotApproved!));
    expect(ADMIN).toBeDefined();
  });

  it("creates pools: SPL Token, Token-2022 with a transfer fee, and the mainnet config", async () => {
    const creator = await funded();
    const cfg = await config(3, 60, 2500);
    // 1.0001^(tick/2) for tick 1234, and a price at the top of a tick range.
    for (const [label, programs, sqrt] of [
      ["SPL Token", [TOKEN, TOKEN], 19_574_085_512_633_416_581n],
      ["Token-2022 transfer-fee mint", [TOKEN, TOKEN_2022], 18_446_744_073_709_551_616n],
    ] as const) {
      const [m0, m1] = await pair(creator, programs[0], programs[1], programs[1] === TOKEN_2022 ? "fee" : undefined);
      const p = await poolAccounts(cfg, m0, m1);
      expect(await both(`create_pool, ${label}`, creator, [createPool(creator, cfg, m0, m1, p, sqrt)], watchPool(p))).toBe("ok");
      expect(await both(`create_pool, ${label}, again`, creator, [createPool(creator, cfg, m0, m1, p, sqrt)], watchPool(p))).toBe(custom(0));
    }
    // The mainnet config of the USDC/CC pool, as cloned.
    const cloned = JSON.parse(readFileSync(MAINNET_CONFIG, "utf8")) as { address: string; data: string; lamports: string };
    for (const vm of vms())
      vm.setAccount({
        address: address(cloned.address),
        data: new Uint8Array(Buffer.from(cloned.data, "base64")),
        executable: false,
        lamports: lamports(BigInt(cloned.lamports)),
        programAddress: PROGRAM,
        space: BigInt(Buffer.from(cloned.data, "base64").length),
      });
    const [m0, m1] = await pair(creator);
    const p = await poolAccounts(address(cloned.address), m0, m1);
    expect(await both("create_pool, mainnet config", creator, [createPool(creator, address(cloned.address), m0, m1, p, 4_295_048_016n)], watchPool(p))).toBe("ok");
  });

  it("creates a pool whose vault address someone pre-funded", async () => {
    const creator = await funded();
    const cfg = await config(4, 1, 100);
    const [m0, m1] = await pair(creator);
    const p = await poolAccounts(cfg, m0, m1);
    await setup(creator, [getTransferSolInstruction({ source: creator, destination: p.vault0, amount: 1_000_000n })]);
    expect(await both("create_pool, pre-funded vault", creator, [createPool(creator, cfg, m0, m1, p, 79_226_673_521_066_979_257_578_248_090n)], watchPool(p))).toBe("ok");
  });

  it("refuses bad pools as the original does", async () => {
    const creator = await funded();
    const cfg = await config(5, 10, 500);
    const [m0, m1] = await pair(creator);
    const p = await poolAccounts(cfg, m0, m1);
    const sqrt = 18_446_744_073_709_551_616n;
    // Mints out of order.
    const swapped = await poolAccounts(cfg, m1, m0);
    expect(await both("create_pool, mints out of order", creator, [createPool(creator, cfg, m1, m0, swapped, sqrt)], watchPool(swapped))).not.toBe("ok");
    // A vault that is not the PDA.
    const other = (await generateKeyPairSigner()).address;
    expect(await both("create_pool, wrong vault", creator, [createPool(creator, cfg, m0, m1, { ...p, vault0: other }, sqrt)], watchPool(p))).not.toBe("ok");
    // A price outside the range, an open time not in the past, a token program that does not own the mint.
    expect(await both("create_pool, price too high", creator, [createPool(creator, cfg, m0, m1, p, 79_226_673_521_066_979_257_578_248_091n)], watchPool(p))).toBe(
      custom(errors.SqrtPriceX64!),
    );
    expect(await both("create_pool, open time ahead", creator, [createPool(creator, cfg, m0, m1, p, sqrt, 1_900_000_000n)], watchPool(p))).toBe(custom(2505));
    expect(await both("create_pool, wrong token program", creator, [createPool(creator, cfg, m0, { ...m1, program: TOKEN_2022 }, p, sqrt)], watchPool(p))).not.toBe("ok");
    // A Token-2022 mint with an extension pools do not handle.
    const [n0, n1] = await pair(creator, TOKEN, TOKEN_2022, "closeAuthority");
    const q = await poolAccounts(cfg, n0, n1);
    expect(await both("create_pool, unsupported extension", creator, [createPool(creator, cfg, n0, n1, q, sqrt)], watchPool(q))).toBe(
      custom(errors.NotSupportMint!),
    );
  });

  it("reports compute units", () => {
    expect(compared).toBeGreaterThan(5);
    console.log(Object.entries(cu).map(([k, [a, b]]) => `${k}: ${a} → ${b}`).join("\n"));
  });
});
