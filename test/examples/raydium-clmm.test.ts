// examples/raydium-clmm against Raydium CLMM as deployed on mainnet (test/programs/raydium_clmm.so, CAMMCzo5…). Both run
// in their own LiteSVM under the same program id with the same clock. Mints and token accounts are made by the same
// token-program instructions in both; AmmConfig accounts are written in both (creating one needs Raydium's admin key):
// the mainnet config of the USDC/CC pool as cloned, and others laid out as the original lays them out. Every
// transaction must then have the same outcome, the same account bytes and the same events ("Program data:" lines).
import { getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import * as token from "@solana-program/token";
import * as t22 from "@solana-program/token-2022";
import { type Address, type Instruction, type KeyPairSigner, AccountRole, address, generateKeyPairSigner, getAddressDecoder, getAddressEncoder, lamports } from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from "litesvm";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { web3 } from "@anchor-lang/core";
import { BN, acct, deployFile, pda, send, type Deployed } from "../harness.js";

const PROGRAM = address("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const ORIGINAL = fileURLToPath(new URL("../programs/raydium_clmm.so", import.meta.url));
const PORT = fileURLToPath(new URL("../../examples/raydium-clmm/raydium_clmm.ts", import.meta.url));
const MAINNET_CONFIG = fileURLToPath(new URL("../fixtures/clmm/mainnet/9iFER3bpjf1PTTCQCfTRu17EJgvsxo9pVyA9QWwEuX4x.json", import.meta.url));
const TOKEN = address(token.TOKEN_PROGRAM_ADDRESS);
const TOKEN_2022 = address(t22.TOKEN_2022_PROGRAM_ADDRESS);
const SYSTEM = address("11111111111111111111111111111111");
const RENT = address("SysvarRent111111111111111111111111111111111");
const ADMIN = address("GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ");
const METADATA = address("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

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
  let admin: KeyPairSigner;
  const cu: Record<string, [bigint, bigint]> = {};
  let compared = 0;
  const errors = Object.fromEntries(
    [...readFileSync(fileURLToPath(new URL("../../examples/raydium-clmm/errors.ts", import.meta.url)), "utf8").matchAll(/^ {2}(\w+) = /gm)].map((m, i) => [m[1]!, 6000 + i]),
  ) as Record<string, number>;
  beforeAll(async () => {
    // Raydium's admin key is replaced by a test key in both, so the admin instructions run too: in the original, in
    // each of the 26 places its code loads the key (as four 64-bit immediates, lddw); in the port, in its source.
    admin = await generateKeyPairSigner();
    const so = Buffer.from(readFileSync(ORIGINAL));
    const [from, to] = [key(ADMIN), key(admin.address)];
    for (let c = 0; c < 4; c++) {
      const [was, now] = [from.readBigUInt64LE(c * 8), to.readBigUInt64LE(c * 8)];
      let patched = 0;
      for (let i = 0; i + 16 <= so.length; i += 8)
        if (so[i] === 0x18 && so.readUInt32LE(i + 4) === Number(was & 0xffffffffn) && so[i + 8] === 0 && so.readUInt32LE(i + 12) === Number(was >> 32n)) {
          so.writeUInt32LE(Number(now & 0xffffffffn), i + 4);
          so.writeUInt32LE(Number(now >> 32n), i + 12);
          patched++;
        }
      expect(patched, `admin key, part ${c}`).toBe(26);
    }
    const source = mkdtempSync(path.join(os.tmpdir(), "clmm-port-"));
    cpSync(path.dirname(PORT), source, { recursive: true });
    for (const f of readdirSync(source)) writeFileSync(path.join(source, f), readFileSync(path.join(source, f), "utf8").replaceAll(ADMIN, admin.address));
    d = await deployFile(path.join(source, path.basename(PORT)), { programId: PROGRAM });
    original = new LiteSVM();
    original.addProgram(PROGRAM, new Uint8Array(so));
    // Metaplex Token Metadata, for the v1 / v2 position NFTs.
    for (const vm of [original, d.svm]) vm.addProgramFromFile(METADATA, fileURLToPath(new URL("../programs/mpl_token_metadata.so", import.meta.url)));
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
    const info = vm.getAccount(a);
    return info.exists ? `${info.lamports} ${info.programAddress} ${Buffer.from(info.data).toString("hex")}` : "missing";
  };
  const setup = async (payer: KeyPairSigner, ixs: Instruction[]) => {
    for (const vm of vms()) {
      const r = await send(vm, payer, ixs);
      if (r instanceof FailedTransactionMetadata) throw new Error(`setup failed: ${String(r.err())}\n${r.meta().logs().join("\n")}`);
    }
  };
  /** Send to both: the same outcome, account bytes and events. */
  /** `failing`: the original panics (no error code to match), so only both failing is required. */
  const both = async (label: string, payer: KeyPairSigner, ixs: Instruction[], watch: Address[], failing = false) => {
    const [a, b] = [await send(original, payer, ixs), await send(d.svm, payer, ixs)];
    compared++;
    const logs = (r: Result) => meta(r).logs().join("\n");
    if (failing) {
      expect(a instanceof FailedTransactionMetadata && b instanceof FailedTransactionMetadata, `${label}\noriginal:\n${logs(a)}\nTypeSOL:\n${logs(b)}`).toBe(true);
      for (const w of watch) expect(bytes(d.svm, w), `${label}: ${w}`).toBe(bytes(original, w));
      return "failed";
    }
    expect(outcome(b), `${label}\noriginal:\n${logs(a)}\nTypeSOL:\n${logs(b)}`).toBe(outcome(a));
    for (const w of watch) expect(bytes(d.svm, w), `${label}: ${w}`).toBe(bytes(original, w));
    if (!(a instanceof FailedTransactionMetadata)) expect(events(b), `${label}: events`).toEqual(events(a));
    cu[label] = [meta(a).computeUnitsConsumed(), meta(b).computeUnitsConsumed()];
    return outcome(a);
  };

  /** A mint of `program`, authority `payer`; Token-2022 extensions by name. */
  async function mint(payer: KeyPairSigner, program: Address, decimals: number, ext?: "fee" | "closeAuthority", freezeAuthority?: Address) {
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
      (program === TOKEN ? token.getInitializeMint2Instruction : t22.getInitializeMint2Instruction)({
        mint: m.address,
        decimals,
        mintAuthority: payer.address,
        ...(freezeAuthority ? { freezeAuthority } : {}),
      }) as Instruction,
    ]);
    return { address: m.address, program };
  }
  type MintInfo = Awaited<ReturnType<typeof mint>>;
  /** Two mints, ordered as a pool wants them (token_mint_0 < token_mint_1). */
  async function pair(payer: KeyPairSigner, p0: Address = TOKEN, p1: Address = TOKEN, ext1?: "fee" | "closeAuthority", freeze1?: Address) {
    const [a, b] = [await mint(payer, p0, 6), await mint(payer, p1, 9, ext1, freeze1)];
    return Buffer.compare(key(a.address), key(b.address)) < 0 ? [a, b] : [b, a];
  }

  /** An AmmConfig laid out as the original lays it out (Borsh), at its PDA ["amm_config", index BE]. */
  async function config(index: number, tickSpacing: number, tradeFee: number, owner?: Address) {
    const [at, bump] = await pda(PROGRAM, ["amm_config", be16(index)]);
    const data = Buffer.concat([
      disc("AmmConfig"),
      Buffer.from([bump]),
      u16(index),
      key(owner ?? address("projjosVCPQH49d5em7VYS7fJZzaqKixqKtus7yk416")),
      u32(120_000),
      u32(tradeFee),
      u16(tickSpacing),
      u32(40_000),
      u32(0),
      key(owner ?? address("FundHfY8oo8J9KYGyfXFFuQCHe7Z1VBNmsj84eMcdYs4")),
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

  // ---- positions ----------------------------------------------------------------------------------------------

  const ATA = address(token.ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
  const MEMO = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
  const be32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n);
    return b;
  };
  const startOf = (tick: number, spacing: number) => Math.floor(tick / (60 * spacing)) * 60 * spacing;
  const tickArray = async (pool: Address, start: number) => (await pda(PROGRAM, ["tick_array", pool, be32(start)]))[0];
  const ata = async (owner: Address, m: Address, program: Address) => (await token.findAssociatedTokenPda({ owner, mint: m, tokenProgram: program }))[0];

  /** A pool with a price, and a funded user holding both tokens (in associated token accounts). */
  async function poolWith(
    spacing: number,
    index: number,
    sqrt: bigint,
    programs: [Address, Address] = [TOKEN, TOKEN],
    ext1?: "fee",
    freeze1?: Address,
    given?: { user: KeyPairSigner; mints: [MintInfo, MintInfo] },
  ) {
    const user = given?.user ?? (await funded());
    const cfg = await config(index, spacing, 2500, user.address);
    const [m0, m1] = given?.mints ?? (await pair(user, programs[0], programs[1], ext1, freeze1));
    const p = await poolAccounts(cfg, m0, m1);
    expect(await both(`create_pool, spacing ${spacing}`, user, [createPool(user, cfg, m0, m1, p, sqrt)], watchPool(p))).toBe("ok");
    const acct0 = await ata(user.address, m0.address, m0.program);
    const acct1 = await ata(user.address, m1.address, m1.program);
    await setup(user, [
      token.getCreateAssociatedTokenIdempotentInstruction({ payer: user, ata: acct0, owner: user.address, mint: m0.address, tokenProgram: m0.program }),
      token.getCreateAssociatedTokenIdempotentInstruction({ payer: user, ata: acct1, owner: user.address, mint: m1.address, tokenProgram: m1.program }),
      { ...token.getMintToInstruction({ mint: m0.address, token: acct0, mintAuthority: user, amount: 10n ** 15n }), programAddress: m0.program },
      { ...token.getMintToInstruction({ mint: m1.address, token: acct1, mintAuthority: user, amount: 10n ** 15n }), programAddress: m1.program },
    ]);
    // The tick array starts positions may have created, for swaps to pass.
    const starts = new Set<number>();
    return { user, cfg, m0, m1, p, acct0, acct1, spacing, starts };
  }
  type Pool = Awaited<ReturnType<typeof poolWith>>;

  /** open_position_with_token22_nft; returns the instruction and the position's accounts. */
  async function openPosition(
    pool: Pool,
    lower: number,
    upper: number,
    liquidity: bigint,
    opts: { max0?: bigint; max1?: bigint; metadata?: boolean; base?: boolean | null; starts?: [number, number]; rest?: Meta[]; owner?: Address } = {},
  ) {
    const nft = await generateKeyPairSigner();
    const owner = opts.owner ?? pool.user.address;
    const [ls, us] = opts.starts ?? [startOf(lower, pool.spacing), startOf(upper, pool.spacing)];
    pool.starts.add(ls).add(us);
    const arrays = [await tickArray(pool.p.pool, ls), await tickArray(pool.p.pool, us)] as const;
    const [position] = await pda(PROGRAM, ["position", nft.address]);
    const nftAccount = await ata(owner, nft.address, TOKEN_2022);
    const instruction = ix(
      "open_position_with_token22_nft",
      {
        tick_lower_index: lower,
        tick_upper_index: upper,
        tick_array_lower_start_index: ls,
        tick_array_upper_start_index: us,
        liquidity: new BN(liquidity.toString()),
        amount_0_max: new BN((opts.max0 ?? 10n ** 14n).toString()),
        amount_1_max: new BN((opts.max1 ?? 10n ** 14n).toString()),
        with_metadata: opts.metadata ?? true,
        base_flag: opts.base ?? null,
      },
      [
        { address: pool.user.address, signer: pool.user, writable: true },
        { address: owner },
        { address: nft.address, signer: nft, writable: true },
        { address: nftAccount, writable: true },
        { address: pool.p.pool, writable: true },
        { address: PROGRAM },
        { address: arrays[0], writable: true },
        { address: arrays[1], writable: true },
        { address: position, writable: true },
        { address: pool.acct0, writable: true },
        { address: pool.acct1, writable: true },
        { address: pool.p.vault0, writable: true },
        { address: pool.p.vault1, writable: true },
        { address: RENT },
        { address: SYSTEM },
        { address: TOKEN },
        { address: ATA },
        { address: TOKEN_2022 },
        { address: pool.m0.address },
        { address: pool.m1.address },
        ...(opts.rest ?? []),
      ],
    );
    const watch = [pool.p.pool, pool.p.vault0, pool.p.vault1, pool.p.bitmap, pool.acct0, pool.acct1, ...arrays, position, nft.address, nftAccount];
    return { instruction, nft: nft.address, nftAccount, position, arrays, watch, lower, upper };
  }
  type Position = Awaited<ReturnType<typeof openPosition>>;

  const changeAccounts = (pool: Pool, pos: Position) => ({
    owner: { address: pool.user.address, signer: pool.user } as Meta,
    nft: { address: pos.nftAccount } as Meta,
  });
  const increase = (pool: Pool, pos: Position, liquidity: bigint, max0: bigint, max1: bigint, base: boolean | null = null, rest: Meta[] = []) =>
    ix(
      "increase_liquidity_v2",
      { liquidity: new BN(liquidity.toString()), amount_0_max: new BN(max0.toString()), amount_1_max: new BN(max1.toString()), base_flag: base },
      [
        changeAccounts(pool, pos).owner,
        changeAccounts(pool, pos).nft,
        { address: pool.p.pool, writable: true },
        { address: PROGRAM },
        { address: pos.position, writable: true },
        { address: pos.arrays[0], writable: true },
        { address: pos.arrays[1], writable: true },
        { address: pool.acct0, writable: true },
        { address: pool.acct1, writable: true },
        { address: pool.p.vault0, writable: true },
        { address: pool.p.vault1, writable: true },
        { address: TOKEN },
        { address: TOKEN_2022 },
        { address: pool.m0.address },
        { address: pool.m1.address },
        ...rest,
      ],
    );
  const decrease = (pool: Pool, pos: Position, liquidity: bigint, min0 = 0n, min1 = 0n, rest: Meta[] = []) =>
    ix(
      "decrease_liquidity_v2",
      { liquidity: new BN(liquidity.toString()), amount_0_min: new BN(min0.toString()), amount_1_min: new BN(min1.toString()) },
      [
        changeAccounts(pool, pos).owner,
        changeAccounts(pool, pos).nft,
        { address: pos.position, writable: true },
        { address: pool.p.pool, writable: true },
        { address: PROGRAM },
        { address: pool.p.vault0, writable: true },
        { address: pool.p.vault1, writable: true },
        { address: pos.arrays[0], writable: true },
        { address: pos.arrays[1], writable: true },
        { address: pool.acct0, writable: true },
        { address: pool.acct1, writable: true },
        { address: TOKEN },
        { address: TOKEN_2022 },
        { address: MEMO },
        { address: pool.m0.address },
        { address: pool.m1.address },
        ...rest,
      ],
    );
  /** The liquidity a position holds (PersonalPositionState.liquidity, at 8 + 1 + 32 + 32 + 4 + 4). */
  const positionLiquidity = (pos: Position) => {
    const b = Buffer.from(acct(original, pos.position).data);
    return b.readBigUInt64LE(81) | (b.readBigUInt64LE(89) << 64n);
  };
  /** Change PoolState bytes in both VMs. */
  const patchPool = (pool: Pool, edit: (b: Buffer) => void) => {
    for (const vm of vms()) {
      const a = vm.getAccount(pool.p.pool);
      if (!a.exists) throw new Error("no pool");
      const b = Buffer.from(a.data);
      edit(b);
      vm.setAccount({ ...a, address: pool.p.pool, data: new Uint8Array(b) } as never);
    }
  };
  const setTime = (unix: bigint) => {
    for (const vm of vms()) {
      const clock = vm.getClock();
      clock.unixTimestamp = unix;
      vm.setClock(clock);
    }
  };
  const writeU128 = (b: Buffer, at: number, v: bigint) => {
    b.writeBigUInt64LE(v & ((1n << 64n) - 1n), at);
    b.writeBigUInt64LE(v >> 64n, at + 8);
  };
  // PoolState offsets (with the discriminator): fee_growth_global_0_x64 277, _1 293, status 389, reward_infos 397 (169 bytes each).
  const POOL_FEE_GROWTH_0 = 277;
  const POOL_STATUS = 389;
  const POOL_REWARDS = 397;

  it("opens positions in range, below and above the price, in one tick array or two", async () => {
    // Spacing 60, price at tick 1234.
    const pool = await poolWith(60, 20, 19_574_085_512_633_416_581n);
    const cases: [string, number, number, bigint, Parameters<typeof openPosition>[4]][] = [
      ["in range", -600, 1800, 1_000_000_000n, {}],
      ["below the price", -7200, -3600, 2_000_000_000n, {}],
      ["above the price, one tick array", 3600, 4200, 3_000_000_000n, {}],
      ["below the minimum array", -443_580, -440_400, 1_000_000n, {}],
      ["sharing a tick", -600, 3600, 500_000_000n, { metadata: false }],
      ["no liquidity, no base_flag", -1200, 1200, 0n, {}],
      ["liquidity from amount_0", -1200, 1200, 0n, { base: true, max0: 1_000_000n }],
      ["liquidity from amount_1", -1200, 2400, 0n, { base: false, max1: 1_000_000n }],
    ];
    for (const [label, lower, upper, liquidity, opts] of cases) {
      const pos = await openPosition(pool, lower, upper, liquidity, opts);
      expect(await both(`open_position, ${label}`, pool.user, [pos.instruction], pos.watch)).toBe("ok");
    }
  });

  it("refuses bad positions as the original does", async () => {
    const pool = await poolWith(60, 21, 19_574_085_512_633_416_581n);
    const bad: [string, number, number, bigint, Parameters<typeof openPosition>[4], string | undefined][] = [
      ["ticks out of order", 1800, -600, 1_000n, {}, custom(errors.TickInvalidOrder!)],
      ["tick off the spacing", -590, 1800, 1_000n, {}, custom(2501)],
      ["wrong tick array start", -600, 1800, 1_000n, { starts: [0, 0] }, custom(2501)],
      ["tick below the minimum", -443_700, 1800, 1_000n, { starts: [-446_400, 0] }, custom(errors.TickLowerOverflow!)],
      ["slippage on token 0", -600, 1800, 1_000_000_000n, { max0: 10n }, custom(errors.PriceSlippageCheck!)],
      ["slippage on token 1", -600, 1800, 1_000_000_000n, { max1: 10n }, custom(errors.PriceSlippageCheck!)],
      ["zero liquidity from amounts", -600, 1800, 0n, { base: true, max0: 0n }, custom(errors.ZeroLiquidity!)],
    ];
    for (const [label, lower, upper, liquidity, opts, want] of bad) {
      const pos = await openPosition(pool, lower, upper, liquidity, opts);
      const out = await both(`open_position, ${label}`, pool.user, [pos.instruction], pos.watch);
      if (want) expect(out, label).toBe(want);
      else expect(out, label).not.toBe("ok");
    }
    // A closed pool (status bit 0) opens nothing.
    patchPool(pool, (b) => (b[POOL_STATUS] = 1));
    const pos = await openPosition(pool, -600, 1800, 1_000n);
    expect(await both("open_position, pool closed to new positions", pool.user, [pos.instruction], pos.watch)).toBe(custom(errors.NotApproved!));
  });

  it("adds and removes liquidity, down to an empty position", async () => {
    const pool = await poolWith(60, 22, 19_574_085_512_633_416_581n);
    const a = await openPosition(pool, -600, 1800, 1_000_000_000n);
    const b = await openPosition(pool, -600, 3600, 700_000_000n);
    for (const pos of [a, b]) expect(await both("open_position", pool.user, [pos.instruction], pos.watch)).toBe("ok");
    const watch = (pos: Position) => [...pos.watch, pool.acct0, pool.acct1];
    expect(await both("increase_liquidity", pool.user, [increase(pool, a, 250_000_000n, 10n ** 12n, 10n ** 12n)], watch(a))).toBe("ok");
    expect(await both("increase_liquidity, from amount_1", pool.user, [increase(pool, a, 0n, 10n ** 12n, 5_000_000n, false)], watch(a))).toBe("ok");
    expect(await both("increase_liquidity, from amount_0", pool.user, [increase(pool, b, 0n, 3_000_000n, 10n ** 12n, true)], watch(b))).toBe("ok");
    expect(await both("increase_liquidity, nothing", pool.user, [increase(pool, b, 0n, 10n ** 12n, 10n ** 12n)], watch(b))).toBe(custom(errors.MissingBaseFlag!));
    expect(await both("increase_liquidity, slippage", pool.user, [increase(pool, a, 250_000_000n, 1n, 10n ** 12n)], watch(a))).toBe(
      custom(errors.PriceSlippageCheck!),
    );
    expect(await both("decrease_liquidity, half", pool.user, [decrease(pool, a, positionLiquidity(a) / 2n)], watch(a))).toBe("ok");
    expect(await both("decrease_liquidity, too much", pool.user, [decrease(pool, a, positionLiquidity(a) + 1n)], watch(a))).toBe(custom(2506));
    expect(await both("decrease_liquidity, slippage", pool.user, [decrease(pool, a, 1_000n, 10n ** 12n)], watch(a))).toBe(custom(errors.PriceSlippageCheck!));
    expect(await both("decrease_liquidity, all", pool.user, [decrease(pool, a, positionLiquidity(a))], watch(a))).toBe("ok");
    expect(await both("decrease_liquidity, nothing left", pool.user, [decrease(pool, a, 0n)], watch(a))).toBe("ok");
    expect(await both("decrease_liquidity, the other, all", pool.user, [decrease(pool, b, positionLiquidity(b))], watch(b))).toBe("ok");
    // Both ticks in one array: added, then emptied (the array's count back to 0, its bit cleared).
    const c = await openPosition(pool, 3600, 4200, 400_000_000n);
    expect(await both("open_position, one tick array", pool.user, [c.instruction], c.watch)).toBe("ok");
    expect(await both("increase_liquidity, one tick array", pool.user, [increase(pool, c, 100_000_000n, 10n ** 12n, 10n ** 12n)], watch(c))).toBe("ok");
    expect(await both("decrease_liquidity, one tick array, all", pool.user, [decrease(pool, c, positionLiquidity(c))], watch(c))).toBe("ok");
    // Pool status bits: decrease liquidity off (fees still collected), then all three off.
    const e = await openPosition(pool, -1200, 1200, 300_000_000n);
    expect(await both("open_position", pool.user, [e.instruction], e.watch)).toBe("ok");
    patchPool(pool, (bytes) => (bytes[POOL_STATUS] = 2));
    expect(await both("decrease_liquidity, decreasing off", pool.user, [decrease(pool, e, 1_000n)], watch(e))).toBe("ok");
    patchPool(pool, (bytes) => (bytes[POOL_STATUS] = 14));
    expect(await both("decrease_liquidity, all off", pool.user, [decrease(pool, e, 1_000n)], watch(e))).toBe(custom(errors.NotApproved!));
    patchPool(pool, (bytes) => (bytes[POOL_STATUS] = 1));
    expect(await both("increase_liquidity, adding off", pool.user, [increase(pool, e, 1_000n, 10n ** 12n, 10n ** 12n)], watch(e))).toBe(custom(errors.NotApproved!));
    patchPool(pool, (bytes) => (bytes[POOL_STATUS] = 0));
    // Another position's tick arrays.
    const mixed = { ...e, arrays: c.arrays } as Position;
    expect(await both("increase_liquidity, wrong tick arrays", pool.user, [increase(pool, mixed, 1_000n, 10n ** 12n, 10n ** 12n)], watch(e))).toBe(
      custom(errors.InvalidTickArray!),
    );
    // Someone else's position NFT account.
    const other = await funded();
    const stolen = { ...decrease(pool, b, 0n), accounts: decrease(pool, b, 0n).accounts!.map((m, i) => (i === 0 ? { ...m, address: other.address, signer: other } : m)) };
    expect(await both("decrease_liquidity, not the owner", other, [stolen as Instruction], watch(b))).toBe(custom(2015));
  });

  it("pays fees and rewards a position earned", async () => {
    const pool = await poolWith(60, 23, 19_574_085_512_633_416_581n);
    const pos = await openPosition(pool, -600, 1800, 1_000_000_000_000n);
    expect(await both("open_position", pool.user, [pos.instruction], pos.watch)).toBe("ok");
    // Fees as swaps would have left them: fee growth in the pool, the tokens in the vaults.
    patchPool(pool, (b) => {
      writeU128(b, POOL_FEE_GROWTH_0, 1n << 56n);
      writeU128(b, POOL_FEE_GROWTH_0 + 16, 3n << 55n);
    });
    const before = Buffer.from(acct(original, pool.acct0).data).readBigUInt64LE(64);
    expect(await both("decrease_liquidity, fees only", pool.user, [decrease(pool, pos, 0n)], [...pos.watch])).toBe("ok");
    // 2^-8 of token 0 per unit of liquidity.
    expect(Buffer.from(acct(original, pool.acct0).data).readBigUInt64LE(64) - before).toBe(1_000_000_000_000n >> 8n);

    // A reward: mint and vault (owned by the pool), emitting 1,000 tokens a second from now.
    const rewardMint = await mint(pool.user, TOKEN, 6);
    const vault = (await generateKeyPairSigner());
    await setup(pool.user, [
      getCreateAccountInstruction({ payer: pool.user, newAccount: vault, lamports: original.minimumBalanceForRentExemption(165n), space: 165, programAddress: TOKEN }),
      token.getInitializeAccount3Instruction({ account: vault.address, mint: rewardMint.address, owner: pool.p.pool }),
      token.getMintToInstruction({ mint: rewardMint.address, token: vault.address, mintAuthority: pool.user, amount: 10n ** 12n }),
    ]);
    const recipient = await ata(pool.user.address, rewardMint.address, TOKEN);
    await setup(pool.user, [token.getCreateAssociatedTokenIdempotentInstruction({ payer: pool.user, ata: recipient, owner: pool.user.address, mint: rewardMint.address, tokenProgram: TOKEN })]);
    const start = 1_800_000_000n;
    patchPool(pool, (b) => {
      const r = POOL_REWARDS;
      b[r] = 1;
      b.writeBigUInt64LE(start, r + 1);
      b.writeBigUInt64LE(start + 1_000_000n, r + 9);
      b.writeBigUInt64LE(start, r + 17);
      writeU128(b, r + 25, 1000n << 64n);
      key(rewardMint.address).copy(b, r + 57);
      key(vault.address).copy(b, r + 89);
    });
    setTime(start + 100n);
    const groups: Meta[] = [{ address: vault.address, writable: true }, { address: recipient, writable: true }, { address: rewardMint.address }];
    expect(await both("increase_liquidity, rewards accrue", pool.user, [increase(pool, pos, 1_000_000n, 10n ** 12n, 10n ** 12n)], [...pos.watch])).toBe("ok");
    setTime(start + 250n);
    expect(await both("decrease_liquidity, without the reward accounts", pool.user, [decrease(pool, pos, 1_000n)], [...pos.watch])).toBe(
      custom(errors.InvalidRewardInputAccountNumber!),
    );
    expect(await both("decrease_liquidity, with rewards", pool.user, [decrease(pool, pos, 1_000n, 0n, 0n, groups)], [...pos.watch, vault.address, recipient])).toBe("ok");
    // Rewards were paid: 250 seconds at 1,000 a second, nearly all to this position.
    const paid = Buffer.from(acct(original, recipient).data).readBigUInt64LE(64);
    expect(paid).toBeGreaterThan(200_000n);
    expect(paid).toBeLessThanOrEqual(250_000n);
    setTime(1_800_000_000n);
  });

  it("marks tick arrays beyond the pool's bitmap in the extension", async () => {
    // Spacing 1: the pool's own bitmap covers ticks -30720..30720.
    const pool = await poolWith(1, 24, 18_446_744_073_709_551_616n);
    const ext = [{ address: pool.p.bitmap, writable: true }];
    const cases: [string, number, number][] = [
      ["both arrays beyond", 40_000, 40_100],
      ["one array beyond", -100, 40_000],
      ["below, beyond", -40_100, -40_000],
    ];
    const opened: Position[] = [];
    for (const [label, lower, upper] of cases) {
      const pos = await openPosition(pool, lower, upper, 1_000_000_000n, { rest: ext });
      expect(await both(`open_position, ${label}`, pool.user, [pos.instruction], pos.watch)).toBe("ok");
      opened.push(pos);
    }
    // The extension holds bits now (the pool's own bitmap only the one for -100's array).
    const extBits = Buffer.from(acct(original, pool.p.bitmap).data).subarray(40);
    expect(extBits.some((x) => x !== 0)).toBe(true);
    const missing = await openPosition(pool, 50_000, 50_100, 1_000_000_000n);
    // remaining_accounts[0] of none: the original panics.
    expect(await both("open_position, extension missing", pool.user, [missing.instruction], missing.watch, true)).toBe("failed");
    const wrong = await openPosition(pool, 50_000, 50_100, 1_000_000_000n, { rest: [{ address: pool.p.observation, writable: true }] });
    expect(await both("open_position, not the extension", pool.user, [wrong.instruction], wrong.watch)).toBe(custom(2502));
    for (const pos of opened) {
      expect(await both("increase_liquidity, extension", pool.user, [increase(pool, pos, 1_000n, 10n ** 12n, 10n ** 12n, null, ext)], pos.watch)).toBe("ok");
      expect(await both("decrease_liquidity, extension missing", pool.user, [decrease(pool, pos, positionLiquidity(pos))], pos.watch)).toBe(
        custom(errors.MissingTickArrayBitmapExtensionAccount!),
      );
      expect(await both("decrease_liquidity, all, extension", pool.user, [decrease(pool, pos, positionLiquidity(pos), 0n, 0n, ext)], pos.watch)).toBe("ok");
    }
    // Every position emptied: no array is marked any more.
    expect(Buffer.from(acct(original, pool.p.bitmap).data).subarray(40).every((x) => x === 0)).toBe(true);
  });

  it("opens positions in Token-2022 transfer-fee pools and restricted-asset pools", async () => {
    const fee = await poolWith(60, 25, 19_574_085_512_633_416_581n, [TOKEN, TOKEN_2022], "fee");
    const pos = await openPosition(fee, -600, 1800, 1_000_000_000_000n);
    expect(await both("open_position, transfer-fee mint", fee.user, [pos.instruction], pos.watch)).toBe("ok");
    const base = await openPosition(fee, -600, 1800, 0n, { base: false, max1: 2_000_000_000n });
    expect(await both("open_position, transfer-fee mint, from amount_1", fee.user, [base.instruction], base.watch)).toBe("ok");
    expect(await both("increase_liquidity, transfer-fee mint", fee.user, [increase(fee, pos, 10n ** 9n, 10n ** 13n, 10n ** 13n)], pos.watch)).toBe("ok");
    expect(await both("decrease_liquidity, transfer-fee mint", fee.user, [decrease(fee, pos, positionLiquidity(pos) / 3n)], pos.watch)).toBe("ok");
    expect(await both("decrease_liquidity, transfer-fee mint, slippage", fee.user, [decrease(fee, pos, 10n ** 9n, 0n, 10n ** 12n)], pos.watch)).toBe(
      custom(errors.PriceSlippageCheck!),
    );

    // A mint frozen by the restricted-asset authority: the position NFT account ends frozen.
    const restricted = await poolWith(60, 26, 19_574_085_512_633_416_581n, [TOKEN, TOKEN], undefined, address("2Yq4T3mPNfjtEyTxSbRjRKqLf1pwbTasuCQrWe6QpM7x"));
    const frozen = await openPosition(restricted, -600, 1800, 1_000_000n);
    expect(await both("open_position, restricted-asset pool", restricted.user, [frozen.instruction], frozen.watch)).toBe("ok");
    expect(Buffer.from(acct(d.svm, frozen.nftAccount).data)[108]).toBe(2);
  });

  it("opens a position whose tick array address someone pre-funded", async () => {
    const pool = await poolWith(60, 27, 19_574_085_512_633_416_581n);
    const pos = await openPosition(pool, -600, 1800, 1_000_000n);
    await setup(pool.user, [getTransferSolInstruction({ source: pool.user, destination: pos.arrays[0], amount: 1_000_000n })]);
    expect(await both("open_position, pre-funded tick array", pool.user, [pos.instruction], pos.watch)).toBe("ok");
  });

  // ---- swaps --------------------------------------------------------------------------------------------------

  /** Every tick array of a pool that exists, ordered for a swap in this direction. */
  const arraysFor = async (pool: Pool, zeroForOne: boolean) => {
    const found: [number, Address][] = [];
    for (const start of pool.starts) {
      const a = await tickArray(pool.p.pool, start);
      if (original.getAccount(a).exists) found.push([start, a]);
    }
    found.sort((x, y) => (zeroForOne ? y[0] - x[0] : x[0] - y[0]));
    return found.map(([, a]) => a);
  };
  const swap = async (
    pool: Pool,
    zeroForOne: boolean,
    amount: bigint,
    opts: { exactOut?: boolean; threshold?: bigint; limit?: bigint; arrays?: Address[]; ext?: boolean; payer?: KeyPairSigner } = {},
  ) => {
    const payer = opts.payer ?? pool.user;
    const [inMint, outMint] = zeroForOne ? [pool.m0, pool.m1] : [pool.m1, pool.m0];
    const [inAcct, outAcct] = zeroForOne ? [pool.acct0, pool.acct1] : [pool.acct1, pool.acct0];
    const [inVault, outVault] = zeroForOne ? [pool.p.vault0, pool.p.vault1] : [pool.p.vault1, pool.p.vault0];
    const arrays = opts.arrays ?? (await arraysFor(pool, zeroForOne));
    const instruction = ix(
      "swap_v2",
      {
        amount: new BN(amount.toString()),
        other_amount_threshold: new BN((opts.threshold ?? (opts.exactOut ? 2n ** 64n - 1n : 0n)).toString()),
        sqrt_price_limit_x64: new BN((opts.limit ?? 0n).toString()),
        is_base_input: !opts.exactOut,
      },
      [
        { address: payer.address, signer: payer },
        { address: pool.cfg },
        { address: pool.p.pool, writable: true },
        { address: inAcct, writable: true },
        { address: outAcct, writable: true },
        { address: inVault, writable: true },
        { address: outVault, writable: true },
        { address: pool.p.observation, writable: true },
        { address: TOKEN },
        { address: TOKEN_2022 },
        { address: MEMO },
        { address: inMint.address },
        { address: outMint.address },
        ...(opts.ext ? [{ address: pool.p.bitmap }] : []),
        ...arrays.map((a) => ({ address: a, writable: true })),
      ],
    );
    return { instruction, watch: [pool.p.pool, pool.p.vault0, pool.p.vault1, pool.acct0, pool.acct1, pool.p.observation, pool.p.bitmap, ...arrays] };
  };
  const swapBoth = async (label: string, pool: Pool, zeroForOne: boolean, amount: bigint, opts: Parameters<typeof swap>[3] = {}) => {
    const s = await swap(pool, zeroForOne, amount, opts);
    return both(label, opts.payer ?? pool.user, [s.instruction], s.watch);
  };
  const tickOf = (pool: Pool) => Buffer.from(acct(original, pool.p.pool).data).readInt32LE(269);
  /** A pool with positions around tick 1234 (spacing 60): in range, wide, and on both sides. */
  async function liquidPool(index: number, programs: [Address, Address] = [TOKEN, TOKEN], ext1?: "fee", given?: { user: KeyPairSigner; mints: [MintInfo, MintInfo] }) {
    const pool = await poolWith(60, index, 19_574_085_512_633_416_581n, programs, ext1, undefined, given);
    for (const [lower, upper, liquidity] of [
      [-600, 1800, 10n ** 12n],
      [-7200, 9000, 5n * 10n ** 11n],
      [1800, 5400, 3n * 10n ** 11n],
      [-3600, -1200, 4n * 10n ** 11n],
      [-30000, 30000, 10n ** 11n],
    ] as const) {
      const pos = await openPosition(pool, lower, upper, liquidity);
      expect(await both("open_position", pool.user, [pos.instruction], pos.watch)).toBe("ok");
    }
    return pool;
  }

  it("swaps both ways, exact input and exact output, across ticks and tick arrays", async () => {
    const pool = await liquidPool(30);
    const steps: [string, boolean, bigint, Parameters<typeof swap>[3]][] = [
      ["0 for 1, small", true, 1_000_000n, {}],
      ["0 for 1, across ticks", true, 30_000_000_000n, {}],
      ["1 for 0, exact output", false, 5_000_000_000n, { exactOut: true }],
      ["1 for 0, across arrays", false, 120_000_000_000n, {}],
      ["0 for 1, to a price limit", true, 10n ** 13n, { limit: 18_000_000_000_000_000_000n }],
      ["0 for 1, exact output", true, 2_000_000_000n, { exactOut: true }],
      ["1 for 0, tiny", false, 3n, {}],
    ];
    for (const [label, zeroForOne, amount, opts] of steps) {
      expect(await swapBoth(`swap, ${label}`, pool, zeroForOne, amount, opts)).toBe("ok");
      setTime(1_800_000_000n + BigInt(compared) * 20n);
    }
    expect(tickOf(pool)).not.toBe(1234);
    setTime(1_800_000_000n);
  });

  it("refuses bad swaps as the original does", async () => {
    const pool = await liquidPool(31);
    expect(await swapBoth("swap, too little out", pool, true, 1_000_000n, { threshold: 10n ** 12n })).toBe(custom(errors.TooLittleOutputReceived!));
    expect(await swapBoth("swap, too much in", pool, true, 1_000_000n, { exactOut: true, threshold: 1n })).toBe(custom(errors.TooMuchInputPaid!));
    expect(await swapBoth("swap, nothing", pool, true, 0n)).toBe(custom(errors.ZeroAmountSpecified!));
    expect(await swapBoth("swap, limit on the wrong side", pool, true, 1_000n, { limit: 30_000_000_000_000_000_000n })).toBe(custom(errors.SqrtPriceLimitOverflow!));
    expect(await swapBoth("swap, no tick arrays", pool, true, 1_000n, { arrays: [] })).toBe(custom(errors.NotEnoughTickArrayAccount!));
    const arrays = await arraysFor(pool, true);
    expect(await swapBoth("swap, wrong first array", pool, true, 1_000n, { arrays: arrays.slice(-1) })).toBe(custom(errors.InvalidFirstTickArrayAccount!));
    expect(await swapBoth("swap, arrays run out", pool, true, 10n ** 14n, { arrays: arrays.slice(0, 2) })).not.toBe("ok");
    expect(await swapBoth("swap, all liquidity and beyond", pool, true, 10n ** 16n)).not.toBe("ok");
    // The vaults the other way round.
    const s = await swap(pool, true, 1_000n);
    const flipped = { ...s.instruction, accounts: s.instruction.accounts!.map((m, i) => (i === 5 ? s.instruction.accounts![6]! : i === 6 ? s.instruction.accounts![5]! : m)) };
    expect(await both("swap, vaults swapped", pool.user, [flipped as Instruction], s.watch)).not.toBe("ok");
    patchPool(pool, (b) => (b[POOL_STATUS] = 16));
    expect(await swapBoth("swap, swaps off", pool, true, 1_000n)).toBe(custom(errors.NotApproved!));
    patchPool(pool, (b) => (b[POOL_STATUS] = 0));
  });

  it("charges fees on token 0 only or token 1 only, and pays protocol and fund fees out", async () => {
    const pool = await liquidPool(32);
    for (const feeOn of [1, 2]) {
      patchPool(pool, (b) => (b[POOL_STATUS + 1] = feeOn));
      expect(await swapBoth(`swap, fee on token ${feeOn - 1}, 0 for 1`, pool, true, 5_000_000_000n)).toBe("ok");
      expect(await swapBoth(`swap, fee on token ${feeOn - 1}, 1 for 0, exact output`, pool, false, 1_000_000_000n, { exactOut: true })).toBe("ok");
    }
    patchPool(pool, (b) => (b[POOL_STATUS + 1] = 0));
    const collect = (name: string, owner: KeyPairSigner, a0: bigint, a1: bigint) =>
      ix(name, { amount_0_requested: new BN(a0.toString()), amount_1_requested: new BN(a1.toString()) }, [
        { address: owner.address, signer: owner },
        { address: pool.p.pool, writable: true },
        { address: pool.cfg },
        { address: pool.p.vault0, writable: true },
        { address: pool.p.vault1, writable: true },
        { address: pool.m0.address },
        { address: pool.m1.address },
        { address: pool.acct0, writable: true },
        { address: pool.acct1, writable: true },
        { address: TOKEN },
        { address: TOKEN_2022 },
      ]);
    const watch = [pool.p.pool, pool.p.vault0, pool.p.vault1, pool.acct0, pool.acct1];
    const someone = await funded();
    for (const name of ["collect_protocol_fee", "collect_fund_fee"]) {
      expect(await both(`${name}, not the owner`, someone, [collect(name, someone, 1n, 1n)], watch)).toBe(custom(errors.NotApproved!));
      expect(await both(`${name}, some`, pool.user, [collect(name, pool.user, 1_000n, 0n)], watch)).toBe("ok");
      expect(await both(`${name}, the rest`, pool.user, [collect(name, pool.user, 2n ** 64n - 1n, 2n ** 64n - 1n)], watch)).toBe("ok");
    }
  });

  it("swaps with a dynamic fee, limit orders at a tick, rewards and the oracle", async () => {
    const pool = await liquidPool(33);
    // DynamicFeeInfo at 8 + 1 + 32 * 7 + 1 + 1 + 2 + 16 + 16 + 4 + 2 + 2 + 16 + 16 + 8 + 8 + 64 + 1 + 1 + 2 + 4 + 507 + 128 + 32 + 8 * 4.
    const DYNAMIC = 1096;
    patchPool(pool, (b) => {
      b.writeUInt16LE(10, DYNAMIC); // filter period
      b.writeUInt16LE(60, DYNAMIC + 2); // decay period
      b.writeUInt16LE(5000, DYNAMIC + 4); // reduction factor
      b.writeUInt32LE(80_000, DYNAMIC + 6); // dynamic fee control
      b.writeUInt32LE(350_000, DYNAMIC + 10); // max volatility accumulator
      b.writeInt32LE(20, DYNAMIC + 14); // tick spacing index reference (tick 1234 / 60)
    });
    for (const [label, zeroForOne, amount, t] of [
      ["dynamic fee, 0 for 1", true, 4_000_000_000n, 5n],
      ["dynamic fee, 1 for 0, soon after", false, 6_000_000_000n, 30n],
      ["dynamic fee, 0 for 1, after decay", true, 2_000_000_000n, 200n],
    ] as const) {
      setTime(1_800_000_000n + t);
      expect(await swapBoth(`swap, ${label}`, pool, zeroForOne, amount)).toBe("ok");
    }
    // The swaps moved the volatility accumulator (at +22) and stamped the update time (at +26).
    const dyn = Buffer.from(acct(original, pool.p.pool).data).subarray(DYNAMIC);
    expect(dyn.readUInt32LE(22)).toBeGreaterThan(0);
    expect(dyn.readBigUInt64LE(26)).toBeGreaterThan(0n);
    // The dynamic fee off again (it steps one tick spacing group at a time, too slow for the long swaps below).
    patchPool(pool, (b) => b.fill(0, DYNAMIC, DYNAMIC + 80));
    // Limit orders on a used tick below the price: 2,000,000 of token 1 for sale at tick -600.
    const below = await tickArray(pool.p.pool, -3600);
    for (const vm of vms()) {
      const a = vm.getAccount(below);
      if (!a.exists) throw new Error("no array");
      const b = Buffer.from(a.data);
      const slot = 8 + 32 + 4 + ((-600 - -3600) / 60) * 168;
      b.writeBigUInt64LE(2_000_000n, slot + 4 + 16 * 7 + 8);
      vm.setAccount({ ...a, address: below, data: new Uint8Array(b) } as never);
    }
    // A reward stream running since t+250 (only its mint is needed to accrue), so crossing ticks moves reward growth too.
    const rewardMint = await mint(pool.user, TOKEN, 6);
    patchPool(pool, (b) => {
      b[POOL_REWARDS] = 1;
      b.writeBigUInt64LE(1_800_000_250n, POOL_REWARDS + 1);
      b.writeBigUInt64LE(1_900_000_000n, POOL_REWARDS + 9);
      b.writeBigUInt64LE(1_800_000_250n, POOL_REWARDS + 17);
      writeU128(b, POOL_REWARDS + 25, 777n << 64n);
      key(rewardMint.address).copy(b, POOL_REWARDS + 57);
    });
    setTime(1_800_000_300n);
    expect(await swapBoth("swap, through limit orders", pool, true, 200_000_000_000n)).toBe("ok");
    // The orders were filled: none left unfilled, a new order phase.
    const slotAt = 8 + 32 + 4 + ((-600 - -3600) / 60) * 168;
    const filled = Buffer.from(acct(original, below).data).subarray(slotAt);
    expect([filled.readBigUInt64LE(124), filled.readBigUInt64LE(132), filled.readBigUInt64LE(116)]).toEqual([0n, 0n, 1n]);
    expect(await swapBoth("swap, back up", pool, false, 300_000_000_000n)).toBe("ok");
    // Orders alone on a fresh tick (-1800, no liquidity): filled in full, the tick is no longer in use, its array counts one less.
    const fresh = 8 + 32 + 4 + ((-1800 - -3600) / 60) * 168;
    const countAt = 8 + 32 + 4 + 60 * 168;
    let countBefore = 0;
    for (const vm of vms()) {
      const a = vm.getAccount(below);
      if (!a.exists) throw new Error("no array");
      const b = Buffer.from(a.data);
      b.writeInt32LE(-1800, fresh);
      b.writeBigUInt64LE(500_000n, fresh + 124);
      b[countAt] += 1;
      countBefore = b[countAt]!;
      vm.setAccount({ ...a, address: below, data: new Uint8Array(b) } as never);
    }
    expect(await swapBoth("swap, orders alone on a tick", pool, true, 300_000_000_000n)).toBe("ok");
    expect(tickOf(pool)).toBeLessThan(-1800);
    const after = Buffer.from(acct(original, below).data);
    expect([after.readBigUInt64LE(fresh + 124), after.readBigUInt64LE(fresh + 132), after[countAt]]).toEqual([0n, 0n, countBefore - 1]);
    setTime(1_800_000_000n);
  });

  it("swaps into tick arrays marked in the bitmap extension", async () => {
    // Spacing 1, price at tick 0; positions far above, so the swap leaves the pool's own bitmap.
    const pool = await poolWith(1, 34, 18_446_744_073_709_551_616n);
    for (const [lower, upper] of [
      [-60, 60],
      [-60, 40_000],
      [39_000, 41_000],
    ] as const) {
      const pos = await openPosition(pool, lower, upper, 10n ** 11n, { rest: [{ address: pool.p.bitmap, writable: true }] });
      expect(await both("open_position", pool.user, [pos.instruction], pos.watch)).toBe("ok");
    }
    // Up to about tick 40,500 (1.0001^(40500/2) * 2^64).
    const limit = BigInt(Math.floor(Math.sqrt(1.0001 ** 40_500) * 2 ** 32)) << 32n;
    expect(await swapBoth("swap, up into the extension", pool, false, 10n ** 13n, { ext: true, limit })).toBe("ok");
    expect(tickOf(pool)).toBeGreaterThan(30_720);
    expect(await swapBoth("swap, extension missing", pool, true, 1_000_000n)).toBe(custom(errors.MissingTickArrayBitmapExtensionAccount!));
    expect(await swapBoth("swap, back down", pool, true, 10n ** 13n, { ext: true, limit: 18_446_744_073_709_551_616n })).toBe("ok");
    expect(tickOf(pool)).toBeLessThan(30_720);
    // The negative side: positions past -30,720, and a swap down into them and back.
    for (const [lower, upper] of [
      [-41_000, -39_000],
      [-40_000, 60],
    ] as const) {
      const pos = await openPosition(pool, lower, upper, 10n ** 11n, { rest: [{ address: pool.p.bitmap, writable: true }] });
      expect(await both("open_position, negative side", pool.user, [pos.instruction], pos.watch)).toBe("ok");
    }
    const down = BigInt(Math.floor(Math.sqrt(1.0001 ** -40_500) * 2 ** 32)) << 32n;
    expect(await swapBoth("swap, down into the extension", pool, true, 10n ** 13n, { ext: true, limit: down })).toBe("ok");
    expect(tickOf(pool)).toBeLessThan(-30_720);
    expect(await swapBoth("swap, back up from below", pool, false, 10n ** 13n, { ext: true, limit: 18_446_744_073_709_551_616n })).toBe("ok");
  });

  it("swaps in a Token-2022 transfer-fee pool", async () => {
    const pool = await liquidPool(35, [TOKEN, TOKEN_2022], "fee");
    expect(await swapBoth("swap, transfer-fee mint in", pool, false, 3_000_000_000n)).toBe("ok");
    expect(await swapBoth("swap, transfer-fee mint out", pool, true, 3_000_000_000n)).toBe("ok");
    expect(await swapBoth("swap, transfer-fee mint out, exact output", pool, true, 1_000_000_000n, { exactOut: true })).toBe("ok");
    expect(await swapBoth("swap, transfer-fee mint in, exact output", pool, false, 1_000_000_000n, { exactOut: true })).toBe("ok");
  });

  it("swaps in the USDC/CC pool as cloned from mainnet", async () => {
    const dir = fileURLToPath(new URL("../fixtures/clmm/mainnet/", import.meta.url));
    for (const f of readdirSync(dir)) {
      const j = JSON.parse(readFileSync(dir + f, "utf8")) as { address: string; data: string; lamports: string; owner?: string; programAddress?: string };
      const data = Buffer.from(j.data, "base64");
      for (const vm of vms())
        vm.setAccount({
          address: address(j.address),
          data: new Uint8Array(data),
          executable: false,
          lamports: lamports(BigInt(j.lamports)),
          programAddress: address((j.owner ?? j.programAddress)!),
          space: BigInt(data.length),
        });
    }
    const POOL = address("774uZXEhCJGqDYrZLLh3EUV6QDsBkeDzGp2gVhpdd9RU");
    const p = Buffer.from(acct(original, POOL).data);
    const at = (o: number) => address(getAddressDecoder().decode(p.subarray(o, o + 32)));
    const [cfg, m0, m1, v0, v1, obs] = [at(9), at(73), at(105), at(137), at(169), at(201)];
    // Token accounts holding both tokens, written as SPL Token lays them out.
    const user = await funded();
    const holding = async (m: Address) => {
      const k = (await generateKeyPairSigner()).address;
      const b = Buffer.alloc(165);
      key(m).copy(b, 0);
      key(user.address).copy(b, 32);
      b.writeBigUInt64LE(10n ** 12n, 64);
      b[108] = 1;
      for (const vm of vms())
        vm.setAccount({ address: k, data: new Uint8Array(b), executable: false, lamports: lamports(2_039_280n), programAddress: TOKEN, space: 165n });
      return k;
    };
    const [a0, a1] = [await holding(m0), await holding(m1)];
    const cloned = {
      user,
      cfg,
      m0: { address: m0, program: TOKEN },
      m1: { address: m1, program: TOKEN },
      p: { pool: POOL, vault0: v0, vault1: v1, observation: obs, bitmap: address("2Qd5cDYWSDJayz6MpQbPL8GGReFJYBv2sAzbXKkgqdNa") },
      acct0: a0,
      acct1: a1,
      spacing: p.readUInt16LE(235),
    } as unknown as Pool;
    const arrays = [address("Ew3kDkV2BBsPQHWzZUB627fWJr8K5jNVKKD2PpPJAsYG"), address("JzimDKzjjLujrUZk2CvF5EmbYa5komZsLeNbjb8NPNo")];
    for (const [label, zeroForOne, amount, exactOut] of [
      ["0 for 1", true, 1_000_000n, false],
      ["1 for 0", false, 1_000_000n, false],
      ["0 for 1, exact output", true, 500_000n, true],
    ] as const)
      expect(await swapBoth(`swap, mainnet USDC/CC pool, ${label}`, cloned, zeroForOne, amount, { arrays: zeroForOne ? arrays : [...arrays].reverse(), ext: true, exactOut })).toBe("ok");
  });

  // ---- admin, customizable pools, rewards ------------------------------------------------------------------------

  const pk = (a: Address) => new web3.PublicKey(a);
  const adminReady = () => {
    for (const vm of vms()) vm.airdrop(admin.address, lamports(100_000_000_000n));
    return admin;
  };
  const bytesAt = (a: Address) => Buffer.from(acct(original, a).data);

  it("runs the admin instructions: configs, operators, dynamic fee configs, support mints, pool status and owner", async () => {
    const a = adminReady();
    const someone = await funded();
    // create_amm_config and update_amm_config.
    const [cfg] = await pda(PROGRAM, ["amm_config", be16(90)]);
    const create = (signer: KeyPairSigner) =>
      ix("create_amm_config", { index: 90, tick_spacing: 10, trade_fee_rate: 2500, protocol_fee_rate: 120_000, fund_fee_rate: 40_000 }, [
        { address: signer.address, signer, writable: true },
        { address: cfg, writable: true },
        { address: SYSTEM },
      ]);
    expect(await both("create_amm_config, admin", a, [create(a)], [cfg])).toBe("ok");
    expect(await both("create_amm_config, again", a, [create(a)], [cfg])).toBe(custom(0));
    const update = (signer: KeyPairSigner, param: number, value: number, rest: Meta[] = []) =>
      ix("update_amm_config", { param, value }, [{ address: signer.address, signer }, { address: cfg, writable: true }, ...rest]);
    for (const [label, param, value, rest, want] of [
      ["trade fee", 0, 3000, [], "ok"],
      ["trade fee too high", 0, 1_000_000, [], custom(2505)],
      ["protocol fee", 1, 200_000, [], "ok"],
      ["protocol fee too high", 1, 970_000, [], custom(2506)],
      ["fund fee", 2, 50_000, [], "ok"],
      ["owner", 3, 0, [{ address: someone.address }], "ok"],
      ["owner, no account", 3, 0, [], custom(errors.AccountLack!)],
      ["fund owner", 4, 0, [{ address: someone.address }], "ok"],
      ["unknown flag", 9, 0, [], custom(errors.InvalidUpdateConfigFlag!)],
    ] as [string, number, number, Meta[], string][])
      expect(await both(`update_amm_config, ${label}`, a, [update(a, param, value, rest)], [cfg])).toBe(want);
    expect(await both("update_amm_config, not the admin", someone, [update(someone, 0, 10, [])], [cfg])).toBe(custom(errors.NotApproved!));

    // The operation account.
    const [operation] = await pda(PROGRAM, ["operation"]);
    const createOp = ix("create_operation_account", {}, [{ address: a.address, signer: a, writable: true }, { address: operation, writable: true }, { address: SYSTEM }]);
    expect(await both("create_operation_account", a, [createOp], [operation])).toBe("ok");
    const keys = await Promise.all([1, 2, 3, 4].map(async () => (await generateKeyPairSigner()).address));
    const updateOp = (param: number, list: Address[], signer = a) =>
      ix("update_operation_account", { param, keys: list.map(pk) }, [{ address: signer.address, signer }, { address: operation, writable: true }, { address: SYSTEM }]);
    for (const [label, param, list, want] of [
      ["add operators", 0, [keys[2]!, keys[0]!, keys[1]!], "ok"],
      ["add operators again, one new", 0, [keys[1]!, keys[3]!], "ok"],
      ["remove an operator", 1, [keys[0]!], "ok"],
      ["add a reward mint", 2, [keys[0]!], "ok"],
      ["remove the reward mint", 3, [keys[0]!], "ok"],
      ["unknown flag", 4, [], custom(errors.InvalidUpdateConfigFlag!)],
    ] as [string, number, Address[], string][])
      expect(await both(`update_operation_account, ${label}`, a, [updateOp(param, list)], [operation])).toBe(want);
    const eleven = await Promise.all(Array.from({ length: 11 }, async () => (await generateKeyPairSigner()).address));
    expect(await both("update_operation_account, more operators than fit", a, [updateOp(0, eleven)], [operation], true)).toBe("failed");
    expect(await both("update_operation_account, not the admin", someone, [updateOp(0, [someone.address], someone)], [operation])).toBe(
      custom(errors.NotApproved!),
    );

    // Dynamic fee configs.
    const [dyn] = await pda(PROGRAM, ["dynamic_fee_config", be16(3)]);
    const dynArgs = { filter_period: 10, decay_period: 60, reduction_factor: 5000, dynamic_fee_control: 80_000, max_volatility_accumulator: 350_000 };
    const createDyn = (args: typeof dynArgs) =>
      ix("create_dynamic_fee_config", { index: 3, ...args }, [{ address: a.address, signer: a, writable: true }, { address: dyn, writable: true }, { address: SYSTEM }]);
    expect(await both("create_dynamic_fee_config, bad parameters", a, [createDyn({ ...dynArgs, decay_period: 5 })], [dyn])).toBe(
      custom(errors.InvalidDynamicFeeConfigParams!),
    );
    expect(await both("create_dynamic_fee_config", a, [createDyn(dynArgs)], [dyn])).toBe("ok");
    const updateDyn = (args: typeof dynArgs) => ix("update_dynamic_fee_config", args, [{ address: a.address, signer: a }, { address: dyn, writable: true }]);
    expect(await both("update_dynamic_fee_config", a, [updateDyn({ ...dynArgs, filter_period: 20 })], [dyn])).toBe("ok");
    expect(await both("update_dynamic_fee_config, bad parameters", a, [updateDyn({ ...dynArgs, reduction_factor: 10_000 })], [dyn])).toBe(
      custom(errors.InvalidDynamicFeeConfigParams!),
    );

    // Support mints: a Token-2022 mint with an extension pools refuse, allowed, then not.
    const odd = await mint(someone, TOKEN_2022, 6, "closeAuthority");
    const [assoc] = await pda(PROGRAM, ["support_mint", odd.address]);
    const supportIx = (name: string, signer: KeyPairSigner, m: Address) =>
      ix(name, {}, [
        { address: signer.address, signer, writable: true },
        { address: m },
        { address: (name === "create_support_mint_associated" || m === odd.address ? assoc : assoc), writable: true },
        ...(name === "create_support_mint_associated" ? [{ address: SYSTEM }] : []),
      ]);
    expect(await both("create_support_mint_associated, not allowed", someone, [supportIx("create_support_mint_associated", someone, odd.address)], [assoc])).toBe(
      custom(errors.NotApproved!),
    );
    const legacy = await mint(someone, TOKEN, 6);
    expect(await both("create_support_mint_associated, an SPL Token mint", a, [supportIx("create_support_mint_associated", a, legacy.address)], [assoc])).not.toBe("ok");
    expect(await both("create_support_mint_associated", a, [supportIx("create_support_mint_associated", a, odd.address)], [assoc])).toBe("ok");
    // A pool of it, now allowed with the associated account passed.
    const cfg2 = await config(91, 10, 500);
    const other = await mint(someone, TOKEN, 9);
    const [n0, n1] = Buffer.compare(key(odd.address), key(other.address)) < 0 ? [odd, other] : [other, odd];
    const q = await poolAccounts(cfg2, n0, n1);
    const plain = createPool(someone, cfg2, n0, n1, q, 18_446_744_073_709_551_616n);
    const withAssoc = { ...plain, accounts: [...plain.accounts!, { address: assoc, role: AccountRole.READONLY }] } as Instruction;
    expect(await both("create_pool, allowed Token-2022 mint", someone, [withAssoc], watchPool(q))).toBe("ok");
    expect(await both("close_support_mint_associated", a, [supportIx("close_support_mint_associated", a, odd.address)], [assoc, a.address])).toBe("ok");

    // Pool status, reward owner, a protocol position.
    const pool = await poolWith(10, 92, 18_446_744_073_709_551_616n);
    const status = (s: number, signer = a) => ix("update_pool_status", { status: s }, [{ address: signer.address, signer }, { address: pool.p.pool, writable: true }]);
    expect(await both("update_pool_status", a, [status(16)], [pool.p.pool])).toBe("ok");
    expect(await both("update_pool_status, not the admin", someone, [status(0, someone)], [pool.p.pool])).toBe(custom(2012));
    expect(await both("update_pool_status, back", a, [status(0)], [pool.p.pool])).toBe("ok");
    const transfer = (signer: KeyPairSigner) =>
      ix("transfer_reward_owner", { new_owner: pk(someone.address) }, [{ address: signer.address, signer }, { address: pool.p.pool, writable: true }]);
    expect(await both("transfer_reward_owner", a, [transfer(a)], [pool.p.pool])).toBe("ok");
    expect(await both("transfer_reward_owner, not the admin", someone, [transfer(someone)], [pool.p.pool])).toBe(custom(errors.NotApproved!));
    const protocolPosition = (await generateKeyPairSigner()).address;
    const pp = Buffer.concat([disc("ProtocolPositionState"), Buffer.alloc(217)]);
    for (const vm of vms())
      vm.setAccount({ address: protocolPosition, data: new Uint8Array(pp), executable: false, lamports: lamports(5_000_000n), programAddress: PROGRAM, space: BigInt(pp.length) });
    expect(await both("close_protocol_position", a, [ix("close_protocol_position", {}, [{ address: a.address, signer: a, writable: true }, { address: protocolPosition, writable: true }])], [protocolPosition, a.address])).toBe("ok");

    // Lamports above rent: on the pool, a vault and the observation account.
    await setup(someone, [
      getTransferSolInstruction({ source: someone, destination: pool.p.pool, amount: 7_000n }),
      getTransferSolInstruction({ source: someone, destination: pool.p.vault0, amount: 9_000n }),
      getTransferSolInstruction({ source: someone, destination: pool.p.observation, amount: 11_000n }),
    ]);
    const collectLamports = (signer: KeyPairSigner) =>
      ix("collect_excess_lamports", {}, [
        { address: signer.address, signer, writable: true },
        { address: pool.p.pool, writable: true },
        { address: TOKEN },
        { address: TOKEN_2022 },
        { address: pool.p.vault0, writable: true },
        { address: pool.p.observation, writable: true },
      ]);
    expect(await both("collect_excess_lamports, not allowed", someone, [collectLamports(someone)], [pool.p.pool])).toBe(custom(errors.NotApproved!));
    expect(await both("collect_excess_lamports", a, [collectLamports(a)], [pool.p.pool, pool.p.vault0, pool.p.observation, a.address])).toBe("ok");
  });

  it("creates customizable pools: fee modes, a dynamic fee, seed indexes", async () => {
    const a = adminReady();
    const creator = await funded();
    const cfg = await config(93, 10, 2500, creator.address);
    const [dyn] = await pda(PROGRAM, ["dynamic_fee_config", be16(4)]);
    expect(
      await both(
        "create_dynamic_fee_config",
        a,
        [
          ix("create_dynamic_fee_config", { index: 4, filter_period: 10, decay_period: 60, reduction_factor: 5000, dynamic_fee_control: 80_000, max_volatility_accumulator: 350_000 }, [
            { address: a.address, signer: a, writable: true },
            { address: dyn, writable: true },
            { address: SYSTEM },
          ]),
        ],
        [dyn],
      ),
    ).toBe("ok");
    const [m0, m1] = await pair(creator);
    const params = (feeOn: number, dynamic: boolean) => ({
      sqrt_price_x64: new BN("19574085512633416581"),
      collect_fee_on: [{ FromInput: {} }, { Token0Only: {} }, { Token1Only: {} }][feeOn],
      enable_dynamic_fee: dynamic,
    });
    const accountsFor = async (seedIndex: number | null) => {
      const seeds: (string | Address | Uint8Array)[] = ["pool", cfg, m0.address, m1.address];
      if (seedIndex !== null) seeds.push(u16(seedIndex));
      const [pool] = await pda(PROGRAM, seeds);
      const [vault0] = await pda(PROGRAM, ["pool_vault", pool, m0.address]);
      const [vault1] = await pda(PROGRAM, ["pool_vault", pool, m1.address]);
      const [observation] = await pda(PROGRAM, ["observation", pool]);
      const [bitmap] = await pda(PROGRAM, [Buffer.from("pool_tick_array_bitmap_extension"), pool]);
      return { pool, vault0, vault1, observation, bitmap };
    };
    const tail = (p: Awaited<ReturnType<typeof accountsFor>>) => [
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
    ];
    const v1 = await accountsFor(null);
    expect(
      await both(
        "create_customizable_pool, fee on token 1, dynamic fee",
        creator,
        [ix("create_customizable_pool", { customizable_params: params(2, true) }, [{ address: creator.address, signer: creator, writable: true }, ...tail(v1), { address: dyn }])],
        watchPool(v1),
      ),
    ).toBe("ok");
    const v2 = await accountsFor(7);
    const createV2 = (seedIndex: number, p: Awaited<ReturnType<typeof accountsFor>>, dynamic = false) =>
      ix("create_customizable_pool_v2", { customizable_params: params(1, dynamic), seed_index: seedIndex }, [
        { address: creator.address, signer: creator, writable: true },
        { address: a.address },
        ...tail(p),
        ...(dynamic ? [] : []),
      ]);
    expect(await both("create_customizable_pool_v2, seed index 7", creator, [createV2(7, v2)], watchPool(v2))).toBe("ok");
    const v0 = await accountsFor(0);
    expect(await both("create_customizable_pool_v2, seed index 0", creator, [createV2(0, v0)], watchPool(v0))).toBe(custom(2505));
    const v3 = await accountsFor(8);
    expect(await both("create_customizable_pool_v2, dynamic fee without its config", creator, [createV2(8, v3, true)], watchPool(v3))).toBe(
      custom(errors.AccountLack!),
    );

    // The seeded pool works: a position and swaps, signed by the pool with its seed index.
    const acct0 = await ata(creator.address, m0.address, TOKEN);
    const acct1 = await ata(creator.address, m1.address, TOKEN);
    await setup(creator, [
      token.getCreateAssociatedTokenIdempotentInstruction({ payer: creator, ata: acct0, owner: creator.address, mint: m0.address, tokenProgram: TOKEN }),
      token.getCreateAssociatedTokenIdempotentInstruction({ payer: creator, ata: acct1, owner: creator.address, mint: m1.address, tokenProgram: TOKEN }),
      token.getMintToInstruction({ mint: m0.address, token: acct0, mintAuthority: creator, amount: 10n ** 15n }),
      token.getMintToInstruction({ mint: m1.address, token: acct1, mintAuthority: creator, amount: 10n ** 15n }),
    ]);
    const seeded = { user: creator, cfg, m0, m1, p: v2, acct0, acct1, spacing: 10, starts: new Set<number>() } as Pool;
    const pos = await openPosition(seeded, -600, 1800, 10n ** 11n);
    expect(await both("open_position, seeded pool", creator, [pos.instruction], pos.watch)).toBe("ok");
    expect(await swapBoth("swap, seeded pool", seeded, true, 1_000_000_000n)).toBe("ok");
    expect(await both("decrease_liquidity, seeded pool", creator, [decrease(seeded, pos, positionLiquidity(pos) / 2n)], pos.watch)).toBe("ok");
    expect(bytesAt(v2.pool).readUInt16LE(391)).toBe(7);
  });

  it("runs reward streams: set up, changed, paid, and what is left returned", async () => {
    const a = adminReady();
    const pool = await poolWith(10, 94, 18_446_744_073_709_551_616n);
    const [operation] = await pda(PROGRAM, ["operation"]);
    if (!original.getAccount(operation).exists)
      await both("create_operation_account", a, [ix("create_operation_account", {}, [{ address: a.address, signer: a, writable: true }, { address: operation, writable: true }, { address: SYSTEM }])], [operation]);
    const pos = await openPosition(pool, -600, 600, 10n ** 12n);
    expect(await both("open_position", pool.user, [pos.instruction], pos.watch)).toBe("ok");
    // The reward is token 1 of the pool (allowed as the first reward), funded by the pool's creator.
    const [vault] = await pda(PROGRAM, ["pool_reward_vault", pool.p.pool, pool.m1.address]);
    const start = 1_800_000_000n;
    const init = (open: bigint, end: bigint, emissions: bigint) =>
      ix("initialize_reward", { param: { open_time: new BN(open.toString()), end_time: new BN(end.toString()), emissions_per_second_x64: new BN(emissions.toString()) } }, [
        { address: pool.user.address, signer: pool.user, writable: true },
        { address: pool.acct1, writable: true },
        { address: pool.cfg },
        { address: pool.p.pool, writable: true },
        { address: operation },
        { address: pool.m1.address },
        { address: vault, writable: true },
        { address: pool.m1.program },
        { address: SYSTEM },
        { address: RENT },
      ]);
    const week = 604_800n;
    const watch = [pool.p.pool, vault, pool.acct1];
    expect(await both("initialize_reward, too short", pool.user, [init(start + 10n, start + 10n + week - 1n, 10n << 64n)], watch)).toBe(custom(errors.InvalidRewardPeriod!));
    expect(await both("initialize_reward, in the past", pool.user, [init(start - 10n, start + week, 10n << 64n)], watch)).toBe(custom(errors.InvalidRewardInitParam!));
    expect(await both("initialize_reward", pool.user, [init(start + 10n, start + 10n + week, 10n << 64n)], watch)).toBe("ok");
    expect(await both("initialize_reward, the same mint again", pool.user, [init(start + 10n, start + 10n + week, 10n << 64n)], watch)).not.toBe("ok");
    const update = ix("update_reward_infos", {}, [{ address: pool.p.pool, writable: true }]);
    setTime(start + 3_600n);
    expect(await both("update_reward_infos", pool.user, [update], [pool.p.pool])).toBe("ok");
    // The admin raises the emissions; the reward added comes from the admin's account.
    const adminAcct = await ata(a.address, pool.m1.address, TOKEN);
    await setup(pool.user, [
      token.getCreateAssociatedTokenIdempotentInstruction({ payer: pool.user, ata: adminAcct, owner: a.address, mint: pool.m1.address, tokenProgram: TOKEN }),
      token.getMintToInstruction({ mint: pool.m1.address, token: adminAcct, mintAuthority: pool.user, amount: 10n ** 13n }),
    ]);
    const setParams = (signer: KeyPairSigner, emissions: bigint, open: bigint, end: bigint, from: Address) =>
      ix("set_reward_params", { reward_index: 0, emissions_per_second_x64: new BN(emissions.toString()), open_time: new BN(open.toString()), end_time: new BN(end.toString()) }, [
        { address: signer.address, signer },
        { address: pool.cfg },
        { address: pool.p.pool, writable: true },
        { address: operation },
        { address: TOKEN },
        { address: TOKEN_2022 },
        { address: vault, writable: true },
        { address: from, writable: true },
        { address: pool.m1.address },
      ]);
    expect(await both("set_reward_params, admin", a, [setParams(a, 20n << 64n, start + 4_000n, start + 10n + 2n * week, adminAcct)], [...watch, adminAcct])).toBe("ok");
    expect(await both("set_reward_params, authority, too short an extension", pool.user, [setParams(pool.user, 20n << 64n, start + 4_000n, start + 10n + 2n * week + 100n, pool.acct1)], watch)).toBe(
      custom(errors.NotApproveUpdateRewardEmissions!),
    );
    expect(await both("set_reward_params, authority, extended", pool.user, [setParams(pool.user, 25n << 64n, start + 4_000n, start + 10n + 3n * week, pool.acct1)], watch)).toBe("ok");
    setTime(start + 10_000n);
    const rewardAcct = pool.acct1;
    expect(
      await both("decrease_liquidity, with the reward", pool.user, [decrease(pool, pos, 1_000n, 0n, 0n, [{ address: vault, writable: true }, { address: rewardAcct, writable: true }, { address: pool.m1.address }])], [
        ...pos.watch,
        vault,
      ]),
    ).toBe("ok");
    const collect = ix("collect_remaining_rewards", { reward_index: 0 }, [
      { address: pool.user.address, signer: pool.user },
      { address: pool.acct1, writable: true },
      { address: pool.p.pool, writable: true },
      { address: vault, writable: true },
      { address: pool.m1.address },
      { address: TOKEN },
      { address: TOKEN_2022 },
      { address: MEMO },
    ]);
    expect(await both("collect_remaining_rewards, still running", pool.user, [collect], watch)).toBe(custom(errors.NotApproved!));
    setTime(start + 10n + 4n * week);
    expect(await both("collect_remaining_rewards", pool.user, [collect], watch)).toBe("ok");
    setTime(start);
  });

  // ---- v1 / v2 positions, closing ------------------------------------------------------------------------------

  /** open_position (v1) or open_position_v2: a Metaplex NFT. */
  async function openMetaplex(pool: Pool, lower: number, upper: number, liquidity: bigint, v2?: { metadata: boolean; base: boolean | null; max0?: bigint; max1?: bigint }) {
    const nft = await generateKeyPairSigner();
    const [ls, us] = [startOf(lower, pool.spacing), startOf(upper, pool.spacing)];
    pool.starts.add(ls).add(us);
    const arrays = [await tickArray(pool.p.pool, ls), await tickArray(pool.p.pool, us)] as const;
    const [position] = await pda(PROGRAM, ["position", nft.address]);
    const nftAccount = await ata(pool.user.address, nft.address, TOKEN);
    const [metadata] = await pda(METADATA, ["metadata", METADATA, nft.address]);
    const args = {
      tick_lower_index: lower,
      tick_upper_index: upper,
      tick_array_lower_start_index: ls,
      tick_array_upper_start_index: us,
      liquidity: new BN(liquidity.toString()),
      amount_0_max: new BN((v2?.max0 ?? 10n ** 14n).toString()),
      amount_1_max: new BN((v2?.max1 ?? 10n ** 14n).toString()),
      ...(v2 ? { with_metadata: v2.metadata, base_flag: v2.base } : {}),
    };
    const instruction = ix(v2 ? "open_position_v2" : "open_position", args, [
      { address: pool.user.address, signer: pool.user, writable: true },
      { address: pool.user.address },
      { address: nft.address, signer: nft, writable: true },
      { address: nftAccount, writable: true },
      { address: metadata, writable: true },
      { address: pool.p.pool, writable: true },
      { address: PROGRAM },
      { address: arrays[0], writable: true },
      { address: arrays[1], writable: true },
      { address: position, writable: true },
      { address: pool.acct0, writable: true },
      { address: pool.acct1, writable: true },
      { address: pool.p.vault0, writable: true },
      { address: pool.p.vault1, writable: true },
      { address: RENT },
      { address: SYSTEM },
      { address: TOKEN },
      { address: ATA },
      { address: METADATA },
      ...(v2 ? [{ address: TOKEN_2022 }, { address: pool.m0.address }, { address: pool.m1.address }] : []),
    ]);
    const watch = [pool.p.pool, pool.p.vault0, pool.p.vault1, pool.acct0, pool.acct1, ...arrays, position, nft.address, nftAccount, metadata];
    return { instruction, nft: nft.address, nftAccount, position, arrays, watch, lower, upper };
  }
  const v1Accounts = (pool: Pool, pos: Position, decrease: boolean) =>
    decrease
      ? [
          { address: pool.user.address, signer: pool.user },
          { address: pos.nftAccount },
          { address: pos.position, writable: true },
          { address: pool.p.pool, writable: true },
          { address: PROGRAM },
          { address: pool.p.vault0, writable: true },
          { address: pool.p.vault1, writable: true },
          { address: pos.arrays[0], writable: true },
          { address: pos.arrays[1], writable: true },
          { address: pool.acct0, writable: true },
          { address: pool.acct1, writable: true },
          { address: TOKEN },
        ]
      : [
          { address: pool.user.address, signer: pool.user },
          { address: pos.nftAccount },
          { address: pool.p.pool, writable: true },
          { address: PROGRAM },
          { address: pos.position, writable: true },
          { address: pos.arrays[0], writable: true },
          { address: pos.arrays[1], writable: true },
          { address: pool.acct0, writable: true },
          { address: pool.acct1, writable: true },
          { address: pool.p.vault0, writable: true },
          { address: pool.p.vault1, writable: true },
          { address: TOKEN },
        ];
  const closePosition = (pool: Pool, pos: Position, program: Address, rest: Meta[] = []) =>
    ix("close_position", {}, [
      { address: pool.user.address, signer: pool.user, writable: true },
      { address: pos.nft, writable: true },
      { address: pos.nftAccount, writable: true },
      { address: pos.position, writable: true },
      { address: SYSTEM },
      { address: program },
      ...rest,
    ]);

  it("opens Metaplex-NFT positions (v1, v2), changes them with the v1 instructions, and closes positions", async () => {
    const pool = await liquidPool(40);
    const v1 = await openMetaplex(pool, -600, 1800, 10n ** 11n);
    expect(await both("open_position (v1, Metaplex)", pool.user, [v1.instruction], v1.watch)).toBe("ok");
    const v2a = await openMetaplex(pool, -1200, 1200, 10n ** 11n, { metadata: true, base: null });
    expect(await both("open_position_v2, metadata", pool.user, [v2a.instruction], v2a.watch)).toBe("ok");
    const v2b = await openMetaplex(pool, -1200, 2400, 0n, { metadata: false, base: true, max0: 5_000_000n });
    expect(await both("open_position_v2, no metadata, from amount_0", pool.user, [v2b.instruction], v2b.watch)).toBe("ok");
    const w = (pos: Position) => [...pos.watch, pool.acct0, pool.acct1];
    const inc = (pos: Position, liquidity: bigint, max = 10n ** 12n) =>
      ix("increase_liquidity", { liquidity: new BN(liquidity.toString()), amount_0_max: new BN(max.toString()), amount_1_max: new BN(max.toString()) }, v1Accounts(pool, pos, false));
    expect(await both("increase_liquidity (v1)", pool.user, [inc(v1, 5n * 10n ** 10n)], w(v1))).toBe("ok");
    expect(await both("increase_liquidity (v1), nothing", pool.user, [inc(v1, 0n)], w(v1))).toBe(custom(2505));
    expect(await both("increase_liquidity (v1), slippage", pool.user, [inc(v1, 5n * 10n ** 10n, 10n)], w(v1))).toBe(custom(errors.PriceSlippageCheck!));
    const dec = (pos: Position, liquidity: bigint) =>
      ix("decrease_liquidity", { liquidity: new BN(liquidity.toString()), amount_0_min: new BN(0), amount_1_min: new BN(0) }, v1Accounts(pool, pos, true));
    expect(await both("decrease_liquidity (v1), half", pool.user, [dec(v1, positionLiquidity(v1) / 2n)], w(v1))).toBe("ok");
    // Swaps earn the position fees; it cannot close until they are paid out with its liquidity.
    expect(await swapBoth("swap", pool, true, 20_000_000_000n)).toBe("ok");
    expect(await swapBoth("swap back", pool, false, 25_000_000_000n)).toBe("ok");
    expect(await both("close_position, liquidity left", pool.user, [closePosition(pool, v1, TOKEN)], w(v1))).toBe(custom(errors.ClosePositionErr!));
    expect(await both("decrease_liquidity (v1), all", pool.user, [dec(v1, positionLiquidity(v1))], w(v1))).toBe("ok");
    expect(await both("close_position, a Metaplex NFT", pool.user, [closePosition(pool, v1, TOKEN)], [...w(v1), pool.user.address])).toBe("ok");
    // A Token-2022 NFT: its mint is closed too.
    const t22 = await openPosition(pool, -600, 600, 10n ** 10n);
    expect(await both("open_position", pool.user, [t22.instruction], t22.watch)).toBe("ok");
    expect(await both("decrease_liquidity, all", pool.user, [decrease(pool, t22, positionLiquidity(t22))], t22.watch)).toBe("ok");
    expect(await both("close_position, the wrong token program", pool.user, [closePosition(pool, t22, TOKEN)], t22.watch)).not.toBe("ok");
    expect(await both("close_position, a Token-2022 NFT", pool.user, [closePosition(pool, t22, TOKEN_2022)], [...t22.watch, pool.user.address])).toBe("ok");
    // A frozen NFT (a restricted-asset pool) is thawed by the pool, passed after the accounts.
    const restricted = await poolWith(60, 41, 19_574_085_512_633_416_581n, [TOKEN, TOKEN], undefined, address("2Yq4T3mPNfjtEyTxSbRjRKqLf1pwbTasuCQrWe6QpM7x"));
    const frozen = await openPosition(restricted, -600, 1800, 0n);
    expect(await both("open_position, restricted, empty", restricted.user, [frozen.instruction], frozen.watch)).toBe("ok");
    expect(await both("close_position, frozen, no pool", restricted.user, [closePosition(restricted, frozen, TOKEN_2022)], frozen.watch)).toBe(custom(errors.AccountLack!));
    expect(await both("close_position, frozen", restricted.user, [closePosition(restricted, frozen, TOKEN_2022, [{ address: restricted.p.pool }])], frozen.watch)).toBe("ok");
  });

  // ---- limit orders -------------------------------------------------------------------------------------------

  it("places, adds to, fills, settles, takes back and closes limit orders", async () => {
    const pool = await liquidPool(42);
    const u64be = (n: bigint) => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64BE(n);
      return b;
    };
    const [nonce] = await pda(PROGRAM, [pool.user.address, Buffer.from([0])]);
    const orderAt = async (n: bigint) => (await pda(PROGRAM, [pool.user.address, nonce, u64be(n)]))[0];
    const nonceCount = () => (original.getAccount(nonce).exists ? bytesAt(nonce).readBigUInt64LE(8 + 32 + 1) : 0n);
    /** zero_for_one: token 0 offered for token 1, on a tick above the price. */
    const open = async (zeroForOne: boolean, tick: number, amount: bigint, rest: Meta[] = []) => {
      const order = await orderAt(nonceCount());
      const start = startOf(tick, pool.spacing);
      pool.starts.add(start);
      const array = await tickArray(pool.p.pool, start);
      const [inMint, outMint] = zeroForOne ? [pool.m0, pool.m1] : [pool.m1, pool.m0];
      const instruction = ix("open_limit_order", { nonce_index: 0, zero_for_one: zeroForOne, tick_index: tick, amount: new BN(amount.toString()) }, [
        { address: pool.user.address, signer: pool.user, writable: true },
        { address: pool.p.pool, writable: true },
        { address: array, writable: true },
        { address: nonce, writable: true },
        { address: order, writable: true },
        { address: zeroForOne ? pool.acct0 : pool.acct1, writable: true },
        { address: zeroForOne ? pool.acct1 : pool.acct0, writable: true },
        { address: zeroForOne ? pool.p.vault0 : pool.p.vault1, writable: true },
        { address: zeroForOne ? pool.p.vault1 : pool.p.vault0, writable: true },
        { address: inMint.address },
        { address: outMint.address },
        { address: inMint.program },
        { address: SYSTEM },
        ...rest,
      ]);
      return { instruction, order, array, zeroForOne, tick, watch: [pool.p.pool, array, nonce, order, pool.acct0, pool.acct1, pool.p.vault0, pool.p.vault1] };
    };
    type Order = Awaited<ReturnType<typeof open>>;
    const increase = (o: Order, amount: bigint) =>
      ix("increase_limit_order", { amount: new BN(amount.toString()) }, [
        { address: pool.user.address, signer: pool.user },
        { address: pool.p.pool, writable: true },
        { address: o.array, writable: true },
        { address: o.order, writable: true },
        { address: o.zeroForOne ? pool.acct0 : pool.acct1, writable: true },
        { address: o.zeroForOne ? pool.p.vault0 : pool.p.vault1, writable: true },
        { address: (o.zeroForOne ? pool.m0 : pool.m1).address },
        { address: (o.zeroForOne ? pool.m0 : pool.m1).program },
      ]);
    const decreaseOrder = (o: Order, amount: bigint, min = 0n) =>
      ix("decrease_limit_order", { amount: new BN(amount.toString()), amount_min: new BN(min.toString()) }, [
        { address: pool.user.address, signer: pool.user },
        { address: pool.p.pool, writable: true },
        { address: o.array, writable: true },
        { address: o.order, writable: true },
        { address: o.zeroForOne ? pool.acct0 : pool.acct1, writable: true },
        { address: o.zeroForOne ? pool.acct1 : pool.acct0, writable: true },
        { address: o.zeroForOne ? pool.p.vault0 : pool.p.vault1, writable: true },
        { address: o.zeroForOne ? pool.p.vault1 : pool.p.vault0, writable: true },
        { address: (o.zeroForOne ? pool.m0 : pool.m1).address },
        { address: (o.zeroForOne ? pool.m1 : pool.m0).address },
        { address: TOKEN },
        { address: TOKEN_2022 },
      ]);
    const settle = (o: Order, by: KeyPairSigner = pool.user) =>
      ix("settle_limit_order", {}, [
        { address: by.address, signer: by },
        { address: pool.p.pool },
        { address: o.array },
        { address: o.order, writable: true },
        { address: o.zeroForOne ? pool.acct1 : pool.acct0, writable: true },
        { address: o.zeroForOne ? pool.p.vault1 : pool.p.vault0, writable: true },
        { address: (o.zeroForOne ? pool.m1 : pool.m0).address },
        { address: (o.zeroForOne ? pool.m1 : pool.m0).program },
      ]);
    const closeOrder = (o: Order) =>
      ix("close_limit_order", {}, [{ address: pool.user.address, signer: pool.user }, { address: pool.user.address, writable: true }, { address: o.order, writable: true }]);

    // Refusals first: the wrong side of the price, off the spacing, nothing.
    for (const [label, zeroForOne, tick, amount, want] of [
      ["below the price", true, 600, 1_000_000n, custom(errors.InvalidTickIndex!)],
      ["off the spacing", true, 3010, 1_000_000n, custom(errors.TickAndSpacingNotMatch!)],
      ["nothing", true, 3000, 0n, custom(errors.ZeroAmountSpecified!)],
    ] as const) {
      const o = await open(zeroForOne, tick, amount);
      expect(await both(`open_limit_order, ${label}`, pool.user, [o.instruction], o.watch)).toBe(want);
    }
    // Orders on a used tick (3000 is not one; 1800 is), on a fresh tick, and on a tick in an array that does not exist yet.
    const a = await open(true, 1800, 5_000_000_000n);
    expect(await both("open_limit_order, on a used tick", pool.user, [a.instruction], a.watch)).toBe("ok");
    const b = await open(true, 3000, 3_000_000_000n);
    expect(await both("open_limit_order, a fresh tick", pool.user, [b.instruction], b.watch)).toBe("ok");
    const c = await open(true, 12_000, 1_000_000_000n);
    expect(await both("open_limit_order, a new tick array", pool.user, [c.instruction], [...c.watch, pool.p.bitmap])).toBe("ok");
    const d1 = await open(false, -2400, 4_000_000_000n);
    expect(await both("open_limit_order, token 1 for token 0", pool.user, [d1.instruction], d1.watch)).toBe("ok");
    expect(await both("increase_limit_order", pool.user, [increase(b, 1_000_000_000n)], b.watch)).toBe("ok");
    expect(await both("increase_limit_order, nothing", pool.user, [increase(b, 0n)], b.watch)).toBe(custom(errors.ZeroAmountSpecified!));
    expect(await both("settle_limit_order, nothing filled", pool.user, [settle(b)], b.watch)).toBe(custom(2505));
    expect(await both("close_limit_order, unfilled", pool.user, [closeOrder(b)], b.watch)).toBe(custom(errors.InvalidLimitOrderAmount!));
    expect(await both("decrease_limit_order, part", pool.user, [decreaseOrder(b, 500_000_000n)], b.watch)).toBe("ok");
    // A swap up through 1800 and 3000: the orders there fill (b in full, a perhaps in part).
    expect(await swapBoth("swap, up through the orders", pool, false, 400_000_000_000n)).toBe("ok");
    expect(tickOf(pool)).toBeGreaterThan(3000);
    expect(await both("increase_limit_order, being filled", pool.user, [increase(b, 1_000_000n)], b.watch)).not.toBe("ok");
    for (const o of [a, b]) expect(await both(`settle_limit_order, tick ${o.tick}`, pool.user, [settle(o)], o.watch)).toBe("ok");
    const someone = await funded();
    expect(await both("settle_limit_order, someone else", someone, [settle(a, someone)], a.watch)).toBe(custom(2003));
    await both("decrease_limit_order, filled", pool.user, [decreaseOrder(b, 1n)], b.watch);
    expect(await both("close_limit_order, filled", pool.user, [closeOrder(b)], [...b.watch, pool.user.address])).toBe("ok");
    await both("decrease_limit_order, the rest of a", pool.user, [decreaseOrder(a, 10n ** 12n)], a.watch);
    // The order in the new array: taken back in full, its tick and the array's bit cleared.
    expect(await both("decrease_limit_order, all of a lone order", pool.user, [decreaseOrder(c, 10n ** 12n)], [...c.watch, pool.p.bitmap])).toBe("ok");
    expect(await both("close_limit_order, emptied", pool.user, [closeOrder(c)], c.watch)).toBe("ok");
    // Limit orders off.
    patchPool(pool, (bytes) => (bytes[POOL_STATUS] = 32));
    const e = await open(true, 6000, 1_000_000n);
    expect(await both("open_limit_order, orders off", pool.user, [e.instruction], e.watch)).toBe(custom(errors.NotApproved!));
    patchPool(pool, (bytes) => (bytes[POOL_STATUS] = 0));
  });

  // ---- swap (v1) and the router ------------------------------------------------------------------------------

  it("swaps with the v1 instruction and routes through two pools", async () => {
    const pool = await liquidPool(43);
    const v1 = async (zeroForOne: boolean, amount: bigint, opts: { exactOut?: boolean; threshold?: bigint; first?: Address } = {}) => {
      const arrays = await arraysFor(pool, zeroForOne);
      const current = await tickArray(pool.p.pool, startOf(tickOf(pool), pool.spacing));
      const first = opts.first ?? current;
      const [inAcct, outAcct] = zeroForOne ? [pool.acct0, pool.acct1] : [pool.acct1, pool.acct0];
      const [inVault, outVault] = zeroForOne ? [pool.p.vault0, pool.p.vault1] : [pool.p.vault1, pool.p.vault0];
      const instruction = ix(
        "swap",
        {
          amount: new BN(amount.toString()),
          other_amount_threshold: new BN((opts.threshold ?? (opts.exactOut ? 2n ** 64n - 1n : 0n)).toString()),
          sqrt_price_limit_x64: new BN(0),
          is_base_input: !opts.exactOut,
        },
        [
          { address: pool.user.address, signer: pool.user },
          { address: pool.cfg },
          { address: pool.p.pool, writable: true },
          { address: inAcct, writable: true },
          { address: outAcct, writable: true },
          { address: inVault, writable: true },
          { address: outVault, writable: true },
          { address: pool.p.observation, writable: true },
          { address: TOKEN },
          { address: first, writable: true },
          ...arrays.filter((a) => a !== first).map((a) => ({ address: a, writable: true })),
        ],
      );
      return { instruction, watch: [pool.p.pool, pool.p.vault0, pool.p.vault1, pool.acct0, pool.acct1, pool.p.observation, ...arrays] };
    };
    for (const [label, zeroForOne, amount, opts, want] of [
      ["0 for 1", true, 10_000_000_000n, {}, "ok"],
      ["1 for 0, across arrays", false, 150_000_000_000n, {}, "ok"],
      ["0 for 1, exact output", true, 3_000_000_000n, { exactOut: true }, "ok"],
      ["too little out", true, 1_000_000n, { threshold: 10n ** 12n }, custom(errors.TooLittleOutputReceived!)],
      ["too much in", false, 1_000_000n, { exactOut: true, threshold: 1n }, custom(errors.TooMuchInputPaid!)],
    ] as const) {
      const s1 = await v1(zeroForOne, amount, opts);
      expect(await both(`swap (v1), ${label}`, pool.user, [s1.instruction], s1.watch)).toBe(want);
    }

    // A second pool trading token 1 of the first against a new token: the router goes token 0 → token 1 → new.
    const third = await mint(pool.user, TOKEN, 8);
    const pairB = (Buffer.compare(key(pool.m1.address), key(third.address)) < 0 ? [pool.m1, third] : [third, pool.m1]) as [MintInfo, MintInfo];
    const poolB = await liquidPool(44, [TOKEN, TOKEN], undefined, { user: pool.user, mints: pairB });
    const hop = async (p: Pool, inMint: Address) => {
      const zeroForOne = inMint === p.m0.address;
      const arrays = await arraysFor(p, zeroForOne);
      return [
        { address: p.cfg },
        { address: p.p.pool, writable: true },
        { address: zeroForOne ? p.acct1 : p.acct0, writable: true },
        { address: zeroForOne ? p.p.vault0 : p.p.vault1, writable: true },
        { address: zeroForOne ? p.p.vault1 : p.p.vault0, writable: true },
        { address: (zeroForOne ? p.m1 : p.m0).address },
        { address: p.p.observation, writable: true },
        ...arrays.map((a) => ({ address: a, writable: true })),
      ] as Meta[];
    };
    const route = async (amount: bigint, min: bigint) =>
      ix("swap_router_base_in", { amount_in: new BN(amount.toString()), amount_out_minimum: new BN(min.toString()) }, [
        { address: pool.user.address, signer: pool.user },
        { address: pool.acct0, writable: true },
        { address: pool.m0.address, writable: true },
        { address: TOKEN },
        { address: TOKEN_2022 },
        { address: MEMO },
        ...(await hop(pool, pool.m0.address)),
        ...(await hop(poolB, pool.m1.address)),
      ]);
    const watch = [pool.p.pool, poolB.p.pool, pool.acct0, pool.acct1, poolB.acct0, poolB.acct1, pool.p.vault0, pool.p.vault1, poolB.p.vault0, poolB.p.vault1];
    const thirdAcct = third.address === poolB.m0.address ? poolB.acct0 : poolB.acct1;
    const before = bytesAt(thirdAcct).readBigUInt64LE(64);
    expect(await both("swap_router_base_in, two hops", pool.user, [await route(2_000_000_000n, 0n)], watch)).toBe("ok");
    // The new token arrived: both hops ran.
    expect(bytesAt(thirdAcct).readBigUInt64LE(64)).toBeGreaterThan(before);
    expect(await both("swap_router_base_in, too little out", pool.user, [await route(2_000_000_000n, 10n ** 13n)], watch)).toBe(custom(errors.TooLittleOutputReceived!));
  });

  it("reports compute units", () => {
    expect(compared).toBeGreaterThan(5);
    console.log(`${compared} transactions compared`);
    console.log(Object.entries(cu).map(([k, [a, b]]) => `${k}: ${a} → ${b}`).join("\n"));
  });
});
